/* ==================================================================== *
 * A node-usb 3.1.0 `UsbDevice` whose camera is the emulator.
 *
 * WHY THIS EXISTS (TESTING.md sec.21.1). The emulator suites drive the
 * transport through `UsbIpWebUsbDevice`, which models what a real host's OS
 * does with the device's strings: a reply that is not a string descriptor is
 * dropped, and the attribute is null. That is right for Chrome on Linux and
 * for the OS layer under node-usb, and it is exactly why no emulator row ever
 * met what the CLI met on the bench Compact 1.3.0.0 (FW-V1 Phase 53): node-usb
 * does not stop at the OS layer. Its `serialNumber` getter, finding no OS copy,
 * opens the device and asks it again through nusb, and nusb's validation turns
 * the same reply into a THROW - "getString error: invalid descriptor" - which
 * took `devices`, `info` and `dump` down before a vendor request was sent.
 *
 * So this is node-usb's own layering over the same USB/IP session, and nothing
 * is decided by a fixture:
 *
 *  - THE STRINGS, as node-usb-rs v3.1.0 src/webusb_device.rs reads them: the
 *    OS's copy when there is one (the adapter's `manufacturerName` /
 *    `productName` / `serialNumber`, read off the wire with the kernel's rule),
 *    and otherwise nusb 0.2.7's `get_string_descriptor`: a real
 *    GET_DESCRIPTOR(STRING, i) with wIndex 0x0409 (`US_ENGLISH`) and wLength
 *    4096 (`Device::get_descriptor` on every platform but Windows), whose reply
 *    must satisfy `validate_string_descriptor` - at least 2 bytes, bLength
 *    equal to the reply's length, bDescriptorType 3 - or the getter throws
 *    "getString error: invalid descriptor". A stall is "getString error:
 *    endpoint stalled". node-usb's getter is synchronous (it blocks on the
 *    transfer) and a USB/IP transfer is not, so the descriptor read happens
 *    once, when the device is attached, and the getter then returns the string
 *    or throws the error EVERY time it is read, as node-usb's does. The bytes on
 *    the wire are the ones node-usb sends; only their moment moves.
 *  - THE TRANSFERS through the REAL shim `usb` installs on every device
 *    (`UsbDevice.prototype.controlTransferIn/Out`, node_modules/usb/dist
 *    index.js), over a native layer that behaves as node-usb-rs's does: bytes
 *    on success, a rejection with nusb's `TransferError` text on a stall.
 *  - THE CONFIGURATION getter throws nusb's "configuration error: device is
 *    not configured" for configuration 0, as node-usb-rs's does.
 *  - A TRANSFER NUSB GAVE UP. Under the `nusb` host model (TESTING.md sec.22)
 *    the emulated host cancels a transfer at exactly the deadline the shim
 *    passed, as nusb does, and the native layer then rejects with nusb's
 *    `TransferError::Cancelled` text, "transfer was cancelled", behind
 *    node-usb-rs's "controlTransferIn error: " prefix - which is what
 *    `fromNodeUsb` turns into `usb/timeout`.
 * ==================================================================== */

import { createRequire } from 'node:module';

import type {
  WebUsbConfiguration,
  WebUsbControlSetup,
  WebUsbInTransferResult,
  WebUsbOutTransferResult,
} from '@seek-fw/core';

import { UsbIpError } from '../../core/test/emulator/usbip-client.js';
import type { UsbIpWebUsbDevice } from '../../core/test/emulator/webusb-over-usbip.js';
import type { NodeUsbDevice } from '../src/node-usb.js';

type ShimIn = (
  this: unknown,
  setup: WebUsbControlSetup,
  length: number,
  timeout?: number,
) => Promise<WebUsbInTransferResult>;
type ShimOut = (
  this: unknown,
  setup: WebUsbControlSetup,
  data: ArrayBufferView,
  timeout?: number,
) => Promise<WebUsbOutTransferResult>;

const require = createRequire(import.meta.url);
require('usb');
const { UsbDevice } = require('usb/index.js') as {
  UsbDevice: { prototype: { controlTransferIn: ShimIn; controlTransferOut: ShimOut } };
};

/** The emulated host's status for a transfer it gave up (-ETIMEDOUT). */
const HOST_GAVE_UP = -110;

/**
 * node-usb-rs's native call, with nusb's text for a transfer nusb itself gave up
 * (see the file comment). Only under the `nusb` host model is a give-up nusb's.
 */
async function nusbTransfer<T>(
  device: UsbIpWebUsbDevice,
  direction: 'In' | 'Out',
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (
      device.hostModel === 'nusb' &&
      error instanceof UsbIpError &&
      error.errno === HOST_GAVE_UP
    ) {
      throw new Error(`controlTransfer${direction} error: transfer was cancelled`, {
        cause: error,
      });
    }
    throw error;
  }
}

/** nusb `descriptors::language_id::US_ENGLISH`, which node-usb-rs asks for. */
const US_ENGLISH = 0x0409;
/** nusb 0.2.7 `Device::get_descriptor`'s wLength off Windows. */
const NUSB_DESCRIPTOR_LENGTH = 4096;
/** node-usb-rs `DESC_TIMEOUT`. */
const DESC_TIMEOUT_MS = 100;
const DESC_STRING = 0x03;

/** nusb 0.2.7 src/descriptors.rs `validate_string_descriptor`. */
export function nusbValidString(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === data.length && data[1] === DESC_STRING;
}

/** nusb 0.2.7 `decode_string_descriptor`: UTF-16LE, unpaired surrogates replaced. */
function nusbDecode(data: Uint8Array): string {
  const body = data.subarray(2, 2 + ((data.length - 2) & ~1));
  return new TextDecoder('utf-16le').decode(body);
}

/** A string node-usb returns, or the error its getter throws. */
type StringOutcome = { readonly value: string | null } | { readonly error: string };

/** What node-usb-rs's getter does for one string index (see the file comment). */
async function nodeUsbString(
  device: UsbIpWebUsbDevice,
  osCopy: string | null,
  index: number,
): Promise<StringOutcome & { readonly asked: boolean }> {
  if (osCopy !== null) return { value: osCopy, asked: false };
  if (index === 0) return { value: null, asked: false };
  /* A STANDARD request, which core's setup type (vendor only: all the toolkit
   * sends) cannot spell; the adapter encodes the type bits from the string. */
  const getDescriptor = {
    requestType: 'standard',
    recipient: 'device',
    request: 0x06,
    value: (DESC_STRING << 8) | index,
    index: US_ENGLISH,
  } as unknown as WebUsbControlSetup;
  const transfer = device.controlTransferIn(getDescriptor, NUSB_DESCRIPTOR_LENGTH, DESC_TIMEOUT_MS);
  /* nusb's own 100 ms deadline, on the emulated camera's clock like every other
   * deadline in these suites (TESTING.md sec.19): "transfer was cancelled". */
  let cancel = (): void => undefined;
  const expired = new Promise<'cancelled'>((resolve) => {
    cancel = device.deadlineClock.startTimer(DESC_TIMEOUT_MS, () => {
      resolve('cancelled');
    });
  });
  transfer.catch(() => undefined);
  const reply = await Promise.race([transfer, expired]).finally(cancel);
  if (reply === 'cancelled') {
    return { error: 'getString error: transfer was cancelled', asked: true };
  }
  if (reply.status === 'stall') return { error: 'getString error: endpoint stalled', asked: true };
  const view = reply.data;
  const data =
    view === undefined
      ? new Uint8Array(0)
      : new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  if (!nusbValidString(data)) return { error: 'getString error: invalid descriptor', asked: true };
  return { value: nusbDecode(data), asked: true };
}

export interface NodeUsbOverUsbIp extends NodeUsbDevice {
  /** The emulator-backed device underneath, for audits. */
  readonly usbip: UsbIpWebUsbDevice;
  /** The string indices node-usb had to ask the device for, because the OS had no copy. */
  readonly askedTheDevice: readonly number[];
}

/**
 * node-usb's `UsbDevice` over an attached emulator device. Call once per
 * attach: the string reads described above happen here.
 */
export async function nodeUsbOverUsbIp(device: UsbIpWebUsbDevice): Promise<NodeUsbOverUsbIp> {
  const descriptor = device.deviceDescriptor;
  const asked: number[] = [];
  const read = async (osCopy: string | null, index: number): Promise<StringOutcome> => {
    const outcome = await nodeUsbString(device, osCopy, index);
    if (outcome.asked) asked.push(index);
    return outcome;
  };
  const strings = {
    manufacturerName: await read(device.manufacturerName, descriptor[14] ?? 0),
    productName: await read(device.productName, descriptor[15] ?? 0),
    serialNumber: await read(device.serialNumber, descriptor[16] ?? 0),
  };
  const get = (outcome: StringOutcome): string | null => {
    if ('error' in outcome) throw new Error(outcome.error);
    return outcome.value;
  };

  const self = {
    usbip: device,
    askedTheDevice: asked,
    get vendorId(): number {
      return device.vendorId;
    },
    get productId(): number {
      return device.productId;
    },
    get manufacturerName(): string | null {
      return get(strings.manufacturerName);
    },
    get productName(): string | null {
      return get(strings.productName);
    },
    get serialNumber(): string | null {
      return get(strings.serialNumber);
    },
    get configuration(): WebUsbConfiguration | null {
      const active = device.configuration;
      if (active === null) throw new Error('configuration error: device is not configured');
      return active;
    },
    get opened(): boolean {
      return device.opened;
    },
    open: (): Promise<void> => device.open(),
    close: (): Promise<void> => device.close(),
    selectConfiguration: (value: number): Promise<void> => device.selectConfiguration(value),
    claimInterface: (n: number): Promise<void> => device.claimInterface(n),
    releaseInterface: (n: number): Promise<void> => device.releaseInterface(n),
    /* The real shim, as `usb` installs it on every UsbDevice. */
    controlTransferIn: UsbDevice.prototype.controlTransferIn,
    controlTransferOut: UsbDevice.prototype.controlTransferOut,
    /* node-usb-rs's native layer: a fresh buffer on success (the shim wraps
     * `res.buffer` whole), nusb's text on a stall. */
    nativeControlTransferIn: async (
      setup: WebUsbControlSetup,
      timeout: number,
      length: number,
    ): Promise<Uint8Array> => {
      const result = await nusbTransfer(device, 'In', () =>
        device.controlTransferIn(setup, length, timeout),
      );
      if (result.status !== 'ok') throw new Error('controlTransferIn error: endpoint stalled');
      const view = result.data;
      return view === undefined
        ? new Uint8Array(0)
        : new Uint8Array(view.buffer, view.byteOffset, view.byteLength).slice();
    },
    nativeControlTransferOut: async (
      setup: WebUsbControlSetup,
      timeout: number,
      data: Uint8Array,
    ): Promise<number> => {
      const result = await nusbTransfer(device, 'Out', () =>
        device.controlTransferOut(setup, data, timeout),
      );
      if (result.status !== 'ok') throw new Error('controlTransferOut error: endpoint stalled');
      return result.bytesWritten ?? data.length;
    },
  };
  return self;
}

/**
 * The `usb` package's device, made to behave as WebUSB says a device behaves.
 *
 * The CLI's host stack is `usb` 3.1.0: node-usb-rs over nusb 0.2.7, not
 * libusb. It ships a WebUSB-shaped API, and core's `WebUsbTransport` is written
 * against WebUSB, but the shape and the behaviour differ in four places. Each
 * one is corrected here and nowhere else, so core keeps one transport for both
 * front ends (TESTING.md sec.11):
 *
 *   1. TIMEOUTS. Every control transfer takes a timeout as its third argument
 *      and uses 1000 ms when there is none: `const DEFAULT_TIMEOUT = 1000` and
 *      `controlTransferIn = async function (setup, length, timeout =
 *      DEFAULT_TIMEOUT)` / `controlTransferOut(setup, data, timeout =
 *      DEFAULT_TIMEOUT)`, node_modules/usb/dist/index.js:8, :22, :32, passed
 *      as `nativeControlTransferIn(setup, timeout, length)` and on to nusb as
 *      `Duration::from_millis(timeout)` (node-usb-rs v3.1.0
 *      src/webusb_device.rs, `controlTransferIn` / `controlTransferOut`). The
 *      `deviceTimeout` option its .d.ts declares is read nowhere. The
 *      transport's own deadline is passed on every call, so the deadline the
 *      code states — 5 s, 1.5 s, 20 s for the flash commit — is the one the
 *      host enforces. When nusb's timer fires first it reports
 *      `TransferError::Cancelled`, "transfer was cancelled"; that is reported
 *      as the timeout it is.
 *   2. STALLS. A firmware refusal rejects with nusb's `TransferError::Stall`,
 *      "endpoint stalled" (nusb src/transfer/mod.rs), where WebUSB resolves
 *      `status: 'stall'`. It is turned back into the WebUSB result, so the
 *      transport reports `usb/stalled` — "the firmware said no" — rather than
 *      `usb/transfer-failed` and its "unplug and replug".
 *   3. AN UNCONFIGURED DEVICE. The `configuration` getter throws
 *      "configuration error: device is not configured" (nusb's
 *      `ActiveConfigurationError` for configuration value 0) where WebUSB
 *      returns null. It returns null here, and the transport then selects
 *      configuration 1 exactly as it does in a browser. Any OTHER error from
 *      the getter still throws.
 *   4. A CLAIM THE OS REFUSED. nusb reports "the interface is held by someone
 *      else" as `ErrorKind::Busy`: "could not open interface for exclusive
 *      access" on macOS (kIOReturnExclusiveAccess) and "interface is busy" on
 *      Linux (EBUSY from USBDEVFS_CLAIMINTERFACE), both behind node-usb-rs's
 *      "claimInterface error: " prefix. WebUSB calls that failure a
 *      `NetworkError`, which is the one claim failure the transport's 'auto'
 *      mode answers with device recipient; these two are renamed to it, with
 *      the host's own message kept. Every other claim error is left as it is.
 */

import {
  SeekError,
  hex,
  type WebUsbConfiguration,
  type WebUsbControlSetup,
  type WebUsbDevice,
  type WebUsbInTransferResult,
  type WebUsbOutTransferResult,
} from '@seek-fw/core';

/**
 * The slice of `usb` 3.x's `UsbDevice` this CLI uses.
 *
 * Its own .d.ts types the transfers as WebUSB's two-argument methods; the
 * installed JavaScript takes the timeout as a third (see 1 above), so that is
 * what is declared here. A real `UsbDevice` is assignable to this.
 */
export interface NodeUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly manufacturerName: string | null;
  readonly productName: string | null;
  readonly serialNumber: string | null;
  /** THROWS on an unconfigured device instead of returning null (see 3 above). */
  readonly configuration: WebUsbConfiguration | null;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  controlTransferIn(
    setup: WebUsbControlSetup,
    length: number,
    timeout?: number,
  ): Promise<WebUsbInTransferResult>;
  controlTransferOut(
    setup: WebUsbControlSetup,
    data: ArrayBufferView,
    timeout?: number,
  ): Promise<WebUsbOutTransferResult>;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** nusb `TransferError::Stall`'s Display text. */
const STALLED = 'endpoint stalled';
/** nusb `TransferError::Cancelled`'s Display text: its own timeout, or a cancel. */
const CANCELLED = 'transfer was cancelled';
/** nusb `ActiveConfigurationError` with configuration value 0. */
const NOT_CONFIGURED = 'device is not configured';
/** nusb `ErrorKind::Busy` from `claim_interface`: macOS, then Linux. */
const CLAIM_BUSY: readonly string[] = [
  'could not open interface for exclusive access',
  'interface is busy',
];

/** WebUSB's name for a claim the platform refused, with the host's words kept. */
class PlatformClaimRefused extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'NetworkError';
  }
}

function transferFailure<T>(
  error: unknown,
  direction: 'IN' | 'OUT',
  setup: WebUsbControlSetup,
  timeoutMs: number,
  stalled: T,
): T {
  const message = messageOf(error);
  if (message.includes(STALLED)) return stalled;
  if (message.includes(CANCELLED)) {
    throw new SeekError(
      'usb/timeout',
      `control ${direction} ${hex(setup.request)} did not answer within ` +
        `${String(timeoutMs)} ms (the host cancelled it: ${message})`,
      { cause: error },
    );
  }
  throw error;
}

/** Core's `WebUsbDevice` over a `usb` 3.x device. See the file comment for what changes. */
export function fromNodeUsb(device: NodeUsbDevice): WebUsbDevice {
  return {
    get vendorId(): number {
      return device.vendorId;
    },
    get productId(): number {
      return device.productId;
    },
    get manufacturerName(): string | null {
      return device.manufacturerName;
    },
    get productName(): string | null {
      return device.productName;
    },
    get serialNumber(): string | null {
      return device.serialNumber;
    },
    get configuration(): WebUsbConfiguration | null {
      try {
        return device.configuration;
      } catch (error) {
        if (messageOf(error).includes(NOT_CONFIGURED)) return null;
        throw error;
      }
    },
    get opened(): boolean {
      return device.opened;
    },
    open: () => device.open(),
    close: () => device.close(),
    selectConfiguration: (value) => device.selectConfiguration(value),
    claimInterface: async (interfaceNumber) => {
      try {
        await device.claimInterface(interfaceNumber);
      } catch (error) {
        const message = messageOf(error);
        if (CLAIM_BUSY.some((busy) => message.includes(busy))) {
          throw new PlatformClaimRefused(message, error);
        }
        throw error;
      }
    },
    releaseInterface: (interfaceNumber) => device.releaseInterface(interfaceNumber),
    controlTransferIn: async (setup, length, timeoutMs) => {
      try {
        return await device.controlTransferIn(setup, length, timeoutMs);
      } catch (error) {
        return transferFailure<WebUsbInTransferResult>(error, 'IN', setup, timeoutMs, {
          status: 'stall',
        });
      }
    },
    controlTransferOut: async (setup, data, timeoutMs) => {
      try {
        return await device.controlTransferOut(setup, data, timeoutMs);
      } catch (error) {
        return transferFailure<WebUsbOutTransferResult>(error, 'OUT', setup, timeoutMs, {
          status: 'stall',
        });
      }
    },
  };
}

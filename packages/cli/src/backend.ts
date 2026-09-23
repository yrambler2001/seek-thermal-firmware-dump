/**
 * Device discovery for Node, and nothing else.
 *
 * The `usb` package ships a WebUSB-shaped API, and core's `WebUsbTransport`
 * already speaks that shape — so this file contains no protocol code at all.
 * It finds Seek devices, wraps each one in the transport core exports — through
 * `fromNodeUsb`, which corrects the four places `usb` 3.x behaves unlike WebUSB
 * (timeouts, stalls, an unconfigured device, a refused claim) — and turns the
 * host's permission failures into the udev advice from the README.
 *
 * `usb` is imported DYNAMICALLY: it is a native addon, and `seek-fw decrypt`
 * must keep working on a machine with no camera, no udev rule and no
 * permission to enumerate USB at all.
 */

import {
  SEEK_VENDOR_ID,
  WebUsbTransport,
  type RecipientPreference,
  type UsbBackend,
  type UsbTransport,
} from '@seek-fw/core';
import { CliError, looksLikeAccessError, permissionHint } from './errors.js';
import { fromNodeUsb, type NodeUsbDevice } from './node-usb.js';

export type { NodeUsbDevice } from './node-usb.js';

/** Recorded in every dump manifest, so a capture says which host read it. */
export const CLI_TRANSPORT_API = 'node-usb 3.x (WebUSB shim)';

export function hostString(): string {
  return `node ${process.version} ${process.platform}/${process.arch}`;
}

/** The camera enumeration a backend performs, injectable for tests. */
export type Enumerate = () => Promise<readonly NodeUsbDevice[]>;

export interface BackendOptions {
  readonly recipient?: RecipientPreference;
  /** Called when the OS refused the claim on interface 0 and 'auto' fell back. */
  readonly onWarning?: (message: string) => void;
  /** Replaces the real `usb` enumeration. Tests pass fake devices here. */
  readonly enumerate?: Enumerate;
}

/** Enumerates through the `usb` package's WebUSB shim. No user prompt in Node. */
export async function enumerateSeekDevices(): Promise<readonly NodeUsbDevice[]> {
  let devices: readonly NodeUsbDevice[];
  try {
    const { WebUSB } = await import('usb');
    const webusb = new WebUSB({ allowAllDevices: true });
    devices = await webusb.getDevices();
  } catch (error) {
    if (looksLikeAccessError(error)) {
      throw new CliError(`could not enumerate USB devices: ${describe(error)}`, {
        code: 'usb/enumerate',
        hint: permissionHint(process.platform),
      });
    }
    throw new CliError(`could not enumerate USB devices: ${describe(error)}`, {
      code: 'usb/enumerate',
    });
  }
  return devices.filter((device) => device.vendorId === SEEK_VENDOR_ID);
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Core's `UsbBackend` for Node.
 *
 * `requestDevice` cannot prompt — there is no chooser in a terminal — so it
 * returns the first camera it finds and says how to fix it when there is none.
 */
export class NodeUsbBackend implements UsbBackend {
  private readonly recipient: RecipientPreference;
  private readonly onWarning: ((message: string) => void) | undefined;
  private readonly enumerate: Enumerate;

  constructor(options: BackendOptions = {}) {
    this.recipient = options.recipient ?? 'auto';
    this.onWarning = options.onWarning;
    this.enumerate = options.enumerate ?? enumerateSeekDevices;
  }

  async listDevices(): Promise<UsbTransport[]> {
    const devices = await this.enumerate();
    return devices.map((device) => this.wrap(device));
  }

  async requestDevice(): Promise<UsbTransport> {
    const [first] = await this.listDevices();
    if (first === undefined) throw noCameraError();
    return first;
  }

  private wrap(device: NodeUsbDevice): UsbTransport {
    return new WebUsbTransport(fromNodeUsb(device), {
      recipient: this.recipient,
      api: CLI_TRANSPORT_API,
      host: hostString(),
      ...(this.onWarning === undefined ? {} : { onWarning: this.onWarning }),
    });
  }
}

export function noCameraError(platform: string = process.platform): CliError {
  return new CliError('no Seek camera found', {
    code: 'usb/no-device',
    hint:
      'Plug a Seek Thermal camera in and make sure nothing else is using it.\n\n' +
      permissionHint(platform),
  });
}

/**
 * Finds one camera and opens it, with the access failures translated.
 *
 * `serial` picks a specific camera when several are attached; without it,
 * several cameras are an error rather than a coin toss — writing firmware to
 * whichever one enumerated first is not a thing this tool should ever do.
 */
export async function openCamera(
  backend: UsbBackend,
  options: { readonly serial?: string | null; readonly platform?: string } = {},
): Promise<UsbTransport> {
  const platform = options.platform ?? process.platform;
  const transports = await backend.listDevices();
  if (transports.length === 0) throw noCameraError(platform);

  const serial = options.serial ?? null;
  const matched =
    serial === null
      ? transports
      : transports.filter((transport) => transport.description.serialNumber === serial);

  if (matched.length === 0) {
    throw new CliError(`no Seek camera with serial '${serial ?? ''}' is attached`, {
      code: 'usb/no-device',
    });
  }
  if (matched.length > 1) {
    throw new CliError(
      `${String(matched.length)} Seek cameras are attached; pick one with --serial <id>`,
      { code: 'usb/ambiguous-device' },
    );
  }

  const transport = matched[0];
  if (transport === undefined) throw noCameraError(platform);

  try {
    await transport.open();
  } catch (error) {
    if (looksLikeAccessError(error)) {
      throw new CliError(`could not open the camera: ${describe(error)}`, {
        code: 'usb/not-open',
        hint: permissionHint(platform),
      });
    }
    throw error;
  }
  return transport;
}

export interface DeviceSummary {
  readonly vendorId: string;
  readonly productId: string;
  readonly productName: string | null;
  readonly manufacturerName: string | null;
  readonly serialNumber: string | null;
}

export function summarizeDevice(transport: UsbTransport): DeviceSummary {
  const description = transport.description;
  return {
    vendorId: `0x${description.vendorId.toString(16).padStart(4, '0')}`,
    productId: `0x${description.productId.toString(16).padStart(4, '0')}`,
    productName: description.productName,
    manufacturerName: description.manufacturerName,
    serialNumber: description.serialNumber,
  };
}

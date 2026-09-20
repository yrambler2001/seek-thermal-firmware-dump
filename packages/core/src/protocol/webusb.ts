/**
 * The one transport implementation, shared by both platforms.
 *
 * Chrome's `navigator.usb` and the `usb` package's v3 WebUSB shim expose the
 * same spec-shaped object, so a single class covers the browser app and the CLI
 * and there is no second protocol implementation to keep in sync.
 */

import { hex } from '../bytes.js';
import { errorMessage, SeekError } from '../errors.js';
import { CONFIGURATION_VALUE, INTERFACE_NUMBER, USB_TIMEOUT_MS } from './ops.js';
import type { DeviceDescription, Recipient, TransportInfo, UsbTransport } from './transport.js';

/* ------------------------------------------------------------------ *
 * The slice of WebUSB this transport uses.
 *
 * Declared structurally rather than pulled in from `@types/w3c-web-usb` so that
 * core's emitted .d.ts stays self-contained and free of ambient global types.
 * A real `USBDevice` and node-usb's `WebUSBDevice` are both assignable to this.
 * ------------------------------------------------------------------ */

export type WebUsbTransferStatus = 'ok' | 'stall' | 'babble';

export interface WebUsbControlSetup {
  requestType: 'vendor';
  recipient: Recipient;
  request: number;
  value: number;
  index: number;
}

export interface WebUsbInTransferResult {
  readonly status: WebUsbTransferStatus;
  readonly data?: DataView | undefined;
}

export interface WebUsbOutTransferResult {
  readonly status: WebUsbTransferStatus;
  readonly bytesWritten?: number | undefined;
}

export interface WebUsbConfiguration {
  readonly configurationValue: number;
}

export interface WebUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly manufacturerName: string | null;
  readonly productName: string | null;
  readonly serialNumber: string | null;
  readonly configuration: WebUsbConfiguration | null;
  readonly opened: boolean;
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  controlTransferIn(setup: WebUsbControlSetup, length: number): Promise<WebUsbInTransferResult>;
  controlTransferOut(
    setup: WebUsbControlSetup,
    data: ArrayBufferView,
  ): Promise<WebUsbOutTransferResult>;
}

/** Which recipient to use. 'auto' claims interface 0 if it can and quietly falls
 *  back to device-recipient requests if a driver is holding it. */
export type RecipientPreference = Recipient | 'auto';

export interface WebUsbTransportOptions {
  readonly interfaceNumber?: number;
  readonly configurationValue?: number;
  readonly recipient?: RecipientPreference;
  /** Recorded in dump manifests, e.g. 'WebUSB' or 'node-usb 3.x (WebUSB shim)'. */
  readonly api?: string;
  readonly host?: string | null;
  /** Called when the interface could not be claimed but 'auto' let us continue. */
  readonly onWarning?: (message: string) => void;
}

/**
 * WebUSB has no timeout of its own: a camera that simply does not answer leaves
 * the transfer pending forever, which shows up as a frozen dump with no error
 * and no retry. Racing a timer turns that into an ordinary failure the retry
 * path can reopen and recover from.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new SeekError('usb/timeout', `${what} did not answer within ${String(ms)} ms`));
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

function statusError(what: string, status: WebUsbTransferStatus): SeekError {
  return new SeekError(
    status === 'stall' ? 'usb/stalled' : 'usb/transfer-failed',
    `${what} -> ${status}`,
  );
}

export class WebUsbTransport implements UsbTransport {
  private readonly device: WebUsbDevice;
  private readonly interfaceNumber: number;
  private readonly configurationValue: number;
  private readonly preference: RecipientPreference;
  private readonly api: string;
  private readonly host: string | null;
  private readonly onWarning: ((message: string) => void) | undefined;

  private recipient: Recipient;
  private claimed = false;
  private opened = false;

  constructor(device: WebUsbDevice, options: WebUsbTransportOptions = {}) {
    this.device = device;
    this.interfaceNumber = options.interfaceNumber ?? INTERFACE_NUMBER;
    this.configurationValue = options.configurationValue ?? CONFIGURATION_VALUE;
    this.preference = options.recipient ?? 'auto';
    this.api = options.api ?? 'WebUSB';
    this.host = options.host ?? null;
    this.onWarning = options.onWarning;
    this.recipient = this.preference === 'device' ? 'device' : 'interface';
  }

  get description(): DeviceDescription {
    return {
      vendorId: this.device.vendorId,
      productId: this.device.productId,
      productName: this.device.productName,
      manufacturerName: this.device.manufacturerName,
      serialNumber: this.device.serialNumber,
    };
  }

  get info(): TransportInfo {
    return {
      api: this.api,
      recipient: this.recipient,
      interfaceNumber: this.interfaceNumber,
      claimedInterface: this.claimed,
      host: this.host,
    };
  }

  get isOpen(): boolean {
    return this.opened;
  }

  async open(): Promise<void> {
    if (this.opened) return;
    const dev = this.device;
    if (!dev.opened) await dev.open();
    if (dev.configuration?.configurationValue !== this.configurationValue) {
      await dev.selectConfiguration(this.configurationValue);
    }

    this.claimed = false;

    if (this.preference === 'device') {
      this.recipient = 'device';
      this.opened = true;
      return;
    }

    try {
      await dev.claimInterface(this.interfaceNumber);
      this.claimed = true;
      this.recipient = 'interface';
    } catch (error) {
      if (this.preference === 'interface') {
        throw new SeekError(
          'usb/not-open',
          `could not claim USB interface ${String(this.interfaceNumber)}: ` +
            `${errorMessage(error)} — another program or a system driver is holding the ` +
            `camera. See the platform notes for how to release it.`,
          { cause: error },
        );
      }
      this.recipient = 'device';
      this.onWarning?.(
        `could not claim interface ${String(this.interfaceNumber)} (${errorMessage(error)}); ` +
          `using recipient=device instead`,
      );
    }
    this.opened = true;
  }

  /** Safe to call when the device has already vanished — a mid-dump unplug must
   *  not let a throwing cleanup path mask the real error. */
  async close(): Promise<void> {
    try {
      if (this.claimed) await this.device.releaseInterface(this.interfaceNumber);
    } catch {
      /* already released */
    }
    this.claimed = false;
    try {
      if (this.device.opened) await this.device.close();
    } catch {
      /* already closed */
    }
    this.opened = false;
  }

  async controlIn(
    request: number,
    length: number,
    timeoutMs: number = USB_TIMEOUT_MS,
  ): Promise<Uint8Array> {
    this.assertOpen();
    const what = `control IN ${hex(request)}`;
    const result = await withTimeout(this.transferIn(request, length, what), timeoutMs, what);
    /* WebUSB resolves on a stall instead of rejecting, so status must be checked
     * explicitly — otherwise a stalled read silently becomes a zero-length one,
     * indistinguishable from the end of the data. */
    if (result.status !== 'ok') throw statusError(what, result.status);
    const data = result.data;
    if (!data) return new Uint8Array(0);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }

  async controlOut(
    request: number,
    data: Uint8Array,
    timeoutMs: number = USB_TIMEOUT_MS,
  ): Promise<void> {
    this.assertOpen();
    const what = `control OUT ${hex(request)}`;
    const result = await withTimeout(this.transferOut(request, data, what), timeoutMs, what);
    if (result.status !== 'ok') throw statusError(what, result.status);
  }

  private setupPacket(request: number): WebUsbControlSetup {
    return {
      requestType: 'vendor',
      recipient: this.recipient,
      request,
      value: 0,
      index: this.recipient === 'interface' ? this.interfaceNumber : 0,
    };
  }

  private assertOpen(): void {
    if (!this.opened) {
      throw new SeekError('usb/not-open', 'the USB transport is not open');
    }
  }

  private async transferIn(
    request: number,
    length: number,
    what: string,
  ): Promise<WebUsbInTransferResult> {
    try {
      return await this.device.controlTransferIn(this.setupPacket(request), length);
    } catch (error) {
      throw new SeekError('usb/transfer-failed', `${what} failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  private async transferOut(
    request: number,
    data: Uint8Array,
    what: string,
  ): Promise<WebUsbOutTransferResult> {
    try {
      return await this.device.controlTransferOut(this.setupPacket(request), data);
    } catch (error) {
      throw new SeekError('usb/transfer-failed', `${what} failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

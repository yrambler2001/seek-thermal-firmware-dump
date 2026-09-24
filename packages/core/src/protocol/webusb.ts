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
  /**
   * `timeoutMs` is the transport's own deadline for this transfer, passed on
   * every call. WebUSB has no per-transfer timeout, so a browser's device (and
   * `asWebUsbDevice` in the web app) ignores it and the transport's own timer
   * is the only deadline. A host stack WITH a per-transfer timeout must apply
   * it: the CLI's `usb` 3.x shim takes it as this same third argument and
   * otherwise uses 1000 ms (node_modules/usb/dist/index.js:8, :22, :32), which
   * is how a 5 s read and a 20 s flash commit became 1 s ones (TESTING.md sec.11).
   */
  controlTransferIn(
    setup: WebUsbControlSetup,
    length: number,
    timeoutMs: number,
  ): Promise<WebUsbInTransferResult>;
  controlTransferOut(
    setup: WebUsbControlSetup,
    data: ArrayBufferView,
    timeoutMs: number,
  ): Promise<WebUsbOutTransferResult>;
}

/**
 * Which recipient to use. 'auto' claims interface 0, and falls back to
 * device-recipient requests only when the platform REFUSED the claim — the
 * interface held by another program or a kernel driver — which it reports
 * through `onWarning` AND `info.recipientFallback`, so a dump manifest records
 * it. The choice is made on the first open() and kept for the transport's
 * lifetime; see `open()`.
 */
export type RecipientPreference = Recipient | 'auto';

export interface WebUsbTransportOptions {
  readonly interfaceNumber?: number;
  readonly configurationValue?: number;
  readonly recipient?: RecipientPreference;
  /** Recorded in dump manifests, e.g. 'WebUSB' or 'node-usb 3.x (WebUSB shim)'. */
  readonly api?: string;
  readonly host?: string | null;
  /** Called once, when the platform refused the claim and 'auto' fell back to device recipient. */
  readonly onWarning?: (message: string) => void;
  /**
   * The clock the per-transfer deadlines are timed on. Omitted: `WALL_CLOCK`,
   * real time, which is what a real camera runs on and what every production
   * caller uses. See `DeadlineClock`.
   */
  readonly clock?: DeadlineClock;
}

/**
 * The clock a transport times its per-transfer deadlines on.
 *
 * A deadline means "the camera has had this long to answer". On a real camera
 * that is real time — the camera's clock and the host's run together — so the
 * default, `WALL_CLOCK`, is `setTimeout`, and nothing about production changes
 * with this interface.
 *
 * An EMULATED camera has no real time: its clock is the work the emulator has
 * retired, and on a loaded machine five seconds of real time are a fraction of a
 * second of the camera's. A deadline timed on the wall clock would then give up
 * after a load-dependent amount of the camera's time, and what the tool recorded
 * would depend on how busy the machine was (TESTING.md sec.19). The emulator
 * tests therefore pass a clock that moves only with the emulated camera's own
 * time, so "5 s" means five seconds of the camera's time on any machine.
 */
export interface DeadlineClock {
  /**
   * Calls `onExpire` once, when `ms` of this clock's time have passed since the
   * call. The returned function cancels it; calling it after expiry is harmless.
   */
  startTimer(ms: number, onExpire: () => void): () => void;
}

/** Real time. The default clock, and the one every real camera is timed on. */
export const WALL_CLOCK: DeadlineClock = {
  startTimer(ms: number, onExpire: () => void): () => void {
    const timer = setTimeout(onExpire, ms);
    return () => {
      clearTimeout(timer);
    };
  },
};

/**
 * True when claimInterface() failed because the PLATFORM would not give this
 * program the interface — the one failure device recipient is the right answer to.
 *
 * WebUSB names that failure: claimInterface performs "the necessary
 * platform-specific steps to request exclusive control over" the interface, and
 * "if the platform-specific steps above failed, reject promise with a
 * NetworkError" (WICG WebUSB, `claimInterface` method steps). Its other
 * rejections are something else: InvalidStateError for a device not opened or
 * not configured, NotFoundError for an interface that does not exist,
 * SecurityError for a protected class. A disconnect is not "someone else holds
 * it" either.
 *
 * Why falling back is right for that one failure and no other: the claim is
 * host-side only, no packet is sent (TESTING.md sec.9.9); a device-recipient
 * control request needs no claimed interface on either host (WebUSB's "check
 * the validity of the control transfer parameters" asks for a claim only for
 * the interface and endpoint recipients; node-usb-rs sends a device-recipient
 * request on the device handle, off Windows); and every Seek firmware's vendor
 * handler checks only the request type and `wIndex == 0`, never the recipient
 * bits, so `0xC0/0x40` with wIndex 0 is the same request to the camera as
 * `0xC1/0x41` to interface 0 (sec.9.9, all eleven FW-V1 `usb_core.c`
 * reconstructions). The CLI's adapter maps nusb's two "held by someone else"
 * claim errors onto this same name.
 */
export function isPlatformClaimRefusal(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'NetworkError'
  );
}

/**
 * WebUSB has no timeout of its own: a camera that simply does not answer leaves
 * the transfer pending forever, which shows up as a frozen dump with no error
 * and no retry. Racing a timer turns that into an ordinary failure the retry
 * path can reopen and recover from. The timer runs on `clock` (real time
 * unless a caller says otherwise; see `DeadlineClock`).
 */
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  what: string,
  clock: DeadlineClock = WALL_CLOCK,
): Promise<T> {
  let cancel: (() => void) | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    cancel = clock.startTimer(ms, () => {
      reject(new SeekError('usb/timeout', `${what} did not answer within ${String(ms)} ms`));
    });
  });
  return Promise.race([promise, timeout]).finally(() => {
    cancel?.();
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
  private readonly clock: DeadlineClock;

  private recipient: Recipient;
  private claimed = false;
  private opened = false;
  /**
   * The recipient this transport settled on at its FIRST successful open(),
   * and why, if it had to fall back. Null until then. Never re-decided: a
   * dump reopens between failed windows, and deciding again there is how one
   * dump could switch recipient half way through (TESTING.md sec.9.9).
   */
  private decision: { readonly recipient: Recipient; readonly fallback: string | null } | null =
    null;

  constructor(device: WebUsbDevice, options: WebUsbTransportOptions = {}) {
    this.device = device;
    this.interfaceNumber = options.interfaceNumber ?? INTERFACE_NUMBER;
    this.configurationValue = options.configurationValue ?? CONFIGURATION_VALUE;
    this.preference = options.recipient ?? 'auto';
    this.api = options.api ?? 'WebUSB';
    this.host = options.host ?? null;
    this.onWarning = options.onWarning;
    this.clock = options.clock ?? WALL_CLOCK;
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
      recipientFallback: this.decision?.fallback ?? null,
    };
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /**
   * Opens the device, selects the configuration, and claims the interface.
   *
   * THE RECIPIENT IS DECIDED ONCE. The first open() settles it; every later
   * open() — `runDump` reopens between attempts at a failed window — keeps it:
   *
   *   - settled on interface: the interface must be claimed again, and a claim
   *     that fails now is an error. Switching to device recipient part-way
   *     would leave one dump read over two different paths.
   *   - settled on device (a fallback, or `recipient: 'device'`): no claim is
   *     attempted, so the path cannot flip back either.
   *
   * With 'auto', only `isPlatformClaimRefusal` falls back, and it is never
   * silent: `onWarning` is called and `info.recipientFallback` carries the
   * reason from then on, which the workflows log and the manifest records.
   */
  async open(): Promise<void> {
    if (this.opened) return;
    const dev = this.device;
    if (!dev.opened) await dev.open();
    if (dev.configuration?.configurationValue !== this.configurationValue) {
      await dev.selectConfiguration(this.configurationValue);
    }

    this.claimed = false;

    if (this.preference === 'device' || this.decision?.recipient === 'device') {
      this.decision ??= { recipient: 'device', fallback: null };
      this.recipient = 'device';
      this.opened = true;
      return;
    }

    try {
      await dev.claimInterface(this.interfaceNumber);
      this.claimed = true;
      this.decision ??= { recipient: 'interface', fallback: null };
      this.recipient = 'interface';
    } catch (error) {
      const which = `USB interface ${String(this.interfaceNumber)}`;
      if (this.preference === 'interface') {
        throw new SeekError(
          'usb/not-open',
          `could not claim ${which}: ${errorMessage(error)} — another program or a system ` +
            `driver is holding the camera. See the platform notes for how to release it.`,
          { cause: error },
        );
      }
      if (this.decision !== null) {
        throw new SeekError(
          'usb/not-open',
          `could not claim ${which} again after reopening: ${errorMessage(error)}. This ` +
            'session has addressed the interface since it opened, and it does not switch ' +
            'recipient part-way through a run.',
          { cause: error },
        );
      }
      if (!isPlatformClaimRefusal(error)) {
        throw new SeekError(
          'usb/not-open',
          `could not claim ${which}: ${errorMessage(error)}. Only a claim the host refused ` +
            'because another program or a system driver holds the interface falls back to ' +
            'device recipient; this failure is not that one, so nothing was sent.',
          { cause: error },
        );
      }
      const fallback =
        `could not claim interface ${String(this.interfaceNumber)} (${errorMessage(error)}): ` +
        'another program or a system driver holds it, so every request goes to the device ' +
        'instead (recipient=device, wIndex 0), which the camera answers the same way';
      this.decision = { recipient: 'device', fallback };
      this.recipient = 'device';
      this.onWarning?.(fallback);
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
    const result = await withTimeout(
      this.transferIn(request, length, timeoutMs, what),
      timeoutMs,
      what,
      this.clock,
    );
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
    const result = await withTimeout(
      this.transferOut(request, data, timeoutMs, what),
      timeoutMs,
      what,
      this.clock,
    );
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

  /* A host adapter that has already classified its failure (the CLI's maps
   * nusb's own deadline to `usb/timeout`) throws a SeekError, and it is passed
   * through; anything else a device throws is a transfer failure. */
  private async transferIn(
    request: number,
    length: number,
    timeoutMs: number,
    what: string,
  ): Promise<WebUsbInTransferResult> {
    try {
      return await this.device.controlTransferIn(this.setupPacket(request), length, timeoutMs);
    } catch (error) {
      if (error instanceof SeekError) throw error;
      throw new SeekError('usb/transfer-failed', `${what} failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  private async transferOut(
    request: number,
    data: Uint8Array,
    timeoutMs: number,
    what: string,
  ): Promise<WebUsbOutTransferResult> {
    try {
      return await this.device.controlTransferOut(this.setupPacket(request), data, timeoutMs);
    } catch (error) {
      if (error instanceof SeekError) throw error;
      throw new SeekError('usb/transfer-failed', `${what} failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
  }
}

/**
 * An emulated Seek camera behind the `UsbTransport` boundary.
 *
 * It exists so protocol and workflow tests can exercise the awkward real-device
 * behaviours that the code was written for. Every quirk is opt-in, so a test
 * states exactly the camera it is describing:
 *
 *   fakeCamera()                                   an ideal camera
 *   fakeCamera({ requireMode0: true })             4.9.x: window commands need mode 0
 *   fakeCamera({ modeSettleMs: 120 })              leaving imaging mode takes time
 *   fakeCamera({ maxChunk: 48 })                   never serves a full request
 *   fakeCamera({ stallAt: [{ subcmd: 5, offset: 0xff00, minSize: 128 }] })
 *                                                  one request that only small reads get past
 *   fakeCamera({ stallAt: [{ subcmd: 5, offset: 0x8000 }] })
 *                                                  one request nothing gets past
 *   fakeCamera({ authBanks: [3, 5], authToken })   protected banks need the 18-byte selector
 *
 * Usage:
 *
 *   const camera = fakeCamera({ requireMode0: true });
 *   await camera.open();
 *   const dev = new SeekDevice(camera);
 *   const window = await dev.readWindow({ subcmd: 5, address: 0x14030000, note: '' });
 *
 * Defaults: 4 MiB of deterministic pattern flash, selector `s` exposing the
 * 64 KiB block at `s * 0x10000`, operation mode 1, no stalls, no auth banks.
 */

import { ERR_BAD_CHECKSUM, OP, WINDOW_SIZE } from '../src/protocol/ops.js';
import { SeekError } from '../src/errors.js';
import type { DeviceDescription, TransportInfo, UsbTransport } from '../src/protocol/transport.js';

/** Status words the fake reports through GetErrorCode. Only BAD_CHECKSUM is a
 *  real firmware value; the rest are distinct stand-ins for a real camera's. */
export const FAKE_ERR = {
  NONE: 0,
  /** A window command arrived while the camera was still imaging. */
  MODE: 0x10000,
  /** A protected bank was selected with the plain 2-byte payload. */
  AUTH: 0x20000,
  /** No selector maps to this subcommand. */
  BAD_SELECTOR: 0x30000,
  /** Staging or reading without an armed window. */
  NOT_ARMED: 0x40000,
  /** More bytes staged than the window holds. */
  OVERFLOW: 0x50000,
  BAD_CHECKSUM: ERR_BAD_CHECKSUM,
} as const;

/** One BeginFirmwareUpgrade selector. */
export interface FakeWindowSpec {
  readonly subcmd: number;
  /** Byte offset into the emulated flash that this selector exposes. */
  readonly offset: number;
  /** Window length. Defaults to 64 KiB. */
  readonly size?: number;
}

/**
 * A request the camera simply never answers.
 *
 * Matched on the armed selector and the current window offset. `minSize` models
 * the 4.9.x PIR324 behaviour the adaptive read exists for: requests of at least
 * that many bytes hang, while smaller ones return the same bytes fine. Omit it
 * for a request that no size can get past.
 */
export interface StallPoint {
  readonly subcmd: number;
  readonly offset: number;
  readonly minSize?: number;
}

export interface FakeCameraOptions {
  /** Backing store. Defaults to `patternFlash(flashSize)`. */
  readonly flash?: Uint8Array;
  /** Size of the default backing store. Defaults to 4 MiB. */
  readonly flashSize?: number;
  /** Selector map. Defaults to subcommand `s` -> flash offset `s * 0x10000`. */
  readonly windows?: readonly FakeWindowSpec[];
  /** Refuse window commands until SetOperationMode(0). Off by default. */
  readonly requireMode0?: boolean;
  /** Operation mode the camera starts in. Defaults to 1 (imaging). */
  readonly initialMode?: number;
  /** How long a mode change takes to read back. Defaults to 0. */
  readonly modeSettleMs?: number;
  /** Requests that never answer. */
  readonly stallAt?: readonly StallPoint[];
  /** How long a stalled request takes to fail. Defaults to 0 so tests stay fast;
   *  a real camera would hang until the transport's own timeout fired. */
  readonly stallDelayMs?: number;
  /** Serve at most this many bytes per request, so short chunks are exercised. */
  readonly maxChunk?: number;
  /** Selectors that reject the plain 2-byte payload and need the 18-byte one. */
  readonly authBanks?: readonly number[];
  /** The 16-byte token bytes 2..17 of an authenticated selector must carry. */
  readonly authToken?: Uint8Array;
  /** GetFirmwareInfo payloads, by SetFirmwareInfoFeatures selector. */
  readonly fwInfo?: ReadonlyMap<number, Uint8Array>;
  /** The RAM block SetRamDataFeatures(0) arms, e.g. the device-id block. */
  readonly ramData?: Uint8Array;
  readonly description?: Partial<DeviceDescription>;
}

/** Deterministic non-repeating fill, so a test can assert exact bytes. */
export function patternFlash(size: number, seed = 0x12345678): Uint8Array {
  const out = new Uint8Array(size);
  let state = seed >>> 0;
  for (let i = 0; i < size; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

function u16le(bytes: Uint8Array): number {
  return (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Turns a synchronous handler into a transfer: a throw becomes a rejection,
 *  exactly as a real transport reports a stall or a timeout. */
function asTransfer<T>(handler: () => T | Promise<T>): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(handler());
  });
}

interface ArmedWindow {
  readonly subcmd: number | null;
  readonly source: Uint8Array;
  /** Flash offset to commit staged bytes to, or null for a read-only window. */
  readonly commitAt: number | null;
}

/** One vendor request, recorded so a test can assert what was (not) sent. */
export interface FakeCall {
  readonly direction: 'in' | 'out';
  readonly op: number;
  readonly length: number;
}

export class FakeCamera implements UsbTransport {
  readonly flash: Uint8Array;
  /** Every vendor request in order. A read-only run must never contain a write op. */
  readonly calls: FakeCall[] = [];
  /**
   * The subcommand of every BeginFirmwareUpgrade received, in order, whether
   * or not it armed. `calls` says an arm went out; this says which selector.
   */
  readonly arms: number[] = [];

  private readonly windows = new Map<number, FakeWindowSpec>();
  private readonly options: FakeCameraOptions;
  private readonly authBanks: ReadonlySet<number>;
  private readonly descriptionValue: DeviceDescription;

  private opened = false;
  private mode: number;
  private modeTarget: number | null = null;
  private modeReadyAt = 0;

  private armed: ArmedWindow | null = null;
  private windowOffset = 0;
  private staged: number[] = [];
  private infoSelector: number | null = null;

  /** Last status word, as GetErrorCode would report it. */
  errorCode = 0;

  constructor(options: FakeCameraOptions = {}) {
    this.options = options;
    this.flash = options.flash ?? patternFlash(options.flashSize ?? 4 * 1024 * 1024);
    this.mode = options.initialMode ?? 1;
    this.authBanks = new Set(options.authBanks ?? []);

    const specs =
      options.windows ??
      Array.from({ length: Math.ceil(this.flash.length / WINDOW_SIZE) }, (_unused, subcmd) => ({
        subcmd,
        offset: subcmd * WINDOW_SIZE,
      }));
    for (const spec of specs) this.windows.set(spec.subcmd, spec);

    this.descriptionValue = {
      vendorId: 0x289d,
      productId: 0x0011,
      productName: 'Seek Thermal Compact PRO',
      manufacturerName: 'Seek Thermal',
      serialNumber: null,
      ...options.description,
    };
  }

  get description(): DeviceDescription {
    return this.descriptionValue;
  }

  get info(): TransportInfo {
    return {
      api: 'fake',
      recipient: 'interface',
      interfaceNumber: 0,
      claimedInterface: true,
      host: null,
      recipientFallback: null,
    };
  }

  get isOpen(): boolean {
    return this.opened;
  }

  /** The selector currently armed, or null. */
  get armedSubcmd(): number | null {
    return this.armed?.subcmd ?? null;
  }

  /** Bytes staged since the window was armed and not yet committed. */
  get stagedBytes(): number {
    return this.staged.length;
  }

  /** The operation mode a GetOperationMode would report right now. */
  get operationMode(): number {
    return this.currentMode();
  }

  open(): Promise<void> {
    this.opened = true;
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.opened = false;
    return Promise.resolve();
  }

  controlIn(request: number, length: number, _timeoutMs: number): Promise<Uint8Array> {
    return asTransfer(() => this.handleIn(request, length));
  }

  controlOut(request: number, data: Uint8Array, _timeoutMs: number): Promise<void> {
    return asTransfer(() => {
      this.handleOut(request, data);
    });
  }

  /* ---- internals ---------------------------------------------------- */

  private handleIn(request: number, length: number): Uint8Array | Promise<Uint8Array> {
    this.assertOpen();
    this.calls.push({ direction: 'in', op: request, length });
    switch (request) {
      case OP.GET_ERROR_CODE: {
        const out = new Uint8Array(4);
        new DataView(out.buffer).setUint32(0, this.errorCode >>> 0, true);
        return out.subarray(0, Math.min(length, 4));
      }
      case OP.GET_OPERATION_MODE: {
        const out = new Uint8Array(2);
        new DataView(out.buffer).setUint16(0, this.currentMode() & 0xffff, true);
        return out.subarray(0, Math.min(length, 2));
      }
      case OP.GET_FEATURED_FIRMWARE_DATA:
      case OP.GET_FEATURED_DATA:
        /* Both reader rows answer the same window: the 0.7.x builds register
         * the read handler in 0x58's getter (and 0x4F's setter), and a device
         * pointed at them by `legacyReaderOp` asks 0x58 (doc 36.5.0). */
        return this.readArmedWindow(length);
      case OP.GET_FIRMWARE_INFO: {
        /* SELECTOR 0 IS THE DEFAULT, not "no selector". This used to stall an
         * unarmed read, which is not what a camera does: after a reset the
         * selector is 0 and 0 is the build block. Measured over USB/IP against
         * five emulated builds — 0.3.0.1, 1.3.0.8, 4.18.2.0, 10.9.1.31 and
         * 42.32.3.10 — each of which answered an unarmed GetFirmwareInfo with
         * 36 bytes beginning 00 03 00 01, 01 03 00 08, 04 12 02 00, 0A 09 01 1F
         * and 2A 20 03 0A: its own version, then its own build date. The
         * capability probe reads exactly that, so the fake has to model it. */
        const sel = this.infoSelector ?? 0;
        this.infoSelector = null; /* the handler clears it after every read */
        const payload = this.options.fwInfo?.get(sel);
        if (payload === undefined) throw this.stall(request);
        return payload.subarray(0, Math.min(length, payload.length));
      }
      default:
        throw this.stall(request);
    }
  }

  private handleOut(request: number, data: Uint8Array): void {
    this.assertOpen();
    this.calls.push({ direction: 'out', op: request, length: data.length });
    switch (request) {
      case OP.SET_OPERATION_MODE:
        this.setMode(u16le(data));
        this.errorCode = FAKE_ERR.NONE;
        return;
      case OP.BEGIN_FIRMWARE_UPGRADE:
        this.beginFirmwareUpgrade(data);
        return;
      case OP.SET_FEATURED_FIRMWARE_DATA:
        this.stage(data);
        return;
      case OP.COMPLETE_MEMORY_UPGRADE:
        this.commit(u16le(data));
        return;
      case OP.SET_FIRMWARE_INFO_FEATURES: {
        const sel = u16le(data);
        if (this.options.fwInfo?.has(sel) === true) {
          this.infoSelector = sel;
          this.errorCode = FAKE_ERR.NONE;
        } else {
          this.infoSelector = null;
          this.errorCode = FAKE_ERR.BAD_SELECTOR;
        }
        return;
      }
      case OP.SET_RAM_DATA_FEATURES: {
        const ram = this.options.ramData;
        if (ram === undefined) {
          this.errorCode = FAKE_ERR.BAD_SELECTOR;
          return;
        }
        this.armed = { subcmd: null, source: ram, commitAt: null };
        this.windowOffset = 0;
        this.staged = [];
        this.errorCode = FAKE_ERR.NONE;
        return;
      }
      default:
        throw this.stall(request);
    }
  }

  private assertOpen(): void {
    if (!this.opened) throw new SeekError('usb/not-open', 'fake camera is not open');
  }

  private stall(request: number): SeekError {
    return new SeekError('usb/stalled', `control 0x${request.toString(16)} -> stall`);
  }

  private currentMode(): number {
    if (this.modeTarget !== null && Date.now() >= this.modeReadyAt) {
      this.mode = this.modeTarget;
      this.modeTarget = null;
    }
    return this.mode;
  }

  private setMode(mode: number): void {
    const settle = this.options.modeSettleMs ?? 0;
    if (settle <= 0) {
      this.mode = mode;
      this.modeTarget = null;
      return;
    }
    this.modeTarget = mode;
    this.modeReadyAt = Date.now() + settle;
  }

  private beginFirmwareUpgrade(data: Uint8Array): void {
    const subcmd = u16le(data);
    this.arms.push(subcmd);
    this.armed = null;
    this.windowOffset = 0;
    this.staged = [];

    if (this.options.requireMode0 === true && this.currentMode() !== 0) {
      this.errorCode = FAKE_ERR.MODE;
      return;
    }
    const spec = this.windows.get(subcmd);
    if (spec === undefined) {
      this.errorCode = FAKE_ERR.BAD_SELECTOR;
      return;
    }
    if (this.authBanks.has(subcmd) && !this.tokenMatches(data)) {
      this.errorCode = FAKE_ERR.AUTH;
      return;
    }

    const size = spec.size ?? WINDOW_SIZE;
    this.armed = {
      subcmd,
      source: this.flash.subarray(spec.offset, spec.offset + size),
      commitAt: spec.offset,
    };
    this.errorCode = FAKE_ERR.NONE;
  }

  private tokenMatches(data: Uint8Array): boolean {
    const token = this.options.authToken;
    if (token === undefined) return data.length >= 18;
    if (data.length < 2 + token.length) return false;
    for (let i = 0; i < token.length; i++) {
      if (data[2 + i] !== token[i]) return false;
    }
    return true;
  }

  private async readArmedWindow(length: number): Promise<Uint8Array> {
    const armed = this.armed;
    if (armed === null) throw this.stall(OP.GET_FEATURED_FIRMWARE_DATA);

    const stall = this.matchStall(armed.subcmd, this.windowOffset, length);
    if (stall !== null) {
      const delay = this.options.stallDelayMs ?? 0;
      if (delay > 0) await sleep(delay);
      throw new SeekError(
        'usb/timeout',
        `control IN 0x${OP.GET_FEATURED_FIRMWARE_DATA.toString(16)} did not answer`,
      );
    }

    const remaining = armed.source.length - this.windowOffset;
    if (remaining <= 0) return new Uint8Array(0);
    const want = Math.min(length, remaining, this.options.maxChunk ?? length);
    const out = armed.source.slice(this.windowOffset, this.windowOffset + want);
    this.windowOffset += want;
    return out;
  }

  private matchStall(subcmd: number | null, offset: number, length: number): StallPoint | null {
    for (const point of this.options.stallAt ?? []) {
      if (point.subcmd !== subcmd || point.offset !== offset) continue;
      if (point.minSize !== undefined && length < point.minSize) continue;
      return point;
    }
    return null;
  }

  private stage(data: Uint8Array): void {
    const armed = this.armed;
    /* Both staging failures a real camera reports are sticky: nothing re-arms
     * the window, so every later chunk reports not-armed too. */
    if (armed?.commitAt == null) {
      this.errorCode = FAKE_ERR.NOT_ARMED;
      return;
    }
    if (this.staged.length + data.length > armed.source.length) {
      this.armed = null;
      this.errorCode = FAKE_ERR.OVERFLOW;
      return;
    }
    for (const byte of data) this.staged.push(byte);
  }

  private commit(sum16: number): void {
    const armed = this.armed;
    if (armed?.commitAt == null) {
      this.errorCode = FAKE_ERR.NOT_ARMED;
      return;
    }
    let sum = 0;
    for (const byte of this.staged) sum = (sum + byte) & 0xffff;
    if (sum !== (sum16 & 0xffff)) {
      /* Checked before anything is erased, so the flash is untouched. */
      this.errorCode = FAKE_ERR.BAD_CHECKSUM;
      return;
    }
    this.flash.set(Uint8Array.from(this.staged), armed.commitAt);
    this.staged = [];
    this.armed = null;
    this.errorCode = FAKE_ERR.NONE;
  }
}

/** One-line construction: `const camera = fakeCamera({ requireMode0: true })`. */
export function fakeCamera(options: FakeCameraOptions = {}): FakeCamera {
  return new FakeCamera(options);
}

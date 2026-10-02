/**
 * The protocol object every workflow talks to.
 *
 * This layer is deliberately thin: it knows how the camera answers, and nothing
 * about what any particular run is trying to achieve. Policy — which windows to
 * read, whether a flash is safe, what to do with a short window — lives in the
 * workflows above it.
 */

import { asciiz, hex, viewOf } from '../bytes.js';
import { CancelledError, errorMessage, SeekError } from '../errors.js';
import { silentReporter, type Reporter } from '../events.js';
import type { WindowEntry } from '../profiles/types.js';
import {
  DEFAULT_READ_CHUNK,
  MAX_CONTROL_IN,
  MIN_READ_CHUNK,
  MODE_SETTLE_MS,
  OP,
  USB_COMMIT_TIMEOUT_MS,
  USB_PROBE_TIMEOUT_MS,
  USB_TIMEOUT_MS,
  WINDOW_SIZE,
} from './ops.js';
import type { UsbTransport } from './transport.js';
import { type DeadlineClock, WALL_CLOCK } from './webusb.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Little-endian u16, the payload shape of nearly every vendor OUT command. */
export function u16Payload(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value & 0xffff, true);
  return bytes;
}

/** Called with the size of each chunk as it arrives, for progress reporting. */
export type ChunkListener = (bytes: number) => void;

/**
 * The outcome of a sequential read.
 *
 * The original smuggled these fields onto the returned Uint8Array; they matter
 * because a caller has to be able to tell a complete window from a truncated one
 * and record exactly what is missing rather than silently gap-filling it.
 */
export interface ReadResult {
  readonly data: Uint8Array;
  /** Bytes actually read. Equals `data.length`. */
  readonly stoppedAt: number;
  /** Why the read ended early, or null when it read everything asked for. */
  readonly stopReason: string | null;
  /** The request size the read finished on. */
  readonly chunkUsed: number;
  /** True if the adaptive path had to shrink below the requested size. */
  readonly shrank: boolean;
}

export interface SeekDeviceOptions {
  readonly reporter?: Reporter;
  readonly signal?: AbortSignal;
}

export class SeekDevice {
  readonly transport: UsbTransport;
  readonly reporter: Reporter;
  readonly signal: AbortSignal | undefined;
  /**
   * The clock this device's own deadlines are checked on: its transport's
   * (`UsbTransport.clock`), else `WALL_CLOCK`. Real time for a real camera; the
   * emulated camera's time under the emulator suites (TESTING.md sec.19, 20).
   */
  readonly clock: DeadlineClock;
  /**
   * The wire id the WINDOW READER answers on for the connected build — the
   * opcode `readArmed` (and the preservation pipeline's drain, which rides the
   * same primitive) sends its data-stage asks to. The default is 0x4F
   * (`GetFeaturedFirmwareData`), right for every build from 0.8.0.0 on; the
   * 0.7.x builds serve the window through 0x58 instead (their table puts the
   * handler in 0x4F's setter column, and 0x4F stalls for every request length
   * — FW-V1 doc 36 sec. 36.5.0), so a caller that knows the version sets this
   * to `legacyReaderOp(version)` once per session, right after the version
   * read. Until it is set, a session simply speaks the 0.8+ shape — which is
   * why the steps that talk to a 0.7.x camera apply it BEFORE the first
   * window read, never after.
   */
  windowReadOp: number = OP.GET_FEATURED_FIRMWARE_DATA;

  constructor(transport: UsbTransport, options: SeekDeviceOptions = {}) {
    this.transport = transport;
    this.reporter = options.reporter ?? silentReporter;
    this.signal = options.signal;
    this.clock = transport.clock ?? WALL_CLOCK;
  }

  get cancelled(): boolean {
    return this.signal?.aborted ?? false;
  }

  /** Throws CancelledError if the caller's signal has fired. Checked at every
   *  loop boundary so a cancel lands within one control transfer. */
  assertNotCancelled(): void {
    if (this.signal?.aborted === true) throw new CancelledError();
  }

  /* ---- raw vendor RPC ---------------------------------------------- */

  rpcIn(op: number, length: number, timeoutMs: number = USB_TIMEOUT_MS): Promise<Uint8Array> {
    return this.transport.controlIn(op, length, timeoutMs);
  }

  rpcOut(op: number, payload: Uint8Array, timeoutMs: number = USB_TIMEOUT_MS): Promise<void> {
    return this.transport.controlOut(op, payload, timeoutMs);
  }

  /* ---- status and mode --------------------------------------------- */

  /** null when the camera answered with fewer than 4 bytes. */
  async getErrorCode(): Promise<number | null> {
    const raw = await this.rpcIn(OP.GET_ERROR_CODE, 4);
    if (raw.length < 4) return null;
    return viewOf(raw).getUint32(0, true) >>> 0;
  }

  /** null when the camera answered with fewer than 2 bytes. */
  async getOperationMode(): Promise<number | null> {
    const raw = await this.rpcIn(OP.GET_OPERATION_MODE, 2);
    if (raw.length < 2) return null;
    return viewOf(raw).getUint16(0, true);
  }

  async setOperationMode(mode: number): Promise<void> {
    await this.rpcOut(OP.SET_OPERATION_MODE, u16Payload(mode));
  }

  /**
   * Operation mode 0 is a hard precondition for the window commands on some
   * firmware. The RPC dispatch table carries two permission bits per command —
   * bit0 "allowed in mode 0", bit1 "allowed in mode 1" — and BeginFirmwareUpgrade
   * and GetFeaturedFirmwareData are 3 (both modes) on 4.18.x but 1 (mode 0 only)
   * on 4.9.x. A 4.9.x camera that is still imaging therefore refuses or ignores
   * the very first window command.
   *
   * Leaving imaging mode is not instant either — the camera has a sensor and a
   * shutter to park — so wait for mode 0 to actually read back instead of
   * assuming a fixed delay covers it.
   *
   * The wait is `MODE_SETTLE_MS` on `this.clock`: real time on a real camera
   * (`Date.now()`, as always), the camera's own time on the emulator, where a
   * loaded machine would otherwise give the camera less of it (TESTING.md sec.20).
   */
  async ensureMode0(): Promise<void> {
    let mode: number | null;
    try {
      mode = await this.getOperationMode();
    } catch (error) {
      throw new SeekError('device/mode', `GetOperationMode failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }
    if (mode === 0) return;

    try {
      await this.setOperationMode(0);
    } catch (error) {
      throw new SeekError('device/mode', `SetOperationMode(0) failed: ${errorMessage(error)}`, {
        cause: error,
      });
    }

    const deadline = this.clock.now() + MODE_SETTLE_MS;
    for (;;) {
      this.assertNotCancelled();
      await sleep(20);
      try {
        mode = await this.getOperationMode();
      } catch {
        mode = null; /* still not answering; keep waiting */
      }
      if (mode === 0) return;
      if (this.clock.now() > deadline) {
        throw new SeekError(
          'device/mode',
          `the camera did not enter operation mode 0 within ${String(MODE_SETTLE_MS / 1000)} s ` +
            `(it reports ${mode === null ? 'nothing' : hex(mode)}). Some firmware only accepts ` +
            `the flash-window commands in mode 0, so reading cannot start until it gets there`,
        );
      }
    }
  }

  /* ---- window arming and reading ----------------------------------- */

  /**
   * Put the device in mode 0 and point its read/write window at `entry`. The
   * window offset resets to 0 on every BeginFirmwareUpgrade, so reads after this
   * start at the base of the selected 64 KiB block and advance sequentially.
   */
  async armWindow(entry: WindowEntry): Promise<void> {
    const { subcmd, address } = entry;

    await this.ensureMode0();

    try {
      await this.rpcOut(OP.BEGIN_FIRMWARE_UPGRADE, entry.payload ?? u16Payload(subcmd));
      await sleep(20);
    } catch (error) {
      throw new SeekError(
        'device/window',
        `BeginFirmwareUpgrade(${hex(subcmd)}) failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let beginErr: number | null;
    try {
      beginErr = await this.getErrorCode();
    } catch (error) {
      throw new SeekError(
        'device/window',
        `GetErrorCode after BeginFirmwareUpgrade(${hex(subcmd)}) failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    if (beginErr) {
      throw new SeekError(
        'device/error-code',
        `BeginFirmwareUpgrade(${hex(subcmd)}) for ${hex(address, 8)} returned ${hex(beginErr)}`,
        { deviceCode: beginErr },
      );
    }
  }

  /**
   * Sequential read of `length` bytes from the window armed by armWindow().
   *
   * The request size adapts. Some cameras serve most of a window at 256 bytes a
   * time and then never answer one particular request — on a 4.9.x PIR324 the
   * last 256 bytes of every window behave that way, while the same bytes come
   * back fine in 64-byte requests. So a failed request is retried once at the
   * same size, then at progressively smaller ones, and whatever size works is
   * KEPT for the rest of the window. Shrinking only for the stuck request and
   * then going back to the big one just stalls again on the next.
   *
   * If a chunk still will not come at any size, the read stops and returns what
   * it has: 65280 good bytes are worth keeping, and the caller records exactly
   * what is missing. Throwing here would discard a whole 64 KiB window over one
   * bad request.
   */
  async readArmed(chunk: number, length: number, onChunk?: ChunkListener): Promise<ReadResult> {
    const raw = new Uint8Array(length);
    let got = 0;
    let stopReason: string | null = null;
    /* Never more than one EP0 packet per request (MAX_CONTROL_IN), then adapts
     * downward and stays there. */
    let size = Math.min(chunk, MAX_CONTROL_IN);
    let shrank = false;

    while (got < length) {
      this.assertNotCancelled();
      const remaining = length - got;
      let blk: Uint8Array | null = null;
      let lastError: unknown;

      for (let attempt = 0; ; attempt++) {
        try {
          blk = await this.rpcIn(
            this.windowReadOp,
            Math.min(size, remaining),
            attempt === 0 ? USB_TIMEOUT_MS : USB_PROBE_TIMEOUT_MS,
          );
          break;
        } catch (error) {
          lastError = error;
          this.assertNotCancelled();
          if (attempt === 0) {
            await sleep(50); /* once more at this size */
            continue;
          }
          if (size <= MIN_READ_CHUNK) break;
          size >>= 1;
          shrank = true;
          await sleep(50);
        }
      }

      if (blk === null) {
        stopReason =
          `window read (op ${hex(this.windowReadOp)}) stopped at offset ${hex(got, 4)} even at ` +
          `${String(size)}-byte requests: ${errorMessage(lastError)}`;
        break;
      }
      if (blk.length === 0) {
        stopReason = `device returned no more data at offset ${hex(got, 4)}`;
        break;
      }
      raw.set(blk, got);
      got += blk.length;
      onChunk?.(blk.length);
      if (blk.length < Math.min(size, remaining)) {
        stopReason = `short chunk at offset ${hex(got, 4)}`;
        break;
      }
    }

    return {
      data: raw.subarray(0, got),
      stoppedAt: got,
      stopReason: got < length ? stopReason : null,
      chunkUsed: size,
      shrank,
    };
  }

  /** Arm `entry` and read its whole 64 KiB window. */
  async readWindow(
    entry: WindowEntry,
    chunk: number = DEFAULT_READ_CHUNK,
    onChunk?: ChunkListener,
  ): Promise<ReadResult> {
    const { subcmd, address } = entry;
    await this.armWindow(entry);
    const got = await this.readArmed(chunk, WINDOW_SIZE, onChunk);

    /* Nothing at all means the window is genuinely unreadable — worth a full
     * retry. A short read is not: the bytes we have are good, and re-reading the
     * window from the start would only lose them again. */
    if (got.data.length === 0) {
      throw new SeekError(
        'device/window',
        `read ${hex(address, 8)} subcmd ${hex(subcmd)} returned nothing` +
          (got.stopReason === null ? '' : ` (${got.stopReason})`),
      );
    }

    let readErr: number | null = null;
    try {
      readErr = await this.getErrorCode();
    } catch (error) {
      /* The status read can time out on a camera that just stopped answering;
       * on a short window that must not cost us the bytes we already have. */
      if (got.data.length === WINDOW_SIZE) {
        throw new SeekError(
          'device/window',
          `GetErrorCode after reading ${hex(address, 8)} failed: ${errorMessage(error)}`,
          { cause: error },
        );
      }
    }
    if (readErr && got.data.length === WINDOW_SIZE) {
      throw new SeekError(
        'device/error-code',
        `read ${hex(address, 8)} subcmd ${hex(subcmd)} returned ${hex(readErr)} after ` +
          `${String(got.data.length)} B`,
        { deviceCode: readErr },
      );
    }

    return got;
  }

  /* ---- firmware info ------------------------------------------------ */

  /** SetFirmwareInfoFeatures(sel) then GetFirmwareInfo. The handler clears the
   *  selector after every read, so it has to be set each time. */
  async readFwInfo(sel: number, length: number): Promise<Uint8Array> {
    await this.rpcOut(OP.SET_FIRMWARE_INFO_FEATURES, u16Payload(sel));
    await sleep(10);
    const selErr = await this.getErrorCode();
    if (selErr) {
      throw new SeekError(
        'device/error-code',
        `SetFirmwareInfoFeatures(${String(sel)}) returned ${hex(selErr)}`,
        { deviceCode: selErr },
      );
    }
    const raw = await this.rpcIn(OP.GET_FIRMWARE_INFO, length);
    const readErr = await this.getErrorCode();
    if (readErr) {
      throw new SeekError(
        'device/error-code',
        `GetFirmwareInfo(${String(sel)}) returned ${hex(readErr)}`,
        { deviceCode: readErr },
      );
    }
    return raw;
  }

  /** Never throws — every one of these is a nice-to-have, and a camera running
   *  older or reconstructed firmware may stall on any single selector. */
  async tryFwInfo(sel: number, length: number, label: string): Promise<Uint8Array | null> {
    try {
      return await this.readFwInfo(sel, length);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      this.reporter.log(`  ${label}: unavailable (${errorMessage(error)})`, 'detail');
      return null;
    }
  }

  /** The device-id block lives in RAM, not flash, so this arms it through
   *  SetRamDataFeatures and then reads it with the ordinary sequential read. */
  async readSerial(): Promise<string | null> {
    try {
      const payload = new Uint8Array(6);
      const view = new DataView(payload.buffer);
      view.setUint16(0, 0, true); /* case 0: device-id block */
      view.setUint16(2, 124, true);
      await this.rpcOut(OP.SET_RAM_DATA_FEATURES, payload);
      await sleep(10);
      const err = await this.getErrorCode();
      if (err) {
        throw new SeekError('device/error-code', `returned ${hex(err)}`, { deviceCode: err });
      }
      const block = await this.readArmed(DEFAULT_READ_CHUNK, 248);
      if (block.data.length < 28) {
        throw new SeekError('device/window', `short read (${String(block.data.length)} B)`);
      }
      return asciiz(block.data.subarray(16, 28));
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      this.reporter.log(`  serial: unavailable (${errorMessage(error)})`, 'detail');
      return null;
    }
  }

  /* ---- write primitives ---------------------------------------------
   *
   * The opcodes live here so there is one place that speaks to the camera, but
   * no flashing policy does: what to stage, when a commit is safe and what a
   * failure means to the image on the device are all decisions for the flash
   * workflow.
   * ------------------------------------------------------------------- */

  /** Stage one chunk into the armed upgrade window. Chunks longer than EP0_BUF
   *  are truncated by the device's 64-byte EP0 buffer. */
  async setFeaturedFirmwareData(data: Uint8Array): Promise<void> {
    await this.rpcOut(OP.SET_FEATURED_FIRMWARE_DATA, data);
  }

  /** Commit the staged payload. The erase, program and verify all run inside
   *  this one transfer, hence the much longer timeout. */
  async completeMemoryUpgrade(
    sum16: number,
    timeoutMs: number = USB_COMMIT_TIMEOUT_MS,
  ): Promise<void> {
    await this.rpcOut(OP.COMPLETE_MEMORY_UPGRADE, u16Payload(sum16), timeoutMs);
  }
}

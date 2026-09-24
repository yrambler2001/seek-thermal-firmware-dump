/**
 * The full-flash preservation pipeline for the v1 locked line (Compact
 * 1.0.0.0 / 1.2.0.0 / 1.3.0.0): read everything the camera can serve, patch
 * the booted bank IN PLACE, dump the whole part through the widened window,
 * put the original bank back — and prove, byte for byte, that the delivered
 * image is the camera's own flash content.
 *
 * The four phases, and what each one is allowed to touch:
 *
 *   P1  backup — the 31 stock windows (modes 3..9 with the 18-byte token,
 *       0x0A..0x21 plain), 64 KiB each, 0x14010000..0x141FFFFF. Read-only.
 *       Every window must come back complete: this is the copy the pipeline
 *       restores from, and a short one is refused, not gap-filled.
 *
 *   P2  in-place patch — read the 28-byte boot-config record (mode 3) and
 *       name the ACTIVE slot; capture that bank through its own window and
 *       verify it against the factory plaintext BEFORE anything is written;
 *       conjugate the plaintext patch into the ciphertext capture
 *       (`patch.ts`); stage IMAGE LENGTH ONLY in 64-byte chunks (the commit
 *       erases the whole 64 KiB block and programs exactly the staged bytes,
 *       and a full 64 KiB stage would overrun the descriptor's staging
 *       buffer); commit (0x51 with the u16 sum); wire-89 reset — the same
 *       session, the proven forge shape. NO bootcfg write, NO other-slot
 *       write: the part's only change is the enumerated patch bytes inside
 *       the one active bank.
 *
 *   P3  full dump — after the warm reset the camera boots the PATCHED image,
 *       whose mode-2 window now spans the whole 4 MiB part. A fresh session
 *       (the post-reset quirk: re-enumerate, probe once, then drain — retry
 *       once on a still-dead window and NEVER re-send the commit) drains the
 *       part at 512 B per call. The RAW dump equals the post-write part; the
 *       DELIVERED dump has the active bank's 64 KiB replaced from the P1
 *       backup, so it is the camera's original flash content, byte-clean.
 *
 *   P4  restore — commit the ORIGINAL bank content back over the same bank
 *       (the patched image still runs from SRAM, so the write is inert to the
 *       running code), reset, then re-read the 31 windows and compare every
 *       one against the P1 backup.
 *
 * ---- The honest risk -------------------------------------------------------
 *
 * P2 and P4 write the ACTIVE slot on whatever camera runs them. On real
 * hardware an interrupted write there has NO bootable fallback — the boot
 * loader's other slots name other banks, and the recovery slot is not written
 * by this pipeline. The pipeline mitigates what it can (P1's backup exists
 * before the first write; P4 puts the original back; the delivered dump is
 * post-processed to the original content), but a power loss mid-commit on
 * silicon is unrecoverable without an SPI programmer. The emulator's
 * copy-on-write overlay is a safety net real flash does not have.
 */

import { hexUp, sha256hex } from '../bytes.js';
import { errorMessage } from '../errors.js';
import type { Reporter } from '../events.js';
import type { SeekDevice } from '../protocol/client.js';
import { u16Payload } from '../protocol/client.js';
import { OP, EP0_BUF, USB_COMMIT_TIMEOUT_MS } from '../protocol/ops.js';
import { FLASH_SIZE } from '../profiles/modern-4x.js';
import { buildV1Patch, conjugateCapture, sum16, verifyCapture } from './patch.js';
import {
  BACKUP_WINDOW_COUNT,
  bankWindow,
  cfgWindow,
  parseBootConfig,
  preservationWindows,
  widenedWindow,
  BOOT_CONFIG_BYTES,
  WINDOW_BYTES,
  type BankKey,
  type SlotDetection,
} from './windows.js';

/** Wire-79 drain unit. The reader serves at most 512 B per call. */
export const READ_CHUNK = 512;
/** Wire-80 staging unit: the device's EP0 buffer truncates longer chunks. */
export const STAGE_CHUNK = EP0_BUF;
/** Per-read retries before a drain fails (the bench contract: fail loudly). */
export const DRAIN_RETRIES = 5;

/** ResetDevice (0x59). Payload u16 0 = plain reset; a NON-zero value arms the
 *  TIMER1 exploit path, which this pipeline must never send. */
export const RESET_OP = 0x59;

/** How far past the stock 16-bit cursor wrap the patch-live probe reads. */
export const PROBE_OFFSET = 0x21000;

/** The reset payload this pipeline sends: u16 0, never the TIMER1 arm. */
export function resetOpPayload(): Uint8Array {
  return u16Payload(0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Thrown when a commit LANDED but the post-reset read window died (the doc 33
 * sec. 11.6 same-server wedge). The commit is never replayed; the caller
 * retries the READ side against a fresh session — on the emulator, a fresh
 * server booted from the committed state.
 */
export class PostResetWedgeError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(message: string, detail: Record<string, unknown>) {
    super(message);
    this.name = 'PostResetWedgeError';
    this.detail = detail;
  }
}

/* ==================================================================== *
 * P1 — the 31-window backup (read-only)
 * ==================================================================== */

export interface WindowBytes {
  readonly mode: number;
  readonly address: number;
  readonly bytes: Uint8Array;
}

export interface BackupResult {
  readonly windows: readonly WindowBytes[];
  /** Window bytes keyed by flash address. */
  readonly byAddress: ReadonlyMap<number, Uint8Array>;
  readonly bytes: number;
}

/**
 * Read all 31 stock windows, each one complete. Read-only.
 */
export async function backupWindows(
  device: SeekDevice,
  reporter: Reporter,
  chunk: number = READ_CHUNK,
): Promise<BackupResult> {
  const windows = preservationWindows();
  const out: WindowBytes[] = [];
  const byAddress = new Map<number, Uint8Array>();
  let index = 0;
  for (const entry of windows) {
    device.assertNotCancelled();
    reporter.progress(
      index,
      windows.length,
      `P1 backup window ${hexUp(entry.address, 8)}`,
      'items',
    );
    await device.armWindow(entry);
    const read = await device.readArmed(chunk, WINDOW_BYTES);
    if (read.data.length !== WINDOW_BYTES) {
      const why = read.stopReason === null ? '' : ` (${read.stopReason})`;
      throw new Error(
        `P1: backup window ${hexUp(entry.address, 8)} came back ` +
          `${String(read.data.length)}/${String(WINDOW_BYTES)} B` +
          why +
          ' — the backup must be complete before anything is written',
      );
    }
    out.push({ mode: entry.subcmd, address: entry.address, bytes: read.data });
    byAddress.set(entry.address, read.data);
    index++;
  }
  reporter.progress(windows.length, windows.length, 'P1 backup complete', 'items');
  return { windows: out, byAddress, bytes: out.length * WINDOW_BYTES };
}

/* ==================================================================== *
 * P2 — detect, verify, conjugate, commit
 * ==================================================================== */

/**
 * Read the 28-byte boot-config record and name the active slot. Read-only.
 */
export async function detectActiveSlot(device: SeekDevice): Promise<SlotDetection> {
  await device.armWindow(cfgWindow());
  const block = await drainExact(device, BOOT_CONFIG_BYTES, 'boot-config read', {
    retries: 3,
    timeoutMs: 5000,
  });
  return parseBootConfig(block);
}

/**
 * The commit: arm the bank's window, stage `payload` in 64-byte chunks with
 * the status polled every chunk (both staging failures are sticky), then
 * CompleteMemoryUpgrade with the u16 transfer checksum. The erase/program/
 * verify chain runs INSIDE the commit transfer.
 */
export async function commitToBank(
  device: SeekDevice,
  bank: BankKey,
  payload: Uint8Array,
  options: { label: string; reporter: Reporter; commitTimeoutMs?: number },
): Promise<{ chunks: number; sum16: number; status: number; ms: number }> {
  const { label, reporter } = options;
  await device.armWindow(bankWindow(bank));

  const startedAt = Date.now();
  let done = 0;
  let chunks = 0;
  while (done < payload.length) {
    device.assertNotCancelled();
    const end = Math.min(done + STAGE_CHUNK, payload.length);
    await device.setFeaturedFirmwareData(payload.subarray(done, end));
    const status = await device.getErrorCode();
    if (status !== 0) {
      throw new Error(
        `${label}: the camera reported ` +
          `${status === null ? 'no status' : hexUp(status)} while staging at offset ` +
          `${hexUp(done)} — aborted before the commit`,
      );
    }
    done = end;
    chunks++;
    if ((chunks & 0xff) === 0) {
      reporter.progress(
        done,
        payload.length,
        `${label}: staged ${String(done)}/${String(payload.length)} B`,
      );
    }
  }
  const streamStatus = await device.getErrorCode();
  if (streamStatus !== 0) {
    const shown = streamStatus === null ? 'no status' : hexUp(streamStatus);
    throw new Error(`${label}: the staging stream ended with ${shown}`);
  }

  const checksum = sum16(payload);
  reporter.log(`${label}: committing, sum16 ${hexUp(checksum, 4)}`, 'detail');
  try {
    await device.completeMemoryUpgrade(checksum, options.commitTimeoutMs ?? USB_COMMIT_TIMEOUT_MS);
  } catch (error) {
    /* The flash work runs inside this transfer; a dropped transfer says
     * nothing about whether flash changed. The status read below decides. */
    reporter.log(`${label}: commit transfer did not complete (${errorMessage(error)})`, 'warn');
  }
  const status = await device.getErrorCode();
  const ms = Date.now() - startedAt;
  const shown = status === null ? 'unreadable' : hexUp(status);
  reporter.log(
    `${label}: ${String(chunks)} chunks staged, ${String(ms)} ms, commit status ${shown}`,
    status === 0 ? 'ok' : 'error',
  );
  if (status !== 0) {
    throw new Error(
      `${label}: CompleteMemoryUpgrade returned ` +
        `${status === null ? 'no status' : hexUp(status)} — flash may be partially written`,
    );
  }
  return { chunks, sum16: checksum, status, ms };
}

/** ResetDevice (0x59), payload u16 0. The transfer usually drops as the part
 *  resets; both outcomes are fine, and a non-zero payload is never sent. */
export async function resetDevice(device: SeekDevice): Promise<'sent' | 'dropped'> {
  try {
    await device.rpcOut(RESET_OP, u16Payload(0), 3000);
    return 'sent';
  } catch {
    return 'dropped';
  }
}

/** The version a running build reports (wire 0x4E), as `1.3.0.0`. */
export async function readVersion(device: SeekDevice): Promise<string> {
  const raw = await device.rpcIn(OP.GET_FIRMWARE_INFO, 64);
  return `${String(raw[0])}.${String(raw[1])}.${String(raw[2])}.${String(raw[3])}`;
}

/* ==================================================================== *
 * P3 — the full 4 MiB drain
 * ==================================================================== */

/**
 * Strict drain of exactly `bytes` through the armed window: every read is
 * retried, a short read fails loudly, and nothing is gap-filled.
 */
export async function drainExact(
  device: SeekDevice,
  bytes: number,
  label: string,
  options: {
    chunk?: number;
    retries?: number;
    timeoutMs?: number;
    onChunk?: (got: number) => void;
  } = {},
): Promise<Uint8Array> {
  const chunk = options.chunk ?? READ_CHUNK;
  const retries = options.retries ?? DRAIN_RETRIES;
  const timeoutMs = options.timeoutMs ?? 20000;
  const parts: Uint8Array[] = [];
  let got = 0;
  while (got < bytes) {
    device.assertNotCancelled();
    const want = Math.min(chunk, bytes - got);
    let blk: Uint8Array | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        blk = await device.rpcIn(OP.GET_FEATURED_FIRMWARE_DATA, want, timeoutMs);
        break;
      } catch (error) {
        blk = null;
        if (attempt === retries) {
          throw new Error(
            `${label}: wire-79 read failed at ${String(got)}/${String(bytes)} B after ` +
              `${String(retries + 1)} tries: ${errorMessage(error)}`,
            { cause: error },
          );
        }
        await sleep(500);
      }
    }
    if (blk === null || blk.length === 0) {
      throw new Error(`${label}: wire-79 returned no data at ${String(got)}/${String(bytes)} B`);
    }
    parts.push(blk);
    got += blk.length;
    options.onChunk?.(got);
  }
  const out = new Uint8Array(bytes);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * P3's drain: arm the PATCHED image's widened mode-2 window and read the
 * whole 4 MiB part at 512 B per call.
 */
export async function drainWholePart(
  device: SeekDevice,
  reporter: Reporter,
  options: { chunk?: number; timeoutMs?: number } = {},
): Promise<Uint8Array> {
  await device.armWindow(widenedWindow());
  const startedAt = Date.now();
  let last = 0;
  const data = await drainExact(device, FLASH_SIZE, 'P3 full dump', {
    chunk: options.chunk ?? READ_CHUNK,
    timeoutMs: options.timeoutMs ?? 20000,
    onChunk: (got) => {
      if (got - last >= 0x40000) {
        last = got;
        reporter.progress(got, FLASH_SIZE, `P3 full dump ${String(got)}/${String(FLASH_SIZE)} B`);
      }
    },
  });
  reporter.log(
    `P3 dump: ${String(data.length)} B in ${((Date.now() - startedAt) / 1000).toFixed(1)} s, ` +
      `sha256 ${await sha256hex(data)}`,
    'ok',
  );
  return data;
}

/**
 * The patch-live probe: read through window offset 0x21000 and compare with
 * `expected` (512 B from the P1 backup at flash offset 0x21000). The STOCK
 * 16-bit reader cursor wraps at 0x10000 and serves bootloader-block bytes
 * there; only the widened window returns the true bytes past it.
 */
export async function probeWidenedWindow(
  device: SeekDevice,
  expected: Uint8Array,
): Promise<{ live: boolean; detail: string }> {
  if (expected.length !== READ_CHUNK) {
    throw new Error(
      `probe reference must be ${String(READ_CHUNK)} B, got ${String(expected.length)}`,
    );
  }
  await device.armWindow(widenedWindow());
  await drainExact(device, PROBE_OFFSET - READ_CHUNK, 'patch probe', {
    retries: 2,
    timeoutMs: 10000,
  });
  const blk = await device.rpcIn(OP.GET_FEATURED_FIRMWARE_DATA, READ_CHUNK, 10000);
  if (blk.length !== READ_CHUNK) {
    return {
      live: false,
      detail:
        `read at window offset ${hexUp(PROBE_OFFSET - READ_CHUNK)} returned ` +
        `${String(blk.length)} B (the stock window shape)`,
    };
  }
  for (let i = 0; i < READ_CHUNK; i++) {
    if (blk[i] !== expected[i]) {
      return {
        live: false,
        detail: 'bytes past 0x10000 do not match the reference (the cursor is still wrapping)',
      };
    }
  }
  return { live: true, detail: 'bytes past 0x10000 match the reference (widened window live)' };
}

/**
 * The probe's 512-byte expectation, cut from the P1 backup at flash offset
 * `start`. The backup is window-addressed, so a slice that crosses a window
 * boundary is assembled from its parts.
 */
export function backupSlice(backup: BackupResult, start: number, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  while (at < length) {
    const flashOffset = start + at;
    const windowBase = Math.floor(flashOffset / WINDOW_BYTES) * WINDOW_BYTES;
    const bytes = backup.byAddress.get(0x14000000 + windowBase);
    if (bytes === undefined) {
      throw new Error(
        `the P1 backup does not cover flash offset ${hexUp(flashOffset)} ` +
          '(the probe reference must lie inside the backed-up region)',
      );
    }
    const within = flashOffset - windowBase;
    const n = Math.min(length - at, WINDOW_BYTES - within);
    out.set(bytes.subarray(within, within + n), at);
    at += n;
  }
  return out;
}

/**
 * The delivered image: the raw post-write dump with the active bank's 64 KiB
 * replaced from the P1 backup — the camera's original flash content.
 */
export function postProcessDump(
  dump: Uint8Array,
  bankAddress: number,
  originalBank: Uint8Array,
): Uint8Array {
  if (dump.length !== FLASH_SIZE) {
    throw new Error(
      `post-process: the dump is ${String(dump.length)} B, want ${String(FLASH_SIZE)}`,
    );
  }
  if (originalBank.length !== WINDOW_BYTES) {
    throw new Error(`post-process: the backup bank is ${String(originalBank.length)} B`);
  }
  const out = new Uint8Array(dump);
  out.set(originalBank, bankAddress - 0x14000000);
  return out;
}

/* ==================================================================== *
 * P4 — restore + verify
 * ==================================================================== */

/**
 * P4's verify: re-read the 31 stock windows and compare every one against the
 * P1 backup.
 */
export async function verifyAgainstBackup(
  device: SeekDevice,
  backup: BackupResult,
  reporter: Reporter,
  chunk: number = READ_CHUNK,
): Promise<{ diffBytes: number; windowsRead: number; badWindows: readonly number[] }> {
  const windows = preservationWindows();
  let diffBytes = 0;
  let windowsRead = 0;
  const badWindows: number[] = [];
  let index = 0;
  for (const entry of windows) {
    index++;
    device.assertNotCancelled();
    reporter.progress(
      index,
      windows.length,
      `P4 verify window ${hexUp(entry.address, 8)}`,
      'items',
    );
    await device.armWindow(entry);
    const read = await device.readArmed(chunk, WINDOW_BYTES);
    if (read.data.length !== WINDOW_BYTES) {
      badWindows.push(entry.subcmd);
      continue;
    }
    windowsRead++;
    const want = backup.byAddress.get(entry.address);
    if (want === undefined) {
      badWindows.push(entry.subcmd);
      continue;
    }
    for (let j = 0; j < WINDOW_BYTES; j++) {
      if (read.data[j] !== want[j]) diffBytes++;
    }
  }
  reporter.progress(windows.length, windows.length, 'P4 verify pass done', 'items');
  return { diffBytes, windowsRead, badWindows };
}

/* ==================================================================== *
 * The whole pipeline, one process
 * ==================================================================== */

/** A fresh camera session. The pipeline opens one per phase boundary (after
 *  every reset) and closes it before opening the next. */
export interface SessionOpener {
  open(): Promise<SeekDevice>;
  close(device: SeekDevice): Promise<void>;
}

export interface PipelineRecord {
  readonly phase: 'P1' | 'P2' | 'P3' | 'P4';
  readonly title: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PipelineArtifacts {
  /** P1's windows, keyed by address (the restore source). */
  readonly backupByAddress: ReadonlyMap<number, Uint8Array>;
  /** The active-bank capture from P1 (ciphertext, as served) — the original bank. */
  readonly bankCapture: Uint8Array;
  /** The slot verdict P2 and P4 acted on. */
  readonly detection: SlotDetection;
  /** P3's raw dump == the post-write part. */
  readonly rawDump: Uint8Array;
  /** P3's dump with the active bank replaced from the backup — the delivered image. */
  readonly processedDump: Uint8Array;
  /** P4's verify pass. */
  readonly verify: { diffBytes: number; windowsRead: number; badWindows: readonly number[] };
  readonly records: readonly PipelineRecord[];
}

export interface PipelineOptions {
  readonly opener: SessionOpener;
  /** The factory plaintext of the running build (the corpus image). */
  readonly plain: Uint8Array;
  /** The version wire 0x4E must report before anything happens. */
  readonly expectedVersion: string;
  /** The bank's expected as-booted image prefix (plain XOR keystream) when the
   *  slot key is known — the emulator's donor case. When absent, only the
   *  verbatim header window can be checked. */
  readonly expectedSlotPrefix?: Uint8Array;
  readonly reporter: Reporter;
  /** P3/P4 post-reset probe attempts per phase before the wedge is declared. */
  readonly postResetAttempts?: number;
}

/**
 * Run the pipeline end to end, phases in order, each on its own session.
 * Throws on the first phase whose proof fails.
 */
export async function runPreservationPipeline(
  options: PipelineOptions,
): Promise<PipelineArtifacts> {
  const { opener, plain, expectedVersion, reporter } = options;
  const records: PipelineRecord[] = [];
  const record = (
    phase: PipelineRecord['phase'],
    title: string,
    ok: boolean,
    detail: string,
  ): void => {
    records.push({ phase, title, ok, detail });
    reporter.log(`${phase} ${ok ? 'PASS' : 'FAIL'}: ${title} — ${detail}`, ok ? 'ok' : 'error');
  };

  /* ---- P1 + P2: one session, backup then commit then reset --------------- */
  let detection: SlotDetection;
  let backup: BackupResult;
  let bankCapture: Uint8Array;
  {
    const device = await opener.open();
    try {
      const version = await readVersion(device);
      if (version !== expectedVersion) {
        throw new Error(
          `the camera reports firmware ${version}, want ${expectedVersion} — the patch is ` +
            "derived from one build's bytes and must not be sent to another",
        );
      }
      reporter.log(`camera reports firmware ${version}`, 'detail');

      backup = await backupWindows(device, reporter);
      record(
        'P1',
        '31-window backup complete',
        true,
        `${String(backup.windows.length)} windows, ${String(backup.bytes)} B`,
      );

      detection = await detectActiveSlot(device);
      reporter.log(`slot: ${detection.verdict}`, 'detail');
      const captured = backup.byAddress.get(detection.bankAddress);
      if (captured === undefined) {
        throw new Error(
          `the P1 backup does not hold the active bank ${hexUp(detection.bankAddress, 8)}`,
        );
      }
      bankCapture = captured;
      const check = verifyCapture(bankCapture, plain, options.expectedSlotPrefix);
      if (!check.ok) {
        throw new Error(
          `the bank capture does not match the factory image: ${check.reason ?? 'unknown'}`,
        );
      }

      const patch = buildV1Patch(plain);
      const payload = conjugateCapture(bankCapture, patch);
      reporter.log(
        `P2 payload: ${String(payload.length)} B (image length only); ` +
          `${String(patch.diffOffsets.length)} conjugated byte(s)`,
        'detail',
      );
      const commit = await commitToBank(device, detection.bank, payload, {
        label: 'P2 in-place patch',
        reporter,
      });
      const reset = await resetDevice(device);
      record(
        'P2',
        'in-place patch committed into the active slot',
        true,
        `bank ${hexUp(detection.bankAddress, 8)} (mode ${String(detection.bankMode)}), ` +
          `${String(commit.chunks)} chunks, commit status ${hexUp(commit.status)}, reset ${reset}` +
          '; no bootcfg write, no other-slot write (the raw path writes no record)',
      );
    } finally {
      await opener.close(device);
    }
  }

  /* ---- P3: fresh session(s); the reset quirk means retry-once ------------- */
  const probeBytes = backupSlice(backup, PROBE_OFFSET - READ_CHUNK, READ_CHUNK);
  let rawDump: Uint8Array | null = null;
  let lastProbe = 'not attempted';
  const attempts = options.postResetAttempts ?? 2;
  for (let n = 1; n <= attempts && rawDump === null; n++) {
    const device = await opener.open();
    try {
      const probe = await probeWidenedWindow(device, probeBytes);
      lastProbe = `attempt ${String(n)}: ${probe.detail}`;
      reporter.log(`P3 probe, ${probe.detail}`, probe.live ? 'detail' : 'warn');
      if (!probe.live) continue;
      rawDump = await drainWholePart(device, reporter);
    } finally {
      await opener.close(device);
    }
  }
  if (rawDump === null) {
    throw new PostResetWedgeError(
      'the commit landed but the post-reset read window never came up — the doc 33 sec. 11.6 ' +
        'same-server wedge. The commit is NOT replayed; re-run the drain phase against a ' +
        `fresh session/server booted from the committed state. Last probe: ${lastProbe}`,
      { records: records.length, lastProbe },
    );
  }
  const processedDump = postProcessDump(rawDump, detection.bankAddress, bankCapture);
  const rawSha = await sha256hex(rawDump);
  const deliveredSha = await sha256hex(processedDump);
  record(
    'P3',
    'full 4 MiB drained through the widened window',
    true,
    `raw sha256 ${rawSha}; delivered (bank swapped back) sha256 ${deliveredSha}`,
  );

  /* ---- P4: restore the original bank, then re-read and compare ----------- */
  {
    const device = await opener.open();
    let restoreDetection: SlotDetection;
    try {
      const version = await readVersion(device);
      if (version !== expectedVersion) {
        throw new Error(`after the patch the camera reports ${version}, want ${expectedVersion}`);
      }
      restoreDetection = await detectActiveSlot(device);
      if (
        restoreDetection.bank !== detection.bank ||
        restoreDetection.bankAddress !== detection.bankAddress
      ) {
        throw new Error(
          `the active slot changed between P2 (${hexUp(detection.bankAddress, 8)}) and P4 ` +
            `(${hexUp(restoreDetection.bankAddress, 8)}) — refusing to restore over a ` +
            'different bank than the one patched',
        );
      }
      /* THE ORIGINAL BANK CONTENT, staged verbatim: the P1 capture's image
       * prefix (ciphertext, as served — the v1 raw path programs verbatim). */
      const payload = bankCapture.subarray(0, plain.length);
      if (payload.length !== plain.length) {
        throw new Error('the bank capture is shorter than the image — cannot restore');
      }
      const commit = await commitToBank(device, detection.bank, payload, {
        label: 'P4 restore',
        reporter,
      });
      const reset = await resetDevice(device);
      record(
        'P4',
        'original bank content restored',
        true,
        `${String(commit.chunks)} chunks, commit status ${hexUp(commit.status)}, reset ${reset}`,
      );
    } finally {
      await opener.close(device);
    }
  }

  let verify: { diffBytes: number; windowsRead: number; badWindows: readonly number[] } = {
    diffBytes: -1,
    windowsRead: 0,
    badWindows: [],
  };
  for (let n = 1; n <= attempts; n++) {
    const device = await opener.open();
    try {
      verify = await verifyAgainstBackup(device, backup, reporter);
      if (verify.badWindows.length === 0) break;
    } finally {
      await opener.close(device);
    }
  }
  record(
    'P4',
    '31-window verify against the P1 backup',
    verify.diffBytes === 0 && verify.badWindows.length === 0,
    `${String(verify.diffBytes)} differing byte(s), ` +
      `${String(verify.windowsRead)}/${String(BACKUP_WINDOW_COUNT)} windows re-read` +
      (verify.badWindows.length > 0 ? `, short windows: ${verify.badWindows.join(',')}` : ''),
  );

  return {
    backupByAddress: backup.byAddress,
    bankCapture,
    detection,
    rawDump,
    processedDump,
    verify,
    records,
  };
}

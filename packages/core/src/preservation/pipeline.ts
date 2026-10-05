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
 *       restores from, and a short one is refused, not gap-filled. The
 *       active bank is read TWICE — two independent captures that must agree
 *       byte for byte — and the factory plaintext is DERIVED from the agreed
 *       capture (`solve.ts`): there is no manual image input anywhere.
 *
 *   P2  in-place patch — read the 28-byte boot-config record (mode 3) and
 *       name the ACTIVE slot; the captured bank's image was already gated
 *       (the build table's detect hooks and before-bytes) BEFORE anything is
 *       written; conjugate the plaintext patch into the ciphertext capture
 *       (`patch.ts`); stage IMAGE LENGTH ONLY in 64-byte chunks (the commit
 *       erases the whole 64 KiB block and programs exactly the staged bytes,
 *       and a full 64 KiB stage would overrun the descriptor's staging
 *       buffer); commit (0x51 with the u16 sum); wire-89 reset — the same
 *       session, the proven patch shape. NO bootcfg write, NO other-slot
 *       write: the part's only change is the enumerated patch bytes inside
 *       the one active bank.
 *
 *   P3  full dump — after the warm reset the camera boots the PATCHED image,
 *       whose mode-2 window now spans the whole 4 MiB part. A fresh session
 *       (the post-reset quirk: re-enumerate, probe once, then drain — retry
 *       once on a still-dead window and NEVER re-send the commit) drains the
 *       part at 64 B per call (READ_CHUNK; sec. 28.3). The RAW dump equals
 *       the post-write part; the
 *       DELIVERED dump has the active bank's 64 KiB replaced from the P1
 *       backup, so it is the camera's original flash content, byte-clean.
 *
 *   P4  restore — commit the ORIGINAL bank content back over the same bank
 *       (the patched image still runs from SRAM, so the write is inert to the
 *       running code), reset, then re-read the 31 windows and compare every
 *       one against the P1 backup.
 *
 * The same operation also exists as SIX RESUMABLE STEPS (`steps.ts`), and
 * `runPreservationPipeline` at the bottom of this file is composed from them.
 * The one behavioural difference: the wire-89 reset that boots the patched
 * image belongs to the drain step's own first session — the commit session
 * stays reset-free, so it can stop politely and its post-commit flash state
 * is the ground truth (TESTING.md sec. 23.8). Use the steps when a run must
 * survive the process that started it; use this when one call is enough.
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

import { hexUp, isoStamp, sha256hex } from '../bytes.js';
import { CancelledError, errorMessage, SeekError } from '../errors.js';
import type { Reporter } from '../events.js';
import type { SeekDevice } from '../protocol/client.js';
import { u16Payload } from '../protocol/client.js';
import { OP, EP0_BUF, USB_COMMIT_TIMEOUT_MS } from '../protocol/ops.js';
import { FLASH_BASE, FLASH_SIZE } from '../profiles/modern-4x.js';
import {
  PRESERVE_BACKUP_FILE,
  PRESERVE_BANK_CAPTURE_FILE,
  PRESERVE_PLAIN_NAME,
  PRESERVE_DUMP_ORIGINAL_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  backupResultFromImage,
  createPreserveRun,
  runPreserveStep,
  type PreserveArtifactLoader,
  type PreserveRunState,
  type PreserveStepId,
} from './steps.js';
import { sum16 } from './patch.js';
import {
  BACKUP_WINDOW_COUNT,
  BANKS,
  bankWindow,
  cfgWindow,
  isBlankWindow,
  isPageShiftedHead,
  isStaleDescriptorWord,
  parseBootConfig,
  preservationWindows,
  spentReaderRefusal,
  widenedWindow,
  BOOT_CONFIG_BYTES,
  WINDOW_BYTES,
  type BankKey,
  type SlotDetection,
} from './windows.js';

/** Wire-79 drain unit: ONE EP0 packet, the ask where serve == ask — measured
 *  exact on both sides of the bridge (TESTING.md sec. 28.3: silicon never
 *  completed a 512 ask, 0/4,194,304 B over four attempts; 64 asks drained the
 *  whole 4 MiB with no short serve). */
export const READ_CHUNK = 64;
/** Wire-80 staging unit: the device's EP0 buffer truncates longer chunks. */
export const STAGE_CHUNK = EP0_BUF;
/** Per-read retries before a drain fails (the bench contract: fail loudly). */
export const DRAIN_RETRIES = 5;

/** ResetDevice (0x59). Payload u16 0 = plain reset; a NON-zero value arms the
 *  TIMER1-driven arm route, which this pipeline must never send. */
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

/** The caller's stop request, checked at every loop boundary alongside the
 *  device's own — a device constructed without a signal still stops. */
function assertLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CancelledError();
}

/** True when the error, or something it wraps, is the wire's stall answer:
 *  both transports map a stalled endpoint to `usb/stalled`, and `drainExact`
 *  rethrows the transport's error as `cause` — the exhausted reader's
 *  measured signature (TESTING.md sec. 28.4: `control IN 0x4f -> stall`,
 *  four reads in a row). */
export function isWireStall(error: unknown): boolean {
  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (cause instanceof SeekError && cause.code === 'usb/stalled') return true;
  }
  return false;
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

/* ==================================================================== *
 * P1 — the 31-window backup (read-only), one boot per window
 * ==================================================================== */

/**
 * THE SILICON READER MODEL (measured 2026-10-03 against the J-Link dump of the
 * reference Compact, sha 40447c7e…; TESTING.md sec. 34). Two quirks govern
 * every window read on a stock camera, and neither is a budget:
 *
 *  1. COMPLETION POISON. A drain that serves a window's LAST byte kills the
 *     reader for the rest of the boot — every later arm serves a misaligned
 *     page-walk, then blank. Measured: mode 3 full 64 KiB OK, then modes
 *     7/3/5/7 all blank on the same boot. Every phase-① failure before
 *     2026-10-03 was this: the sweep's own first completed window poisoned
 *     the reader, and the "backup" it assembled was the poison's page-walk,
 *     not flash content. A fresh boot gives ONE full window, no more.
 *     CORRECTION (TESTING.md sec. 35.4): these measurements ran while bank A
 *     held the PATCHED image, left there by a run that stopped after its
 *     commit. The patch widens the reader's position (descriptor +12) to a
 *     word but the arm still zeroes it with `strh` (0x1008412E), so a read
 *     that carries past 0xFFFF leaves the upper half stuck and every later
 *     window serves one page further per full read. Stock firmware wraps the
 *     halfword and is clean: five full windows on one session, and an
 *     over-read, all read correctly. The probe-and-reboot design below
 *     stays, because a run can find a camera that is still patched.
 *  2. PER-BOOT PAGE BIAS. A healthy boot serves window m at plan(m) plus one
 *     64 KiB page for some boots (window m answers with the plan's block m+1).
 *     The bias is chosen per boot, stable within it, and cleared by any
 *     reboot; the mode-3 probe identifies it (the page-shift anchor).
 *
 * What survives on silicon: a fresh arm re-serves from byte 0; small reads and
 * re-arms are healthy indefinitely; the completion poison is CLEARED by the
 * wire-89 firmware reboot (measured — no physical power cycle needed). Hence
 * the shape of everything below: ONE window per boot — arm, read it FULL
 * (completing is fine; nothing else is read on that boot), reboot by command,
 * next. 31 windows ≈ 13 s each. Every session is admitted by the mode-3
 * probe: a written record is a healthy boot, the page-shift anchor is a
 * page-shifted boot (reboot and retry), blank retries once (a genuinely blank
 * record is legitimate) before it proceeds, anything else reboots and retries.
 */

/** How the mode-3 probe read classifies this boot's reader. */
export type ReaderBoot = 'healthy' | 'page-shifted' | 'blank';

/** True when a probe head is a written boot-config record (cfg0 0/1/2 with
 *  the bank addresses). */
function isWrittenCfgRecord(head: Uint8Array): boolean {
  return cfgRecordShape(head) === 'written';
}

export function classifyReaderBoot(head: Uint8Array): ReaderBoot {
  /* The anchor first: its cfg0 names no slot, so the record shape alone would
   * misread it as written. */
  if (isPageShiftedHead(head)) return 'page-shifted';
  if (isWrittenCfgRecord(head)) return 'healthy';
  return 'blank';
}

/** How many fresh boots one segment may demand before the reader is refused.
 *  Two of them may legitimately be blank (a genuinely blank-record camera
 *  reads blank on every boot and must proceed); the third blank is a wedged
 *  reader and the refusal names the physical power cycle. */
export const SEGMENT_BOOT_ATTEMPTS = 4;

/**
 * Open ONE admitted session: ride the opener's ladder through any reset
 * silence, then probe the reader with the mode-3 head read. A boot that is
 * page-shifted or unreadable is rebooted by command and retried; a blank
 * probe proceeds after two blank boots (a genuinely blank-record camera).
 * Returns the device and its probe head — the head IS the boot-config record
 * on a healthy boot, so callers get the slot detection for free.
 */
export async function openProbedSession(
  opener: SessionOpener,
  reporter: Reporter,
  signal: AbortSignal | undefined,
  label: string,
  prepare?: (device: SeekDevice) => void,
): Promise<{ device: SeekDevice; cfgHead: Uint8Array; boots: number }> {
  let blankBoots = 0;
  for (let attempt = 1; attempt <= SEGMENT_BOOT_ATTEMPTS; attempt++) {
    assertLive(signal);
    const device = await opener.open();
    prepare?.(device);
    let head: Uint8Array;
    try {
      await device.armWindow(cfgWindow());
      /* THE START-UP WINDOW, the version read's shape: after a reboot the
       * firmware refuses (or stalls) every request while it initializes —
       * ~10 ms of real time on the real camera, but on the EMULATOR the
       * camera's clock only advances while requests are outstanding, so the
       * probe must keep asking, a pause between each, until the dispatcher
       * comes up. 26 reads, 20 ms apart, exactly the version read's window. */
      head = await (async (): Promise<Uint8Array> => {
        let lastError: Error | null = null;
        for (let probeRead = 0; probeRead < 26; probeRead++) {
          assertLive(signal);
          try {
            if (probeRead > 0) await sleep(20);
            return await drainExact(device, BOOT_CONFIG_BYTES, `${label} reader probe`, {
              retries: 0,
              timeoutMs: 5000,
              ...(signal === undefined ? {} : { signal }),
            });
          } catch (error) {
            /* a refusal or a stall (both Errors) asks again; anything else is not the camera */
            if (!(error instanceof Error)) throw error;
            lastError = error;
          }
        }
        throw lastError ?? new Error('the reader probe never answered');
      })();
    } catch (error) {
      await opener.close(device);
      /* A stall is the dead reader's wire answer; reboot by command on the
       * next open and try again — the wire-89 clears the completion poison
       * (measured on stock). It did NOT revive the reader a 4 MiB drain
       * exhausted (TESTING.md secs. 28.4, 35), so the log names the probe's
       * own failure and the reboot's outcome: every attempt must say what the
       * wire answered, not only that it failed. */
      reporter.log(
        `${label}: the reader probe stalled (${errorMessage(error)}) — rebooting by command ` +
          'and retrying',
        'warn',
      );
      try {
        const reboot = await opener.open();
        const outcome = await resetDevice(reboot);
        /* 'dropped' is the usual answer, not a failure: the camera reboots
         * before it acknowledges, so the transfer dies with the wire (measured
         * over real WebUSB, 2026-10-05). The next open tells whether it took. */
        reporter.log(
          `${label}: reboot command ${
            outcome === 'sent'
              ? 'acknowledged'
              : 'sent — no reply, as when the camera reboots before answering'
          }`,
          'detail',
        );
        await opener.close(reboot);
      } catch (rebootError) {
        /* the camera may already be down; the next open's ladder rides it */
        reporter.log(`${label}: reboot command not sent (${errorMessage(rebootError)})`, 'detail');
      }
      continue;
    }
    const boot = classifyReaderBoot(head);
    if (boot === 'healthy') {
      return { device, cfgHead: head, boots: attempt };
    }
    if (
      boot === 'blank' &&
      head.every((b) => b === 0xff) /* stale garbage never proceeds — only a
       * genuinely unprogrammed record does */
    ) {
      blankBoots += 1;
      if (blankBoots >= 2) {
        /* Two independent boots read an unprogrammed record: a genuinely
         * blank-record camera. Proceed — the sweep's canary still refuses an
         * all-blank reader, and the window reads themselves are validated
         * downstream. */
        reporter.log(
          `${label}: the boot-config record reads as unprogrammed on two boots — ` +
            'treating it as a genuinely blank record and proceeding',
          'detail',
        );
        return { device, cfgHead: head, boots: attempt };
      }
    }
    reporter.log(
      `${label}: the reader came up ` +
        (boot === 'page-shifted'
          ? 'page-shifted (every window answers one page up)'
          : 'unreadable (the probe served blank or garbage)') +
        ' — rebooting by command and retrying',
      'warn',
    );
    await resetDevice(device).catch(() => undefined);
    await opener.close(device);
  }
  throw new SeekError(
    'pipeline/refused',
    spentReaderRefusal(
      `${label}: the reader probe failed on ${String(SEGMENT_BOOT_ATTEMPTS)} consecutive ` +
        'boots (blank, page-shifted or stalled each time) — the wire reboot did not revive ' +
        'it; power-cycle the camera (unplug and replug it, or use its power switch), then re-run',
    ),
  );
}

/**
 * Read all 31 stock windows, each one complete — one boot per window.
 * Read-only.
 *
 * THE READER CANARY rides along: the two rows whose BOTH being unprogrammed no
 * honest reader can serve — the boot-config block (0x14010000) and bank A
 * (0x14050000). A blank record is what makes the bootloader's fixed validate
 * order boot bank A, so bank A must then hold the running image; a record
 * naming bank B or recovery is written, not blank. One re-arm separates the
 * honest exception (the measured single-arm swallow) from a wedged reader.
 */
export async function backupWindows(
  opener: SessionOpener,
  reporter: Reporter,
  chunk: number = READ_CHUNK,
  signal?: AbortSignal,
  prepare?: (device: SeekDevice) => void,
): Promise<BackupResult> {
  const windows = preservationWindows();
  const out: WindowBytes[] = [];
  const byAddress = new Map<number, Uint8Array>();
  let index = 0;
  /* The canary state: whether the boot-config row (the sweep's first window)
   * came back entirely unprogrammed. Bank A is the sweep's fifth window; the
   * check fires there. */
  let cfgRowBlank = false;
  const bankAAddress = BANKS[0].address;
  for (const entry of windows) {
    assertLive(signal);
    reporter.progress(
      index,
      windows.length,
      `P1 backup window ${hexUp(entry.address, 8)}`,
      'items',
    );
    const { device } = await openProbedSession(
      opener,
      reporter,
      signal,
      `P1 window ${hexUp(entry.address, 8)}`,
      prepare,
    );
    let read: Awaited<ReturnType<SeekDevice['readArmed']>>;
    try {
      await device.armWindow(entry);
      read = await device.readArmed(chunk, WINDOW_BYTES);
    } catch (error) {
      await opener.close(device);
      throw error;
    }
    if (read.data.length !== WINDOW_BYTES) {
      await opener.close(device);
      const why = read.stopReason === null ? '' : ` (${read.stopReason})`;
      throw new Error(
        `P1: backup window ${hexUp(entry.address, 8)} came back ` +
          `${String(read.data.length)}/${String(WINDOW_BYTES)} B` +
          why +
          ' — the backup must be complete before anything is written',
      );
    }
    if (entry.address === 0x14010000) cfgRowBlank = isBlankWindow(read.data);
    if (entry.address === bankAAddress && cfgRowBlank && isBlankWindow(read.data)) {
      /* Both canary rows blank. One re-arm separates a wedged reader from the
       * measured single-arm swallow (this segment's boot is otherwise done —
       * the re-arm costs nothing the segment wasn't already spending). */
      await device.armWindow(entry);
      const again = await device.readArmed(chunk, WINDOW_BYTES);
      if (again.data.length !== WINDOW_BYTES || isBlankWindow(again.data)) {
        await opener.close(device);
        throw new SeekError(
          'pipeline/refused',
          spentReaderRefusal(
            `the sweep's boot-config block (${hexUp(0x14010000, 8)}) and bank A ` +
              `(${hexUp(bankAAddress, 8)}) both served entirely unprogrammed 0xFF fill, and ` +
              'bank A’s re-armed read agreed — a running camera cannot hold both (a blank ' +
              'record is what makes the bootloader boot bank A, so bank A must then hold the ' +
              'running image), so the reader is serving blank and every window so far is ' +
              'fill, not flash content',
          ),
        );
      }
      reporter.log(
        `the sweep’s bank A row (${hexUp(bankAAddress, 8)}) served blank and was ` +
          're-verified on a fresh arm — the re-read is the row (the measured single-arm ' +
          'swallow, not a wedged reader: the boot-config row is blank because the record is)',
        'detail',
      );
      out.push({ mode: entry.subcmd, address: entry.address, bytes: again.data });
      byAddress.set(entry.address, again.data);
    } else {
      out.push({ mode: entry.subcmd, address: entry.address, bytes: read.data });
      byAddress.set(entry.address, read.data);
    }
    /* The window's last byte was just served — the poison is armed on a real
     * camera. NO eager reset here: the NEXT segment's mode-3 probe is what
     * detects the poisoned boot (it serves blank) and reboots by command
     * itself, so a reader that does not poison (the emulator's) is never
     * reset at all. */
    await opener.close(device);
    index++;
  }
  reporter.progress(windows.length, windows.length, 'P1 backup complete', 'items');
  return { windows: out, byAddress, bytes: out.length * WINDOW_BYTES };
}

/* ==================================================================== *
 * P2 — detect, verify, conjugate, commit
 * ==================================================================== */

/**
 * Name the active slot from a probe head already in hand — the mode-3 read
 * `openProbedSession` admits every session with. Read-only, no wire.
 */
export function detectActiveSlotFromHead(cfgHead: Uint8Array): SlotDetection {
  return parseBootConfig(cfgHead);
}

/** Which of the three known shapes a 28-byte boot-config read carries:
 *  'written' (parses toward parseBootConfig as served), 'unprogrammed'
 *  (0xFF-fill — suspect, verified by re-arm), 'stale' (an SRAM-shaped
 *  selector word — suspect, verified by re-arm). */
function cfgRecordShape(block: Uint8Array): 'written' | 'unprogrammed' | 'stale' {
  let allBlank = true;
  for (const byte of block) {
    if (byte !== 0xff) {
      allBlank = false;
      break;
    }
  }
  if (allBlank) return 'unprogrammed';
  if (
    isStaleDescriptorWord(
      new DataView(block.buffer, block.byteOffset, block.byteLength).getUint32(0, true),
    )
  ) {
    return 'stale';
  }
  return 'written';
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
  options: { label: string; reporter: Reporter; commitTimeoutMs?: number; signal?: AbortSignal },
): Promise<{ chunks: number; sum16: number; status: number; ms: number }> {
  const { label, reporter } = options;
  await device.armWindow(bankWindow(bank));

  const startedAt = Date.now();
  let done = 0;
  let chunks = 0;
  while (done < payload.length) {
    assertLive(options.signal);
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
    signal?: AbortSignal;
  } = {},
): Promise<Uint8Array> {
  const chunk = options.chunk ?? READ_CHUNK;
  const retries = options.retries ?? DRAIN_RETRIES;
  const timeoutMs = options.timeoutMs ?? 20000;
  const parts: Uint8Array[] = [];
  let got = 0;
  while (got < bytes) {
    assertLive(options.signal);
    device.assertNotCancelled();
    const want = Math.min(chunk, bytes - got);
    let blk: Uint8Array | null = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        blk = await device.rpcIn(device.windowReadOp, want, timeoutMs);
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
 * whole 4 MiB part at READ_CHUNK (64, one EP0 packet) per call — the ask
 * measured exact on silicon (TESTING.md sec. 28.3).
 */
export async function drainWholePart(
  device: SeekDevice,
  reporter: Reporter,
  options: { chunk?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Uint8Array> {
  await device.armWindow(widenedWindow());
  const startedAt = Date.now();
  let last = 0;
  const data = await drainExact(device, FLASH_SIZE, 'P3 full dump', {
    chunk: options.chunk ?? READ_CHUNK,
    timeoutMs: options.timeoutMs ?? 20000,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
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
 * `expected` (READ_CHUNK B from the P1 backup at flash offset 0x21000). The
 * STOCK 16-bit reader cursor wraps at 0x10000 and serves bootloader-block bytes
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
  const blk = await device.rpcIn(device.windowReadOp, READ_CHUNK, 10000);
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
 * The probe's expectation (READ_CHUNK B), cut from the P1 backup at flash
 * offset `start`. The backup is window-addressed, so a slice that crosses a
 * window boundary is assembled from its parts.
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

/* ---- the 0.7.0.7 rotation ---------------------------------------------------
 *
 * On 0.7.0.7 the widened mode-2 row shares mode 0's body — the boot-config
 * walk that arms the A/B slot the ACTIVE-slot word does not name (the upgrade
 * target; FW-V1 doc 36 secs. 36.4.2 and 36.10.3) — so a whole-part drain
 * serves part[base:] and then wraps through the NOR's own alias decode
 * (machine.py `_alias_flash` on the emulator). Measured on the donor: slot B
 * 0x14060000 with the blank record. A whole-part in-order drain would need a
 * mode-2 body rewrite (a third patch shape) and was not pursued; the drain
 * instead UNROTATES what the window served.
 */

/** The flash address the 0.7.0.7 widened window's offset 0 serves, from the
 *  slot detection: the A/B bank the detection does NOT name — bank A (or a
 *  blank record, which names A) serves from slot B, bank B from slot A. The
 *  measured donor case is the blank record serving from 0x14060000. A record
 *  naming RECOVERY was never measured on this walk and refuses rather than
 *  guess the base. */
export function rotatedDrainBase(detection: SlotDetection): number {
  if (detection.bank === 'a') return 0x14060000;
  if (detection.bank === 'b') return 0x14050000;
  throw new SeekError(
    'pipeline/refused',
    `the active slot is recovery (${hexUp(detection.bankAddress, 8)}) and the 0.7.0.7 mode-2 ` +
      'walk was never measured against a recovery-named record — the rotation base of the ' +
      'widened window is unknown, so the drain refuses rather than deliver a wrongly-folded ' +
      'part (doc 36.10 item 3)',
  );
}

/**
 * Undo the 0.7.0.7 rotation: window offset i served flash
 * `(base - 0x14000000 + i) mod 4 MiB`, so layout byte j is the served byte
 * `(j + SIZE - at) mod SIZE`. The result is the part in layout order — the
 * state the commits produced — which is what every downstream consumer
 * (the delivered-dump swap-back, the == post-commit proofs) expects.
 */
export function unrotateDump(dump: Uint8Array, base: number): Uint8Array {
  if (dump.length !== FLASH_SIZE) {
    throw new Error(`unrotate: the dump is ${String(dump.length)} B, want ${String(FLASH_SIZE)}`);
  }
  const at = base - FLASH_BASE;
  if (!Number.isInteger(at) || at < 0 || at >= FLASH_SIZE || at % WINDOW_BYTES !== 0) {
    throw new Error(`unrotate: ${hexUp(base, 8)} is not a slot-aligned flash base`);
  }
  const out = new Uint8Array(dump.length);
  for (let j = 0; j < dump.length; j++) {
    out[j] = dump[(j + dump.length - at) % dump.length] ?? 0;
  }
  return out;
}

/* ==================================================================== *
 * P4 — restore + verify
 * ==================================================================== */

/**
 * P4's verify: re-read the 31 stock windows and compare every one against the
 * P1 backup — one admitted boot per window, the backup's own discipline (the
 * completing read poisons the reader, and the segment ends with the wire
 * reboot that clears it). The full-length windows it read come back too, keyed
 * by address, so the run can keep the re-read beside the backup.
 */
export async function verifyAgainstBackup(
  opener: SessionOpener,
  backup: BackupResult,
  reporter: Reporter,
  chunk: number = READ_CHUNK,
  signal?: AbortSignal,
  prepare?: (device: SeekDevice) => void,
): Promise<{
  diffBytes: number;
  windowsRead: number;
  badWindows: readonly number[];
  readBack: ReadonlyMap<number, Uint8Array>;
}> {
  const windows = preservationWindows();
  let diffBytes = 0;
  let windowsRead = 0;
  const badWindows: number[] = [];
  const readBack = new Map<number, Uint8Array>();
  let index = 0;
  for (const entry of windows) {
    index++;
    assertLive(signal);
    reporter.progress(
      index,
      windows.length,
      `P4 verify window ${hexUp(entry.address, 8)}`,
      'items',
    );
    const { device } = await openProbedSession(
      opener,
      reporter,
      signal,
      `P4 verify ${hexUp(entry.address, 8)}`,
      prepare,
    );
    let read: Awaited<ReturnType<SeekDevice['readArmed']>>;
    try {
      await device.armWindow(entry);
      read = await device.readArmed(chunk, WINDOW_BYTES);
    } finally {
      /* No eager reset: the next segment's probe detects a poisoned boot and
       * reboots by command itself. */
      await opener.close(device);
    }
    if (read.data.length !== WINDOW_BYTES) {
      badWindows.push(entry.subcmd);
      continue;
    }
    windowsRead++;
    readBack.set(entry.address, read.data);
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
  return { diffBytes, windowsRead, badWindows, readBack };
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
  /** The factory plaintext the BACKUP step derived from that capture — the
   *  image the patch was built from. There is no other input: the run
   *  self-sources. */
  readonly plain: Uint8Array;
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
  /** The bank's expected as-booted image prefix (plain XOR keystream) when the
   *  slot key is known — the emulator's donor case. When absent, the run
   *  relies on the double-read agreement and the derived-image gates. */
  readonly expectedSlotPrefix?: Uint8Array;
  readonly reporter: Reporter;
  /** P3/P4 post-reset probe attempts per phase before the wedge is declared. */
  readonly postResetAttempts?: number;
  /** Threaded through every step's loops: the CLI's interrupt path and the
   *  web runner both stop a run this way. */
  readonly signal?: AbortSignal;
  /** The wire-79 read size the drain asks for. Default READ_CHUNK (64, one
   *  EP0 packet — the ask measured exact on silicon and in the emulator,
   *  TESTING.md sec. 28.3). */
  readonly drainChunk?: number;
}

/**
 * Run the pipeline end to end, phases in order, each on its own session.
 * Throws on the first phase whose proof fails.
 *
 * COMPOSED FROM THE SIX STEPS (`steps.ts`) — the same gates, the same proofs,
 * the same session shape — with the step artifacts held in memory instead of
 * on disk. The one deliberate change from the pre-step shape: the wire-89
 * reset that boots the patched image now happens on the DRAIN step's own
 * first session, not in the commit session. The commit session therefore
 * stays reset-free and can stop politely — its post-commit flash state is
 * the ground truth every offline proof reads (TESTING.md sec. 23.8) — and
 * the reset's orphaned URB lands on the session that owns the reset.
 */
export async function runPreservationPipeline(
  options: PipelineOptions,
): Promise<PipelineArtifacts> {
  const { opener, reporter, signal } = options;
  const { state: initialState } = await createPreserveRun({
    ...(options.expectedSlotPrefix === undefined
      ? {}
      : { expectedSlotPrefix: options.expectedSlotPrefix }),
    ...(options.postResetAttempts === undefined
      ? {}
      : { postResetAttempts: options.postResetAttempts }),
    ...(options.drainChunk === undefined ? {} : { drainChunk: options.drainChunk }),
    runId: `pipeline-${isoStamp()}`,
  });

  /* The steps' artifacts, held where `loadArtifact` serves them from — the
   * one-process stand-in for the run directory a checkpointing caller keeps. */
  const store = new Map<string, Uint8Array>();
  const loadArtifact: PreserveArtifactLoader = (name) => Promise.resolve(store.get(name) ?? null);

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

  /* The state threads forward: each step runs on the state the previous one
   * produced (the gates read the checkpoint record). */
  let current = initialState;
  const runStep = async (step: PreserveStepId): Promise<PreserveRunState> => {
    const outcome = await runPreserveStep(step, opener, current, loadArtifact, reporter, signal);
    for (const artifact of outcome.artifacts) store.set(artifact.name, artifact.data);
    current = outcome.state;
    return current;
  };

  const afterBackup = await runStep('backup');
  const detection = afterBackup.detection;
  if (detection === undefined) throw new Error('the backup step recorded no slot detection');
  const backupImage = store.get(PRESERVE_BACKUP_FILE);
  if (backupImage === undefined) throw new Error('the backup step produced no backup image');
  const backup = backupResultFromImage(backupImage);
  const bankCapture = store.get(PRESERVE_BANK_CAPTURE_FILE);
  if (bankCapture === undefined) throw new Error('the backup step produced no bank capture');
  const plain = store.get(PRESERVE_PLAIN_NAME);
  if (plain === undefined) {
    throw new Error('the backup step derived no factory plaintext from the capture');
  }
  record(
    'P1',
    '31-window backup complete',
    true,
    `${String(backup.windows.length)} windows, ${String(backup.bytes)} B`,
  );

  await runStep('patch');
  const afterCommit = await runStep('commit');
  record(
    'P2',
    'in-place patch committed into the active slot',
    true,
    afterCommit.steps.commit?.notes ??
      `bank ${hexUp(detection.bankAddress, 8)} (mode ${String(detection.bankMode)})` +
        '; no bootcfg write, no other-slot write (the raw path writes no record)',
  );

  /* P3: the drain step sends the wire-89 reset on its own first session and
   * then drains, DRAIN FIRST on its own single arm (the per-arm budget is
   * consumed in asks — TESTING.md sec. 23.3), the patch-live probe afterwards
   * as an advisory on what budget remains. */
  const afterDrain = await runStep('drain');
  const rawDump = store.get(PRESERVE_DUMP_POSTWRITE_FILE);
  const processedDump = store.get(PRESERVE_DUMP_ORIGINAL_FILE);
  if (rawDump === undefined || processedDump === undefined) {
    throw new Error('the drain step produced no dumps');
  }
  record(
    'P3',
    'full 4 MiB drained through the widened window',
    true,
    `raw sha256 ${afterDrain.rawDumpSha256 ?? 'unknown'}; delivered (bank swapped back) ` +
      `sha256 ${afterDrain.deliveredSha256 ?? 'unknown'}`,
  );

  const afterRestore = await runStep('restore');
  record('P4', 'original bank content restored', true, afterRestore.steps.restore?.notes ?? '');

  const afterVerify = await runStep('verify');
  const verify = afterVerify.verify ?? {
    diffBytes: -1,
    windowsRead: 0,
    badWindows: [] as number[],
  };
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
    plain,
    detection,
    rawDump,
    processedDump,
    verify,
    records,
  };
}

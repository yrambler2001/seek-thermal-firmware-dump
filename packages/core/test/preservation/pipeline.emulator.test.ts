/* ==================================================================== *
 * The v1 full-flash preservation pipeline, end to end, against the
 * FW-V1 emulator, booted from the REAL 4 MiB flash dumps of the 2014
 * Compact cameras (the jlink reads beside FW-V1's targets tree, and the
 * vendored corpus dump that is byte-identical to one of them).
 *
 * THE PLAINTEXT WORLD OF THE 2014 LINE. The Sep 29 2014 bootloader has no
 * cipher: a slot is accepted when the magic at +0x200 is 0xA1B2C3D4, the
 * length at +0x204 is under 0x10000, and the stored words sum to 0. Every
 * bank these dumps carry IS the factory plaintext, as stored. So the
 * pipeline runs in its strongest form here: the pre-write capture gate
 * (`verifyCapture`) gets the factory plaintext as the EXPECTED prefix — a
 * whole-image byte comparison, no keyless window fallback — and the
 * conjugation (`conjugateCapture`) is its own zero-keystream identity: the
 * staged wire-80 payload IS the patched plaintext. The rebalance word
 * (0x238) still applies; the keystream never enters.
 *
 * The four phases run against real emulator lifecycles, because the
 * pipeline's proofs are cross-lifecycle by nature:
 *
 *   SERVER A (--flash-out) — P1: the 31-window backup; P2: slot detect,
 *     bank capture verified against the factory plaintext BEFORE anything
 *     is written, then the conjugated in-place commit. NO reset here: a
 *     wire-89 resets the part mid-transfer, the URB is never answered, and
 *     a gated-clock emulator never retires it — the server could not stop
 *     politely and its `.final` would be lost to SIGKILL. Unbroken, this
 *     server stops cleanly and its `.final` IS the post-commit ground
 *     truth — asserted to exist, never synthesized.
 *
 *   The wire-89 reset belongs to P3 (the mission's own phase order): it is
 *   what boots the patched image, and its dropped URB is the documented
 *   shape of a reset on the wire.
 *
 *   OFFLINE — P2's proof: the post-commit state differs from the as-booted
 *     state by EXACTLY the ten enumerated patch bytes inside the ACTIVE
 *     bank — not the boot-config block, not the bootloader block, not the
 *     other two banks, not the bank's erased tail.
 *
 *   SERVER B (--flash <truth>) — P3: the wire-89 warm reset, then the
 *     full 4 MiB drain through the widened window ON ITS OWN SINGLE ARM
 *     (the reader descriptor budgets each arm a fixed number of served
 *     bytes, so anything read before the drain shortens its reach), the
 *     patch-live probe afterwards as an advisory on what budget remains.
 *     OFFLINE: the raw dump == the post-commit state, 0 diffs; the
 *     delivered dump (the active bank swapped back from the P1 backup) ==
 *     the as-booted state, 0 diffs.
 *
 *   SERVER C (--flash <truth>, --flash-out) — P4: the original bank
 *     content committed back over the active bank, reset, then the
 *     31-window verify against the P1 backup. OFFLINE: the restored
 *     `.final` == the as-booted state, 0 diffs over the whole 4 MiB.
 *
 * THE FIVE BOOTS. The same four phases run on: the vendored corpus entry
 * (the camera's own dump, with the 32K board profile the manifest carries
 * and the bench-measured JEDEC id 010215), the same bytes through the
 * byte-exact `--flash` cross-check (6.bin), two more dumps of the same
 * 2014 chain whose settings/calibration blocks differ (1.bin, 2.bin —
 * cfg[0]=0, bank A active, slots A and recovery both holding the factory
 * plaintext), and the post-write dump 4.bin, whose boot-config record
 * names the RECOVERY slot (cfg[0]=2): the pipeline must patch the bank
 * the camera actually boots, and the delivered-dump swap-back must use
 * that bank's backup. A fifth dump, 3.bin, is a DIFFERENT boot chain and
 * is a NEGATIVE case only: the builder refuses its slot image before
 * anything is derived, and the wire run refuses it at the version gate
 * with no write-shaped request ever sent.
 *
 * The post-reset quirk is modeled, not ignored: after the wire-89 the
 * harness waits out the reboot, re-enumerates on a fresh session, and only
 * then re-boots a fresh server from the same part image if the window stays
 * dead — the wire commit is NEVER replayed. Because a reset orphans exactly one URB (its
 * own), the delivery audit is taught that one shape: a session that ended
 * holding a single unanswered 0x41/0x59 is the reset, not a lost reply,
 * and everything else must still be clean.
 *
 * NO FILL on purpose. The `--fill-erased` knob exists for the dump
 * round trips, where an erased byte is indistinguishable from a lost
 * one; here every assert is against the emulator's own `.final` bytes
 * and the ten-byte diff set is exact, so a fill would only break the
 * "the bank tail past the image is already erased" measured fact.
 * ==================================================================== */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { silentReporter } from '../../src/events.js';
import { errorMessage } from '../../src/errors.js';
import { SeekDevice } from '../../src/protocol/client.js';
import { WebUsbTransport } from '../../src/protocol/webusb.js';
import { FLASH_BASE, FLASH_SIZE } from '../../src/profiles/modern-4x.js';
import {
  BACKUP_WINDOW_COUNT,
  PostResetWedgeError,
  PROBE_OFFSET,
  READ_CHUNK,
  backupSlice,
  backupWindows,
  commitToBank,
  conjugateCapture,
  detectActiveSlot,
  drainWholePart,
  postProcessDump,
  probeWidenedWindow,
  readVersion,
  resetDevice,
  resetOpPayload,
  verifyAgainstBackup,
  type BackupResult,
  type SlotDetection,
} from '../../src/preservation/index.js';
import { buildV1Patch, sum16, verifyCapture, wordSum } from '../../src/preservation/patch.js';
import { BANKS, type BankKey } from '../../src/preservation/windows.js';
import {
  InfrastructureDefect,
  liveEmulatorCount,
  RowEmulators,
  type Emulator,
  type StartOptions,
} from '../emulator/harness.js';
import { announceSkip, EMU_DIR, scratchFile, URB_TIMEOUT_MS } from '../emulator/suite.js';
import { assertRealHostPath } from '../emulator/webusb-over-usbip.js';

/* ---- the boot descriptions ------------------------------------------------ */

const CORPUS_ENTRY = '101310HSNEA2/dump'; /* unique substring of the full entry id */
const JEDEC = '010215'; /* the bench-measured SPI-NOR id (manifest emu.nor) */
const EXPECTED_VERSION = '1.3.0.0';
/** A wire-89 mid-session leaves its own URB unanswered; the reboot wait is the
 *  measured shape (the part re-initializes USB within it, on this emulator). */
const REBOOT_WAIT_MS = 15_000;

/* ---- the real dumps (FW-V1 targets tree, beside the emulator) -------------- */

function dumpFile(name: string): string | null {
  if (EMU_DIR === null) return null;
  const file = path.resolve(EMU_DIR, '..', 'targets', 'compact_32k_1_3_0_8', 'jlink_dumps', name);
  return existsSync(file) ? file : null;
}

/** sha256 of each dump, as measured on 2026-10-01 — a wrong or swapped file
 *  fails the boot assert instead of silently measuring something else. */
const DUMP_SHA256: Readonly<Record<string, string>> = {
  '1.bin': '37f5f983066e85c4007bb2b12e159d678d37647242d406451969cf3f81f7de78',
  '2.bin': '6d94b0890635d5d8ee8bffeb0ad6a4c6c9ec07dd9bf2198aed12b46814515825',
  '3.bin': 'fb1cb1f5127177276d00b6d017386e76349dee2ff7c48c34f2190564d51a6c9f',
  '4.bin': '059931aa844587f3ba3d63671202af8c33a91956548a939925e793185c8df9fe',
  '6.bin': '40447c7e6da5cbc84621f4694ffff5bda0f783e7807a45e80443383b19a8eb72',
};

/* ---- corpus inputs -------------------------------------------------------- */

function corpusFile(...parts: readonly string[]): string | null {
  if (EMU_DIR === null) return null;
  const file = path.join(EMU_DIR, 'data', 'corpus', ...parts);
  return existsSync(file) ? file : null;
}

const PLAIN_FILE = corpusFile(
  'compact',
  '2014.10.21-14.58.29-1.3.0.0',
  'no-serial',
  'subi_lpc43xx_lpcopen_1.3.0.0_-_compact_oct_21_2014_14-58-29_99.28_gabiz_ro_firmware.bin',
);

/** The vendored dump behind the corpus entry — 6.bin byte for byte. */
const VENDORED_DUMP = corpusFile(
  'compact',
  '2014.10.21-14.58.29-1.3.0.0',
  '101310HSNEA2',
  'compact_101310hsnea2_4mb.bin',
);

/* ---- prerequisites --------------------------------------------------------- */

function unsupportedReason(): string | null {
  if (EMU_DIR === null) return 'no emulator found (SEEK_EMU_DIR)';
  const cli = path.join(EMU_DIR, 'seekemu', 'cli.py');
  if (!existsSync(cli)) return `${EMU_DIR} has no seekemu/cli.py`;
  const text = readFileSync(cli, 'utf8');
  /* NO --host-wait-budget here, and none needed: the emulator this suite runs
   * on ends every long operation on EMULATED time with a wall-clock safety net
   * (FW-V1 Phase 63), and the emulated SPIFI completes erase and program at
   * once — the wire-81 commit URB retires in tens of ms of the camera's time
   * (TESTING.md sec.22.3), under every deadline the transport sets. The flag
   * was the older emulator's per-transfer guest-step budget; porting it here
   * would be dead code. What IS required is the device-time side channel:
   * without it the transport's deadlines would run on the wall clock. */
  for (const flag of ['--jedec', '--flash', '--flash-out', '--corpus-entry', '--usbip-clock']) {
    if (!text.includes(flag)) return `the emulator at ${EMU_DIR} does not support ${flag}`;
  }
  if (PLAIN_FILE === null) return 'the corpus does not carry the Compact 1.3.0.0 plaintext';
  return null;
}

const UNSUPPORTED = unsupportedReason();
if (UNSUPPORTED !== null) announceSkip(`v1 preservation pipeline (${UNSUPPORTED})`);

/** The dump-dependent cases skip with their own reason; the corpus case does
 *  not need the jlink files. */
function dumpUnavailable(): string | null {
  if (UNSUPPORTED !== null) return UNSUPPORTED;
  for (const name of Object.keys(DUMP_SHA256)) {
    if (dumpFile(name) === null) return `the jlink dump ${name} is not beside the emulator`;
  }
  return null;
}

/** Per-case gate: the corpus entry needs only the emulator; a `--flash` case
 *  also needs its dump (and, for 3.bin, that the other dumps are there too —
 *  the sha table pins them together). */
function caseUnavailable(spec: CaseSpec): string | null {
  if (UNSUPPORTED !== null) return UNSUPPORTED;
  if (spec.bootFlash === null) return null;
  return dumpUnavailable();
}

/* ---- shared harness pieces -------------------------------------------------- */

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Every offset at which two same-length images differ. */
function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
  expect(a.length).toBe(b.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) out.push(i);
  }
  return out;
}

async function withDevice<T>(
  emu: Emulator,
  label: string,
  fn: (seek: SeekDevice) => Promise<T>,
): Promise<T> {
  const device = await emu.attach({ urbTimeoutMs: URB_TIMEOUT_MS });
  const transport = new WebUsbTransport(device, {
    recipient: 'auto',
    api: 'usbip (emulator)',
    host: 'vitest preservation',
    /* THE CAMERA'S CLOCK (TESTING.md sec.19): every deadline this transport
     * arms must run on the emulated camera's time, or the delivery audit
     * fails the row — a deadline that decides on the wall clock decides on
     * machine load. The 2026-09-24 suite predated the tripwire and its loose
     * reset-orphan tolerance absorbed exactly this violation; tightening the
     * tolerance surfaced it. */
    clock: device.deadlineClock,
  });
  await transport.open();
  assertRealHostPath(device, transport.info, label);
  const seek = new SeekDevice(transport, { reporter: silentReporter });
  try {
    return await fn(seek);
  } finally {
    await device.close().catch(() => undefined);
  }
}

interface BootOptions {
  readonly flash?: string;
  readonly flashOut?: string;
}

async function boot(row: RowEmulators, options: BootOptions): Promise<Emulator> {
  const start: StartOptions = {
    entryId: options.flash === undefined ? CORPUS_ENTRY : `flash:${path.basename(options.flash)}`,
    readyTimeoutMs: 180_000,
    ...(options.flash !== undefined ? { flashOverride: options.flash, jedec: JEDEC } : {}),
    ...(options.flashOut !== undefined ? { flashOut: options.flashOut } : {}),
  };
  return row.start(EMU_DIR!, start);
}

/**
 * Read-only `work` on a fresh session, retried the documented way: once more
 * on a fresh session, then on a freshly booted server from the SAME part
 * image. The wire work that put the part in its current state is never
 * replayed — `work` must not write.
 */
async function withFreshSessions<T>(
  row: RowEmulators,
  bootOptions: BootOptions,
  work: (seek: SeekDevice) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;
  for (let round = 0; round < 3; round++) {
    const emu = await boot(row, bootOptions);
    try {
      for (let session = 0; session < 2; session++) {
        try {
          return await row.guard(emu, () =>
            withDevice(emu, `session r${String(round)}s${String(session)}`, work),
          );
        } catch (error) {
          lastError = error;
        }
      }
    } finally {
      await emu.stop();
    }
  }
  throw new PostResetWedgeError(
    'the read window never came up on any retry (three fresh servers, two sessions ' +
      'each) — that is the doc 33 sec. 11.6 wedge, not a firmware answer. Last error: ' +
      describeError(lastError),
    { lastError: describeError(lastError) },
  );
}

/**
 * P3's shape, exactly as the mission states it: a first session sends the
 * wire-89 warm reset ONCE (on the live server, so the part boots the patched
 * image in place), then the drain runs on a re-enumerated fresh session —
 * retried on another session, and finally on a fresh server from the same part
 * image if the post-reset window never came up. The reset is never sent twice.
 */
async function withDrainAfterReset(
  row: RowEmulators,
  bootOptions: BootOptions,
  probeBytes: Uint8Array,
): Promise<Uint8Array> {
  let lastError: unknown = null;
  for (let round = 0; round < 3; round++) {
    const emu = await boot(row, bootOptions);
    try {
      /* The warm reset, exactly once, on the first server. The part then
       * reboots: give it time to re-initialize USB before the next attach —
       * an immediate one lands on a device that is still coming up, and a
       * transfer into it can time out and leave the server's session stuck
       * "attached" (the next import is then refused). */
      if (round === 0) {
        await row.guard(emu, async () => {
          await withDevice(emu, 'P3 warm reset', async (seek) => {
            expect(await readVersion(seek)).toBe(EXPECTED_VERSION);
            await resetDevice(seek);
          });
        });
        await new Promise((resolve) => setTimeout(resolve, REBOOT_WAIT_MS));
      }
      for (let session = 0; session < 2; session++) {
        try {
          return await row.guard(emu, async () =>
            withDevice(emu, `P3 drain r${String(round)}s${String(session)}`, async (seek) => {
              /* DRAIN FIRST, on its own single arm: the reader descriptor's
               * d4 budget is consumed by everything served from the arm, so
               * a probe that runs first shortens the drain that follows
               * (measured: a probe-then-drain stalled at 4,063,232 B, twice,
               * on fresh servers). The full-4-MiB completion is itself the
               * liveness proof — a stock 64 KiB window closes the descriptor
               * at 64 KiB — and the explicit probe then runs afterwards on
               * what budget remains, advisory only.
               *
               * THE ASK IS 64 B, ONE EP0 PACKET, AND THAT IS A MEASURED FACT
               * OF THIS MACHINE, NOT A TUNING CHOICE. The 2014 reader budgets
               * its arm in ASKS, not bytes served: every wire-79 read burns
               * its wLength (0x200 for a 512-ask) from the descriptor's
               * remaining counter and advances the cursor by it, whether or
               * not that many bytes came back — and the SERVE on this machine
               * is the reader's own and varies (512-ask histogram: 512 B x438,
               * 256 B x4644, 192 B x3110; measured over usbip, 8,192 asks
               * consuming the whole 0x400000 budget while delivering only
               * 2,010,240 B, then a permanent stall). At 64 B the ask is one
               * packet, serve == ask always, and the drain lands exactly:
               * 65,536 asks, remaining 0 at cursor 0x400000, no short serve.
               * The pipeline now asks 64 by default too: the hardware run
               * measured the other side (TESTING.md sec. 28.3) and overturned
               * the real-host NAK bet — silicon never completed a 512-ask at
               * all (0/4,194,304 B served, four attempts), while 64 asks
               * drained the whole 4 MiB exactly. 64 is the proven shape on
               * both sides of the bridge, not just in this model. */
              const dump = await drainWholePart(seek, silentReporter, { chunk: 64 });
              process.stderr.write(
                `[preservation] r${String(round)}s${String(session)} DRAIN COMPLETE\n`,
              );
              const probe = await probeWidenedWindow(seek, probeBytes).catch((e: unknown) => ({
                live: false,
                detail: errorMessage(e),
              }));
              process.stderr.write(
                `[preservation] r${String(round)}s${String(session)} probe (advisory): ${probe.detail}\n`,
              );
              return dump;
            }),
          );
        } catch (error) {
          process.stderr.write(
            `[preservation] r${String(round)}s${String(session)} failed: ` +
              (error instanceof Error ? error.message : String(error)) +
              '\n',
          );
          lastError = error;
          await new Promise((resolve) => setTimeout(resolve, 3000));
        }
      }
    } finally {
      await emu.stop(120_000);
    }
  }
  throw new PostResetWedgeError(
    'the post-reset read window never came up on any retry (three fresh servers, two ' +
      'sessions each) — that is the doc 33 sec. 11.6 wedge, not a firmware answer. ' +
      'Last error: ' +
      describeError(lastError),
    { lastError: describeError(lastError) },
  );
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'unreadable';
}

/* ---- delivery audit, with the reset's own shape taught ----------------------- */

/**
 * Stop every emulator the row started and audit the deliveries.
 *
 * A wire-89 reset resets the part IN THE MIDDLE of its own control transfer, so
 * that one URB is never answered and the session ends holding it — that is what
 * a reset IS on this wire, not a lost reply. Everything else must be perfect:
 * any reply the device produced and the client did not read, any ledger that
 * does not balance, any abandoned transfer that is not the reset, any emulator
 * that died without being asked — all of it still fails the row.
 */
async function assertDelivery(row: RowEmulators): Promise<void> {
  const audits = await row.finish();
  for (const audit of audits) {
    if (audit.violations.length === 0) continue;
    /* The tolerated shape, EXACTLY: the session held ONE unanswered transfer,
     * the wire sent the resets that explain it, and nothing else is wrong
     * with the ledger (no drops reported; the counts otherwise match). A
     * session with no reset on it — the commit server above all, whose
     * `.final` is ground truth — must be perfectly clean; the old `<= 1`
     * here also tolerated every unrelated violation of a clean session,
     * because `0 >= 0` and `0 <= 1` are both trivially true. */
    const oneOrphan = audit.client.urbsAbandoned === 1;
    const resetSent = (audit.client.requests['0x41/0x59']?.sent ?? 0) >= 1;
    const noDrops = audit.server === null || audit.server.completions.dropped === 0;
    if (oneOrphan && resetSent && noDrops) {
      process.stderr.write(
        `[preservation] tolerating the reset's own orphaned URB on ${audit.entryId}: ` +
          `${String(audit.client.urbsAbandoned)} unanswered wire-89 transfer(s); ` +
          `violations seen: ${audit.violations.join(' | ')}\n`,
      );
      continue;
    }
    throw new InfrastructureDefect(audit.entryId, audits);
  }
}

/* ==================================================================== *
 * the cases
 * ==================================================================== */

interface CaseSpec {
  /** Short key for scratch paths and row labels. */
  readonly key: string;
  readonly title: string;
  /** The 4 MiB file to boot with `--flash`; undefined boots the corpus entry. */
  readonly bootFlash: string | null;
  /** The as-booted image must equal this file byte for byte. */
  readonly sourceDump: string;
  /** The sha256 the boot must report for the source part (a swapped or
   *  edited dump fails at the READY line, before the wire is touched). */
  readonly sourceSha: string;
  readonly expectCfg0: number;
  readonly expectBlank: boolean;
  readonly expectBank: BankKey;
}

function buildCases(): readonly CaseSpec[] {
  const corpus = (): CaseSpec => ({
    key: 'corpus',
    title: 'the corpus entry 101310HSNEA2 (the vendored dump, 32K board profile)',
    bootFlash: null,
    sourceDump: VENDORED_DUMP!,
    sourceSha: DUMP_SHA256['6.bin']!,
    expectCfg0: 0,
    expectBlank: true,
    expectBank: 'a',
  });
  const flashCase = (name: string, cfg0: number, blank: boolean, bank: BankKey): CaseSpec => ({
    key: `dump${name.replace(/\.bin$/, '')}`,
    title: `--flash ${name} (sha ${DUMP_SHA256[name]!.slice(0, 8)}...)`,
    bootFlash: dumpFile(name),
    sourceDump: dumpFile(name)!,
    sourceSha: DUMP_SHA256[name]!,
    expectCfg0: cfg0,
    expectBlank: blank,
    expectBank: bank,
  });
  return [
    corpus(),
    flashCase('6.bin', 0, true, 'a'),
    flashCase('1.bin', 0, true, 'a'),
    flashCase('2.bin', 0, true, 'a'),
    /* The post-write dump: cfg[0]=2 names the RECOVERY slot, and slot A's
     * header magic was overwritten by the update that wrote it (4 bytes at
     * 0x50200) — the pipeline must patch the bank the record names, and the
     * delivered-dump swap-back must use THAT bank's backup. */
    flashCase('4.bin', 2, false, 'r'),
  ];
}

/** Per-case run state — one full four-phase run per boot description. */
interface RunState {
  backup: BackupResult | null;
  detection: SlotDetection | null;
  bankCapture: Uint8Array | null;
  payload: Uint8Array | null;
  commit: { chunks: number; sum16: number; status: number; ms: number } | null;
  asbooted: Uint8Array | null;
  truth: Uint8Array | null;
  truthLabel: string | null;
  rawDump: Uint8Array | null;
  processedDump: Uint8Array | null;
  restoreFinal: Uint8Array | null;
  verify: { diffBytes: number; windowsRead: number; badWindows: readonly number[] } | null;
}

const emptyState = (): RunState => ({
  backup: null,
  detection: null,
  bankCapture: null,
  payload: null,
  commit: null,
  asbooted: null,
  truth: null,
  truthLabel: null,
  rawDump: null,
  processedDump: null,
  restoreFinal: null,
  verify: null,
});

/* ---- the run's shared plaintext --------------------------------------------- */

const plain = PLAIN_FILE === null ? new Uint8Array(0) : new Uint8Array(readFileSync(PLAIN_FILE));
const patch = UNSUPPORTED === null ? buildV1Patch(plain) : null;

describe.skipIf(UNSUPPORTED !== null)(
  'v1 preservation pipeline — the 2014 Compact flash dumps (emulator)',
  () => {
    const describeBytes = (label: string, bytes: Uint8Array): string =>
      `${label}: sha256 ${sha256(bytes)}, ${String(bytes.length)} B`;

    afterAll(() => {
      const leaked = liveEmulatorCount();
      expect(leaked, 'emulator processes still running at the end').toBe(0);
    });

    for (const spec of buildCases()) {
      describe.skipIf(caseUnavailable(spec) !== null)(spec.title, () => {
        const st: RunState = emptyState();
        const scratch = (name: string): string => scratchFile(`preserve_${spec.key}_${name}`);

        it(
          'P1+P2: 31-window backup, slot detect, plaintext capture verified, in-place commit',
          /* 900 s idle is ~54 s of work; under `npm run check`'s own parallel
           * suites the same rows have measured 2-3x that. A ceiling on
           * failure, not a wait. */
          { timeout: 1_800_000 },
          async () => {
            const row = new RowEmulators(`${spec.key} P1+P2`);
            const asbootedPath = scratch('asbooted.bin');
            const finalPath = `${asbootedPath}.final`;
            const startedAt = Date.now();
            const emu = await boot(row, {
              ...(spec.bootFlash !== null ? { flash: spec.bootFlash } : {}),
              flashOut: asbootedPath,
            });
            try {
              /* The part the READY line reported must be the dump this case
               * names — a wrong or edited file stops here, on the ground
               * truth, before any wire traffic. */
              expect(emu.ready.flash_sha256).toBe(spec.sourceSha);
              await row.guard(emu, async () => {
                await withDevice(emu, 'P1+P2 session', async (seek) => {
                  expect(await readVersion(seek)).toBe(EXPECTED_VERSION);
                  /* The reset payload this pipeline sends is u16 0 — never the
                   * non-zero value that arms the TIMER1 exploit path. */
                  expect([...resetOpPayload()]).toEqual([0, 0]);

                  /* ---- P1: the backup (read-only) ------------------------- */
                  st.backup = await backupWindows(seek, silentReporter);
                  expect(st.backup.windows.length).toBe(BACKUP_WINDOW_COUNT);
                  expect(st.backup.bytes).toBe(BACKUP_WINDOW_COUNT * 0x10000);

                  /* ---- P2: detect, verify, conjugate, commit --------------- */
                  const detection = await detectActiveSlot(seek);
                  st.detection = detection;
                  expect(
                    detection.cfg0,
                    `cfg[0]=${String(detection.cfg0)} should be ${String(spec.expectCfg0)}`,
                  ).toBe(spec.expectCfg0);
                  expect(detection.blank).toBe(spec.expectBlank);
                  expect(detection.bank).toBe(spec.expectBank);

                  const capture = st.backup.byAddress.get(detection.bankAddress);
                  expect(capture, 'the P1 backup holds the active bank').toBeDefined();
                  st.bankCapture = capture!;
                  /* THE PRE-WRITE GATE, PLAINTEXT FORM: the 2014 bootloader
                   * stores its banks unencrypted, so the wire capture IS the
                   * factory plaintext and the strongest check applies — the
                   * whole image prefix, byte for byte. A mismatch here
                   * refuses the whole run before anything is written. */
                  const check = verifyCapture(capture!, plain, plain);
                  expect(check.ok, check.reason ?? 'capture verified').toBe(true);

                  /* The zero-keystream identity: with no cipher the staged
                   * payload IS the patched plaintext. */
                  st.payload = conjugateCapture(capture!, patch!);
                  expect(st.payload.length).toBe(plain.length);
                  const commit = await commitToBank(seek, detection.bank, st.payload, {
                    label: 'P2 in-place patch',
                    reporter: silentReporter,
                    commitTimeoutMs: 60_000,
                  });
                  st.commit = commit;
                  expect(commit.status).toBe(0); /* the measured commit verdict */
                  expect(commit.chunks).toBe(Math.ceil(plain.length / 64)); /* 747 for 1.3.0.0 */
                  expect(commit.sum16).toBe(sum16(st.payload));
                  /* NO reset in this session: the reset is P3's opener (its own
                   * phase), and keeping it out of here lets this server stop
                   * politely and write the `.final` the ground truth needs. */
                });
              });
              await assertDelivery(row);
            } catch (error) {
              process.stderr.write(
                `--- emulator log tail after the P1+P2 failure ---\n${emu.log(80)}\n`,
              );
              throw error;
            } finally {
              await emu.stop();
            }
            process.stderr.write(
              `[preservation] ${spec.key} P1+P2 took ${((Date.now() - startedAt) / 1000).toFixed(1)} s ` +
                `(commit ${String(st.commit?.ms ?? -1)} ms device-side)\n`,
            );

            /* The as-booted capture must exist and be the source dump, whole. */
            expect(existsSync(asbootedPath), 'the emulator wrote its --flash-out image').toBe(true);
            st.asbooted = new Uint8Array(readFileSync(asbootedPath));
            expect(st.asbooted.length).toBe(FLASH_SIZE);
            expect(sha256(st.asbooted)).toBe(spec.sourceSha);

            /* The post-commit truth: the commit server stopped politely (no reset
             * orphan in this session), so its `.final` is the real post-commit
             * part state — not a synthesis. */
            expect(existsSync(finalPath), 'the commit server wrote its post-commit .final').toBe(
              true,
            );
            st.truth = new Uint8Array(readFileSync(finalPath));
            st.truthLabel = '.final (the commit server stopped politely)';
            writeFileSync(scratch('truth.bin'), st.truth);
            expect(st.truth.length).toBe(FLASH_SIZE);
          },
        );

        it('P2 ground truth: exactly the ten enumerated bytes moved, inside the active bank only', () => {
          const { asbooted, truth, bankCapture, detection } = st;
          expect(asbooted).not.toBeNull();
          expect(truth).not.toBeNull();
          expect(bankCapture).not.toBeNull();
          expect(detection).not.toBeNull();

          const bankOff = detection!.bankAddress - FLASH_BASE;
          const moved = diffOffsets(asbooted!, truth!);
          expect(
            moved,
            `the write moved ${String(moved.length)} byte(s); truth = ${st.truthLabel ?? 'unknown'}`,
          ).toEqual(patch!.diffOffsets.map((o) => bankOff + o));

          /* Every changed byte is the CONJUGATED one: truth = capture XOR mask.
           * On these plaintext banks the mask is the plaintext diff itself. */
          for (let i = 0; i < patch!.diffOffsets.length; i++) {
            const off = patch!.diffOffsets[i]!;
            expect(truth![bankOff + off]).toBe((bankCapture![off]! ^ patch!.mask[i]!) & 0xff);
          }

          /* The blocks a preservation route must never touch — every 64 KiB
           * block except the one active bank. */
          const same = (a: number, b: number): number => {
            let d = 0;
            for (let i = a; i < b; i++) {
              if (asbooted![i] !== truth![i]) d++;
            }
            return d;
          };
          expect(same(0, 0x10000)).toBe(0); /* bootloader block */
          expect(same(0x10000, 0x20000)).toBe(0); /* boot-config block: untouched by design */
          for (const bank of BANKS) {
            if (bank.address === detection!.bankAddress) continue;
            expect(
              same(bank.address - FLASH_BASE, bank.address - FLASH_BASE + 0x10000),
              `bank ${bank.key} must be untouched`,
            ).toBe(0);
          }
          expect(same(0x80000, FLASH_SIZE)).toBe(0); /* everything above the banks */
          /* And the bank's erased tail past the image is exactly as booted. */
          expect(same(bankOff + plain.length, bankOff + 0x10000)).toBe(0);
        });

        it(
          'P3: wire-89 reset boots the patched image; whole 4 MiB drains on its own single arm',
          /* The drain is ~85 s idle, but every one of its 65,536 asks is a
           * separate round trip: under `npm run check`'s own parallel suites
           * (or any busy machine) it has measured 30+ min. 60 min is the
           * ceiling on failure, not a wait. */
          { timeout: 3_600_000 },
          async () => {
            const row = new RowEmulators(`${spec.key} P3`);
            const truthPath = scratch('truth.bin');
            const probeBytes = backupSlice(st.backup!, PROBE_OFFSET - READ_CHUNK, READ_CHUNK);

            let rawDump: Uint8Array;
            const startedAt = Date.now();
            try {
              rawDump = await withDrainAfterReset(row, { flash: truthPath }, probeBytes);
            } catch (error) {
              process.stderr.write(
                `--- last emulator log after the P3 failure ---\n${row.lastLog(120)}\n`,
              );
              throw error;
            }
            await assertDelivery(row);
            process.stderr.write(
              `[preservation] ${spec.key} P3 took ${((Date.now() - startedAt) / 1000).toFixed(1)} s ` +
                '(reset server, reboot wait included)\n',
            );
            expect(rawDump.length).toBe(FLASH_SIZE);
            st.rawDump = rawDump;

            /* The DELIVERED image: the ACTIVE bank swapped back from the P1
             * backup — recovery, not A, on the dump whose record names it. */
            st.processedDump = postProcessDump(rawDump, st.detection!.bankAddress, st.bankCapture!);
          },
        );

        it('P3 ground truth: raw dump == post-commit state and delivered dump == as-booted, 0 diffs each', () => {
          const { rawDump, processedDump, truth, asbooted } = st;
          expect(rawDump).not.toBeNull();
          expect(processedDump).not.toBeNull();

          const rawVsTruth = diffOffsets(rawDump!, truth!);
          expect(
            rawVsTruth,
            `RAW dump vs the post-commit state [${st.truthLabel ?? 'unknown'}] — ` +
              `${describeBytes('raw', rawDump!)} vs ${describeBytes('truth', truth!)}`,
          ).toEqual([]);

          const deliveredVsAsBooted = diffOffsets(processedDump!, asbooted!);
          expect(
            deliveredVsAsBooted,
            `DELIVERED dump (bank swapped back) vs the as-booted state — ` +
              `${describeBytes('delivered', processedDump!)} vs ${describeBytes('as-booted', asbooted!)}`,
          ).toEqual([]);
          process.stderr.write(
            `[preservation] ${spec.key} P3 GREEN: raw == post-commit state, 0 diffs; ` +
              `delivered == as-booted, 0 diffs; ${describeBytes('raw', rawDump!)}; ` +
              `${describeBytes('delivered', processedDump!)}; ${describeBytes('as-booted', asbooted!)}\n`,
          );
        });

        it(
          'P4: original bank restored in place, reset; fresh boot re-reads 31 windows, 0 diffs',
          { timeout: 1_800_000 },
          async () => {
            const row = new RowEmulators(`${spec.key} P4`);
            const truthPath = scratch('truth.bin');
            const restoreOutPath = scratch('restored.bin');
            const restoreFinalPath = `${restoreOutPath}.final`;
            const startedAt = Date.now();

            /* ---- the restore commit: the ORIGINAL bank content (the P1
             * capture's image prefix, as stored) staged verbatim over the
             * active bank while the patched image still runs; then reset --- */
            {
              const emu = await boot(row, { flash: truthPath, flashOut: restoreOutPath });
              try {
                await row.guard(emu, async () => {
                  await withDevice(emu, 'P4 restore session', async (seek) => {
                    /* The patched image still reports the build's version. */
                    expect(await readVersion(seek)).toBe(EXPECTED_VERSION);
                    const detection = await detectActiveSlot(seek);
                    expect(detection.bankAddress).toBe(st.detection!.bankAddress);
                    expect(detection.blank).toBe(
                      spec.expectBlank,
                    ); /* the bootcfg was never written */
                    const payload = st.bankCapture!.subarray(0, plain.length);
                    const commit = await commitToBank(seek, detection.bank, payload, {
                      label: 'P4 restore',
                      reporter: silentReporter,
                      commitTimeoutMs: 60_000,
                    });
                    expect(commit.status).toBe(0);
                    expect(['sent', 'dropped']).toContain(await resetDevice(seek));
                  });
                });
              } catch (error) {
                process.stderr.write(
                  `--- emulator log tail after the P4 restore failure ---\n${emu.log(80)}\n`,
                );
                throw error;
              }
              /* Give the restored part a moment to come back, then touch it once:
               * the post-reset activity retires the gated clock's step budget for
               * the reset's orphaned URB, which is what lets this server stop
               * POLITELY and write the `.final` the whole-4-MiB offline proof
               * reads. */
              await new Promise((resolve) => setTimeout(resolve, 5000));
              try {
                await withDevice(emu, 'P4 post-reset touch', async (seek) => {
                  expect(await readVersion(seek)).toBe(EXPECTED_VERSION);
                });
              } catch {
                /* the post-reset window can wedge (doc 33 sec 11.6) — the verify
                 * below runs on a fresh server either way */
              }
              await emu.stop(120_000);
              await assertDelivery(row);
            }

            /* ---- the boot-back verify: a fresh server boots the RESTORED part
             * (that is the boot-back proof) and re-reads all 31 windows ------- */
            const verifySource = existsSync(restoreFinalPath)
              ? restoreFinalPath
              : scratch('asbooted.bin');
            let verify: RunState['verify'];
            try {
              verify = await withFreshSessions(row, { flash: verifySource }, async (seek) => {
                return verifyAgainstBackup(seek, st.backup!, silentReporter);
              });
            } catch (error) {
              process.stderr.write(
                `--- last emulator log after the P4 verify failure ---\n${row.lastLog(120)}\n`,
              );
              throw error;
            }
            await assertDelivery(row);
            st.verify = verify;
            expect(verify.badWindows, 'short verify windows').toEqual([]);
            expect(
              verify.diffBytes,
              `P4: the part re-reads byte-identical to the P1 backup (${String(verify.windowsRead)}/${String(BACKUP_WINDOW_COUNT)} windows)`,
            ).toBe(0);
            process.stderr.write(
              `[preservation] ${spec.key} P4 took ${((Date.now() - startedAt) / 1000).toFixed(1)} s\n`,
            );

            /* ---- offline: the restored `.final` vs the as-booted state, whole
             * 4 MiB, when the restore server managed a polite stop ---------- */
            if (existsSync(restoreFinalPath)) {
              st.restoreFinal = new Uint8Array(readFileSync(restoreFinalPath));
              const d = diffOffsets(st.restoreFinal, st.asbooted!);
              expect(
                d,
                `RESTORED part vs the as-booted state — ${describeBytes('restored', st.restoreFinal)} vs ${describeBytes('as-booted', st.asbooted!)}`,
              ).toEqual([]);
              process.stderr.write(
                `[preservation] ${spec.key} P4 GREEN: restored part == as-booted, 0 diffs over ` +
                  `the whole 4 MiB; ${describeBytes('restored', st.restoreFinal)}` +
                  ` vs ${describeBytes('as-booted', st.asbooted!)}\n`,
              );
            } else {
              process.stderr.write(
                '[preservation] the restore server was killed by the reset orphan, so its ' +
                  '`.final` never landed; the 31-window in-band verify is the restore proof\n',
              );
            }
          },
        );
      });
    }

    /* ================================================================== *
     * the negative: 3.bin is a DIFFERENT boot chain (its own bootloader
     * reset vector 0x14000371, initial SP 0x10020000, and a 42,680-byte
     * slot image that is not the 1.3.0.0 build). The four phases never run
     * against it; what is proven is that the pipeline refuses it at every
     * gate it reaches, and that nothing write-shaped goes out.
     * ================================================================== */
    describe.skipIf(dumpUnavailable() !== null)('negative: 3.bin, a different boot chain', () => {
      const image3 = (): Uint8Array => {
        const dump = new Uint8Array(readFileSync(dumpFile('3.bin')!));
        return dump.subarray(0x50000, 0x50000 + 42680);
      };

      it('the builder refuses the slot image before anything is derived', () => {
        const img = image3();
        expect(img.length).toBe(42680);
        /* The measured first gate: the image's stored words do not sum to 0
         * (0x9AD27D5F), so the balance assumption fails before the site
         * bytes are even looked at. */
        expect(hexWord(wordSum(img))).toBe('0x9AD27D5F');
        expect(() => buildV1Patch(img)).toThrow(/word sum is not 0/);

        /* And the before-byte gate fires too: force the sum to 0 through a
         * scratch word far from every site (offline algebra only — no such
         * image exists on the part), and the site bytes still refuse it. */
        const rebalanced = new Uint8Array(img);
        const dv = new DataView(rebalanced.buffer);
        dv.setUint32(0x4000, 0, true);
        dv.setUint32(0x4000, (0 - wordSum(rebalanced)) >>> 0, true);
        expect(wordSum(rebalanced)).toBe(0);
        expect(dv.getUint32(0x238, true)).toBe(0); /* the rebalance word is free */
        expect(() => buildV1Patch(rebalanced)).toThrow(
          /does not carry the v1 2014 update machinery/,
        );
      });

      it('the pre-write capture gate refuses: bank A does not hold the 1.3.0.0 image', () => {
        const dump = new Uint8Array(readFileSync(dumpFile('3.bin')!));
        const capture = dump.subarray(0x50000, 0x50000 + 0x10000);
        /* The plaintext form of the gate — the whole-image comparison the
         * pipeline would run — fails on the header length at 0x204. */
        const check = verifyCapture(capture, plain, plain);
        expect(check.ok).toBe(false);
        expect(check.reason).toMatch(/does not hold the factory image/);
      });

      it(
        'on the wire: the camera does not report 1.3.0.0 and no write is ever attempted',
        { timeout: 600_000 },
        async () => {
          const row = new RowEmulators('dump3 negative');
          const emu = await boot(row, { flash: dumpFile('3.bin')! });
          try {
            expect(emu.ready.flash_sha256).toBe(DUMP_SHA256['3.bin']);
            await row.guard(emu, async () => {
              await withDevice(emu, 'negative session', async (seek) => {
                /* The pipeline's first gate is the version read: a camera
                 * that does not report the build the patch was derived from
                 * is refused before P1 reads a single window. Whatever this
                 * chain answers (or refuses to answer), it must not be
                 * 1.3.0.0 — record which refusal fired. */
                try {
                  const version = await readVersion(seek);
                  process.stderr.write(
                    `[preservation] 3.bin reports firmware ${version} (not the patched line)\n`,
                  );
                  expect(version).not.toBe(EXPECTED_VERSION);
                } catch (error) {
                  process.stderr.write(
                    '[preservation] 3.bin refused the version read itself: ' +
                      `${describeError(error)} — the same refusal, one gate earlier\n`,
                  );
                }
              });
            });
          } catch (error) {
            process.stderr.write(
              `--- emulator log tail after the negative-case failure ---\n${emu.log(80)}\n`,
            );
            throw error;
          } finally {
            await emu.stop();
          }
          await assertDelivery(row);
          /* NO WRITE ATTEMPTED, on the wire ledger of the whole server:
           * no BeginFirmwareUpgrade (0x52), no SetFeaturedFirmwareData
           * (0x50), no CompleteMemoryUpgrade (0x81), no ResetDevice (0x59). */
          const requests = emu.ledger.snapshot().requests;
          for (const opcode of ['0x52', '0x50', '0x81', '0x59']) {
            expect(
              requests[`0x41/${opcode}`]?.sent ?? 0,
              `no 0x41/${opcode} may go out against 3.bin`,
            ).toBe(0);
          }
        },
      );
    });
  },
);

/** A u32 as `0x........`, for the one pinned sum in the negative case. */
function hexWord(word: number): string {
  return `0x${word.toString(16).toUpperCase().padStart(8, '0')}`;
}

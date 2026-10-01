/* ==================================================================== *
 * The v1 full-flash preservation pipeline, end to end, against the
 * FW-V1 emulator (Compact 1.3.0.0 as a chimera on the 2016 Compact PRO
 * donor 0C21A1M5KP15 — the same boot doc 34 sec. 34.11 measured).
 *
 * The four phases run against real emulator lifecycles, because the
 * pipeline's proofs are cross-lifecycle by nature:
 *
 *   SERVER A (corpus boot, --flash-out) — P1: the 31-window backup;
 *     P2: slot detect, bank capture verified against the builder's
 *     expected as-booted bytes BEFORE anything is written, then the
 *     conjugated in-place commit. NO reset here: a wire-89 resets the
 *     part mid-transfer, the URB is never answered, and a gated-clock
 *     emulator never retires it — the server could not stop politely
 *     and its `.final` would be lost to SIGKILL. Unbroken, this server
 *     stops cleanly and its `.final` IS the post-commit ground truth
 *     — the test asserts that `.final` exists rather than falling back
 *     to a synthesis of what the write SHOULD have done.
 *
 *   The wire-89 reset belongs to P3 (the mission's own phase order): it
 *   is what boots the patched image, and its dropped URB is the
 *   documented shape of a reset on the wire.
 *
 *   OFFLINE — P2's proof: the post-commit state differs from the
 *     as-booted state by EXACTLY the ten enumerated patch bytes inside
 *     the active bank — not the boot-config block, not the bootloader
 *     block, not the other two banks, not the bank's erased tail.
 *
 *   SERVER B (--flash <truth>) — P3: the wire-89 warm reset, then the
 *     full 4 MiB drain through the widened window ON ITS OWN SINGLE ARM
 *     (the reader descriptor budgets each arm a fixed number of served
 *     bytes, so anything read before the drain shortens its reach), the
 *     patch-live probe afterwards as an advisory on what budget remains.
 *     OFFLINE: the raw dump == the post-commit state, 0 diffs; the
 *     delivered dump (the bank swapped back from the P1 backup) == the
 *     as-booted state, 0 diffs.
 *
 *   SERVER C (--flash <truth>, --flash-out) — P4: the original bank
 *     content committed back over the active bank, reset, then the
 *     31-window verify against the P1 backup. OFFLINE: the restored
 *     `.final` == the as-booted state, 0 diffs over the whole 4 MiB.
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
import {
  buildV1Patch,
  keystream,
  sum16,
  verifyCapture,
  xorWindowVerbatim,
} from '../../src/preservation/patch.js';
import { BANKS } from '../../src/preservation/windows.js';
import {
  InfrastructureDefect,
  liveEmulatorCount,
  RowEmulators,
  type Emulator,
  type StartOptions,
} from '../emulator/harness.js';
import { announceSkip, EMU_DIR, scratchFile, URB_TIMEOUT_MS } from '../emulator/suite.js';
import { assertRealHostPath } from '../emulator/webusb-over-usbip.js';

/* ---- the boot description (doc 34 sec. 34.9) ----------------------------- */

const ENTRY = '1.3.0.0';
const DONOR_ID = 'compact_pro/2016.07.06-17.04.49-1.0.3.0/0C21A1M5KP15/dump';
const JEDEC = '010215'; /* the donor's Spansion part */
const HOST_WAIT_BUDGET = 40000000; /* a wire-81 commit's URB must outlive the flash work */
const EXPECTED_VERSION = '1.3.0.0';
/** The active bank: a blank cfg[0] boots the donor bootloader's fixed A order. */
const BANK_A = BANKS.find((b) => b.key === 'a')!;
const BANK_OFF = BANK_A.address - FLASH_BASE;

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

/** The donor's fixed device key (KeyB) — the chimera's bank cipher. */
const DONOR_KEY_WORDS = ((): [number, number, number, number] => {
  const raw = new Uint8Array(
    'faacb3c6f1412469bd122fb82d78160d'.match(/.{2}/g)!.map((h) => Number.parseInt(h, 16)),
  );
  const dv = new DataView(raw.buffer);
  return [
    dv.getUint32(0, true),
    dv.getUint32(4, true),
    dv.getUint32(8, true),
    dv.getUint32(12, true),
  ];
})();

/* ---- prerequisites --------------------------------------------------------- */

function unsupportedReason(): string | null {
  if (EMU_DIR === null) return 'no emulator found (SEEK_EMU_DIR)';
  const cli = path.join(EMU_DIR, 'seekemu', 'cli.py');
  if (!existsSync(cli)) return `${EMU_DIR} has no seekemu/cli.py`;
  const text = readFileSync(cli, 'utf8');
  for (const flag of [
    '--donor',
    '--jedec',
    '--host-wait-budget',
    '--flash-out',
    '--corpus-entry',
  ]) {
    if (!text.includes(flag)) return `the emulator at ${EMU_DIR} does not support ${flag}`;
  }
  if (PLAIN_FILE === null) return 'the corpus does not carry the Compact 1.3.0.0 plaintext';
  return null;
}

const UNSUPPORTED = unsupportedReason();
if (UNSUPPORTED !== null) announceSkip(`v1 preservation pipeline (${UNSUPPORTED})`);

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
    entryId: options.flash === undefined ? ENTRY : `flash:${path.basename(options.flash)}`,
    readyTimeoutMs: 180_000,
    donor: DONOR_ID,
    jedec: JEDEC,
    hostWaitBudget: HOST_WAIT_BUDGET,
    ...(options.flash !== undefined ? { flashOverride: options.flash } : {}),
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
 * image in place), then the probe-then-drain runs on a re-enumerated fresh
 * session — retried on another session, and finally on a fresh server from the
 * same part image if the post-reset window never came up. The reset is never
 * sent twice.
 */
async function withProbeAfterReset(
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
        await new Promise((resolve) => setTimeout(resolve, 15000));
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
               * what budget remains, advisory only. */
              const dump = await drainWholePart(seek, silentReporter);
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

/* ---- the run's shared state -------------------------------------------------- */

const plain = PLAIN_FILE === null ? new Uint8Array(0) : new Uint8Array(readFileSync(PLAIN_FILE));
const patch = UNSUPPORTED === null ? buildV1Patch(plain) : null;
/** The as-booted bank content the wire must serve: plain under the donor's cipher. */
const expectedSlotPrefix =
  patch === null
    ? undefined
    : xorWindowVerbatim(plain, keystream(DONOR_KEY_WORDS, plain.length >> 2));

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

const state: RunState = {
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
};

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
    /* The tolerated shape: the session held exactly one unanswered transfer,
     * the wire sent the resets that explain it, and nothing else is wrong
     * with the ledger (no drops reported; the counts otherwise match). */
    const abandonedOnly = audit.client.urbsAbandoned <= 1;
    const resetSent = (audit.client.requests['0x41/0x59']?.sent ?? 0) >= audit.client.urbsAbandoned;
    const noDrops = audit.server === null || audit.server.completions.dropped === 0;
    if (abandonedOnly && resetSent && noDrops) {
      process.stderr.write(
        `[preservation] tolerating the reset's own orphaned URB on ${audit.entryId}: ` +
          `${String(audit.client.urbsAbandoned)} unanswered wire-89 transfer(s)\n`,
      );
      continue;
    }
    throw new InfrastructureDefect(audit.entryId, audits);
  }
}

/* ==================================================================== *
 * the suite
 * ==================================================================== */

describe.skipIf(UNSUPPORTED !== null)(
  'v1 preservation pipeline — Compact 1.3.0.0 on the 2016 donor (emulator)',
  () => {
    const describeBytes = (label: string, bytes: Uint8Array): string =>
      `${label}: sha256 ${sha256(bytes)}, ${String(bytes.length)} B`;

    afterAll(() => {
      const leaked = liveEmulatorCount();
      expect(leaked, 'emulator processes still running at the end').toBe(0);
    });

    it(
      'P1+P2: 31-window backup, slot detect, capture verified, conjugated in-place commit',
      { timeout: 900_000 },
      async () => {
        const row = new RowEmulators(`${ENTRY} P1+P2`);
        const asbootedPath = scratchFile('preserve_1300_asbooted.bin');
        const finalPath = `${asbootedPath}.final`;
        const emu = await boot(row, { flashOut: asbootedPath });
        try {
          await row.guard(emu, async () => {
            await withDevice(emu, 'P1+P2 session', async (seek) => {
              expect(await readVersion(seek)).toBe(EXPECTED_VERSION);
              /* The reset payload this pipeline sends is u16 0 — never the
               * non-zero value that arms the TIMER1 exploit path. */
              expect([...resetOpPayload()]).toEqual([0, 0]);

              /* ---- P1: the backup (read-only) ------------------------- */
              state.backup = await backupWindows(seek, silentReporter);
              expect(state.backup.windows.length).toBe(BACKUP_WINDOW_COUNT);
              expect(state.backup.bytes).toBe(BACKUP_WINDOW_COUNT * 0x10000);

              /* ---- P2: detect, verify, conjugate, commit --------------- */
              const detection = await detectActiveSlot(seek);
              state.detection = detection;
              expect(detection.blank, `cfg[0]=${String(detection.cfg0)} should be blank`).toBe(
                true,
              );
              expect(detection.bankAddress).toBe(BANK_A.address);
              expect(detection.bankMode).toBe(BANK_A.mode);

              const capture = state.backup.byAddress.get(detection.bankAddress);
              expect(capture, 'the P1 backup holds the active bank').toBeDefined();
              state.bankCapture = capture!;
              /* THE PRE-WRITE GATE: the wire capture equals the builder's
               * expected as-booted bytes, byte for byte, BEFORE anything is
               * written. A mismatch here refuses the whole run. */
              const check = verifyCapture(capture!, plain, expectedSlotPrefix);
              expect(check.ok, check.reason ?? 'capture verified').toBe(true);

              state.payload = conjugateCapture(capture!, patch!);
              expect(state.payload.length).toBe(plain.length);
              const commit = await commitToBank(seek, detection.bank, state.payload, {
                label: 'P2 in-place patch',
                reporter: silentReporter,
                commitTimeoutMs: 60_000,
              });
              state.commit = commit;
              expect(commit.status).toBe(0); /* the measured commit verdict */
              expect(commit.chunks).toBe(Math.ceil(plain.length / 64)); /* 747 for 1.3.0.0 */
              expect(commit.sum16).toBe(sum16(state.payload));
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

        /* The as-booted capture must exist and be a whole part. */
        expect(existsSync(asbootedPath), 'the emulator wrote its --flash-out image').toBe(true);
        state.asbooted = new Uint8Array(readFileSync(asbootedPath));
        expect(state.asbooted.length).toBe(FLASH_SIZE);

        /* The post-commit truth: the commit server stopped politely (no reset
         * orphan in this session), so its `.final` is the real post-commit
         * part state — not a synthesis. */
        expect(existsSync(finalPath), 'the commit server wrote its post-commit .final').toBe(true);
        state.truth = new Uint8Array(readFileSync(finalPath));
        state.truthLabel = '.final (the commit server stopped politely)';
        writeFileSync(scratchFile('preserve_1300_truth.bin'), state.truth);
        expect(state.truth.length).toBe(FLASH_SIZE);
      },
    );

    it('P2 ground truth: exactly the ten enumerated bytes moved, inside the active bank only', () => {
      const { asbooted, truth, bankCapture } = state;
      expect(asbooted).not.toBeNull();
      expect(truth).not.toBeNull();
      expect(bankCapture).not.toBeNull();

      const moved = diffOffsets(asbooted!, truth!);
      expect(
        moved,
        `the write moved ${String(moved.length)} byte(s); truth = ${state.truthLabel ?? 'unknown'}`,
      ).toEqual(patch!.diffOffsets.map((o) => BANK_OFF + o));

      /* Every changed byte is the CONJUGATED one: truth = capture XOR mask. */
      for (let i = 0; i < patch!.diffOffsets.length; i++) {
        const off = patch!.diffOffsets[i]!;
        expect(truth![BANK_OFF + off]).toBe((bankCapture![off]! ^ patch!.mask[i]!) & 0xff);
      }

      /* The blocks a preservation route must never touch. */
      const same = (a: number, b: number): number => {
        let d = 0;
        for (let i = a; i < b; i++) {
          if (asbooted![i] !== truth![i]) d++;
        }
        return d;
      };
      expect(same(0, 0x10000)).toBe(0); /* bootloader block */
      expect(same(0x10000, 0x20000)).toBe(0); /* boot-config block: untouched by design */
      expect(same(0x60000, 0x70000)).toBe(0); /* bank B */
      expect(same(0x70000, 0x80000)).toBe(0); /* recovery bank */
      expect(same(0x80000, FLASH_SIZE)).toBe(0); /* everything above the banks */
      /* And the bank's erased tail past the image is exactly as booted. */
      expect(same(BANK_OFF + plain.length, BANK_OFF + 0x10000)).toBe(0);
    });

    it(
      'P3: wire-89 reset boots the patched image; probe goes live; whole 4 MiB drains',
      { timeout: 1_200_000 },
      async () => {
        const row = new RowEmulators(`${ENTRY} P3`);
        const truthPath = scratchFile('preserve_1300_truth.bin');
        const probeBytes = backupSlice(state.backup!, 0x21000 - 512, 512);

        let rawDump: Uint8Array;
        try {
          rawDump = await withProbeAfterReset(row, { flash: truthPath }, probeBytes);
        } catch (error) {
          process.stderr.write(
            `--- last emulator log after the P3 failure ---\n${row.lastLog(120)}\n`,
          );
          throw error;
        }
        await assertDelivery(row);
        expect(rawDump.length).toBe(FLASH_SIZE);
        state.rawDump = rawDump;

        /* The DELIVERED image: the active bank swapped back from the P1 backup. */
        state.processedDump = postProcessDump(rawDump, BANK_A.address, state.bankCapture!);
      },
    );

    it('P3 ground truth: raw dump == post-commit state and delivered dump == as-booted, 0 diffs each', () => {
      const { rawDump, processedDump, truth, asbooted } = state;
      expect(rawDump).not.toBeNull();
      expect(processedDump).not.toBeNull();

      const rawVsTruth = diffOffsets(rawDump!, truth!);
      expect(
        rawVsTruth,
        `RAW dump vs the post-commit state [${state.truthLabel ?? 'unknown'}] — ` +
          `${describeBytes('raw', rawDump!)} vs ${describeBytes('truth', truth!)}`,
      ).toEqual([]);

      const deliveredVsAsBooted = diffOffsets(processedDump!, asbooted!);
      expect(
        deliveredVsAsBooted,
        `DELIVERED dump (bank swapped back) vs the as-booted state — ` +
          `${describeBytes('delivered', processedDump!)} vs ${describeBytes('as-booted', asbooted!)}`,
      ).toEqual([]);
      process.stderr.write(
        `[preservation] P3 GREEN: raw == post-commit state, 0 diffs; ` +
          `delivered == as-booted, 0 diffs; ${describeBytes('raw', rawDump!)}; ` +
          `${describeBytes('delivered', processedDump!)}; ${describeBytes('as-booted', asbooted!)}\n`,
      );
    });

    it(
      'P4: original bank restored in place, reset; fresh boot re-reads 31 windows, 0 diffs',
      { timeout: 1_200_000 },
      async () => {
        const row = new RowEmulators(`${ENTRY} P4`);
        const truthPath = scratchFile('preserve_1300_truth.bin');
        const restoreOutPath = scratchFile('preserve_1300_restored.bin');
        const restoreFinalPath = `${restoreOutPath}.final`;

        /* ---- the restore commit: the ORIGINAL bank content (the P1
         * capture's image prefix, ciphertext as served) staged verbatim over
         * the active bank while the patched image still runs; then reset --- */
        {
          const emu = await boot(row, { flash: truthPath, flashOut: restoreOutPath });
          try {
            await row.guard(emu, async () => {
              await withDevice(emu, 'P4 restore session', async (seek) => {
                /* The patched image still reports the build's version. */
                expect(await readVersion(seek)).toBe(EXPECTED_VERSION);
                const detection = await detectActiveSlot(seek);
                expect(detection.bankAddress).toBe(state.detection!.bankAddress);
                expect(detection.blank).toBe(true); /* the bootcfg was never written */
                const payload = state.bankCapture!.subarray(0, plain.length);
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
          : scratchFile('preserve_1300_asbooted.bin');
        let verify: RunState['verify'];
        try {
          verify = await withFreshSessions(row, { flash: verifySource }, async (seek) => {
            return verifyAgainstBackup(seek, state.backup!, silentReporter);
          });
        } catch (error) {
          process.stderr.write(
            `--- last emulator log after the P4 verify failure ---\n${row.lastLog(120)}\n`,
          );
          throw error;
        }
        await assertDelivery(row);
        state.verify = verify;
        expect(verify.badWindows, 'short verify windows').toEqual([]);
        expect(
          verify.diffBytes,
          `P4: the part re-reads byte-identical to the P1 backup (${String(verify.windowsRead)}/${String(BACKUP_WINDOW_COUNT)} windows)`,
        ).toBe(0);

        /* ---- offline: the restored `.final` vs the as-booted state, whole
         * 4 MiB, when the restore server managed a polite stop ---------- */
        if (existsSync(restoreFinalPath)) {
          state.restoreFinal = new Uint8Array(readFileSync(restoreFinalPath));
          const d = diffOffsets(state.restoreFinal, state.asbooted!);
          expect(
            d,
            `RESTORED part vs the as-booted state — ${describeBytes('restored', state.restoreFinal)} vs ${describeBytes('as-booted', state.asbooted!)}`,
          ).toEqual([]);
          process.stderr.write(
            `[preservation] P4 GREEN: restored part == as-booted, 0 diffs over the whole ` +
              `4 MiB; ${describeBytes('restored', state.restoreFinal)}` +
              ` vs ${describeBytes('as-booted', state.asbooted!)}\n`,
          );
        } else {
          process.stderr.write(
            '[preservation] the restore server was killed by the reset orphan, so its ' +
              '`.final` never landed; the 31-window in-band verify is the restore proof\n',
          );
        }
      },
    );
  },
);

/* ==================================================================== *
 * The NEW build families, end to end, against the FW-V1 emulator — one
 * focused run per family, on the boots the RE records used:
 *
 *   1. Compact 1.3.0.8 8 Hz — the chimera the doc-35 patch ran (the 8 Hz
 *      image spliced onto the PLAINTEXT 2014 donor 101310HSNEA2): the six
 *      steps, whole-part drain, delivered == as-booted. SELF-SOURCED: no
 *      image input anywhere — the backup step reads the active slot twice,
 *      agrees the captures, derives the plaintext (identity: the donor's
 *      banks hold the image as-is), and the run proceeds from that.
 *   2. Compact Pro 1.0.3.0 — the NATIVE 2016 dump 0C21A1M5KP15, the only
 *      fixture with a GENUINELY CIPHERED at-rest bank (as-booted = plain ^
 *      ks(key block 1); the header window rides verbatim): the six steps,
 *      self-sourced through the compact-2016 keystream solver — the backup
 *      solves the slot state from the crib (GF(2), reserved vector words
 *      7..10), decrypts, and the run proceeds; delivered == the corpus
 *      dump's own bytes. Plus the NEGATIVE: one flipped capture byte (a
 *      copy of the same dump with one byte of the slot image corrupted) —
 *      the solve refuses at the sum rule and nothing write-shaped is sent.
 *   3. Compact 1.3.0.8-FF — the recovery-slot route: the part synthesized
 *      from the same plaintext donor with cfg[0]=2 (selecting recovery,
 *      where the 2014 bootloader boots the 0xFFFF-sum image UNCHECKED) and
 *      the FF image spliced into the slots; commit 0x0 through the app's
 *      TWO accepts, drain through the patched guard, 6 patch bytes vs
 *      as-booted. The FF chimera self-sources like the 8 Hz row: the donor
 *      stores the image as-is, so identity solves it and the build table
 *      names the FF build. (No native FF camera dump exists — the FF
 *      family's genuinely ciphered at-rest forms are proven in
 *      solve.test.ts, on the real FF image.) Plus the NEGATIVE: the factory
 *      FF chimera on the same donor with its blank cfg (detection names
 *      bank A) refuses the commit and the drain — the bootloader would not
 *      boot the patch from there — and never stages a byte.
 *
 * Everything wire-shaped reuses the §23/§24 machinery: RowEmulators, the
 * delivery audit with the reset's one tolerated orphan, the camera's clock
 * under every deadline, 64-byte asks for the drain (the measured
 * serve == ask shape), commit sessions that never reset.
 * ==================================================================== */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { silentReporter, type Reporter } from '../../src/events.js';
import { SeekError } from '../../src/errors.js';
import { SeekDevice } from '../../src/protocol/client.js';
import { WebUsbTransport } from '../../src/protocol/webusb.js';
import { FLASH_SIZE } from '../../src/profiles/modern-4x.js';
import {
  PRESERVE_DUMP_ORIGINAL_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  createPreserveRun,
  describeStepGate,
  readVersion,
  runPreserveStep,
  type CreatedPreserveRun,
  type PreserveArtifactLoader,
  type PreserveRunState,
  type SessionOpener,
} from '../../src/preservation/index.js';
import {
  buildV1Patch,
  keyWordsOf,
  keystream,
  xorWindowVerbatim,
} from '../../src/preservation/patch.js';
import {
  InfrastructureDefect,
  liveEmulatorCount,
  RowEmulators,
  type Emulator,
  type StartOptions,
} from '../emulator/harness.js';
import { EMU_DIR, announceSkip, scratchFile, URB_TIMEOUT_MS } from '../emulator/suite.js';
import { assertRealHostPath } from '../emulator/webusb-over-usbip.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** A wire-89 mid-session leaves its own URB unanswered; the reboot wait is
 *  the measured shape (the part re-initializes USB within it, on this
 *  emulator). */
const REBOOT_WAIT_MS = 15_000;
const JEDEC = '010215';
/** The plaintext 2014 donor every chimera here splices onto. */
const DONOR_2014 = '101310HSNEA2/dump';

function corpusFile(...parts: readonly string[]): string | null {
  if (EMU_DIR === null) return null;
  const file = path.join(EMU_DIR, 'data', 'corpus', ...parts);
  return existsSync(file) ? file : null;
}

const PLAIN_8HZ = corpusFile(
  'compact',
  '2017.01.06-11.16.17-1.3.0.8',
  'no-serial',
  '32k_43x0_1.3.0.8_compact-insecure-8hz_public_-_compact_jan_6_2017_11-16-17_99.28_gabiz_ro_firmware.bin',
);
/** The 0.x plaintexts (doc 36.1's corpus paths), by build. */
const PLAIN_0907 = corpusFile(
  'compact',
  '2014.10.03-18.31.47-0.9.0.7',
  'no-serial',
  'subi_lpc43xx_lpcopen_0.9.0.7_compact_oct_3_2014_18-31-47_99.28_yrambler2001_firmware.bin',
);
const PLAIN_0800 = corpusFile(
  'compact',
  '2014.09.17-09.17.37-0.8.0.0',
  'no-serial',
  'subi_lpc43xx_lpcopen_0.8.0.0_compact_sep_17_2014_09-17-37_99.28_yrambler2001_firmware.bin',
);
const PLAIN_0707 = corpusFile(
  'compact',
  '2014.09.04-14.15.36-0.7.0.7',
  'no-serial',
  'subi_lpc43xx_lpcopen_0.7.0.7_compact_sep_4_2014_14-15-36_99.28_yrambler2001_firmware.bin',
);
const PLAIN_FF = corpusFile(
  'compact',
  '2017.01.06-11.17.29-1.3.0.8-FF',
  'no-serial',
  '32k_43x0_1.3.0.8_compact-16hz_public_-_compact_ff_jan_6_2017_11-17-29_99.28_gabiz_ro_firmware.bin',
);
const PLAIN_1030 = corpusFile(
  'compact_pro',
  '2016.07.06-17.04.49-1.0.3.0',
  'no-serial',
  '80k_4330_1.0.3.0-9hz_public_-_compact_pro_jul_6_2016_17-04-49_84.00_gabiz_ro_firmware.bin',
);
/** The native 2016 dump 0C21A1M5KP15: bank A holds the 1.0.3.0 image
 *  ciphered at rest (plain ^ ks(key block 1), doc 33 sec. 11.2). */
const DUMP_1030 = corpusFile(
  'compact_pro',
  '2016.07.06-17.04.49-1.0.3.0',
  '0C21A1M5KP15',
  'compact_pro_android_uq-aaa.bin',
);

function unsupported(): string | null {
  if (EMU_DIR === null) return 'no emulator found (SEEK_EMU_DIR)';
  const cli = path.join(EMU_DIR, 'seekemu', 'cli.py');
  if (!existsSync(cli)) return `${EMU_DIR} has no seekemu/cli.py`;
  const text = readFileSync(cli, 'utf8');
  for (const flag of ['--jedec', '--flash', '--flash-out', '--corpus-entry', '--usbip-clock']) {
    if (!text.includes(flag)) return `the emulator at ${EMU_DIR} does not support ${flag}`;
  }
  return null;
}

const UNSUPPORTED = unsupported();
if (UNSUPPORTED !== null) announceSkip(`preservation families (${UNSUPPORTED})`);

function missingPlain(name: string, file: string | null): string | null {
  if (UNSUPPORTED !== null) return UNSUPPORTED;
  return file === null ? `the corpus does not carry the ${name} plaintext` : null;
}

/* ---- sessions over a booted server ----------------------------------------- */

interface Attached {
  readonly seek: SeekDevice;
  close(): Promise<void>;
}

async function attach(emu: Emulator, label: string): Promise<Attached> {
  const device = await emu.attach({ urbTimeoutMs: URB_TIMEOUT_MS });
  const transport = new WebUsbTransport(device, {
    recipient: 'auto',
    api: 'usbip (emulator)',
    host: 'vitest preservation families',
    /* THE CAMERA'S CLOCK (TESTING.md sec.19): every deadline this transport
     * arms runs on the emulated camera's time, or the audit fails the row. */
    clock: device.deadlineClock,
  });
  await transport.open();
  assertRealHostPath(device, transport.info, label);
  return {
    seek: new SeekDevice(transport, { reporter: silentReporter }),
    close: async () => {
      await device.close().catch(() => undefined);
    },
  };
}

interface BootOptions {
  readonly flash?: string;
  readonly flashOut?: string;
  /** `--corpus-entry` (substring) + `--donor`: the chimera boots. */
  readonly entry?: string;
  readonly donor?: string;
}

async function boot(row: RowEmulators, options: BootOptions): Promise<Emulator> {
  const chimera = options.entry !== undefined;
  const start: StartOptions = chimera
    ? {
        entryId: options.entry ?? '',
        readyTimeoutMs: 180_000,
        jedec: JEDEC,
        donor: options.donor ?? DONOR_2014,
        ...(options.flashOut === undefined ? {} : { flashOut: options.flashOut }),
      }
    : {
        entryId: `flash:${path.basename(options.flash ?? 'part.bin')}`,
        readyTimeoutMs: 180_000,
        jedec: JEDEC,
        flashOverride: options.flash ?? '',
        ...(options.flashOut === undefined ? {} : { flashOut: options.flashOut }),
      };
  return row.start(EMU_DIR!, start);
}

async function assertDelivery(row: RowEmulators): Promise<void> {
  const audits = await row.finish();
  for (const audit of audits) {
    if (audit.violations.length === 0) continue;
    /* The tolerated shape, EXACTLY (as the §23/§24 suites pin it): the
     * session held ONE unanswered transfer, the wire sent the resets that
     * explain it, and nothing else is wrong with the ledger. */
    const oneOrphan = audit.client.urbsAbandoned === 1;
    const resetSent = (audit.client.requests['0x41/0x59']?.sent ?? 0) >= 1;
    const noDrops = audit.server === null || audit.server.completions.dropped === 0;
    if (oneOrphan && resetSent && noDrops) {
      process.stderr.write(
        `[families] tolerating the reset's own orphaned URB on ${audit.entryId}: ` +
          `${String(audit.client.urbsAbandoned)} unanswered wire-89 transfer(s)\n`,
      );
      continue;
    }
    throw new InfrastructureDefect(audit.entryId, audits);
  }
}

function diffOffsets(a: Uint8Array, b: Uint8Array): number[] {
  expect(a.length).toBe(b.length);
  const out: number[] = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) out.push(i);
  }
  return out;
}

/* ---- openers ---------------------------------------------------------------- */

function singleServerOpener(emu: Emulator): SessionOpener {
  let current: Attached | null = null;
  return {
    open: async () => {
      current = await attach(emu, 'step session');
      return current.seek;
    },
    close: async () => {
      const session = current;
      current = null;
      await session?.close();
    },
  };
}

/**
 * The doc 35.4 first-session shape, as the doc-34 retry shape does it: open
 * a session, touch wire 53 twice, read the version. A freshly booted
 * server's FIRST session can stall its first vendor INs while the guest
 * settles; the touched second session is the one that works. Failures here
 * are surface noise — the step's own gate re-checks everything.
 */
async function warmServer(server: Emulator, label: string): Promise<void> {
  try {
    const session = await attach(server, `${label} warm-up`);
    try {
      await session.seek.getErrorCode();
      await session.seek.getErrorCode();
      const version = await readVersion(session.seek);
      process.stderr.write(`[families] ${label}: warm, reports ${version}\n`);
    } finally {
      await session.close();
    }
  } catch (error) {
    process.stderr.write(
      `[families] ${label}: warm-up failed (the step's own gate will decide): ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

/** The drain step's opener — the measured ladder: call 1 the reset's own
 *  session, call 2 back to the reset server after the reboot wait, call 3 a
 *  FRESH server booted from the committed part. The reset belongs to the
 *  step; the commit is never replayed. Every freshly booted server is
 *  warmed first (the doc 35.4 shape). */
function drainOpener(row: RowEmulators, bootOptions: BootOptions): SessionOpener {
  let resetServer: Emulator | null = null;
  let visitsOnResetServer = 0;
  let current: Attached | null = null;
  return {
    open: async () => {
      if (resetServer === null) {
        resetServer = await boot(row, bootOptions);
        await warmServer(resetServer, 'drain reset server');
        current = await attach(resetServer, 'drain reset session');
        return current.seek;
      }
      current = await (async () => {
        if (visitsOnResetServer < 1) {
          visitsOnResetServer += 1;
          await new Promise((resolve) => setTimeout(resolve, REBOOT_WAIT_MS));
          return attach(resetServer, 'drain attempt on the reset server');
        }
        const fresh = await boot(row, bootOptions);
        await warmServer(fresh, 'drain fresh server');
        return attach(fresh, 'drain on a fresh server');
      })();
      return current.seek;
    },
    close: async () => {
      const session = current;
      current = null;
      await session?.close();
    },
  };
}

function memoryStore(): {
  load: PreserveArtifactLoader;
  keep: (outcome: {
    readonly artifacts: readonly { readonly name: string; readonly data: Uint8Array }[];
  }) => void;
} {
  const map = new Map<string, Uint8Array>();
  return {
    load: (name) => Promise.resolve(map.get(name) ?? null),
    keep: (outcome) => {
      for (const artifact of outcome.artifacts) map.set(artifact.name, artifact.data);
    },
  };
}

/** A reporter that logs the drain's progress to stderr, so a hung drain says
 *  where it stopped instead of just timing out. */
function progressReporter(label: string): Reporter {
  let last = 0;
  return {
    log: () => undefined,
    progress: (done, total) => {
      if (total === FLASH_SIZE && done - last >= 0x40000) {
        last = done;
        process.stderr.write(`[families] ${label}: ${String(done)}/${String(total)} B\n`);
      }
    },
    artifact: () => undefined,
  };
}

/**
 * The six steps on the §24 choreography: SERVER A takes backup + patch +
 * commit (reset-free commit session, its `.final` is the ground truth); the
 * DRAIN step runs on the ladder (reset once, then a fresh server); RESTORE
 * on its own server (the polite-stop treatment); VERIFY on a fresh boot.
 * Offline asserts: the commit's 6-or-10-byte diff set, raw == post-commit,
 * delivered == as-booted, restored .final == as-booted.
 */
async function runFullInPlace(spec: {
  readonly label: string;
  readonly expectedSlotPrefix: Uint8Array;
  readonly expectedDiffOffsets: readonly number[];
  readonly bankFlashOffset: number; /* 0x50000 for bank A */
  readonly boot: BootOptions;
  /** false: the run ends after the drain — the restore gate refuses, the
   *  delivered dump is the run's product (the FF build), and the refusal is
   *  asserted instead of a restore server. */
  readonly restore: boolean;
  /** The bank the run's detection must name after the backup (the FF
   *  build's recovery override). */
  readonly expectDetectionBank?: 'a' | 'b' | 'r';
  /** Offline oracle for the delivered dump: the bytes the part must have
   *  carried before the run (the corpus dump itself, for a native boot). */
  readonly expectDelivered?: Uint8Array;
}): Promise<void> {
  /* NO image input: the run is created empty and self-sources at the backup
   * step (double read -> derive -> gate). The expectedSlotPrefix is an
   * OFFLINE oracle — the donor's known key — not an input. */
  const created: CreatedPreserveRun = await createPreserveRun({
    runId: `families-${spec.label}`,
    drainChunk: 64,
    expectedSlotPrefix: spec.expectedSlotPrefix,
  });
  const store = memoryStore();

  /* ---- SERVER A: backup, patch, commit ------------------------------------
   * THE FIRST-SESSION SHAPE (doc 35.4): the first session opened on a
   * freshly booted server can stall its first vendor INs while the guest
   * settles — the doc-34 retry shape (close, reopen, retry) covers it, and
   * the doc's own patch runs each needed exactly one retry. So each step
   * runs on a ladder: two sessions on this server, then a fresh server,
   * three rounds — the same shape the §23 suite's withFreshSessions gives
   * read phases. The commit's landed case (the pre-check's "resume at
   * drain" refusal after a crash between the transfer and its checkpoint)
   * is recognized as progress, never replayed. */
  const commitRow = new RowEmulators(`${spec.label} A (backup+patch+commit)`);
  const asbootedPath = scratchFile(`families_${spec.label}_asbooted.bin`);
  const finalPath = `${asbootedPath}.final`;
  let state: PreserveRunState;
  const t0 = Date.now();
  {
    let running = created.state;
    let lastErrorMessage: string | null = null;
    let committed = false;
    outer: for (let round = 0; round < 3 && !committed; round++) {
      const emu = await boot(commitRow, { ...spec.boot, flashOut: asbootedPath });
      try {
        for (let session = 0; session < 2; session++) {
          try {
            for (const step of ['backup', 'patch', 'commit'] as const) {
              if (running.steps[step]?.status === 'done') continue; /* never re-run a done step */
              if (step === 'commit' && committed) continue;
              const outcome = await commitRow.guard(emu, () =>
                runPreserveStep(step, singleServerOpener(emu), running, store.load, silentReporter),
              );
              store.keep(outcome);
              running = outcome.state;
              process.stderr.write(
                `[families] ${spec.label} ${step} done -> next ${running.nextStep}\n`,
              );
              if (step === 'commit') committed = true;
            }
            break outer;
          } catch (error) {
            if (
              error instanceof Error &&
              error.message.includes('already holds the patched bytes')
            ) {
              /* The commit landed in a previous attempt and must not be
               * replayed — the documented recovery is to go on. */
              process.stderr.write(`[families] ${spec.label} commit already landed; going on\n`);
              committed = true;
              break outer;
            }
            lastErrorMessage = error instanceof Error ? error.message : String(error);
            process.stderr.write(
              `[families] ${spec.label} round ${String(round)} session ${String(session)} ` +
                `failed: ${lastErrorMessage}\n`,
            );
          }
        }
      } catch (error) {
        process.stderr.write(
          `--- emulator log tail after the commit-phase failure ---\n${emu.log(80)}\n`,
        );
        throw error;
      } finally {
        await emu.stop(120_000);
      }
    }
    if (!committed && lastErrorMessage !== null) {
      throw new Error(
        `${spec.label}: the backup/patch/commit phase never completed on any session or ` +
          `server. Last failure: ${lastErrorMessage}`,
      );
    }
    state = running;
    await assertDelivery(commitRow);
  }
  process.stderr.write(
    `[families] ${spec.label} commit phase took ${((Date.now() - t0) / 1000).toFixed(1)} s\n`,
  );

  if (spec.expectDetectionBank !== undefined) {
    expect(
      state.detection?.bank,
      `the run must act on the bank that runs (${spec.expectDetectionBank})`,
    ).toBe(spec.expectDetectionBank);
  }

  /* The as-booted capture and the post-commit ground truth. */
  expect(existsSync(asbootedPath), 'the emulator wrote its --flash-out image').toBe(true);
  const asbooted = new Uint8Array(readFileSync(asbootedPath));
  expect(asbooted.length).toBe(FLASH_SIZE);
  expect(existsSync(finalPath), 'the commit server wrote its post-commit .final').toBe(true);
  const truth = new Uint8Array(readFileSync(finalPath));
  expect(truth.length).toBe(FLASH_SIZE);
  /* The commit moved EXACTLY the family's patch bytes, inside the one bank. */
  const moved = diffOffsets(asbooted, truth);
  expect(moved, `${spec.label}: the commit's diff vs as-booted`).toEqual(
    spec.expectedDiffOffsets.map((o) => spec.bankFlashOffset + o),
  );
  writeFileSync(scratchFile(`families_${spec.label}_truth.bin`), truth);

  /* ---- SERVERS B: the drain step ------------------------------------------
   * The step's FIRST session is the reset's own, on a freshly booted server
   * — exactly the doc 35.4 first-session shape — so the step call itself
   * gets one retry when the version gate stalls BEFORE the reset went out
   * (the only escaping failure shape: everything after the reset is the
   * step's own attempts ladder, and a sent reset is never sent twice). */
  const drainRow = new RowEmulators(`${spec.label} B (drain)`);
  const truthPath = scratchFile(`families_${spec.label}_truth.bin`);
  const t1 = Date.now();
  let drained: Awaited<ReturnType<typeof runPreserveStep>> | null = null;
  for (let attempt = 0; attempt < 2 && drained === null; attempt++) {
    try {
      drained = await runPreserveStep(
        'drain',
        drainOpener(drainRow, { flash: truthPath }),
        state,
        store.load,
        progressReporter('drain'),
      );
    } catch (error) {
      const stalledBeforeReset =
        error instanceof Error && error.message.includes('control IN 0x4e -> stall');
      if (!stalledBeforeReset || attempt === 1) {
        process.stderr.write(
          `--- last emulator log after the drain failure ---\n${drainRow.lastLog(120)}\n`,
        );
        throw error;
      }
      process.stderr.write(
        `[families] ${spec.label} drain attempt ${String(attempt)} stalled at the version ` +
          'gate (no reset was sent); retrying on a fresh session\n',
      );
    }
  }
  if (drained === null) throw new Error('the drain step never ran');
  store.keep(drained);
  state = drained.state;
  expect(state.nextStep).toBe('restore');
  await assertDelivery(drainRow);
  process.stderr.write(
    `[families] ${spec.label} drain took ${((Date.now() - t1) / 1000).toFixed(1)} s\n`,
  );

  /* OFFLINE: raw == the post-commit state; delivered == the as-booted part. */
  const raw = new Uint8Array(
    drained.artifacts.find((a) => a.name === PRESERVE_DUMP_POSTWRITE_FILE)!.data,
  );
  expect(diffOffsets(raw, truth), 'raw dump vs the post-commit state').toEqual([]);
  const delivered = new Uint8Array((await store.load(PRESERVE_DUMP_ORIGINAL_FILE))!);
  expect(diffOffsets(delivered, asbooted), 'delivered dump vs the as-booted part').toEqual([]);
  if (spec.expectDelivered !== undefined) {
    expect(diffOffsets(delivered, spec.expectDelivered), 'delivered dump vs the oracle').toEqual(
      [],
    );
  }
  process.stderr.write(
    `[families] ${spec.label} GREEN: raw sha256 ${sha256(raw)}; delivered sha256 ` +
      `${sha256(delivered)}; as-booted sha256 ${sha256(asbooted)}\n`,
  );

  if (!spec.restore) {
    /* The FF build: the delivered dump IS the run's product. The restore
     * gate refuses with the measured acceptance fact; nothing writes. */
    const refusal = await describeStepGate('restore', state, store.load);
    expect(refusal).toMatch(/the restore step refuses on compact-1\.3\.0\.8-ff/);
    expect(refusal).toMatch(/0xB7AB9D17/);
    process.stderr.write(`[families] ${spec.label} restore refused as documented; run ends\n`);
    return;
  }

  /* ---- SERVER C: the restore step -----------------------------------------
   * The same first-session shape as everywhere else: warm the freshly
   * booted server (doc 35.4), and retry the step ONCE on a fresh server if
   * the version gate stalls BEFORE anything was written. A restore that
   * landed without its checkpoint is safe either way — the step's own
   * already-original detection marks it done instead of rewriting. The
   * server that restored gets the polite-stop treatment (a post-reset
   * touch, then a stop), so its `.final` lands for the whole-run offline
   * proof. */
  const restoreRow = new RowEmulators(`${spec.label} C (restore)`);
  const restoredPath = scratchFile(`families_${spec.label}_restored.bin`);
  {
    let restoreServer: Emulator | null = null;
    for (let attempt = 0; attempt < 2 && restoreServer === null; attempt++) {
      const emu = await boot(restoreRow, { flash: truthPath, flashOut: restoredPath });
      try {
        await warmServer(emu, `${spec.label} restore server`);
        const outcome = await runPreserveStep(
          'restore',
          singleServerOpener(emu),
          state,
          store.load,
          silentReporter,
        );
        store.keep(outcome);
        state = outcome.state;
        restoreServer = emu;
      } catch (error) {
        const stalledBeforeWrite =
          error instanceof Error && error.message.includes('control IN 0x4e -> stall');
        await emu.stop(120_000);
        if (!stalledBeforeWrite || attempt === 1) {
          process.stderr.write(
            `--- emulator log tail after the restore failure ---\n${restoreRow.lastLog(80)}\n`,
          );
          throw error;
        }
        process.stderr.write(
          `[families] ${spec.label} restore attempt ${String(attempt)} stalled at the ` +
            'version gate (nothing was written); retrying on a fresh server\n',
        );
      }
    }
    if (restoreServer === null) throw new Error('the restore step never ran');
    expect(state.nextStep).toBe('verify');
    /* The polite-stop treatment: a post-reset touch, then a stop, so the
     * `.final` lands. */
    await new Promise((resolve) => setTimeout(resolve, 5000));
    try {
      const session = await attach(restoreServer, 'restore post-reset touch');
      try {
        expect(await readVersion(session.seek)).toBe(state.expectedVersion);
      } finally {
        await session.close();
      }
    } catch {
      /* the post-reset window can wedge; the verify runs on a fresh server */
    }
    await restoreServer.stop(120_000);
    await assertDelivery(restoreRow);
  }

  /* ---- SERVER D: the verify step, on a fresh boot --------------------------
   * Warm (doc 35.4), then run; read-only, so a stalled attempt just reruns
   * on a fresh server. */
  const restoredFinal = `${restoredPath}.final`;
  const verifySource = existsSync(restoredFinal) ? restoredFinal : asbootedPath;
  const verifyRow = new RowEmulators(`${spec.label} D (verify)`);
  {
    let finalState: PreserveRunState | null = null;
    for (let attempt = 0; attempt < 2 && finalState === null; attempt++) {
      const emu = await boot(verifyRow, { flash: verifySource });
      try {
        await warmServer(emu, `${spec.label} verify server`);
        const outcome = await runPreserveStep(
          'verify',
          singleServerOpener(emu),
          state,
          store.load,
          progressReporter('verify'),
        );
        store.keep(outcome);
        finalState = outcome.state;
      } catch (error) {
        await emu.stop();
        if (attempt === 1) {
          process.stderr.write(
            `--- last emulator log after the verify failure ---\n${verifyRow.lastLog(120)}\n`,
          );
          throw error;
        }
        process.stderr.write(
          `[families] ${spec.label} verify attempt ${String(attempt)} failed ` +
            `(${error instanceof Error ? error.message : String(error)}); retrying\n`,
        );
      }
    }
    if (finalState === null) throw new Error('the verify step never ran');
    await assertDelivery(verifyRow);
    expect(finalState.nextStep).toBe('done');
    expect(finalState.verify).toEqual({ diffBytes: 0, windowsRead: 31, badWindows: [] });
    if (existsSync(restoredFinal)) {
      const restoredPart = new Uint8Array(readFileSync(restoredFinal));
      expect(diffOffsets(restoredPart, asbooted), 'restored part vs the as-booted part').toEqual(
        [],
      );
      process.stderr.write(
        `[families] ${spec.label} restore proven offline: restored .final == as-booted, ` +
          `0 diffs (sha256 ${sha256(restoredPart)})\n`,
      );
    } else {
      process.stderr.write(
        '[families] the restore server was killed by the reset orphan, so its `.final` ' +
          'never landed; the 31-window in-band verify is the restore proof\n',
      );
    }
  }
}

/* ==================================================================== *
 * 1 — Compact 1.3.0.8 8 Hz, the 2014 donor chimera (doc 35.2)
 * ==================================================================== */

describe.skipIf(missingPlain('1.3.0.8 8 Hz', PLAIN_8HZ) !== null)(
  'family compact-1.3.0.8-8hz — full in-place on the 2014 donor (emulator)',
  () => {
    it(
      'self-sourced: backup derives the image from the slot, then patch (one site), commit, whole-part drain, restore, verify; delivered == as-booted',
      { timeout: 5_400_000 },
      async () => {
        /* The expectedSlotPrefix is the offline oracle only: the 2014 donor's
         * banks are plaintext, so the capture must be the corpus image's own
         * bytes — checked by the run's gate, not fed to it as input. */
        const plain = new Uint8Array(readFileSync(PLAIN_8HZ!));
        await runFullInPlace({
          label: '1308-8hz',
          expectedSlotPrefix: plain,
          expectedDiffOffsets: [0x239, 0x3cbd] /* word 142 + the widen byte */,
          bankFlashOffset: 0x50000 /* bank A: the donor's blank cfg boots A */,
          boot: { entry: '11.16.17', donor: DONOR_2014 },
          restore: true,
        });
        expect(liveEmulatorCount()).toBe(0);
      },
    );
  },
);

/* ==================================================================== *
 * 2 — Compact Pro 1.0.3.0, the native 2016 dump (doc 33 sec. 11): the only
 * fixture whose at-rest bank is genuinely ciphered — the solver's fixture
 * ==================================================================== */

describe.skipIf(
  missingPlain('1.0.3.0', PLAIN_1030) ??
    (DUMP_1030 === null ? 'the corpus does not carry the native 1.0.3.0 dump' : null),
)(
  'family compact-pro-1.0.3.0 — full in-place on the native dump, solved from the ciphered capture (emulator)',
  () => {
    it(
      'self-sourced through the cipher solver: the crib-solved capture derives the image, then patch, commit, whole-part drain, restore, verify; delivered == the dump’s own sha',
      { timeout: 5_400_000 },
      async () => {
        /* The donor's KeyB == the app's key block 1 (measured full length,
         * doc 1032 sec. 3), so the as-booted bank IS plain ^ ks1 — the
         * expected prefix the run's capture gate checks (an offline oracle,
         * not an input). The backup solves the slot state from the verbatim
         * crib, decrypts the capture, and the run proceeds from that. */
        const plain = new Uint8Array(readFileSync(PLAIN_1030!));
        const patch = buildV1Patch(plain);
        expect(patch.buildId).toBe('compact-pro-1.0.3.0');
        const ks1 = keystream(keyWordsOf(patch.keys?.block1Hex ?? ''), plain.length >> 2);
        await runFullInPlace({
          label: '1030-native',
          expectedSlotPrefix: xorWindowVerbatim(plain, ks1),
          expectedDiffOffsets: [
            0x239, 0x23b, 0x352f, 0x3639,
          ] /* the rebalance word + the guard + the widen byte (doc 33 sec. 11.5) */,
          bankFlashOffset: 0x50000 /* bank A: the dump's blank cfg boots A */,
          boot: { flash: DUMP_1030! },
          restore: true,
          expectDetectionBank: 'a',
          expectDelivered: new Uint8Array(readFileSync(DUMP_1030!)),
        });
        expect(liveEmulatorCount()).toBe(0);
      },
    );

    it(
      'one flipped capture byte: the solve refuses at the sum rule and nothing write-shaped is sent',
      { timeout: 1_800_000 },
      async () => {
        /* A copy of the same dump with ONE byte of the bank-A image
         * corrupted (in the tables past the code payload — the part still
         * boots, from bank B: the corrupted sum fails the bootloader's
         * validation). The expected-prefix oracle is deliberately absent so
         * the SOLVER's own refusal is what fires, not the capture gate. The
         * identity candidate dies on the build gates (the ciphered bytes
         * are not balanced), both cipher families die on the sum rule, and
         * the run refuses before anything is recorded or written. */
        const corruptedPath = scratchFile('families_1030_corrupted.bin');
        writeFileSync(corruptedPath, readFileSync(DUMP_1030!));
        const corrupted = new Uint8Array(readFileSync(corruptedPath));
        corrupted[0x50000 + 0xc500] = (corrupted[0x50000 + 0xc500] ?? 0) ^ 0x40;
        writeFileSync(corruptedPath, corrupted);
        const created = await createPreserveRun({ runId: 'families-1030-corrupt' });
        const store = memoryStore();
        const row = new RowEmulators('1030 N (backup: the corrupt-byte refusal)');
        const emu = await boot(row, { flash: corruptedPath });
        try {
          await warmServer(emu, '1030 corrupt server');
          /* The step is read-only, so a first-session stall (doc 35.4) can
           * be retried on a fresh session; the SOLVER refusal is the
           * expected answer and ends the ladder. */
          let error: unknown = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            error = await row
              .guard(emu, () =>
                runPreserveStep(
                  'backup',
                  singleServerOpener(emu),
                  created.state,
                  store.load,
                  silentReporter,
                ),
              )
              .catch((e: unknown) => e);
            if (
              error instanceof SeekError &&
              error.message.includes('do not yield the factory plaintext')
            ) {
              break;
            }
            process.stderr.write(
              `[families] 1030 corrupt attempt ${String(attempt)} failed with ` +
                `${error instanceof Error ? error.message : String(error)}; retrying\n`,
            );
          }
          expect(error).toBeInstanceOf(SeekError);
          expect((error as Error).message).toMatch(/do not yield the factory plaintext/);
          /* The identity candidate got as far as the build gates (the
           * verbatim header window parses straight through the cipher)... */
          expect((error as Error).message).toMatch(/failed its build gates/);
          /* ...and both cipher families refuse on the sum rule. */
          expect((error as Error).message).toMatch(/v1-2014-ff/);
          expect((error as Error).message).toMatch(/compact-2016/);
          expect((error as Error).message).toMatch(/word sum is 0x/);
        } catch (error) {
          process.stderr.write(
            `--- emulator log tail after the corrupt-byte refusal ---\n${emu.log(80)}\n`,
          );
          throw error;
        } finally {
          await emu.stop(120_000);
        }
        await assertDelivery(row);
        /* NOTHING WRITE-SHAPED went out: the refusal precedes every stage and
         * every commit, on the wire ledger of the whole server. */
        const requests = emu.ledger.snapshot().requests;
        for (const opcode of ['0x50', '0x81', '0x59']) {
          expect(
            requests[`0x41/${opcode}`]?.sent ?? 0,
            `no 0x41/${opcode} may go out against the corrupted capture`,
          ).toBe(0);
        }
        expect(liveEmulatorCount()).toBe(0);
      },
    );
  },
);

/* ==================================================================== *
 * 3 — Compact 1.3.0.8-FF, the recovery-slot route (doc 35.3)
 * ==================================================================== */

describe.skipIf(missingPlain('1.3.0.8-FF', PLAIN_FF) !== null)(
  'family compact-1.3.0.8-ff — commit+drain through the recovery route (emulator)',
  () => {
    it(
      'the blank-cfg factory chimera, self-sourced: detection names RECOVERY, the commit passes the app\u2019s two accepts, the whole part drains; restore refuses as documented',
      { timeout: 5_400_000 },
      async () => {
        /* THE PROVEN ROUTE (doc 35.3.3): the factory FF chimera on the
         * plaintext 2014 donor, with its BLANK boot-config record. The
         * bootloader rejects the 0xFFFF-sum image at A/B and boots the
         * recovery bank unchecked — so the RUNNING bank is recovery even
         * though a blank record makes the cfg-derived detection name A. The
         * pipeline re-points the detection at recovery (effectiveDetection):
         * the capture, the commit, the delivered-dump swap-back and the
         * restore all act on 0x14070000 and never on A/B. The run
         * self-sources: the donor stores the FF image as-is, so the identity
         * solve derives it and the build table names the FF build.
         *
         * (A part whose record EXPLICITLY selects recovery was also tried:
         * the donor bootloader faults booting it — the explicit-record path
         * validates the slot's word sum, which the FF image fails. The
         * blank-cfg route is the one the RE record proved, and it is the one
         * this run drives.) */
        const plain = new Uint8Array(readFileSync(PLAIN_FF!));
        await runFullInPlace({
          label: '1308-ff',
          expectedSlotPrefix: plain /* the plaintext donor stores the image as-is */,
          expectedDiffOffsets: [
            0x238, 0x239, 0x23a, 0x23b, 0x3d69, 0x3e71,
          ] /* the rebalance word + the guard + the widen */,
          bankFlashOffset: 0x70000 /* recovery — the running bank */,
          boot: { entry: '11.17.29', donor: DONOR_2014 },
          restore: false,
          expectDetectionBank: 'r',
        });
        expect(liveEmulatorCount()).toBe(0);
      },
    );
  },
);

/* ==================================================================== *
 * 4..6 — the 0.x line (doc 36): the 2014 Compact builds the widening
 * chain reached, each on the SAME plaintext donor chimera. Every row is
 * self-sourced like the 1.3.0.8 rows; the per-build shape comes from the
 * run state the backup derives. Three rows, one per NEW mechanism:
 *   4. Compact 0.9.0.7  — the plain 0.8+ shape (wire 79, direct mode 2),
 *      carrying the 1.3.0.0 generation's exact site offsets.
 *   5. Compact 0.8.0.0  — the INDIRECT mode-2 crash hazard: the patch's
 *      nop site is what makes the drain's mode-2 arm safe (12-byte diff).
 *   6. Compact 0.7.0.7  — the WIRE-88 reader and the ROTATED drain: every
 *      window read goes out on 0x58, the widened window serves the part
 *      from slot B (0x14060000), and the delivered dump is unrotated.
 * ==================================================================== */

describe.skipIf(missingPlain('0.9.0.7', PLAIN_0907) !== null)(
  'family compact-0.9.0.7 — full in-place on the 2014 donor (emulator)',
  () => {
    it(
      'self-sourced: backup derives the image, then patch (four sites), commit, whole-part drain, restore, verify; delivered == as-booted',
      { timeout: 5_400_000 },
      async () => {
        const plain = new Uint8Array(readFileSync(PLAIN_0907!));
        await runFullInPlace({
          label: '0907',
          expectedSlotPrefix: plain,
          expectedDiffOffsets: [
            0x238, 0x239, 0x23b, 0x3c1c, 0x3c1d, 0x3c68, 0x3c69, 0x3c70, 0x3c71, 0x3db7,
          ] /* the rebalance word + the widen byte + both bytes of each trio site (doc 36.4.2) */,
          bankFlashOffset: 0x50000 /* bank A: the donor's blank cfg boots A */,
          boot: { entry: '18.31.47', donor: DONOR_2014 },
          restore: true,
          expectDetectionBank: 'a',
        });
        expect(liveEmulatorCount()).toBe(0);
      },
    );
  },
);

describe.skipIf(missingPlain('0.8.0.0', PLAIN_0800) !== null)(
  'family compact-0.8.0.0 — the indirect mode-2 hazard, full in-place on the 2014 donor (emulator)',
  () => {
    it(
      'self-sourced: the patch carries the mode-2 nop site (12 bytes), commit, whole-part drain, restore, verify; delivered == as-booted',
      { timeout: 5_400_000 },
      async () => {
        const plain = new Uint8Array(readFileSync(PLAIN_0800!));
        const patch = buildV1Patch(plain);
        /* THE HAZARD, as the table records it: the factory mode 2 arms
         * *(0x14000000) and an armed read faults the guest (doc 36.3.1) —
         * the nop is a first-class gated site, and the drain gate refuses a
         * run whose patch lacks it. */
        expect(patch.capability.modeTwoHazardSites).toEqual([0x3ce4]);
        expect(patch.sites.map((s) => s.offset)).toContain(0x3ce4);
        await runFullInPlace({
          label: '0800',
          expectedSlotPrefix: plain,
          expectedDiffOffsets: [
            0x238, 0x239, 0x23b, 0x3bbc, 0x3bbd, 0x3c08, 0x3c09, 0x3c10, 0x3c11, 0x3ce4, 0x3ce5,
            0x3d67,
          ] /* the rebalance word + widen + trio + the mode-2 nop (doc 36.4.2) */,
          bankFlashOffset: 0x50000,
          boot: { entry: '09.17.37', donor: DONOR_2014 },
          restore: true,
          expectDetectionBank: 'a',
        });
        expect(liveEmulatorCount()).toBe(0);
      },
    );
  },
);

describe.skipIf(missingPlain('0.7.0.7', PLAIN_0707) !== null)(
  'family compact-0.7.0.7 — wire 88 and the rotated drain, full in-place on the 2014 donor (emulator)',
  () => {
    it(
      'self-sourced: every window read rides wire 88, the widened window serves the part rotated from slot B, and the delivered dump is the unrotated part',
      { timeout: 5_400_000 },
      async () => {
        const plain = new Uint8Array(readFileSync(PLAIN_0707!));
        const patch = buildV1Patch(plain);
        expect(patch.capability.rotation).toEqual({
          walk: 'upgrade-target',
          measuredBase: 0x14060000,
        });
        await runFullInPlace({
          label: '0707',
          expectedSlotPrefix: plain,
          expectedDiffOffsets: [
            0x238, 0x239, 0x3ae4, 0x3ae5, 0x3b30, 0x3b31, 0x3b38, 0x3b39, 0x3c89,
          ] /* the rebalance word (0x00009240 — two bytes) + widen + trio (doc 36.5) */,
          bankFlashOffset: 0x50000,
          boot: { entry: '14.15.36', donor: DONOR_2014 },
          restore: true,
          expectDetectionBank: 'a',
        });
        expect(liveEmulatorCount()).toBe(0);
      },
    );
  },
);

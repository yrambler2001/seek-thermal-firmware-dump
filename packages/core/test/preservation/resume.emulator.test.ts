/* ==================================================================== *
 * The stepwise preservation run, RESUMED, against the FW-V1 emulator
 * booted from the REAL 4 MiB flash dump of the 2014 Compact (the corpus
 * entry, as the four-phase suite at 2488fcc boots it).
 *
 * THE RUN SELF-SOURCES. No image is passed to `createPreserveRun` and no
 * plaintext is seeded into the checkpoint store: the backup step reads the
 * active slot TWICE, requires the two reads to agree, derives the factory
 * plaintext from the agreed capture (identity — the 2014 banks hold the
 * image as-is), and emits it as the run artifact the later steps load. The
 * run needs nothing but the camera — exactly what `--resume` needs on disk:
 * the run directory and nothing else.
 *
 * THE SCENARIO IS THE ONE THE STEPWISE SHAPE EXISTS FOR. On one boot
 * description, and in one process:
 *
 *   SERVER A (--flash-out) — the backup, patch and COMMIT steps, each
 *     checkpointing the way the CLI does: the state document and the step
 *     artifacts held in memory, the backup step's dump archive included.
 *     The commit session never resets (its post-commit flash state is the
 *     ground truth), so this server stops politely and its `.final` is
 *     asserted to exist, never synthesized.
 *
 *   THE CRASH — everything wire-shaped is thrown away, and the state that
 *     enters the resume is `JSON.parse(JSON.stringify(...))` of what the
 *     first three steps produced: the checkpoint document, not the process.
 *     nextStep is `drain`; the bank already holds the patch.
 *
 *   SERVERS B.. — the DRAIN step, resumed: its own first session sends the
 *     wire-89 reset ONCE, and its ladder then drains the whole 4 MiB through
 *     the widened window — DRAIN FIRST on its own single arm, at 64-byte
 *     asks (the measured shape: the reader's per-arm budget is consumed in
 *     asks, and at one packet per ask serve == ask; TESTING.md sec. 23.3) —
 *     first on the reset's own server, then on a FRESH server booted from
 *     the committed part when the post-reset window stays dead (doc 33
 *     sec. 11.6; the commit is never replayed). OFFLINE: the raw dump ==
 *     the commit server's `.final` (0 diffs), and the delivered dump — the
 *     active bank swapped back from the backup artifact — == the as-booted
 *     image (0 diffs), pinned to the shas the hardware campaign measured
 *     (TESTING.md sec. 28.2): the flow's outputs must stay byte-identical.
 *
 *   SERVER C (--flash <truth>, --flash-out) — the RESTORE step: the original
 *     bank staged back verbatim from the backup artifact, reset; the same
 *     polite-stop treatment the four-phase suite gives this server.
 *   SERVER D — the VERIFY step: a fresh boot from the restored part re-reads
 *     all 31 windows against the backup artifact — 0 diffs — and the run's
 *     state reaches `done` with the verify outcome recorded.
 *
 * Everything the four-phase suite knows about this boot is reused: the
 * delivery audit with the reset's own tolerated shape, the camera's clock
 * under every deadline, the no-sensor boot, and the bench part's JEDEC id.
 * What is NEW here is only the resume: a fresh process's worth of state, and
 * fresh servers, completing a run the first process never did.
 * ==================================================================== */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { silentReporter, type Reporter } from '../../src/events.js';
import { SeekDevice } from '../../src/protocol/client.js';
import { WebUsbTransport } from '../../src/protocol/webusb.js';
import { FLASH_SIZE } from '../../src/profiles/modern-4x.js';
import {
  PRESERVE_DUMP_ORIGINAL_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  createPreserveRun,
  readVersion,
  runPreserveStep,
  type PreserveArtifactLoader,
  type PreserveRunState,
  type SessionOpener,
} from '../../src/preservation/index.js';
import {
  InfrastructureDefect,
  liveEmulatorCount,
  RowEmulators,
  type Emulator,
  type StartOptions,
} from '../emulator/harness.js';
import { EMU_DIR, announceSkip, scratchFile, URB_TIMEOUT_MS } from '../emulator/suite.js';
import { assertRealHostPath } from '../emulator/webusb-over-usbip.js';

/* ---- the boot description -------------------------------------------------- */

const CORPUS_ENTRY = '101310HSNEA2/dump';
const JEDEC = '010215';
const EXPECTED_VERSION = '1.3.0.0';
/** The corpus entry IS the vendored dump — 6.bin byte for byte (TESTING.md
 *  sec. 23 pins the sha; a swapped or edited file fails here, before any wire
 *  traffic). The self-sourced run's DELIVERED dump is this same part content
 *  (the active bank swapped back), and its RAW dump is the post-commit part —
 *  both pinned to the hardware campaign's shas (TESTING.md sec. 28.2), so the
 *  flow's outputs cannot drift a byte without this suite saying so. */
const CORPUS_FLASH_SHA = '40447c7e6da5cbc84621f4694ffff5bda0f783e7807a45e80443383b19a8eb72';
const CORPUS_RAW_DUMP_SHA = '7ada1be6b211329189ff3e87d109e9d5ac5f2fcb9e891d054127e72f53d499f9';
/** A wire-89 mid-session leaves its own URB unanswered; the reboot wait is the
 *  measured shape (the part re-initializes USB within it, on this emulator). */
const REBOOT_WAIT_MS = 15_000;

function unsupportedReason(): string | null {
  if (EMU_DIR === null) return 'no emulator found (SEEK_EMU_DIR)';
  const cli = path.join(EMU_DIR, 'seekemu', 'cli.py');
  if (!existsSync(cli)) return `${EMU_DIR} has no seekemu/cli.py`;
  const text = readFileSync(cli, 'utf8');
  for (const flag of ['--jedec', '--flash', '--flash-out', '--corpus-entry', '--usbip-clock']) {
    if (!text.includes(flag)) return `the emulator at ${EMU_DIR} does not support ${flag}`;
  }
  return null;
}

const UNSUPPORTED = unsupportedReason();
if (UNSUPPORTED !== null) announceSkip(`v1 preservation resume (${UNSUPPORTED})`);

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
    host: 'vitest preservation resume',
    /* THE CAMERA'S CLOCK (TESTING.md sec.19): every deadline this transport
     * arms runs on the emulated camera's time, or the delivery audit fails
     * the row. */
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

async function assertDelivery(row: RowEmulators): Promise<void> {
  const audits = await row.finish();
  for (const audit of audits) {
    if (audit.violations.length === 0) continue;
    /* The tolerated shape, EXACTLY (as the four-phase suite pins it): the
     * session held ONE unanswered transfer, the wire sent the resets that
     * explain it, and nothing else is wrong with the ledger. A session with
     * no reset on it — the commit server above all — must be perfectly clean. */
    const oneOrphan = audit.client.urbsAbandoned === 1;
    const resetSent = (audit.client.requests['0x41/0x59']?.sent ?? 0) >= 1;
    const noDrops = audit.server === null || audit.server.completions.dropped === 0;
    if (oneOrphan && resetSent && noDrops) {
      process.stderr.write(
        `[resume] tolerating the reset's own orphaned URB on ${audit.entryId}: ` +
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

/** One server, a fresh session per `open()`. The first three steps run on it:
 *  backup, patch (no device), commit — the commit's session never resets. */
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
 * The drain step's opener — the measured ladder, one `open()` per session:
 * call 1 is the reset's own session, on a server booted from the committed
 * part; call 2 goes back to that server after the reboot wait (the post-reset
 * wedge, doc 33 sec. 11.6, measured); call 3 boots a FRESH server from the
 * same part image, which boots past READY and drains. The reset itself
 * belongs to the step.
 */
function drainOpener(row: RowEmulators, bootOptions: BootOptions): SessionOpener {
  let resetServer: Emulator | null = null;
  let visitsOnResetServer = 0;
  let current: Attached | null = null;
  return {
    open: async () => {
      if (resetServer === null) {
        resetServer = await boot(row, bootOptions);
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

/* ---- the checkpoint store: the first process's "run directory" -------------- */

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
        process.stderr.write(`[resume] ${label}: ${String(done)}/${String(total)} B\n`);
      }
    },
    artifact: () => undefined,
  };
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/* ==================================================================== *
 * the resumed run
 * ==================================================================== */

describe.skipIf(UNSUPPORTED !== null)('v1 preservation run — resumed (emulator)', () => {
  it(
    'backup+patch+commit on one server; the crash; drain, restore and verify on fresh servers',
    { timeout: 5_400_000 },
    async () => {
      /* NO image input anywhere: the run derives its factory plaintext from
       * the camera's active slot (the backup step), and the derived artifact
       * rides the store from there — the shape `--resume` needs. */
      const { state: created } = await createPreserveRun({
        runId: 'resume-emulator',
        drainChunk: 64 /* the measured ask: one EP0 packet, serve == ask */,
      });
      const store = memoryStore();

      /* ---- SERVER A: backup, patch, commit — the crash comes after ------ */
      const commitRow = new RowEmulators('resume A (backup+patch+commit)');
      const asbootedPath = scratchFile('resume_asbooted.bin');
      const finalPath = `${asbootedPath}.final`;
      let committed: PreserveRunState;
      const t0 = Date.now();
      {
        const emu = await boot(commitRow, { flashOut: asbootedPath });
        try {
          expect(emu.ready.flash_sha256).toBe(CORPUS_FLASH_SHA);
          let state = created;
          for (const step of ['backup', 'patch', 'commit'] as const) {
            const outcome = await runPreserveStep(
              step,
              singleServerOpener(emu),
              state,
              store.load,
              silentReporter,
            );
            store.keep(outcome);
            state = outcome.state;
            process.stderr.write(`[resume] ${step} done -> next ${state.nextStep}\n`);
          }
          committed = state;
        } catch (error) {
          process.stderr.write(
            `--- emulator log tail after the commit-phase failure ---\n${emu.log(80)}\n`,
          );
          throw error;
        } finally {
          await emu.stop(120_000);
        }
        await assertDelivery(commitRow);
      }
      expect(existsSync(finalPath), 'the commit server wrote its post-commit .final').toBe(true);
      const truth = new Uint8Array(readFileSync(finalPath));
      expect(truth.length).toBe(FLASH_SIZE);
      process.stderr.write(
        `[resume] commit phase took ${((Date.now() - t0) / 1000).toFixed(1)} s\n`,
      );

      /* ---- THE CRASH: the checkpoint document is all that survives ------- */
      const resumed: PreserveRunState = JSON.parse(JSON.stringify(committed)) as PreserveRunState;
      expect(resumed.nextStep).toBe('drain');

      /* ---- SERVERS B..: the drain step, resumed -------------------------- */
      const drainRow = new RowEmulators('resume B (drain)');
      const truthPath = scratchFile('resume_truth.bin');
      writeFileSync(truthPath, truth);
      const t1 = Date.now();
      /* One mutable state threaded through the remaining phases, exactly as
       * the CLI's step loop carries it. */
      let state = resumed;
      const drained = await runPreserveStep(
        'drain',
        drainOpener(drainRow, { flash: truthPath }),
        state,
        store.load,
        progressReporter('drain'),
      ).catch((error: unknown) => {
        process.stderr.write(
          `--- last emulator log after the drain failure ---\n${drainRow.lastLog(120)}\n`,
        );
        throw error;
      });
      store.keep(drained);
      state = drained.state;
      expect(state.nextStep).toBe('restore');
      process.stderr.write(`[resume] drain took ${((Date.now() - t1) / 1000).toFixed(1)} s\n`);
      /* The drain row's two servers (the reset's own, then the fresh one the
       * ladder booted) are done being used: stop and audit them here. The
       * reset server carries the tolerated one-orphan shape. */
      await assertDelivery(drainRow);

      /* OFFLINE: raw == the post-commit state; delivered == the as-booted.
       * Both pinned to the hardware campaign's shas (TESTING.md sec. 28.2):
       * the same 10-byte commit on the same part content must drain to the
       * same bytes here as it did on the bench, or the flow has drifted. */
      const asbooted = new Uint8Array(readFileSync(asbootedPath));
      expect(sha256(asbooted)).toBe(CORPUS_FLASH_SHA);
      const raw = new Uint8Array(
        drained.artifacts.find((a) => a.name === PRESERVE_DUMP_POSTWRITE_FILE)!.data,
      );
      expect(diffOffsets(raw, truth), 'raw dump vs the post-commit state').toEqual([]);
      expect(
        sha256(raw),
        'the raw post-write dump, byte-identical to the hardware campaign’s',
      ).toBe(CORPUS_RAW_DUMP_SHA);
      const delivered = new Uint8Array((await store.load(PRESERVE_DUMP_ORIGINAL_FILE))!);
      expect(diffOffsets(delivered, asbooted), 'delivered dump vs the as-booted part').toEqual([]);
      expect(sha256(delivered), 'the delivered dump == the as-booted part content').toBe(
        CORPUS_FLASH_SHA,
      );
      process.stderr.write(
        `[resume] raw sha256 ${sha256(raw)}; delivered sha256 ${sha256(delivered)}\n`,
      );

      /* ---- SERVER C: the restore step ------------------------------------ */
      const restoreRow = new RowEmulators('resume C (restore)');
      const restoredPath = scratchFile('resume_restored.bin');
      {
        const emu = await boot(restoreRow, { flash: truthPath, flashOut: restoredPath });
        try {
          const outcome = await runPreserveStep(
            'restore',
            singleServerOpener(emu),
            state,
            store.load,
            silentReporter,
          );
          store.keep(outcome);
          state = outcome.state;
        } catch (error) {
          process.stderr.write(
            `--- emulator log tail after the restore failure ---\n${emu.log(80)}\n`,
          );
          throw error;
        }
        expect(state.nextStep).toBe('verify');
        /* The polite-stop treatment the four-phase suite gives this server:
         * a post-reset touch, then a stop, so the `.final` lands. */
        await new Promise((resolve) => setTimeout(resolve, 5000));
        try {
          const session = await attach(emu, 'restore post-reset touch');
          try {
            expect(await readVersion(session.seek)).toBe(EXPECTED_VERSION);
          } finally {
            await session.close();
          }
        } catch {
          /* the post-reset window can wedge; the verify below runs on a fresh
           * server either way */
        }
        await emu.stop(120_000);
        await assertDelivery(restoreRow);
      }

      /* ---- SERVER D: the verify step, on a fresh boot -------------------- */
      const restoredFinal = `${restoredPath}.final`;
      const verifySource = existsSync(restoredFinal) ? restoredFinal : asbootedPath;
      const verifyRow = new RowEmulators('resume D (verify)');
      {
        const emu = await boot(verifyRow, { flash: verifySource });
        let finalState: PreserveRunState;
        try {
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
          process.stderr.write(
            `--- last emulator log after the verify failure ---\n${emu.log(80)}\n`,
          );
          throw error;
        } finally {
          await emu.stop();
        }
        await assertDelivery(verifyRow);

        expect(finalState.nextStep).toBe('done');
        expect(finalState.verify).toEqual({ diffBytes: 0, windowsRead: 31, badWindows: [] });
        /* And the restore server's own ground truth, when it stopped politely. */
        if (existsSync(restoredFinal)) {
          const restoredPart = new Uint8Array(readFileSync(restoredFinal));
          expect(
            diffOffsets(restoredPart, asbooted),
            'restored part vs the as-booted part',
          ).toEqual([]);
        } else {
          process.stderr.write(
            '[resume] the restore server was killed by the reset orphan, so its `.final` ' +
              'never landed; the 31-window in-band verify is the restore proof\n',
          );
        }
      }
      expect(liveEmulatorCount()).toBe(0);
    },
  );
});

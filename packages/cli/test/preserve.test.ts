/**
 * `seek-fw preserve`, stepwise: the checkpointing, the resume and the gates.
 *
 * Every test here runs the REAL command against core's fake camera wired as a
 * v1 locked-line part — blank boot-config record, factory plaintext in bank A,
 * the selector map the pipeline arms, mode 2 widened to the whole part. That
 * is the same shape the emulator suite proves end to end; what the CLI tests
 * add is the run directory: a checkpoint after every step, a resume from a run
 * the drain killed, a `--from-step` that refuses on a torn directory, and a
 * `--print-state` that says which checkpoint files still match.
 *
 * THE RUN SELF-SOURCES: no test passes an image. The command takes no
 * positional at all — the backup step derives the factory plaintext from the
 * camera's active slot (two agreeing reads), writes it into the run directory
 * as `preserve_image_plain.bin`, and every later step loads it from there.
 * The migration shape a version-1 run directory left behind (its plaintext
 * lived outside the directory) is tested too.
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FLASH_SIZE,
  PRESERVE_BANK_CAPTURE_FILE,
  PRESERVE_BACKUP_FILE,
  PRESERVE_DUMP_ORIGINAL_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  PRESERVE_PATCHED_FILE,
  PRESERVE_PLAIN_NAME,
  PRESERVE_RUN_STATE_FILE,
  REBALANCE_WORD_OFFSET,
  V1_2014_PATCH_SITES,
  sha256hex,
  wordSum,
  type PreserveRunState,
  type UsbBackend,
} from '@seek-fw/core';
import { FakeCamera, type FakeWindowSpec } from '../../core/test/fake-transport.js';
import type { StallPoint } from '../../core/test/fake-transport.js';
import { run } from '../src/cli.js';
import { EXIT_CANCELLED, EXIT_FAILED, EXIT_OK, EXIT_USAGE } from '../src/errors.js';
import { fixedBackend, tempDir, testIo } from './helpers.js';
import type { BackendOptions } from '../src/backend.js';

let dir = '';
let cleanup: () => Promise<void> = (): Promise<void> => Promise.resolve();

beforeEach(async () => {
  const temp = await tempDir();
  dir = temp.path;
  cleanup = temp.cleanup;
});
afterEach(async () => {
  await cleanup();
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

/* ---- the synthetic factory plaintext (the patch sites included) --------- */

const IMAGE_LENGTH = 0x4000;
const VERSION_WORD = 0x0000_0301; /* -> "1.3.0.0" */
const EXPECTED_VERSION = '1.3.0.0';
const BANK_A_OFFSET = 0x50000;

function syntheticPlain(): Uint8Array {
  const bytes = new Uint8Array(IMAGE_LENGTH);
  let state = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  for (const site of V1_2014_PATCH_SITES) bytes.set(site.before, site.offset);
  const dv = new DataView(bytes.buffer);
  bytes[REBALANCE_WORD_OFFSET] = 0;
  bytes[REBALANCE_WORD_OFFSET + 1] = 0;
  bytes[REBALANCE_WORD_OFFSET + 2] = 0;
  bytes[REBALANCE_WORD_OFFSET + 3] = 0;
  dv.setUint32(0x200, 0xa1b2c3d4, true);
  dv.setUint32(0x204, IMAGE_LENGTH, true);
  dv.setUint32(0x20c, VERSION_WORD, true);
  const scratch = 0x3ff0;
  dv.setUint32(scratch, 0, true);
  dv.setUint32(scratch, (0 - wordSum(bytes)) >>> 0, true);
  if (wordSum(bytes) !== 0) throw new Error('fixture is not balanced');
  return bytes;
}

/* ---- the fake v1 camera -------------------------------------------------- */

function v1WindowMap(): FakeWindowSpec[] {
  const windows: FakeWindowSpec[] = [{ subcmd: 2, offset: 0, size: FLASH_SIZE }];
  for (let mode = 3; mode <= 9; mode++) {
    windows.push({ subcmd: mode, offset: (mode - 2) * 0x10000 });
  }
  for (let mode = 0x0a; mode <= 0x21; mode++) {
    windows.push({ subcmd: mode, offset: 0x80000 + (mode - 0x0a) * 0x10000 });
  }
  return windows;
}

function v1Camera(
  plain: Uint8Array,
  options: {
    readonly flash?: Uint8Array;
    readonly stallDrain?: boolean;
    readonly stallAt?: readonly StallPoint[];
  } = {},
): FakeCamera {
  const flash =
    options.flash ??
    (() => {
      const bytes = new Uint8Array(FLASH_SIZE).fill(0xff);
      new DataView(bytes.buffer).setUint32(0x10000, 0xffffffff, true); /* blank cfg -> bank A */
      bytes.set(plain, BANK_A_OFFSET);
      return bytes;
    })();
  const stallAt: readonly StallPoint[] | undefined =
    /* the widened window never answers, for the stallDrain shape */
    options.stallAt ?? (options.stallDrain === true ? [{ subcmd: 2, offset: 0 }] : undefined);
  return new FakeCamera({
    flash,
    windows: v1WindowMap(),
    authBanks: [3, 4, 5, 6, 7, 8, 9],
    fwInfo: new Map([[0, Uint8Array.from([1, 3, 0, 0, 0, 0, 0, 0])]]),
    ...(stallAt === undefined ? {} : { stallAt }),
  });
}

const backendOf = (camera: FakeCamera): ((options: BackendOptions) => UsbBackend) =>
  fixedBackend([camera]);

function runDir(name = 'run'): string {
  return join(dir, name);
}

async function loadState(name = 'run'): Promise<PreserveRunState> {
  return JSON.parse(
    await readFile(join(runDir(name), PRESERVE_RUN_STATE_FILE), 'utf8'),
  ) as PreserveRunState;
}

async function saveState(name: string, state: PreserveRunState): Promise<void> {
  await writeFile(
    join(runDir(name), PRESERVE_RUN_STATE_FILE),
    `${JSON.stringify(state, null, 2)}\n`,
  );
}

/** The version-1 shape of a state document: the older schema, whose plaintext
 *  lived outside the run directory. */
function asVersion1(state: PreserveRunState): PreserveRunState {
  const v1: PreserveRunState & { imageSource?: unknown; slotReadShas?: unknown } = JSON.parse(
    JSON.stringify(state),
  );
  v1.version = 1;
  delete v1.imageSource;
  delete v1.slotReadShas;
  return v1;
}

/* ==================================================================== *
 * a fresh run, checkpointed
 * ==================================================================== */

describe('preserve — a fresh run, checkpointed after every step', () => {
  it(
    'runs all six steps self-sourced and leaves a complete run directory',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      const camera = v1Camera(plain);
      const asBooted = new Uint8Array(camera.flash);
      const test = testIo({ backend: backendOf(camera) });
      const code = await run(['preserve', '--out', runDir(), '--yes', '--json'], test.io, signal());
      expect(code).toBe(EXIT_OK);

      const state = await loadState();
      expect(state.version).toBe(2);
      expect(state.imageSource).toBe('device');
      expect(state.nextStep).toBe('done');
      expect(state.expectedVersion).toBe(EXPECTED_VERSION);
      expect(state.imageSha256).toBe(await sha256hex(plain));
      /* The double read: both shas recorded, and agreeing — the shas are of
       * the whole 64 KiB slot capture (the image plus its erased tail). */
      const bankWindow = new Uint8Array(0x10000).fill(0xff);
      bankWindow.set(plain, 0);
      const captureSha = await sha256hex(bankWindow);
      expect(state.slotReadShas).toHaveLength(2);
      expect(state.slotReadShas?.[0]).toBe(captureSha);
      expect(state.slotReadShas?.[1]).toBe(captureSha);
      for (const step of ['backup', 'patch', 'commit', 'drain', 'restore', 'verify'] as const) {
        expect(state.steps[step]?.status, `${step} done`).toBe('done');
      }
      expect(state.steps.commit?.notes).toMatch(/no reset sent in this session/);
      expect(state.verify).toEqual({ diffBytes: 0, windowsRead: 31, badWindows: [] });

      /* The checkpoint files are all there — the derived factory plaintext
       * among them — and the shas are as recorded. */
      for (const name of [
        PRESERVE_BACKUP_FILE,
        PRESERVE_BANK_CAPTURE_FILE,
        PRESERVE_PLAIN_NAME,
        PRESERVE_PATCHED_FILE,
        PRESERVE_DUMP_POSTWRITE_FILE,
        PRESERVE_DUMP_ORIGINAL_FILE,
        'manifest.json',
        'README.md',
      ]) {
        const bytes = await readFile(join(runDir(), name));
        const recorded = Object.values(state.steps)
          .flatMap((record) => Object.entries(record.artifactShas ?? {}))
          .filter(([entryName]) => entryName === name)
          .map(([, sha]) => sha)
          .at(-1);
        expect(recorded, `${name} recorded`).toBeDefined();
        expect(await sha256hex(new Uint8Array(bytes)), name).toBe(recorded);
      }
      /* The derived plaintext artifact IS the camera's slot A content. */
      const derived = await readFile(join(runDir(), PRESERVE_PLAIN_NAME));
      expect(await sha256hex(new Uint8Array(derived))).toBe(await sha256hex(plain));
      /* The dump archive's decrypted slots came along. */
      const decrypted = (await readdir(join(runDir(), 'decrypted'))).length;
      expect(decrypted).toBeGreaterThan(0);

      /* The delivered dump is the camera's original content; the part was
       * restored underneath the run. */
      const delivered = await readFile(join(runDir(), PRESERVE_DUMP_ORIGINAL_FILE));
      expect(await sha256hex(new Uint8Array(delivered))).toBe(await sha256hex(asBooted));
      expect(await sha256hex(camera.flash)).toBe(await sha256hex(asBooted));

      /* The --json document names the run, its self-sourced image, and the
       * double read's shas. */
      const document = JSON.parse(test.stdout.text) as {
        image: { source: string; version: string; sha256: string };
        run: { nextStep: string; id: string };
        sha256: { slotReads: string[]; deliveredDump: string };
      };
      expect(document.run.nextStep).toBe('done');
      expect(document.image).toEqual({
        source: 'device',
        version: EXPECTED_VERSION,
        sha256: await sha256hex(plain),
      });
      expect(document.sha256.slotReads).toEqual([captureSha, captureSha]);
      expect(document.sha256.deliveredDump).toBe(await sha256hex(asBooted));

      /* The plan prints twice — on the human stream (stderr under --json):
       * the generic one before the camera is touched, and the derived one
       * after the patch step, before the first write. */
      expect(test.stderr.text).toMatch(/read from the camera.s active slot, two agreeing reads/);
      expect(test.stderr.text).toMatch(/derived from the camera/);
      expect(test.stderr.text).toMatch(/v1 2014 chain/);
      expect(test.stderr.text).toMatch(/bytes that move\s+10 on the part/);
    },
  );

  it(
    'writes no temporary files behind: every checkpoint write is a rename',
    { timeout: 180_000 },
    async () => {
      const camera = v1Camera(syntheticPlain());
      await run(
        ['preserve', '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        signal(),
      );
      const names = await readdir(runDir());
      expect(names.filter((name) => name.includes('.tmp-'))).toEqual([]);
    },
  );

  it(
    'refuses a second fresh run into a directory that already holds one',
    { timeout: 180_000 },
    async () => {
      const camera = v1Camera(syntheticPlain());
      const args = ['preserve', '--out', runDir(), '--yes'];
      expect(await run(args, testIo({ backend: backendOf(camera) }).io, signal())).toBe(EXIT_OK);
      const second = testIo({ backend: backendOf(camera) });
      expect(await run(args, second.io, signal())).toBe(EXIT_FAILED);
      expect(second.stderr.text).toMatch(/already holds a preserve_run\.json .* --resume/);
    },
  );

  it(
    'an interactive run confirms twice — before the camera, and at the derived plan, before the first write',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      const camera = v1Camera(plain);
      const asBooted = new Uint8Array(camera.flash);
      /* Decline at the first prompt: nothing runs, nothing exists. */
      const declined = testIo({ backend: backendOf(camera), answer: false, stdinIsTty: true });
      expect(await run(['preserve', '--out', runDir()], declined.io, signal())).toBe(EXIT_FAILED);
      expect(declined.stderr.text).toMatch(
        /aborted at the confirmation prompt — nothing was written/,
      );
      expect(declined.questions).toHaveLength(1);

      /* Accept both: the run completes, and the second question is the one at
       * the derived plan, naming the write it gates. */
      const accepted = testIo({ backend: backendOf(camera), answer: true, stdinIsTty: true });
      expect(await run(['preserve', '--out', runDir()], accepted.io, signal())).toBe(EXIT_OK);
      expect(accepted.questions).toHaveLength(2);
      expect(accepted.questions[1]).toMatch(/Proceed to the commit/);
      expect((await loadState()).nextStep).toBe('done');
      const delivered = await readFile(join(runDir(), PRESERVE_DUMP_ORIGINAL_FILE));
      expect(await sha256hex(new Uint8Array(delivered))).toBe(await sha256hex(asBooted));

      /* Decline at the SECOND prompt instead: the backup and the derived plan
       * are checkpointed, the camera is untouched (the commit is the first
       * write, and it never ran), and a --resume finishes the run. */
      const midCamera = v1Camera(plain);
      const midRun = runDir('midrun');
      const partial = testIo({
        backend: backendOf(midCamera),
        answers: [true, false],
        stdinIsTty: true,
      });
      expect(await run(['preserve', '--out', midRun], partial.io, signal())).toBe(EXIT_FAILED);
      expect(partial.stderr.text).toMatch(/aborted at the plan prompt — nothing was written/);
      const torn: PreserveRunState = JSON.parse(
        await readFile(join(midRun, PRESERVE_RUN_STATE_FILE), 'utf8'),
      ) as PreserveRunState;
      expect(torn.nextStep).toBe('commit');
      expect(await sha256hex(midCamera.flash)).toBe(await sha256hex(asBooted));
      const resumed = testIo({ backend: backendOf(midCamera) });
      expect(await run(['preserve', '--resume', midRun, '--yes'], resumed.io, signal())).toBe(
        EXIT_OK,
      );
      expect((await loadState('midrun')).nextStep).toBe('done');
    },
  );

  it(
    'writes the initial checkpoint before the first step, so an early abort is resumable',
    { timeout: 180_000 },
    async () => {
      const camera = v1Camera(syntheticPlain());
      const controller = new AbortController();
      controller.abort(); /* the run is dead before it starts */
      const code = await run(
        ['preserve', '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        controller.signal,
      );
      expect(code).toBe(EXIT_CANCELLED);
      /* The initial checkpoint stands: a resume re-runs the whole run. */
      const state = await loadState();
      expect(state.version).toBe(2);
      expect(state.nextStep).toBe('backup');
      expect(Object.keys(state.steps)).toEqual([]);
    },
  );

  it('refuses a positional argument — there is no image input anywhere', async () => {
    const camera = v1Camera(syntheticPlain());
    const refused = testIo({ backend: backendOf(camera) });
    const code = await run(
      ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
      refused.io,
      signal(),
    );
    expect(code).toBe(EXIT_USAGE);
    expect(refused.stderr.text).toMatch(/unexpected argument/);
  });
});

/* ==================================================================== *
 * the spent-reader retry gate: a failed backup re-runs only past the
 * power-cycle acknowledgement (the 2026-10-02 incident: a backup attempt +
 * retry back-to-back with no reset served stale and blank descriptor bytes)
 * ==================================================================== */

describe('preserve — the power-cycle retry gate on a failed backup', () => {
  it(
    'the fresh run suggests the power cycle on a stall; the retry asks, and --yes asserts',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      /* The second sweep window never answers — the stall-at-offset-0 shape
       * of the incident (the fake's stand-in for a spent reader). */
      const wedged = v1Camera(plain, { stallAt: [{ subcmd: 4, offset: 0 }] });

      /* THE FIRST ATTEMPT of the fresh run: the failure line is preceded by
       * the one-line remedy — say the power cycle before any retry. (Under a
       * plain run the reporter's lines are on stdout; stderr carries the
       * top-level error line.) */
      const first = testIo({ backend: backendOf(wedged) });
      expect(await run(['preserve', '--out', runDir(), '--yes'], first.io, signal())).toBe(
        EXIT_FAILED,
      );
      expect(first.stdout.text).toMatch(
        /window reader is spent for this boot — power-cycle the camera .* before any retry/,
      );
      expect(first.stderr.text).toMatch(/error: P1: backup window 0x14020000 .* did not answer/);
      expect(first.stdout.text).toMatch(/backup failed: .*0x14020000/);
      const torn = await loadState();
      expect(torn.nextStep).toBe('backup');
      expect(torn.steps.backup?.status).toBe('failed');

      /* THE RETRY on a terminal: the instruction prints, the prompt gates,
       * and a decline re-reads nothing. */
      const declined = testIo({ backend: backendOf(wedged), stdinIsTty: true, answers: [false] });
      expect(await run(['preserve', '--resume', runDir()], declined.io, signal())).toBe(
        EXIT_FAILED,
      );
      expect(declined.stdout.text).toMatch(
        /power-cycle the camera first \(unplug and replug it, or use its power switch\)/,
      );
      expect(declined.questions).toHaveLength(1);
      expect(declined.questions[0]).toMatch(/power-cycled the camera since that failed backup/);
      expect(declined.stderr.text).toMatch(/aborted at the power-cycle prompt/);

      /* Accepting the prompt asserts the power cycle into core: the gate
       * opens, the camera is still wedged, and the backup fails again — the
       * failure is recorded and the gate stands for the next attempt. */
      const retry = testIo({ backend: backendOf(wedged), stdinIsTty: true, answers: [true] });
      expect(await run(['preserve', '--resume', runDir()], retry.io, signal())).toBe(EXIT_FAILED);
      expect(retry.questions).toHaveLength(1);
      expect(retry.stdout.text).toMatch(/backup failed:/);
      expect((await loadState()).steps.backup?.status).toBe('failed');

      /* --yes asserts the power cycle without a prompt. */
      const asserted = testIo({ backend: backendOf(wedged) });
      expect(await run(['preserve', '--resume', runDir(), '--yes'], asserted.io, signal())).toBe(
        EXIT_FAILED,
      );
      expect(asserted.stdout.text).toMatch(/--yes given: asserting the camera was power-cycled/);
      expect(asserted.questions).toHaveLength(0);
    },
  );

  it(
    'recovers end to end once the camera answers again: no prompt on a clean camera, prompt still asked for the failed record',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      const asBooted = new Uint8Array(v1Camera(plain).flash);
      const wedged = v1Camera(plain, { stallAt: [{ subcmd: 4, offset: 0 }] });
      expect(
        await run(
          ['preserve', '--out', runDir(), '--yes'],
          testIo({ backend: backendOf(wedged) }).io,
          signal(),
        ),
      ).toBe(EXIT_FAILED);

      /* The power cycle that revives the camera — the same part, reading now.
       * The retry (tty) is asked once, answers yes, and the whole run lands:
       * the gate exists to make the operator say the camera was cycled, not
       * to keep a healthy run from finishing. */
      const revived = v1Camera(plain, { flash: wedged.flash });
      const recovered = testIo({ backend: backendOf(revived), stdinIsTty: true, answers: [true] });
      expect(await run(['preserve', '--resume', runDir()], recovered.io, signal())).toBe(EXIT_OK);
      expect(recovered.questions).toHaveLength(1);
      expect((await loadState()).nextStep).toBe('done');
      const delivered = await readFile(join(runDir(), PRESERVE_DUMP_ORIGINAL_FILE));
      expect(await sha256hex(new Uint8Array(delivered))).toBe(await sha256hex(asBooted));
    },
  );
});

/* ==================================================================== *
 * resume, from-step, print-state
 * ==================================================================== */

describe('preserve — resume from a run the drain killed', () => {
  it(
    'checkpoints the failure, then finishes on a healthy camera — with no file but the run directory',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      const asBooted = new Uint8Array(
        v1Camera(plain).flash,
      ); /* the pre-commit part, for the final compare */
      const wedged = v1Camera(plain, { stallDrain: true });
      const first = await run(
        ['preserve', '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(wedged) }).io,
        signal(),
      );
      expect(first).toBe(EXIT_FAILED);

      const torn = await loadState();
      expect(torn.nextStep).toBe('drain');
      expect(torn.steps.backup?.status).toBe('done');
      expect(torn.steps.patch?.status).toBe('done');
      expect(torn.steps.commit?.status).toBe('done');
      expect(torn.steps.drain?.status).toBe('failed');
      expect(torn.steps.drain?.error).toMatch(/post-reset read window never came up/);
      /* The failure is recorded, the previous checkpoint stands, and the run
       * directory holds the restore source AND the derived plaintext. */
      expect(await readFile(join(runDir(), PRESERVE_BANK_CAPTURE_FILE))).toBeTruthy();
      expect(await readFile(join(runDir(), PRESERVE_PLAIN_NAME))).toBeTruthy();

      /* RESUME on the same part, healthy now: the drain runs, then restore and
       * verify, and the run reaches done — the commit is NOT replayed, and no
       * image is asked for. */
      const samePart = v1Camera(plain, { flash: wedged.flash });
      const second = await run(
        ['preserve', '--resume', runDir(), '--yes'],
        testIo({ backend: backendOf(samePart) }).io,
        signal(),
      );
      expect(second).toBe(EXIT_OK);
      const state = await loadState();
      expect(state.nextStep).toBe('done');
      expect(state.steps.commit?.finishedAt).toBe(torn.steps.commit?.finishedAt);
      const delivered = await readFile(join(runDir(), PRESERVE_DUMP_ORIGINAL_FILE));
      expect(await sha256hex(new Uint8Array(delivered))).toBe(await sha256hex(asBooted));
    },
  );

  it(
    'resuming a run directory that lost the derived plaintext refuses, with the remedy',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      const camera = v1Camera(plain);
      await run(
        ['preserve', '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        signal(),
      );
      /* Rewind the state to just before the commit AND take the derived
       * plaintext out of the run directory: the migration shape a version-1
       * run left behind (its plaintext lived outside). */
      const state = await loadState();
      const rewound: PreserveRunState = { ...state, nextStep: 'commit' };
      delete rewound.steps.commit;
      delete rewound.steps.drain;
      delete rewound.steps.restore;
      delete rewound.steps.verify;
      await saveState('run', rewound);
      const plainFile = await readFile(join(runDir(), PRESERVE_PLAIN_NAME));
      const { rm } = await import('node:fs/promises');
      await rm(join(runDir(), PRESERVE_PLAIN_NAME));

      const probe = testIo({ backend: backendOf(camera) });
      const code = await run(['preserve', '--resume', runDir(), '--yes'], probe.io, signal());
      expect(code).toBe(EXIT_FAILED);
      expect(probe.stderr.text).toMatch(/preserve_image_plain\.bin/);
      expect(probe.stderr.text).toMatch(/version-1 run/);

      /* The file goes back under its artifact name (from the run zip, or the
       * version-1 image copied there) and the same resume just works. */
      await writeFile(join(runDir(), PRESERVE_PLAIN_NAME), plainFile);
      const retry = testIo({ backend: backendOf(camera) });
      expect(await run(['preserve', '--resume', runDir(), '--yes'], retry.io, signal())).toBe(
        EXIT_OK,
      );
      expect((await loadState()).nextStep).toBe('done');
    },
  );

  it(
    'a version-1 run directory still loads: print-state and resume work on it',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      const camera = v1Camera(plain);
      await run(
        ['preserve', '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        signal(),
      );
      /* Downgrade the on-disk state to the version-1 schema. */
      await saveState('run', asVersion1(await loadState()));

      const printed = testIo();
      expect(
        await run(['preserve', '--print-state', runDir(), '--json'], printed.io, signal()),
      ).toBe(EXIT_OK);
      const document = JSON.parse(printed.stdout.text) as { state: PreserveRunState };
      expect(document.state.version).toBe(1);

      const done = testIo();
      expect(await run(['preserve', '--resume', runDir(), '--yes'], done.io, signal())).toBe(
        EXIT_OK,
      );
      expect(done.stdout.text).toMatch(/run .* is already done — nothing to resume/);
    },
  );

  it(
    '--from-step past an incomplete commit warns loudly, and the run recovers safely',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      const camera = v1Camera(plain);
      await run(
        ['preserve', '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        signal(),
      );
      /* Rewind the on-disk state to just after the backup: patch/commit not
       * on record, while the camera is fact RESTORED (the full run above put
       * it back). Exactly the ambiguous state a lost checkpoint can leave. */
      const state = await loadState();
      const rewound: PreserveRunState = { ...state, nextStep: 'patch' };
      delete rewound.steps.patch;
      delete rewound.steps.commit;
      delete rewound.steps.drain;
      delete rewound.steps.restore;
      delete rewound.steps.verify;
      await saveState('run', rewound);

      const jumped = testIo({ backend: backendOf(camera) });
      const code = await run(
        ['preserve', '--resume', runDir(), '--from-step', 'drain', '--yes'],
        jumped.io,
        signal(),
      );
      expect(code).toBe(EXIT_OK);
      expect(jumped.stdout.text).toMatch(
        /WARNING: jumping from patch to drain, skipping: patch, commit/,
      );
      expect(jumped.stdout.text).toMatch(/past an INCOMPLETE commit .* expected to be in the/);
      /* The wire-side protections held: the drain read the (original) part,
       * the restore detected an already-original bank, the verify proved
       * 0 diffs — and the camera was never written. */
      const after = await loadState();
      expect(after.nextStep).toBe('done');
      expect(after.steps.restore?.notes).toMatch(/already held the original content/);
      expect(after.verify).toEqual({ diffBytes: 0, windowsRead: 31, badWindows: [] });
      const expectedFlash = new Uint8Array(v1Camera(plain).flash);
      expect(await sha256hex(camera.flash)).toBe(await sha256hex(expectedFlash));
    },
  );

  it(
    '--from-step restore recovers a drain-abandoned run: warn, restore, verify, done',
    { timeout: 180_000 },
    async () => {
      const plain = syntheticPlain();
      const asBooted = new Uint8Array(v1Camera(plain).flash);
      const wedged = v1Camera(plain, { stallDrain: true });
      const first = await run(
        ['preserve', '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(wedged) }).io,
        signal(),
      );
      expect(first).toBe(EXIT_FAILED);
      const torn = await loadState();
      expect(torn.nextStep).toBe('drain');

      /* The dump is not worth another drain: restore and verify, skipping it. */
      const camera = v1Camera(plain, { flash: wedged.flash });
      const recovered = testIo({ backend: backendOf(camera) });
      const code = await run(
        ['preserve', '--resume', runDir(), '--from-step', 'restore', '--yes'],
        recovered.io,
        signal(),
      );
      expect(code).toBe(EXIT_OK);
      /* The warn rides the log stream (stdout unless --json). */
      expect(recovered.stdout.text).toMatch(
        /WARNING: jumping from drain to restore, skipping: drain/,
      );
      expect(recovered.stderr.text).not.toMatch(/no COMPLETED commit/); /* commit IS done */
      const after = await loadState();
      expect(after.nextStep).toBe('done');
      expect(after.steps.drain?.status).toBe('failed'); /* the skip is on the record */
      expect(after.steps.restore?.status).toBe('done');
      expect(after.verify?.diffBytes).toBe(0);
      /* The camera was put back even though the dump never happened. */
      expect(await sha256hex(camera.flash)).toBe(await sha256hex(asBooted));
    },
  );

  it('--resume on a run that is already done says so and touches no camera', async () => {
    const camera = v1Camera(syntheticPlain());
    await run(
      ['preserve', '--out', runDir(), '--yes'],
      testIo({ backend: backendOf(camera) }).io,
      signal(),
    );
    /* No backend injected: if anything reached for a camera, the run would
     * fail on the missing device instead of exiting cleanly. */
    const done = testIo();
    const code = await run(['preserve', '--resume', runDir(), '--yes'], done.io, signal());
    expect(code).toBe(EXIT_OK);
    expect(done.stdout.text).toMatch(/run .* is already done — nothing to resume/);
    /* The state is untouched. */
    expect((await loadState()).nextStep).toBe('done');
  });

  it('--from-step needs --resume, and a bogus step id is a usage error', async () => {
    const usage = testIo();
    expect(await run(['preserve', '--from-step', 'drain', '--yes'], usage.io, signal())).toBe(
      EXIT_USAGE,
    );
    expect(usage.stderr.text).toMatch(/--from-step needs --resume/);

    const bogus = testIo();
    expect(
      await run(
        ['preserve', '--resume', runDir(), '--from-step', 'middle', '--yes'],
        bogus.io,
        signal(),
      ),
    ).toBe(EXIT_USAGE); /* the step id is checked before the run directory is read */
    expect(bogus.stderr.text).toMatch(/'middle' is not a step/);
  });

  it(
    '--print-state reports the run, its next step, and the checkpoint files',
    { timeout: 180_000 },
    async () => {
      const camera = v1Camera(syntheticPlain());
      await run(
        ['preserve', '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        signal(),
      );
      const printed = testIo();
      const code = await run(
        ['preserve', '--print-state', runDir(), '--json'],
        printed.io,
        signal(),
      );
      expect(code).toBe(EXIT_OK);
      /* No camera was needed: no backend was even injected. */
      const document = JSON.parse(printed.stdout.text) as {
        state: PreserveRunState;
        run: { nextStep: string; id: string };
        inventory: { name: string; present: boolean; shaMatches: boolean | null }[];
      };
      expect(document.run.nextStep).toBe('done');
      expect(document.state.version).toBe(2);
      expect(document.state.imageSource).toBe('device');
      const files = document.inventory.map((entry) => entry.name);
      expect(files).toContain(PRESERVE_BACKUP_FILE);
      expect(files).toContain(PRESERVE_PLAIN_NAME);
      expect(files).toContain(PRESERVE_DUMP_ORIGINAL_FILE);
      for (const entry of document.inventory) {
        expect(entry.present, entry.name).toBe(true);
        expect(entry.shaMatches, entry.name).toBe(true);
      }

      /* A tampered checkpoint file is reported CHANGED, not silently ok. */
      const patched = await readFile(join(runDir(), PRESERVE_PATCHED_FILE));
      patched[9] = (patched[9] ?? 0) ^ 0xff;
      await writeFile(join(runDir(), PRESERVE_PATCHED_FILE), patched);
      const after = testIo();
      await run(['preserve', '--print-state', runDir()], after.io, signal());
      expect(after.stdout.text).toMatch(/CHANGED\s+preserve_patch_plain_patched\.bin/);
    },
  );
});

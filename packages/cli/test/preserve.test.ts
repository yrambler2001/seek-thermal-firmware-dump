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
  PRESERVE_RUN_STATE_FILE,
  REBALANCE_WORD_OFFSET,
  V1_2014_PATCH_SITES,
  sha256hex,
  wordSum,
  type PreserveRunState,
  type UsbBackend,
} from '@seek-fw/core';
import { FakeCamera, type FakeWindowSpec } from '../../core/test/fake-transport.js';
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
  options: { readonly flash?: Uint8Array; readonly stallDrain?: boolean } = {},
): FakeCamera {
  const flash =
    options.flash ??
    (() => {
      const bytes = new Uint8Array(FLASH_SIZE).fill(0xff);
      new DataView(bytes.buffer).setUint32(0x10000, 0xffffffff, true); /* blank cfg -> bank A */
      bytes.set(plain, BANK_A_OFFSET);
      return bytes;
    })();
  return new FakeCamera({
    flash,
    windows: v1WindowMap(),
    authBanks: [3, 4, 5, 6, 7, 8, 9],
    fwInfo: new Map([[0, Uint8Array.from([1, 3, 0, 0, 0, 0, 0, 0])]]),
    ...(options.stallDrain === true
      ? { stallAt: [{ subcmd: 2, offset: 0 }] } /* the widened window never answers */
      : {}),
  });
}

const backendOf = (camera: FakeCamera): ((options: BackendOptions) => UsbBackend) =>
  fixedBackend([camera]);

async function writePlainFile(name = 'plain-1.3.0.0.bin'): Promise<Uint8Array> {
  const plain = syntheticPlain();
  await writeFile(join(dir, name), plain);
  return plain;
}

function runDir(name = 'run'): string {
  return join(dir, name);
}

async function loadState(name = 'run'): Promise<PreserveRunState> {
  return JSON.parse(
    await readFile(join(runDir(name), PRESERVE_RUN_STATE_FILE), 'utf8'),
  ) as PreserveRunState;
}

/* ==================================================================== *
 * a fresh run, checkpointed
 * ==================================================================== */

describe('preserve — a fresh run, checkpointed after every step', () => {
  it('runs all six steps and leaves a complete run directory', { timeout: 180_000 }, async () => {
    const plain = await writePlainFile();
    const camera = v1Camera(plain);
    const asBooted = new Uint8Array(camera.flash);
    const test = testIo({ backend: backendOf(camera) });
    const code = await run(
      ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes', '--json'],
      test.io,
      signal(),
    );
    expect(code).toBe(EXIT_OK);

    const state = await loadState();
    expect(state.version).toBe(1);
    expect(state.nextStep).toBe('done');
    expect(state.expectedVersion).toBe(EXPECTED_VERSION);
    expect(state.imageSha256).toBe(await sha256hex(plain));
    for (const step of ['backup', 'patch', 'commit', 'drain', 'restore', 'verify'] as const) {
      expect(state.steps[step]?.status, `${step} done`).toBe('done');
    }
    expect(state.steps.commit?.notes).toMatch(/no reset sent in this session/);
    expect(state.verify).toEqual({ diffBytes: 0, windowsRead: 31, badWindows: [] });

    /* The checkpoint files are all there, and the shas are as recorded. */
    for (const name of [
      PRESERVE_BACKUP_FILE,
      PRESERVE_BANK_CAPTURE_FILE,
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
    /* The dump archive's decrypted slots came along. */
    const decrypted = (await readdir(join(runDir(), 'decrypted'))).length;
    expect(decrypted).toBeGreaterThan(0);

    /* The delivered dump is the camera's original content; the part was
     * restored underneath the run. */
    const delivered = await readFile(join(runDir(), PRESERVE_DUMP_ORIGINAL_FILE));
    expect(await sha256hex(new Uint8Array(delivered))).toBe(await sha256hex(asBooted));
    expect(await sha256hex(camera.flash)).toBe(await sha256hex(asBooted));

    /* The --json document names the run and its shas. */
    const document = JSON.parse(test.stdout.text) as {
      run: { nextStep: string; id: string };
      sha256: { deliveredDump: string };
    };
    expect(document.run.nextStep).toBe('done');
    expect(document.sha256.deliveredDump).toBe(await sha256hex(asBooted));
  });

  it(
    'writes no temporary files behind: every checkpoint write is a rename',
    { timeout: 180_000 },
    async () => {
      const plain = await writePlainFile();
      const camera = v1Camera(plain);
      await run(
        ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
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
      const plain = await writePlainFile();
      const camera = v1Camera(plain);
      const args = ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'];
      expect(await run(args, testIo({ backend: backendOf(camera) }).io, signal())).toBe(EXIT_OK);
      const second = testIo({ backend: backendOf(camera) });
      expect(await run(args, second.io, signal())).toBe(EXIT_FAILED);
      expect(second.stderr.text).toMatch(/already holds a preserve_run\.json .* --resume/);
    },
  );

  it(
    'writes the initial checkpoint before the first step, so an early abort is resumable',
    { timeout: 180_000 },
    async () => {
      const plain = await writePlainFile();
      const camera = v1Camera(plain);
      const controller = new AbortController();
      controller.abort(); /* the run is dead before it starts */
      const code = await run(
        ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        controller.signal,
      );
      expect(code).toBe(EXIT_CANCELLED);
      /* The initial checkpoint stands: a resume re-runs the whole run. */
      const state = await loadState();
      expect(state.nextStep).toBe('backup');
      expect(Object.keys(state.steps)).toEqual([]);
    },
  );
});

/* ==================================================================== *
 * resume, from-step, print-state
 * ==================================================================== */

describe('preserve — resume from a run the drain killed', () => {
  it(
    'checkpoints the failure, then finishes on a healthy camera',
    { timeout: 180_000 },
    async () => {
      const plain = await writePlainFile();
      const asBooted = new Uint8Array(
        v1Camera(plain).flash,
      ); /* the pre-commit part, for the final compare */
      const wedged = v1Camera(plain, { stallDrain: true });
      const first = await run(
        ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
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
       * directory holds the restore source. */
      expect(await readFile(join(runDir(), PRESERVE_BANK_CAPTURE_FILE))).toBeTruthy();

      /* RESUME on the same part, healthy now: the drain runs, then restore and
       * verify, and the run reaches done — the commit is NOT replayed. */
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
    'resuming at a patch-building step without the image refuses, with the command to run',
    { timeout: 180_000 },
    async () => {
      const plain = await writePlainFile();
      const camera = v1Camera(plain);
      await run(
        ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        signal(),
      );
      /* Rewind the state to just before the commit: patch done, commit gone. */
      const state = await loadState();
      const rewound: PreserveRunState = { ...state, nextStep: 'commit' };
      delete rewound.steps.commit;
      delete rewound.steps.drain;
      delete rewound.steps.restore;
      delete rewound.steps.verify;
      await writeFile(
        join(runDir(), PRESERVE_RUN_STATE_FILE),
        `${JSON.stringify(rewound, null, 2)}\n`,
      );

      /* No image positional: the commit rebuilds the patch, so it refuses with
       * the command line that fixes it. */
      const probe = testIo({ backend: backendOf(camera) });
      const code = await run(['preserve', '--resume', runDir(), '--yes'], probe.io, signal());
      expect(code).toBe(EXIT_USAGE);
      expect(probe.stderr.text).toMatch(
        /resuming at commit needs the factory plaintext .* preserve <image> --resume/,
      );
      /* And the same resume WITH the image passes the gate and re-commits. */
      const retry = testIo({ backend: backendOf(camera) });
      expect(
        await run(
          ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--resume', runDir(), '--yes'],
          retry.io,
          signal(),
        ),
      ).toBe(EXIT_OK);
      expect((await loadState()).nextStep).toBe('done');
    },
  );

  it(
    '--from-step refuses when the step it names has no completed commit under it',
    { timeout: 180_000 },
    async () => {
      const plain = await writePlainFile();
      const camera = v1Camera(plain);
      await run(
        ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
        testIo({ backend: backendOf(camera) }).io,
        signal(),
      );
      /* Rewind the on-disk state to just after the backup: patch not done. */
      const state = await loadState();
      const rewound: PreserveRunState = { ...state, nextStep: 'patch' };
      delete rewound.steps.patch;
      delete rewound.steps.commit;
      delete rewound.steps.drain;
      delete rewound.steps.restore;
      delete rewound.steps.verify;
      await writeFile(
        join(runDir(), PRESERVE_RUN_STATE_FILE),
        `${JSON.stringify(rewound, null, 2)}\n`,
      );

      const refused = testIo({ backend: backendOf(camera) });
      const code = await run(
        ['preserve', '--resume', runDir(), '--from-step', 'drain', '--yes'],
        refused.io,
        signal(),
      );
      expect(code).toBe(EXIT_FAILED);
      expect(refused.stderr.text).toMatch(/no completed commit/);
    },
  );

  it(
    '--from-step restore recovers a drain-abandoned run: warn, restore, verify, done',
    { timeout: 180_000 },
    async () => {
      const plain = await writePlainFile();
      const asBooted = new Uint8Array(v1Camera(plain).flash);
      const wedged = v1Camera(plain, { stallDrain: true });
      const first = await run(
        ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
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
    const plain = await writePlainFile();
    const camera = v1Camera(plain);
    await run(
      ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
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
    await writePlainFile();
    const usage = testIo();
    expect(
      await run(
        ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--from-step', 'drain', '--yes'],
        usage.io,
        signal(),
      ),
    ).toBe(EXIT_USAGE);
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

  it('--resume with a different image refuses by sha', { timeout: 180_000 }, async () => {
    const plain = await writePlainFile();
    const camera = v1Camera(plain);
    await run(
      ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
      testIo({ backend: backendOf(camera) }).io,
      signal(),
    );
    const other = syntheticPlain();
    other[0x400] = (other[0x400] ?? 0) ^ 0xff;
    const dv = new DataView(other.buffer);
    dv.setUint32(0x3ff0, 0, true);
    dv.setUint32(0x3ff0, (0 - wordSum(other)) >>> 0, true);
    await writeFile(join(dir, 'other.bin'), other);
    const mismatch = testIo({ backend: backendOf(camera) });
    const code = await run(
      ['preserve', join(dir, 'other.bin'), '--resume', runDir(), '--yes'],
      mismatch.io,
      signal(),
    );
    expect(code).toBe(EXIT_FAILED);
    expect(mismatch.stderr.text).toMatch(/is not the image this run was created from/);
  });

  it(
    '--print-state reports the run, its next step, and the checkpoint files',
    { timeout: 180_000 },
    async () => {
      const plain = await writePlainFile();
      const camera = v1Camera(plain);
      await run(
        ['preserve', join(dir, 'plain-1.3.0.0.bin'), '--out', runDir(), '--yes'],
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
        run: { nextStep: string; id: string };
        inventory: { name: string; present: boolean; shaMatches: boolean | null }[];
      };
      expect(document.run.nextStep).toBe('done');
      const files = document.inventory.map((entry) => entry.name);
      expect(files).toContain(PRESERVE_BACKUP_FILE);
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

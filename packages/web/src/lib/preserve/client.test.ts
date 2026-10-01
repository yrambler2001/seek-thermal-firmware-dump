/**
 * The adapter against the real core steps API, offline paths only:
 * `createPreserveRun`'s plan from a synthetic v1 plaintext, the patch step —
 * the one step with no camera — and the refusals the loader's answers
 * produce. The camera steps are the emulator suite's business
 * (packages/core/test/preservation); here they are only checked to refuse
 * before anything opens a session.
 */

import {
  CancelledError,
  REBALANCE_WORD_OFFSET,
  SeekError,
  V1_2014_PATCH_SITES,
  buildV1Patch,
  sha256hex,
  silentReporter,
  wordSum,
  type SessionOpener,
} from '@seek-fw/core';
import { describe, expect, it } from 'vitest';
import {
  RESERVED_PLAIN_NAME,
  buildPatchSummary,
  createPreserveRun,
  isCancelledStep,
  plainLoader,
  runPreserveStep,
} from './client';
import { buildRunFile, parseRunFile } from './run-file';
import type { CheckpointName, PreserveRunState } from './types';

/** A synthetic factory plaintext that carries the four patch sites — the
 * same recipe core's patch.test.ts uses, with a header version word. */
function syntheticPlain(): Uint8Array {
  const bytes = new Uint8Array(0x4000);
  let state = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  for (const site of V1_2014_PATCH_SITES) bytes.set(site.before, site.offset);
  bytes[0x20c] = 0x01; /* header version word 0x00000301 -> "1.3.0.0" */
  bytes[0x20d] = 0x03;
  bytes[0x20e] = 0x00;
  bytes[0x20f] = 0x00;
  for (let i = 0; i < 4; i++) bytes[REBALANCE_WORD_OFFSET + i] = 0;
  const dv = new DataView(bytes.buffer);
  const scratch = 0x3ff0;
  dv.setUint32(scratch, 0, true);
  dv.setUint32(scratch, (0 - wordSum(bytes)) >>> 0, true);
  expect(wordSum(bytes)).toBe(0);
  return bytes;
}

/** An opener that must never be reached by the offline steps. */
const NO_CAMERA: SessionOpener = {
  open: () => {
    throw new Error('no camera takes part in this test');
  },
  close: () => Promise.resolve(),
};

function bytesOf(bytes: Uint8Array | undefined): Uint8Array {
  return bytes ?? new Uint8Array();
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

describe('createPreserveRun', () => {
  it('builds the plan offline: version from the header, no steps, next backup', async () => {
    const image = syntheticPlain();
    const created = await createPreserveRun(image, {
      runId: 'preserve-test',
      now: (): Date => new Date('2026-10-01T10:00:00Z'),
    });

    expect(created.state.version).toBe(1);
    expect(created.state.runId).toBe('preserve-test');
    expect(created.state.buildFamily).toBe('v1-2014');
    expect(created.state.expectedVersion).toBe('1.3.0.0');
    expect(created.state.nextStep).toBe('backup');
    expect(created.state.steps).toEqual({});
    /* The patch itself rides beside the state; the run state carries the
     * summary only after the patch step records it. */
    expect(created.state.patch).toBeUndefined();
    expect(created.patch.diffOffsets.length).toBeGreaterThan(0);
  });

  it('the plan screen summary mirrors what the patch step will record', async () => {
    const image = syntheticPlain();
    const created = await createPreserveRun(image);
    const summary = await buildPatchSummary(created.patch);

    expect(summary.sites).toHaveLength(V1_2014_PATCH_SITES.length);
    expect(summary.rebalanceWord).toBe(created.patch.rebalanceWord);
    expect(summary.stagedLength).toBe(image.length);
    expect(summary.chunkCount).toBe(Math.ceil(image.length / 64));
    /* The instruction sites, in the builder's order — the rebalance word is
     * carried beside them, not as a fifth site. */
    expect(summary.sites.map((site) => site.offset)).toEqual(
      V1_2014_PATCH_SITES.map((site) => site.offset),
    );
    /* The recorded sha is the patched plaintext's — the patch step
     * re-derives and re-checks exactly this from the loader's image. */
    await expect(sha256hex(buildV1Patch(image).patched)).resolves.toBe(summary.patchedSha256);
  });

  it('refuses an image that is not a balanced v1 plaintext', async () => {
    const broken = syntheticPlain();
    broken[0x1000] = (broken[0x1000] ?? 0) ^ 0xff; /* the word sum is no longer 0 */
    await expect(createPreserveRun(broken)).rejects.toThrow(SeekError);
  });
});

/** A checkpoint doc as it stands after the backup step — what the patch
 * step's gate demands before it will run offline. */
function stateAfterBackup(state: PreserveRunState): PreserveRunState {
  return {
    ...state,
    nextStep: 'patch',
    detection: {
      cfgHex: 'ff',
      cfg0: 0,
      blank: true,
      bank: 'a',
      bankAddress: 0x14050000,
      bankMode: 7,
      verdict: 'blank -> bank A',
    },
    steps: {
      backup: {
        status: 'done',
        startedAt: '2026-10-01T10:00:01Z',
        finishedAt: '2026-10-01T10:00:20Z',
        notes: 'test fixture',
      },
    },
  } as unknown as PreserveRunState;
}

describe('runPreserveStep — the patch step, offline', () => {
  it('files the patched plaintext and advances the run to commit', async () => {
    const image = syntheticPlain();
    const created = await createPreserveRun(image);
    const loader = plainLoader(new Map(), new Map(), { bytes: image });
    const state = stateAfterBackup(created.state);

    const outcome = await runPreserveStep('patch', NO_CAMERA, state, loader, silentReporter);
    expect(outcome.artifacts).toHaveLength(1);
    expect(outcome.artifacts[0]?.name).toBe('preserve_patch_plain_patched.bin');
    expect(equalBytes(bytesOf(outcome.artifacts[0]?.data), buildV1Patch(image).patched)).toBe(true);
    expect(outcome.state.nextStep).toBe('commit');
    expect(outcome.state.steps.patch?.status).toBe('done');
    expect(outcome.state.patch?.patchedSha256).toBe(
      outcome.state.steps.patch?.artifactShas?.['preserve_patch_plain_patched.bin'],
    );
  });

  it('a checkpoint loader serves the run file’s bytes back, by name', async () => {
    const image = syntheticPlain();
    const created = await createPreserveRun(image);
    const patched = buildV1Patch(image).patched;
    /* A resumed run: the patch step's file came back inside the run ZIP. */
    const zip = buildRunFile(
      created.state,
      new Map([['preserve_patch_plain_patched.bin', patched] as [CheckpointName, Uint8Array]]),
    );
    const parsed = parseRunFile(zip);
    const loader = plainLoader(parsed.checkpoints, parsed.extra, null);
    await expect(loader('preserve_patch_plain_patched.bin')).resolves.not.toBeNull();
    await expect(loader(RESERVED_PLAIN_NAME)).resolves.toBeNull();
  });

  it('refuses when the plaintext is not attached', async () => {
    const image = syntheticPlain();
    const created = await createPreserveRun(image);
    await expect(
      runPreserveStep(
        'patch',
        NO_CAMERA,
        stateAfterBackup(created.state),
        plainLoader(new Map(), new Map(), null),
        silentReporter,
      ),
    ).rejects.toThrow(/factory plaintext/);
  });

  it('refuses a plaintext that is not the run’s image', async () => {
    const image = syntheticPlain();
    const created = await createPreserveRun(image);
    /* Different bytes — the sha check fires before anything is derived. */
    const other = syntheticPlain();
    other[0x1000] = (other[0x1000] ?? 0) ^ 0xff;
    await expect(
      runPreserveStep(
        'patch',
        NO_CAMERA,
        stateAfterBackup(created.state),
        plainLoader(new Map(), new Map(), { bytes: other }),
        silentReporter,
      ),
    ).rejects.toThrow(/not the one this run was created from/);
  });

  it('the commit refuses at the gate before any session opens on a fresh run', async () => {
    const image = syntheticPlain();
    const created = await createPreserveRun(image);
    await expect(
      runPreserveStep(
        'commit',
        NO_CAMERA,
        created.state,
        plainLoader(new Map(), new Map(), { bytes: image }),
        silentReporter,
      ),
    ).rejects.toThrow(/backup/);
  });
});

describe('small adapter helpers', () => {
  it('isCancelledStep tells a cancel from a failure', () => {
    expect(isCancelledStep(new Error('bank mismatch'))).toBe(false);
    expect(isCancelledStep(new CancelledError())).toBe(true);
  });
});

/**
 * The gating table, walked row by row — the wizard's sync mirror of core's
 * `describeStepGate`: strict order, no re-runs of done steps, and the loud
 * `pastCommit` context on every step that concerns the patched part while the
 * commit is not on record.
 */

import { describe, expect, it } from 'vitest';
import { canRunStep } from './gating';
import type { PreserveRunState, PreserveStepId } from './types';

function runState(
  overrides: {
    backup?: 'done' | 'failed';
    patch?: 'done' | 'failed';
    commit?: 'done' | 'failed';
    drain?: 'done' | 'failed';
    restore?: 'done' | 'failed';
    verify?: 'done' | 'failed';
    withPlan?: boolean;
    /** Default: present once the backup is done (the backup step records it). */
    detection?: boolean;
    nextStep?: PreserveRunState['nextStep'];
  } = {},
): PreserveRunState {
  const step = (status: 'done' | 'failed' | undefined) =>
    status === undefined ? undefined : { status };
  const detection = overrides.detection ?? (overrides.backup === 'done' ? true : false);
  return {
    version: 1,
    runId: 'preserve-test',
    buildFamily: 'v1-2014',
    imageSha256: 'a'.repeat(64),
    expectedVersion: '1.3.0.0',
    createdAt: '2026-10-01T00:00:00Z',
    nextStep: overrides.nextStep ?? 'backup',
    patch:
      overrides.withPlan === false
        ? undefined
        : {
            sites: [],
            rebalanceWord: 0x30006240,
            stagedLength: 0x4000,
            chunkCount: 256,
            patchedSha256: 'b'.repeat(64),
          },
    ...(detection
      ? {
          detection: {
            cfgHex: 'ff',
            cfg0: 0,
            blank: true,
            bank: 'a',
            bankAddress: 0x14050000,
            bankMode: 7,
            verdict: 'blank -> bank A',
          },
        }
      : {}),
    steps: {
      backup: step(overrides.backup),
      patch: step(overrides.patch),
      commit: step(overrides.commit),
      drain: step(overrides.drain),
      restore: step(overrides.restore),
      verify: step(overrides.verify),
    },
  } as unknown as PreserveRunState;
}

const NOTHING = () => false;
const WITH_CAPTURE = (name: string): boolean =>
  name === 'preserve_bank_capture.bin' || name === 'preserve_backup_windows.bin';
const WITH_PLAIN = true;

function gate(
  state: PreserveRunState | null,
  step: PreserveStepId,
  has: (name: string) => boolean = NOTHING,
  hasPlain = WITH_PLAIN,
) {
  return canRunStep({ state, step, has, hasPlain });
}

describe('canRunStep — the run’s gate, as the buttons show it', () => {
  it('refuses every step before a run exists', () => {
    for (const step of ['backup', 'patch', 'commit', 'drain', 'restore', 'verify'] as const) {
      const g = gate(null, step);
      expect(g.ok, step).toBe(false);
      expect(g.pastCommit, step).toBe(false);
    }
  });

  it('a fresh run: only the backup is armed, and only with the image attached', () => {
    const state = runState();
    expect(gate(state, 'backup')).toMatchObject({ ok: true, pastCommit: false });
    expect(gate(state, 'backup', NOTHING, false).ok).toBe(false);
    for (const step of ['patch', 'commit', 'drain', 'restore', 'verify'] as const) {
      expect(gate(state, step).ok, step).toBe(false);
    }
    /* patch waits for the backup — core's order, stricter than the plan's */
    expect(gate(state, 'patch').missing).toEqual(['the flash backup (run the backup step first)']);
    expect(gate(state, 'drain').pastCommit).toBe(true);
  });

  it('after the backup: the patch arms, the commit waits for it', () => {
    const state = runState({ backup: 'done', nextStep: 'patch' });
    expect(gate(state, 'backup').ok).toBe(false); /* a done run never re-runs backup */
    expect(gate(state, 'backup').missing[0]).toContain('already done');
    expect(gate(state, 'patch')).toMatchObject({ ok: true, pastCommit: false });
    expect(gate(state, 'patch', NOTHING, false).ok).toBe(false);
    expect(gate(state, 'commit', WITH_CAPTURE).ok).toBe(false);
    expect(gate(state, 'commit', WITH_CAPTURE).missing).toEqual(['the patch step']);
  });

  it('the commit gate reads the whole checklist, in core’s order', () => {
    const state = runState({
      backup: 'done',
      patch: 'done',
      detection: false,
      nextStep: 'commit',
    });
    const g = gate(state, 'commit', NOTHING);
    expect(g.missing).toEqual([
      'the slot detection',
      'the backup windows file',
      'the bank capture',
    ]);
    expect(gate(state, 'commit', WITH_CAPTURE).missing).toEqual(['the slot detection']);
  });

  it('a done commit disarms nothing but stops warning the reads', () => {
    const state = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      nextStep: 'drain',
    });
    expect(gate(state, 'drain', WITH_CAPTURE)).toMatchObject({ ok: true, pastCommit: false });
    expect(gate(state, 'restore', WITH_CAPTURE)).toMatchObject({ ok: true, pastCommit: false });
    expect(gate(state, 'verify').ok).toBe(false);
  });

  it('a FAILED commit is not a recorded commit: the reads stay shut and loud', () => {
    const state = runState({
      backup: 'done',
      patch: 'done',
      commit: 'failed',
      nextStep: 'commit',
    });
    const drain = gate(state, 'drain', WITH_CAPTURE);
    expect(drain.ok).toBe(false);
    expect(drain.pastCommit).toBe(true);
    expect(drain.missing[0]).toContain('the commit');
    expect(gate(state, 'restore').pastCommit).toBe(true);
    expect(gate(state, 'verify').pastCommit).toBe(true);
  });

  it('each stage arms exactly the next one', () => {
    const drained = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      drain: 'done',
      nextStep: 'restore',
    });
    expect(gate(drained, 'restore', WITH_CAPTURE)).toMatchObject({ ok: true });
    expect(gate(drained, 'verify').ok).toBe(false);

    const restored = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      drain: 'done',
      restore: 'done',
      nextStep: 'verify',
    });
    expect(gate(restored, 'verify', WITH_CAPTURE)).toMatchObject({
      ok: true,
      pastCommit: false,
    });
  });

  it('a done run refuses everything', () => {
    const state = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      drain: 'done',
      restore: 'done',
      verify: 'done',
      nextStep: 'done',
    });
    for (const step of ['backup', 'patch', 'commit', 'drain', 'restore', 'verify'] as const) {
      const g = gate(state, step, WITH_CAPTURE);
      expect(g.ok, step).toBe(false);
      expect(g.missing[0], step).toContain('this run is done');
    }
  });
});

describe('canRunStep — the past-commit context', () => {
  it('marks drain, restore and verify while the commit is not on record', () => {
    const state = runState();
    for (const step of ['drain', 'restore', 'verify'] as const) {
      expect(gate(state, step).pastCommit, step).toBe(true);
    }
  });

  it('never marks the steps up to and including the commit, or a done run', () => {
    const state = runState();
    for (const step of ['backup', 'patch', 'commit'] as const) {
      expect(gate(state, step).pastCommit, step).toBe(false);
    }
    const done = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      drain: 'done',
      restore: 'done',
      verify: 'done',
      nextStep: 'done',
    });
    for (const step of ['drain', 'restore', 'verify'] as const) {
      expect(gate(done, step).pastCommit, step).toBe(false);
    }
  });
});

describe('canRunStep — the danger dialog', () => {
  it('asks before the two writes, and never before a read', () => {
    const fresh = runState();
    expect(gate(fresh, 'commit').confirm).toBe(true);
    expect(gate(fresh, 'restore').confirm).toBe(true);
    for (const step of ['backup', 'patch', 'drain', 'verify'] as const) {
      expect(gate(fresh, step).confirm, step).toBe(false);
    }
  });
});

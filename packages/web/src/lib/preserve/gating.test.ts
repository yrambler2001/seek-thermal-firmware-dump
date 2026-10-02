/**
 * The gating table, walked row by row — the wizard's sync mirror of core's
 * `describeStepGate`, regrouped at PHASE granularity: a phase's gate is the
 * gate of every core step it will run, with the ordering preconditions the
 * phase satisfies itself (patch's backup, drain's commit) treated as met.
 * The loud `pastCommit` context, the danger-dialog set, and the explicit
 * jump (`allowJump`) all live here.
 */

import { describe, expect, it } from 'vitest';
import { canRunPhase } from './gating';
import type { PreservePhaseId, PreserveRunState } from './types';

function runState(
  overrides: {
    backup?: 'done' | 'failed';
    patch?: 'done' | 'failed';
    commit?: 'done' | 'failed';
    drain?: 'done' | 'failed';
    restore?: 'done' | 'failed';
    verify?: 'done' | 'failed';
    detection?: boolean;
    nextStep?: PreserveRunState['nextStep'];
    /** The FF build: the restore refuses and the route is recovery-only. */
    restoreNone?: boolean;
    /** A cipher family: the restore stages the derived plaintext. */
    ciphered?: boolean;
  } = {},
): PreserveRunState {
  const step = (status: 'done' | 'failed' | undefined) =>
    status === undefined ? undefined : { status };
  const detection = overrides.detection ?? (overrides.backup === 'done' ? true : false);
  return {
    version: 2,
    runId: 'preserve-test',
    imageSource: 'device',
    buildFamily: 'v1-2014',
    buildId: 'compact-1.3.0.8-8hz',
    buildLabel: 'Compact 1.3.0.8 (8 Hz)',
    imageSha256: 'a'.repeat(64),
    expectedVersion: '1.3.0.8',
    createdAt: '2026-10-01T00:00:00Z',
    nextStep: overrides.nextStep ?? 'backup',
    stagedForm: overrides.ciphered === true ? 'xor-ks0' : 'plain',
    restoreForm: overrides.restoreNone === true ? 'none' : 'capture-verbatim',
    route: overrides.restoreNone === true ? 'recovery-only' : 'active-bank',
    ...(detection
      ? {
          detection: {
            cfgHex: 'ff',
            cfg0: 0,
            blank: true,
            bank: overrides.restoreNone === true ? 'r' : 'a',
            bankAddress: overrides.restoreNone === true ? 0x14070000 : 0x14050000,
            bankMode: overrides.restoreNone === true ? 9 : 7,
            verdict: 'test',
          },
        }
      : {}),
    patch: {
      sites: [],
      rebalanceWord: 0x30006240,
      stagedLength: 0x4000,
      chunkCount: 256,
      patchedSha256: 'b'.repeat(64),
      diffCount: 10,
    },
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

const NOTHING = (): boolean => false;
const HAS_ALL = (): boolean => true;

function gate(
  state: PreserveRunState | null,
  phase: PreservePhaseId,
  has: (name: string) => boolean = HAS_ALL,
) {
  return canRunPhase({ state, phase, has });
}

const ALL_PHASES: readonly PreservePhaseId[] = ['read-build', 'patch-dump', 'restore-verify'];

describe('canRunPhase — the run’s gate, as the buttons show it', () => {
  it('before a run exists only the first phase is armed — it creates the run', () => {
    expect(gate(null, 'read-build').ok).toBe(true);
    for (const phase of ['patch-dump', 'restore-verify'] as const) {
      const g = gate(null, phase);
      expect(g.ok, phase).toBe(false);
      expect(g.missing[0], phase).toContain('no run is active');
      expect(g.pastCommit, phase).toBe(false);
      expect(g.jumpable, phase).toBe(false);
    }
  });

  it('a failed backup with powerCycleRequired holds phase ① for the power-cycle assertion', () => {
    const state = {
      ...runState({ backup: 'failed' }),
      steps: {
        ...runState({ backup: 'failed' }).steps,
        backup: { status: 'failed', powerCycleRequired: true, error: 'spent reader' },
      },
    } as unknown as PreserveRunState;
    const g = gate(state, 'read-build');
    expect(g.ok).toBe(false);
    expect(g.needsPowerCycle).toBe(true);
    expect(g.jumpable).toBe(false);
    expect(g.missing.join('; ')).toMatch(/power-cycle assertion/);
    /* The other phases are untouched by the backup's retry gate. */
    expect(gate(state, 'patch-dump').needsPowerCycle).toBe(false);
    /* A failed backup WITHOUT the flag (any other failure shape) is a normal
     * re-run: the phase arms as before. */
    const other = {
      ...runState({ backup: 'failed' }),
      steps: {
        ...runState({ backup: 'failed' }).steps,
        backup: { status: 'failed', error: 'something else' },
      },
    } as unknown as PreserveRunState;
    expect(gate(other, 'read-build').ok).toBe(true);
    expect(gate(other, 'read-build').needsPowerCycle).toBe(false);
  });

  it('a fresh run: phase ① armed; the later phases wait, in the run’s normal order', () => {
    const state = runState();
    const first = gate(state, 'read-build');
    expect(first).toMatchObject({ ok: true, pastCommit: false, startStep: 'backup' });

    const second = gate(state, 'patch-dump');
    expect(second.ok).toBe(false);
    expect(second.pastCommit).toBe(false); /* a fresh run is not the anomalous case */
    expect(second.missing).toEqual(['the flash backup', 'the patch step', 'the slot detection']);

    const third = gate(state, 'restore-verify');
    expect(third.ok).toBe(false);
    expect(third.pastCommit).toBe(false);
    expect(third.missing[0]).toContain('the commit');
    expect(third.jumpable).toBe(false); /* detection and the patch summary are missing too */
  });

  it('after phase ①: phase ② arms, phase ③ is jump-only and loud', () => {
    const state = runState({ backup: 'done', patch: 'done', nextStep: 'commit' });
    expect(gate(state, 'read-build').missing[0]).toContain('already done');

    const second = gate(state, 'patch-dump');
    expect(second).toMatchObject({ ok: true, confirm: true, startStep: 'commit', jumpable: false });
    expect(second.pastCommit).toBe(false);

    const third = gate(state, 'restore-verify');
    expect(third.ok).toBe(false);
    expect(third.pastCommit).toBe(true);
    expect(third.jumpable).toBe(true);
    expect(third.missing).toEqual(['the commit (run or resume at it first)']);
    expect(third.jumpStartStep).toBe('restore');
  });

  it('after the commit: phase ② starts at the drain (no dialog needed for it), phase ③ arms', () => {
    const state = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      nextStep: 'drain',
    });
    const second = gate(state, 'patch-dump');
    expect(second).toMatchObject({ ok: true, startStep: 'drain' });
    expect(second.confirm).toBe(false); /* only the drain is left, and the drain reads */
    const third = gate(state, 'restore-verify');
    expect(third).toMatchObject({ ok: true, confirm: true, pastCommit: false });
  });

  it('each phase arms exactly the next one', () => {
    const drained = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      drain: 'done',
      nextStep: 'restore',
    });
    expect(gate(drained, 'patch-dump').missing[0]).toContain('already done');
    expect(gate(drained, 'restore-verify')).toMatchObject({ ok: true, startStep: 'restore' });

    const restored = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      drain: 'done',
      restore: 'done',
      nextStep: 'verify',
    });
    const third = gate(restored, 'restore-verify');
    expect(third).toMatchObject({ ok: true, startStep: 'verify' });
    expect(third.confirm).toBe(false); /* only the verify read is left */
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
    for (const phase of ALL_PHASES) {
      const g = gate(state, phase);
      expect(g.ok, phase).toBe(false);
      expect(g.jumpable, phase).toBe(false);
      expect(g.missing[0], phase).toContain('this run is done');
    }
  });

  it('missing checkpoints keep the phase dark, in core’s order, without repeats', () => {
    const state = runState({ backup: 'done', patch: 'done', nextStep: 'commit' });
    const g = gate(state, 'patch-dump', NOTHING);
    expect(g.ok).toBe(false);
    expect(g.jumpable).toBe(false); /* a jump cannot fabricate the capture */
    /* The capture is wanted by both the commit and the drain; named once. */
    expect(g.missing).toEqual(['the backup windows file', 'the bank capture']);
  });
});

describe('canRunPhase — the past-commit context and the jump', () => {
  it('a FAILED commit offers both ways forward: the re-run and the jump past it', () => {
    const state = runState({
      backup: 'done',
      patch: 'done',
      commit: 'failed',
      nextStep: 'commit',
    });
    const second = gate(state, 'patch-dump');
    /* The normal run stays available — the commit's own pre-check sorts
     * landed from not-landed. */
    expect(second.ok).toBe(true);
    expect(second.pastCommit).toBe(true);
    expect(second.jumpable).toBe(true);
    expect(second.startStep).toBe('commit');
    expect(second.jumpStartStep).toBe('drain');
    expect(second.confirm).toBe(true);
    /* And phase ③ is jump-only, as after any commit-less state. */
    const third = gate(state, 'restore-verify');
    expect(third.ok).toBe(false);
    expect(third.jumpable).toBe(true);
    expect(third.pastCommit).toBe(true);
  });

  it('the jump refuses when anything beyond the ordering gate is missing', () => {
    const state = runState({ backup: 'done', patch: 'done', nextStep: 'commit' });
    const g = gate(state, 'restore-verify', NOTHING);
    expect(g.ok).toBe(false);
    expect(g.jumpable).toBe(false); /* the capture is gone; allowJump cannot help */
    expect(g.missing.length).toBeGreaterThan(1);
  });

  it('the FF build’s restore refusal is a hard stop, not a jump', () => {
    const state = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      drain: 'done',
      restoreNone: true,
      nextStep: 'restore',
    });
    const third = gate(state, 'restore-verify');
    expect(third.ok).toBe(false);
    expect(third.jumpable).toBe(false);
    expect(third.missing.join(' ')).toContain('restore refuses');
  });

  it('a cipher family’s restore wants the derived plaintext artifact', () => {
    const base = {
      backup: 'done',
      patch: 'done',
      commit: 'done',
      drain: 'done',
      ciphered: true,
      nextStep: 'restore',
    } as const;
    const without = gate(
      runState(base),
      'restore-verify',
      (name) => name !== 'preserve_image_plain.bin',
    );
    expect(without.ok).toBe(false);
    expect(without.missing.join(' ')).toContain('preserve_image_plain.bin');

    const withPlain = gate(runState(base), 'restore-verify');
    expect(withPlain.ok).toBe(true);
  });

  it('never flags pastCommit before the run stands past phase ①', () => {
    const fresh = runState();
    for (const phase of ALL_PHASES) {
      expect(gate(fresh, phase).pastCommit, phase).toBe(false);
    }
  });
});

describe('canRunPhase — the danger dialog', () => {
  it('asks before the write phases, and never before the read phase', () => {
    const fresh = runState();
    expect(gate(fresh, 'read-build').confirm).toBe(false);
    /* The flag is about the phase's pending steps, not about whether the
     * gate arms them — a refused ② still contains the commit. */
    expect(gate(fresh, 'patch-dump').confirm).toBe(true);
    expect(gate(fresh, 'restore-verify').confirm).toBe(true);
    const afterFirst = runState({ backup: 'done', patch: 'done', nextStep: 'commit' });
    expect(gate(afterFirst, 'patch-dump').confirm).toBe(true);
    expect(gate(afterFirst, 'restore-verify').confirm).toBe(true);
    /* A resumed ② at the drain (the write already landed) runs without one. */
    const atDrain = runState({
      backup: 'done',
      patch: 'done',
      commit: 'done',
      nextStep: 'drain',
    });
    expect(gate(atDrain, 'patch-dump').confirm).toBe(false);
  });
});

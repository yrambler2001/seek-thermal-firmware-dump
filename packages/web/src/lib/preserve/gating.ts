/**
 * The wizard's phase gates: a synchronous projection of core's
 * `describeStepGate` (which `runPreserveStep` enforces authoritatively, and
 * which is async because it inspects the run directory), regrouped at PHASE
 * granularity. Each phase's gate mirrors the gate of every core step the
 * phase will run, in core's order, with the ordering preconditions a phase
 * satisfies ITSELF (the patch step's backup, the drain's commit) treated as
 * met — by the time that step runs, the step it waits for has just finished
 * inside the same task.
 *
 * The two must agree, because a button is enabled exactly when core will
 * accept the call.
 *
 * `pastCommit` is the loud context flag: the commit is not on record and the
 * phase's remaining work concerns the patched part. Core refuses such a
 * step, and the ONE recovery core's own gate offers is the explicit jump
 * (`allowJump`), which relaxes exactly those ordering gates. It is surfaced
 * here as `jumpable` and armed only through the danger dialog, whose
 * assertion is the operator's: the writes landed without their checkpoints.
 * A FAILED commit record is the other jump shape — an attempt happened and
 * the run file cannot prove whether the write landed — and that jump starts
 * the phase PAST the commit (`jumpStartStep`), at the drain, instead of
 * replaying a write that may already be on the camera.
 */

import {
  NEEDS_CONFIRM,
  PRESERVE_STEPS,
  phaseMeta,
  type CheckpointName,
  type PreservePhaseId,
  type PreserveRunState,
  type PreserveStepId,
} from './types';

export interface PreserveGate {
  /** The phase may be started as-is — core's gate will accept every step. */
  readonly ok: boolean;
  /** The unmet prerequisites, in the order core's gate names them. */
  readonly missing: readonly string[];
  /**
   * The commit is not on record, and this phase's remaining work concerns
   * the patched part. The UI must say loudly what that means before the
   * phase is armed.
   */
  readonly pastCommit: boolean;
  /**
   * Core's gate accepts the phase with `allowJump` — the only unmet gates
   * are the ordering ones past the commit — or a failed commit record makes
   * the jump-past-commit variant worth offering. Armed only through the
   * danger dialog; `runPhase` then passes `allowJump` down to core.
   */
  readonly jumpable: boolean;
  /** The step the phase starts at: the first one not already done. */
  readonly startStep: PreserveStepId | null;
  /** Where a JUMP run starts. Differs from `startStep` only past a FAILED
   *  commit: the jump does not replay a write that may already be on the
   *  camera, it continues at the drain. */
  readonly jumpStartStep: PreserveStepId | null;
  /** Needs the danger confirmation (a write among the pending steps, or a jump). */
  readonly confirm: boolean;
}

export interface PreserveGateInput {
  readonly state: PreserveRunState | null;
  readonly phase: PreservePhaseId;
  /** Whether a checkpoint's bytes are in memory (run so far or loaded run file). */
  readonly has: (name: CheckpointName) => boolean;
}

const done = (state: PreserveRunState, step: PreserveStepId): boolean =>
  state.steps[step]?.status === 'done';

const buildName = (state: PreserveRunState): string =>
  state.buildId ?? state.buildFamily ?? 'the detected build';

export function canRunPhase(input: PreserveGateInput): PreserveGate {
  const { state, phase, has } = input;
  const meta = phaseMeta(phase);
  const first = meta.steps[0] ?? 'backup';

  if (state === null) {
    return {
      ok: phase === 'read-build',
      missing: phase === 'read-build' ? [] : ['no run is active — the first phase creates the run'],
      pastCommit: false,
      jumpable: false,
      startStep: first,
      jumpStartStep: null,
      confirm: false,
    };
  }
  if (state.nextStep === 'done') {
    return {
      ok: false,
      missing: ['this run is done — every phase completed'],
      pastCommit: false,
      jumpable: false,
      startStep: first,
      jumpStartStep: null,
      confirm: false,
    };
  }

  const startStep = meta.steps.find((step) => !done(state, step)) ?? null;
  if (startStep === null) {
    return {
      ok: false,
      missing: [`already done — resume continues at ${state.nextStep}`],
      pastCommit: false,
      jumpable: false,
      startStep: first,
      jumpStartStep: null,
      confirm: false,
    };
  }

  /* The gate of every pending step, in core's order. `effDone` grows as the
   * loop walks the phase: a step that runs earlier in the same task counts
   * as done for the steps after it. */
  const effDone = new Set<PreserveStepId>(
    PRESERVE_STEPS.filter((entry) => done(state, entry.id)).map((entry) => entry.id),
  );
  const missing: string[] = [];
  /* The ordering gates allowJump relaxes, kept apart from the rest: they are
   * the only gaps a jump can clear. */
  const ordering: string[] = [];

  for (const step of meta.steps) {
    if (done(state, step)) continue;

    const want = (pre: PreserveStepId, why: string): void => {
      if (!effDone.has(pre)) ordering.push(why);
    };
    switch (step) {
      case 'backup':
        /* Nothing comes before it, and a run with work done never re-runs it. */
        break;
      case 'patch':
        want('backup', 'the flash backup (it runs first in this phase)');
        break;
      case 'commit': {
        want('backup', 'the flash backup');
        want('patch', 'the patch step');
        if (state.detection === undefined) missing.push('the slot detection');
        if (state.route === 'recovery-only' && state.detection?.bank !== 'r') {
          missing.push('the recovery-slot route (the detection must name the recovery bank)');
        }
        if (!has('preserve_backup_windows.bin')) missing.push('the backup windows file');
        if (!has('preserve_bank_capture.bin')) missing.push('the bank capture');
        break;
      }
      case 'drain': {
        want('commit', 'the commit (run or resume at it first)');
        if (state.detection === undefined) missing.push('the slot detection');
        if (state.route === 'recovery-only' && state.detection?.bank !== 'r') {
          missing.push('the recovery-slot route (the detection must name the recovery bank)');
        }
        if (state.capability !== undefined && !state.capability.wholePart) {
          missing.push(`the drain refuses on ${buildName(state)} — ${state.capability.note}`);
        }
        if (!has('preserve_bank_capture.bin')) missing.push('the bank capture');
        break;
      }
      case 'restore': {
        want('commit', 'the commit (run or resume at it first)');
        if (state.detection === undefined) missing.push('the slot detection');
        if (state.route === 'recovery-only' && state.detection?.bank !== 'r') {
          missing.push('the recovery-slot route (the detection must name the recovery bank)');
        }
        if (state.patch === undefined) missing.push('the patch summary (the staged length)');
        if (state.restoreForm === 'none') {
          missing.push(
            `the restore refuses on ${buildName(state)} — no staged form of the factory ` +
              'image transforms back to the original slot bytes; the run ends with the ' +
              'delivered dump and the patch in place',
          );
        }
        if (
          state.stagedForm !== undefined &&
          state.stagedForm !== 'plain' &&
          !has('preserve_image_plain.bin')
        ) {
          missing.push('the factory plaintext (preserve_image_plain.bin, from the backup step)');
        }
        if (!has('preserve_bank_capture.bin')) missing.push('the bank capture');
        break;
      }
      case 'verify': {
        want('restore', 'the restore (it runs first in this phase)');
        if (!has('preserve_backup_windows.bin')) missing.push('the flash backup');
        break;
      }
    }
    effDone.add(step);
  }

  /* allowJump relaxes exactly the ordering gates past the commit — nothing
   * else. A phase whose only gaps are those runs ONLY as a jump; a phase
   * with no gaps at all runs normally and may additionally offer the
   * jump-past-a-failed-commit (see below). */
  const orderOnly = ordering.length > 0 && missing.length === 0;
  const ok = missing.length === 0 && ordering.length === 0;
  /* Two steps of one phase can want the same file (the commit and the drain
   * both need the capture) — named once, in first-seen order. */
  const uniqueMissing = [...new Set(missing)];

  /* The failed-commit jump: an attempt is on record as failed — the write may
   * already be on the camera — and the drain is otherwise ready. The normal
   * run stays available (the commit's own pre-check reads the bank and sorts
   * landed from not-landed); the jump skips the commit instead of replaying
   * it, which is core's own remedy text for a landed commit. */
  const stuckJump =
    phase === 'patch-dump' &&
    state.steps.commit?.status === 'failed' &&
    !done(state, 'drain') &&
    ok &&
    has('preserve_bank_capture.bin');

  return {
    ok,
    missing: ok ? [] : orderOnly ? ordering : [...ordering, ...uniqueMissing],
    /* Loud only where the situation is anomalous: the run stands PAST phase ①
     * (the backup is on record) and the commit still is not. On a fresh run
     * the ordering gaps are just the run's normal order. */
    pastCommit: (ordering.length > 0 || stuckJump) && state.steps.backup?.status === 'done',
    jumpable: orderOnly || stuckJump,
    startStep,
    jumpStartStep: stuckJump ? 'drain' : orderOnly ? startStep : null,
    confirm: meta.steps.some((step) => !done(state, step) && NEEDS_CONFIRM.has(step)),
  };
}

/** One line for a row's subtitle: why the Run button is dark. */
export function gateReason(gate: PreserveGate): string | null {
  if (gate.ok || gate.jumpable) return null;
  return `needs ${gate.missing.join('; ')}`;
}

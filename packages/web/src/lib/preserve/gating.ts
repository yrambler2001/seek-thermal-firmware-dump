/**
 * The wizard's step gates: a synchronous projection of core's
 * `describeStepGate` (which `runPreserveStep` enforces authoritatively, and
 * which is async because it inspects the run directory). The two must agree,
 * because the buttons enable exactly what core will accept.
 *
 * Core's rule, in gate order: the steps run in order and a `done` step never
 * re-runs; the backup exists before the patch is built; the patch summary
 * exists before anything write-shaped; the commit exists before anything that
 * reads the patched part; the restore exists before the verify that proves
 * it. And the backup / patch / commit steps read the factory plaintext via
 * the caller's loader, so a resumed run that has not re-attached the image
 * cannot arm them either.
 *
 * `pastCommit` is the loud context flag: a step that concerns the patched
 * part while the commit is not on record. Core refuses such a step, the UI
 * says why at length, and the recovery is the commit pre-check's own — run
 * (or resume at) the commit step.
 */

import {
  NEEDS_CONFIRM,
  type CheckpointName,
  type PreserveRunState,
  type PreserveStepId,
} from './types';

/** The steps that act on (or read) the patched part. */
const PAST_COMMIT: ReadonlySet<PreserveStepId> = new Set<PreserveStepId>([
  'drain',
  'restore',
  'verify',
]);

export interface PreserveGate {
  /** The step may be started — core's gate will accept it. */
  readonly ok: boolean;
  /** The unmet prerequisites, in the order core's gate names them. */
  readonly missing: readonly string[];
  /**
   * The commit is not on record, and this step concerns the patched part.
   * The UI must say loudly what that means before the step is armed.
   */
  readonly pastCommit: boolean;
  /** Needs the danger confirmation even past the gate. */
  readonly confirm: boolean;
}

export interface PreserveGateInput {
  readonly state: PreserveRunState | null;
  readonly step: PreserveStepId;
  /** Whether a checkpoint's bytes are in memory (run so far or loaded run file). */
  readonly has: (name: CheckpointName) => boolean;
  /** Whether the run's factory plaintext is attached (picked, or re-picked). */
  readonly hasPlain: boolean;
}

const done = (state: PreserveRunState, step: PreserveStepId): boolean =>
  state.steps[step]?.status === 'done';

export function canRunStep(input: PreserveGateInput): PreserveGate {
  const { state, step, has, hasPlain } = input;

  if (state === null) {
    return {
      ok: false,
      missing: ['create the run: pick the firmware image first'],
      pastCommit: false,
      confirm: NEEDS_CONFIRM.has(step),
    };
  }
  if (state.nextStep === 'done') {
    return {
      ok: false,
      missing: ['this run is done — every step completed'],
      pastCommit: false,
      confirm: NEEDS_CONFIRM.has(step),
    };
  }

  const mine = state.steps[step];
  if (mine?.status === 'done') {
    return {
      ok: false,
      missing: [`already done — resume continues at ${state.nextStep}`],
      pastCommit: false,
      confirm: NEEDS_CONFIRM.has(step),
    };
  }

  const plainNote = 'the run’s firmware image (re-attach it above)';
  const missing: string[] = [];
  switch (step) {
    case 'backup': {
      if (PRESERVE_STEPS_IDS.some((id) => done(state, id))) {
        missing.push(
          `the backup cannot re-run: this run has completed earlier step(s) and its next ` +
            `step is ${state.nextStep}`,
        );
      }
      if (!hasPlain) missing.push(plainNote);
      break;
    }
    case 'patch': {
      if (!done(state, 'backup')) missing.push('the flash backup (run the backup step first)');
      if (!hasPlain) missing.push(plainNote);
      break;
    }
    case 'commit': {
      if (!done(state, 'backup')) missing.push('the flash backup');
      if (!done(state, 'patch')) missing.push('the patch step');
      if (state.detection === undefined) missing.push('the slot detection');
      if (!has('preserve_backup_windows.bin')) missing.push('the backup windows file');
      if (!has('preserve_bank_capture.bin')) missing.push('the bank capture');
      if (!hasPlain) missing.push(plainNote);
      break;
    }
    case 'drain': {
      if (!done(state, 'commit')) missing.push('the commit (run or resume at it first)');
      if (state.detection === undefined) missing.push('the slot detection');
      if (!has('preserve_bank_capture.bin')) missing.push('the bank capture');
      break;
    }
    case 'restore': {
      if (!done(state, 'commit')) missing.push('the commit (there would be nothing to revert)');
      if (state.detection === undefined) missing.push('the slot detection');
      if (state.patch === undefined) missing.push('the patch summary (the staged length)');
      if (!has('preserve_bank_capture.bin')) missing.push('the bank capture');
      break;
    }
    case 'verify': {
      if (!done(state, 'restore')) missing.push('the restore (run the restore step first)');
      if (!has('preserve_backup_windows.bin')) missing.push('the flash backup');
      break;
    }
  }

  const commitOnRecord = done(state, 'commit');
  const ok = missing.length === 0;
  const pastCommit = !commitOnRecord && PAST_COMMIT.has(step);

  return { ok, missing, pastCommit, confirm: NEEDS_CONFIRM.has(step) };
}

/** One line for a row's subtitle: why the Run button is dark. */
export function gateReason(gate: PreserveGate): string | null {
  if (gate.ok) return null;
  return `needs ${gate.missing.join('; ')}`;
}

const PRESERVE_STEPS_IDS: readonly PreserveStepId[] = [
  'backup',
  'patch',
  'commit',
  'drain',
  'restore',
  'verify',
];

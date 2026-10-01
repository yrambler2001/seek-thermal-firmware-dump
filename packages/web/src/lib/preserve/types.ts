/**
 * The preserve wizard's view of the checkpoint-run contract.
 *
 * The contract's types and file names live in `@seek-fw/core`
 * (`preservation/steps.ts`) and are re-exported here under one roof, so the
 * wizard's imports keep pointing at this module. Only UI metadata — the step
 * list, the write sets, the file naming — is declared here.
 *
 * The run file is the ONLY memory a run has: the app holds no browser
 * storage, so closing the tab without the file ends the run.
 */

import type { PreserveStepId } from '@seek-fw/core';
import {
  PRESERVE_BACKUP_FILE,
  PRESERVE_BANK_CAPTURE_FILE,
  PRESERVE_DUMP_ORIGINAL_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  PRESERVE_PATCHED_FILE,
  PRESERVE_RUN_STATE_FILE,
} from '@seek-fw/core';

export type {
  CreatePreserveRunOptions,
  CreatedPreserveRun,
  PreserveArtifactLoader,
  PreservePatchSummary,
  PreserveRunState,
  PreserveStepOutcome,
  PreserveStepRecord,
} from '@seek-fw/core';
export type { PreserveStepId, V1Patch } from '@seek-fw/core';

/** The patch plan as the wizard's plan screen shows it (core's summary). */
export type { PreservePatchSummary as PreservePatchPlan } from '@seek-fw/core';

/** The run-state file, by its name inside the run ZIP. */
export const RUN_STATE_FILE: string = PRESERVE_RUN_STATE_FILE;

/** The binary checkpoints a run produces, in step order. */
export const CHECKPOINT_FILES = [
  PRESERVE_BACKUP_FILE,
  PRESERVE_BANK_CAPTURE_FILE,
  PRESERVE_PATCHED_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  PRESERVE_DUMP_ORIGINAL_FILE,
] as const;

export type CheckpointName = (typeof CHECKPOINT_FILES)[number];

/** Which steps put bytes on the wire's write path (the "do not unplug" set). */
export const WRITES_FLASH: ReadonlySet<PreserveStepId> = new Set<PreserveStepId>([
  'commit',
  'restore',
]);

/** Which steps can only run through the danger confirmation. */
export const NEEDS_CONFIRM: ReadonlySet<PreserveStepId> = new Set<PreserveStepId>([
  'commit',
  'restore',
]);

export interface PreserveStepMeta {
  readonly id: PreserveStepId;
  readonly label: string;
  readonly description: string;
}

/** The six steps in run order — the order `nextStep` advances through, and
 *  the order core's gate insists on. */
export const PRESERVE_STEPS: readonly PreserveStepMeta[] = [
  {
    id: 'backup',
    label: 'Back up the reachable flash',
    description:
      'Reads all 31 windows a stock camera serves, 64 KiB each, verifies the active bank ' +
      'against the factory image, and decrypts the assembled backup into an archive — the ' +
      "dump of the available regions, taken BEFORE anything is written. This is the run's " +
      'only copy of this camera.',
  },
  {
    id: 'patch',
    label: 'Build the patched image',
    description:
      'Offline. Applies the four instruction edits and the checksum rebalance to the factory ' +
      'plaintext and files the result as a checkpoint. No camera traffic.',
  },
  {
    id: 'commit',
    label: 'Commit the patch into the active slot',
    description:
      'THE WRITE. Reads the active bank back, refuses unless it still holds exactly what the ' +
      'backup recorded, stages the conjugated patch (image length only) and commits. No reset ' +
      'in this session — the reset belongs to the drain step.',
  },
  {
    id: 'drain',
    label: 'Dump the whole part',
    description:
      'Resets the camera so it boots the patched image (it stays silent for roughly ten ' +
      'seconds while it boots — the wizard waits), then drains the whole 4 MiB part through ' +
      'the widened window and swaps the active bank back from the backup to build the ' +
      'delivered, original-content image. Nothing is written.',
  },
  {
    id: 'restore',
    label: 'Restore the original bank',
    description:
      'THE OTHER WRITE. Stages the backup capture verbatim back over the active bank while ' +
      'the patched image still runs from SRAM, then resets.',
  },
  {
    id: 'verify',
    label: 'Verify against the backup',
    description:
      'Re-reads the 31 windows on a fresh boot and requires zero differing bytes against the ' +
      'backup taken before the first write. Read-only.',
  },
];

export function stepMeta(step: PreserveStepId): PreserveStepMeta {
  const found = PRESERVE_STEPS.find((entry) => entry.id === step);
  if (found === undefined) throw new Error(`no such preserve step: ${step}`);
  return found;
}

/** `preserve-run-<runId>.zip` — the run-file naming rule. */
export function runFileName(runId: string): string {
  return `preserve-run-${runId}.zip`;
}

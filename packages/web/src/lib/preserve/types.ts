/**
 * The preserve wizard's view of the checkpoint-run contract.
 *
 * The contract's types and file names live in `@seek-fw/core`
 * (`preservation/steps.ts`) and are re-exported here under one roof, so the
 * wizard's imports keep pointing at this module. Only UI metadata — the
 * phases, the step list under them, the write sets, the file naming — is
 * declared here.
 *
 * THE IMAGE IS THE CAMERA'S OWN: there is no manual plaintext-image
 * selection anywhere. A new run (`version: 2`) derives the factory plaintext
 * from the camera's active slot in the backup step, and the derived image is
 * a run artifact (`PRESERVE_PLAIN_NAME`) like the rest — so the run zip is
 * the only file a run ever needs, here or on a resume.
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
  PRESERVE_PLAIN_NAME,
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
export type { PreserveStepId } from '@seek-fw/core';

/** The file names a run's checkpoints travel under — re-exported so the
 *  wizard's callers share one set of literals. */
export {
  PRESERVE_BACKUP_FILE,
  PRESERVE_BANK_CAPTURE_FILE,
  PRESERVE_DUMP_ORIGINAL_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  PRESERVE_PATCHED_FILE,
  PRESERVE_PLAIN_NAME,
  PRESERVE_RUN_STATE_FILE,
} from '@seek-fw/core';

/** The run-state file, by its name inside the run ZIP. */
export const RUN_STATE_FILE: string = PRESERVE_RUN_STATE_FILE;

/** The binary checkpoints a run produces, in step order — the derived
 *  factory plaintext among them, from the backup step onward. */
export const CHECKPOINT_FILES = [
  PRESERVE_BACKUP_FILE,
  PRESERVE_BANK_CAPTURE_FILE,
  PRESERVE_PLAIN_NAME,
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
      'Reads all 31 windows a stock camera serves, 64 KiB each, reads the active bank a ' +
      'SECOND time through a different reader shape, requires the two reads to agree byte ' +
      'for byte, derives the factory plaintext from that capture and gates it — the dump ' +
      "of the available regions, taken BEFORE anything is written. This is the run's " +
      'only copy of this camera.',
  },
  {
    id: 'patch',
    label: 'Build the patched image',
    description:
      'Offline. Applies the instruction edits and the checksum rebalance to the derived ' +
      'factory plaintext and files the result as a checkpoint. No camera traffic.',
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
      'seconds while it boots — the wizard waits and re-adopts it when it re-enumerates), ' +
      'then drains the whole 4 MiB part through the widened window and swaps the active ' +
      'bank back from the backup to build the delivered, original-content image. Nothing ' +
      'is written.',
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

/* ---- the three phases --------------------------------------------------- */

/** The wizard's rows. A phase is one runner task that runs its core steps
 *  back-to-back, and one run-file download at its end. */
export type PreservePhaseId = 'read-build' | 'patch-dump' | 'restore-verify';

export interface PreservePhaseMeta {
  readonly id: PreservePhaseId;
  readonly label: string;
  readonly description: string;
  /** The core steps the phase runs, in order, in one task. */
  readonly steps: readonly PreserveStepId[];
  /** The camera leaves the bus mid-phase by design (the drain's or the
   *  restore's wire-89 reset): a disconnect there is the reset, not a swap. */
  readonly resetsCamera: boolean;
}

export const PRESERVE_PHASES: readonly PreservePhaseMeta[] = [
  {
    id: 'read-build',
    label: 'Read & build',
    description:
      'Connect, read the device info, and let the run build itself: the 31 stock windows are ' +
      'backed up — one admitted boot per window, the camera rebooting by command between ' +
      'them — the active slot is read on two boots and the two reads must agree, the factory ' +
      'plaintext is derived from that capture and gated, the patch is built offline, and the ' +
      'plan below prints from what the camera produced. Read-only. About seven minutes.',
    steps: ['backup', 'patch'],
    resetsCamera: true,
  },
  {
    id: 'patch-dump',
    label: 'Patch & dump',
    description:
      'THE WRITE, then the reward. The commit stages the conjugated patch into the active bank ' +
      '(image length only) behind the danger dialog — the one irreversible write of the run. ' +
      'Then the camera is reset so it boots the patched image, and the whole 4 MiB part is ' +
      'drained through the widened window.',
    steps: ['commit', 'drain'],
    resetsCamera: true,
  },
  {
    id: 'restore-verify',
    label: 'Restore & verify',
    description:
      'Put the camera back. The original bank content is staged over the active bank (the ' +
      'other write, behind the danger dialog) and the camera is reset; then the 31 windows ' +
      'are re-read on the fresh boot and must match the backup byte for byte — the verdict ' +
      'is shown on this row.',
    steps: ['restore', 'verify'],
    resetsCamera: true,
  },
];

export function phaseMeta(phase: PreservePhaseId): PreservePhaseMeta {
  const found = PRESERVE_PHASES.find((entry) => entry.id === phase);
  if (found === undefined) throw new Error(`no such preserve phase: ${phase}`);
  return found;
}

/** The phases whose remaining work expects the camera to drop off the bus and
 *  re-enumerate mid-phase — the disconnect there is the reset working, not a
 *  device swap. */
export const RESETS_CAMERA: ReadonlySet<PreservePhaseId> = new Set<PreservePhaseId>(
  PRESERVE_PHASES.filter((phase) => phase.resetsCamera).map((phase) => phase.id),
);

/** `preserve-run-<runId>.zip` — the run-file naming rule. */
export function runFileName(runId: string): string {
  return `preserve-run-${runId}.zip`;
}

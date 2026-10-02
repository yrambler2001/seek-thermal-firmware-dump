/**
 * The one door between the preserve wizard and the checkpoint-step API in
 * `@seek-fw/core` (`preservation/steps.ts`). The web package owns no step
 * logic: this module re-exports the entry points under the names the wizard
 * uses and adds exactly one web-side convenience —
 *
 *  - `artifactLoader`: the checkpoint loader a browser runner serves. Every
 *    artifact a run needs is a RUN ARTIFACT: finished checkpoints from
 *    memory, then whatever the run zip carried beyond them (the backup
 *    step's decrypt archive). There is no picked file anywhere — the factory
 *    plaintext is `PRESERVE_PLAIN_NAME`, the backup step's own artifact, so
 *    it arrives through the same map as the rest. Core sha-checks whatever
 *    this serves against the run state.
 *
 * `runPreserveStep` enforces core's own gates before anything touches the
 * camera, so the wizard's buttons are advisory and core is the law.
 */

import {
  createPreserveRun,
  describeStepGate,
  isPreserveStepId,
  nextStepAfter,
  recordStepFailure,
  runPreserveStep,
  type PreserveArtifactLoader,
} from '@seek-fw/core';
import { CancelledError, errorMessage } from '@seek-fw/core';

export type {
  CreatePreserveRunOptions,
  CreatedPreserveRun,
  PreserveArtifactLoader,
  PreserveRunState,
  PreserveStepId,
  PreserveStepOutcome,
} from './types';
export {
  createPreserveRun,
  describeStepGate,
  isPreserveStepId,
  nextStepAfter,
  recordStepFailure,
  runPreserveStep,
};

/** A step failure worth its message — a cancelled step stays quiet. */
export function isCancelledStep(error: unknown): boolean {
  return error instanceof CancelledError || errorMessage(error).toLowerCase() === 'cancelled';
}

/** The wizard's checkpoint loader: the run's own artifacts and nothing else —
 *  finished checkpoints first, then the run zip's extra entries. */
export function artifactLoader(
  checkpoints: ReadonlyMap<string, Uint8Array>,
  extra: ReadonlyMap<string, Uint8Array>,
): PreserveArtifactLoader {
  return (name: string): Promise<Uint8Array | null> =>
    Promise.resolve(checkpoints.get(name) ?? extra.get(name) ?? null);
}

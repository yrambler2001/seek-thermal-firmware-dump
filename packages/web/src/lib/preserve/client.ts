/**
 * The one door between the preserve wizard and the checkpoint-step API in
 * `@seek-fw/core` (`preservation/steps.ts`). The web package owns no step
 * logic: this module re-exports the entry points under the names the wizard
 * uses and adds exactly two web-side conveniences —
 *
 *  - `buildPatchSummary`: the plan screen's table, derived from the `V1Patch`
 *    `createPreserveRun` returns (core builds the same summary again inside
 *    the patch step; this mirrors that shape for the pre-run display);
 *  - `plainLoader`: the checkpoint loader a browser runner serves — finished
 *    checkpoints from memory, unknown names from the run file's extra
 *    entries, and the factory plaintext from the picked image. Core
 *    sha-checks whatever it gets against the run state.
 *
 * `runPreserveStep` enforces core's own gates before anything touches the
 * camera, so the wizard's buttons are advisory and core is the law.
 */

import {
  PRESERVE_PLAIN_NAME,
  STAGE_CHUNK,
  V1_2014_PATCH_SITES,
  createPreserveRun,
  describeStepGate,
  recordStepFailure,
  runPreserveStep,
  sha256hex,
  type PreservePatchSummary,
} from '@seek-fw/core';
import { CancelledError, errorMessage } from '@seek-fw/core';
import type { PreserveArtifactLoader, V1Patch } from './types';

export type {
  CreatePreserveRunOptions,
  CreatedPreserveRun,
  PreserveArtifactLoader,
  PreserveRunState,
  PreserveStepId,
  PreserveStepOutcome,
  V1Patch,
} from './types';
export { createPreserveRun, describeStepGate, recordStepFailure, runPreserveStep };

/** The name the factory plaintext arrives under via `loadArtifact` — run
 *  input, never a file in the run ZIP. */
export const RESERVED_PLAIN_NAME: string = PRESERVE_PLAIN_NAME;

/** A step failure worth its message — a cancelled step stays quiet. */
export function isCancelledStep(error: unknown): boolean {
  return error instanceof CancelledError || errorMessage(error).toLowerCase() === 'cancelled';
}

/** The patch plan the wizard shows before any step runs: the four instruction
 *  sites plus the rebalance word — the same shape the patch step records into
 *  the run state (`runPatchStep`'s summary). */
export async function buildPatchSummary(patch: V1Patch): Promise<PreservePatchSummary> {
  const patchedSha256 = await sha256hex(patch.patched);
  return {
    sites: V1_2014_PATCH_SITES.map((site) => ({
      name: site.what.split(' (')[0] ?? site.what,
      offset: site.offset,
      before: [...site.before],
      after: [...site.after],
    })),
    rebalanceWord: patch.rebalanceWord,
    stagedLength: patch.factory.length,
    chunkCount: Math.ceil(patch.factory.length / STAGE_CHUNK),
    patchedSha256,
  };
}

/** The wizard's checkpoint loader: finished checkpoints first, then the run
 *  input the picked image answers, then whatever the run file carried that
 *  this wizard does not model (the backup step's decrypt archive). */
export function plainLoader(
  checkpoints: ReadonlyMap<string, Uint8Array>,
  extra: ReadonlyMap<string, Uint8Array>,
  plain: { readonly bytes: Uint8Array } | null,
): PreserveArtifactLoader {
  return (name: string): Promise<Uint8Array | null> => {
    const stored = checkpoints.get(name);
    if (stored !== undefined) return Promise.resolve(stored);
    if (name === RESERVED_PLAIN_NAME) return Promise.resolve(plain?.bytes ?? null);
    return Promise.resolve(extra.get(name) ?? null);
  };
}

/**
 * The preserve run directory: the CLI half of the checkpoint contract.
 *
 * Core's steps return bytes and state; this module is what makes them
 * durable. Two rules do all the work:
 *
 *  - EVERY write is atomic (temporary file in the destination directory, then
 *    rename). A run killed mid-write leaves either the old file or the new
 *    one, never a truncated checkpoint — and rename never crosses filesystems,
 *    so the temporary file lives beside its target.
 *  - The state document is written AFTER the artifacts it names, every step.
 *    A crash between the two leaves the state behind the files, which is the
 *    safe direction: `--resume` re-runs the step, rewrites its artifacts and
 *    catches up. The reverse — a state naming files that were never written —
 *    is what a run must never be able to resume against.
 */

import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  PRESERVE_RUN_STATE_FILE,
  PRESERVE_STEP_IDS,
  isPreserveStepId,
  sha256hex,
  type PreserveRunState,
} from '@seek-fw/core';
import type { Artifact } from '@seek-fw/core';
import { CliError } from './errors.js';
import { resolveArtifactPath } from './output.js';

export { PRESERVE_RUN_STATE_FILE };

/** The state document's path inside a run directory. */
export function runStatePath(runDir: string): string {
  return join(runDir, PRESERVE_RUN_STATE_FILE);
}

let tmpSequence = 0;

/** Writes `data` so that a crash leaves either the old file or the new one. */
export async function writeFileAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.tmp-${String(process.pid)}-${String((tmpSequence += 1))}`;
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** One run artifact, written atomically at its (zip-slip-checked) name. */
export async function writeRunArtifact(runDir: string, artifact: Artifact): Promise<string> {
  const file = resolveArtifactPath(runDir, artifact.name);
  await writeFileAtomic(file, artifact.data);
  return file;
}

/** Validates the shape well enough that the steps can trust it, and says so
 *  when it is not the document this tool wrote. */
export function parseRunState(text: string, file: string): PreserveRunState {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new CliError(
      `${file} is not valid JSON (${error instanceof Error ? error.message : String(error)}) — ` +
        'the run state is damaged; restore it from a copy or start a new run',
      { code: 'preserve/state' },
    );
  }
  /* Inspected as unknown on purpose: the cast below is only honest after the
   * checks, and a document that fails them is refused, not trimmed to fit. */
  const loose = doc as Record<string, unknown>;
  if (
    typeof doc !== 'object' ||
    doc === null ||
    loose.version !== 1 ||
    typeof loose.runId !== 'string' ||
    typeof loose.imageSha256 !== 'string' ||
    typeof loose.expectedVersion !== 'string' ||
    typeof loose.createdAt !== 'string' ||
    !(
      typeof loose.nextStep === 'string' &&
      (loose.nextStep === 'done' || isPreserveStepId(loose.nextStep))
    ) ||
    typeof loose.steps !== 'object' ||
    loose.steps === null
  ) {
    throw new CliError(
      `${file} is not a version-1 preserve run state — this tool refuses to guess what a ` +
        'document it did not write means. Start a new run, or restore the file from a copy.',
      { code: 'preserve/state' },
    );
  }
  return doc as PreserveRunState;
}

/** Loads and validates `preserve_run.json` from a run directory. */
export async function loadRunState(runDir: string): Promise<PreserveRunState> {
  const file = runStatePath(runDir);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new CliError(
      `no preserve run state at ${file} — --resume needs a run directory that holds one ` +
        '(start a run without --resume to create it)',
      { code: 'preserve/state' },
    );
  }
  return parseRunState(text, file);
}

/** Rewrites the state document. Called after every step, and once before the
 *  first, so a run is always resumable from what is on disk. */
export async function saveRunState(runDir: string, state: PreserveRunState): Promise<void> {
  await writeFileAtomic(
    runStatePath(runDir),
    new TextEncoder().encode(`${JSON.stringify(state, null, 2)}\n`),
  );
}

/** One recorded artifact, checked against the run directory. */
export interface ArtifactInventoryEntry {
  readonly name: string;
  readonly recordedSha256: string;
  readonly present: boolean;
  /** null when the file is absent, true when it still matches the record. */
  readonly shaMatches: boolean | null;
}

/** Every artifact a completed step recorded, checked against what is on disk. */
export async function artifactInventory(
  runDir: string,
  state: PreserveRunState,
): Promise<ArtifactInventoryEntry[]> {
  const recorded = new Map<string, string>();
  for (const id of PRESERVE_STEP_IDS) {
    const record = state.steps[id];
    for (const [name, sha] of Object.entries(record?.artifactShas ?? {})) {
      /* The same artifact can be re-emitted by a re-run step; last wins. */
      recorded.set(name, sha);
    }
  }
  const out: ArtifactInventoryEntry[] = [];
  for (const [name, recordedSha256] of [...recorded].sort(([a], [b]) => a.localeCompare(b))) {
    let bytes: Uint8Array | null;
    try {
      const file = resolveArtifactPath(runDir, name);
      await stat(file); /* distinguishes absent from unreadable cheaply */
      const buffer = await readFile(file);
      bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    } catch {
      bytes = null;
    }
    out.push({
      name,
      recordedSha256,
      present: bytes !== null,
      shaMatches: bytes === null ? null : (await sha256hex(bytes)) === recordedSha256,
    });
  }
  return out;
}

/**
 * Where a run's `Artifact[]` ends up: a directory, a `.zip`, or both.
 *
 * Core hands back names like `windows/addr_14030000_subcmd_05.bin` and
 * `decrypted/....bin`, so writing them means creating subdirectories — and
 * that is exactly the shape of a zip-slip: one artifact named `../../etc/x`
 * and a dump would write outside the directory the user named. Every name
 * therefore goes through `resolveArtifactPath`, which refuses anything that
 * does not stay inside the output directory.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { buildZip, zipEntryCount, zipTotalDataSize, type Artifact } from '@seek-fw/core';
import { CliError } from './errors.js';

function reject(name: string, why: string): never {
  throw new CliError(`refusing to write artifact '${name}': ${why}`, {
    code: 'cli/unsafe-path',
  });
}

/**
 * The absolute path an artifact may be written to, or a throw.
 *
 * Rejects absolute names, Windows drive letters, `..` traversal and NUL, and
 * then re-checks the resolved result against the resolved directory so that a
 * name which is individually innocent cannot escape by some route this list
 * did not anticipate.
 */
export function resolveArtifactPath(directory: string, name: string): string {
  if (name === '') reject(name, 'the name is empty');
  if (name.includes('\0')) reject(name, 'the name contains a NUL byte');
  if (name.includes('\\'))
    reject(name, 'artifact names are POSIX paths; backslashes are not allowed');
  if (isAbsolute(name) || name.startsWith('/')) reject(name, 'the name is an absolute path');
  if (/^[A-Za-z]:/.test(name)) reject(name, 'the name carries a drive letter');

  const segments = name.split('/');
  if (segments.some((segment) => segment === '..'))
    reject(name, "the name contains a '..' segment");
  if (segments.some((segment) => segment === ''))
    reject(name, 'the name has an empty path segment');

  const root = resolve(directory);
  const full = resolve(root, name);
  const rel = relative(root, full);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    reject(name, 'the name resolves outside the output directory');
  }
  /* `relative` normalises separators, so this catches anything the segment
   * checks above missed on a platform whose rules differ. */
  if (rel.split(sep).includes('..')) reject(name, 'the name escapes the output directory');
  return full;
}

export interface WrittenOutput {
  /** Absolute paths written, in artifact order. */
  readonly files: readonly string[];
  /** The directory written to, when one was. */
  readonly directory: string | null;
  /** The zip written, when one was. */
  readonly zip: string | null;
  /** Artifacts written — which is one per zip entry, not one per path. */
  readonly entries: number;
  readonly bytes: number;
}

export async function writeArtifactsToDirectory(
  directory: string,
  artifacts: readonly Artifact[],
): Promise<readonly string[]> {
  const written: string[] = [];
  /* Resolve every name BEFORE creating anything, so a bad one cannot leave a
   * half-written directory behind. */
  const targets = artifacts.map((artifact) => resolveArtifactPath(directory, artifact.name));
  await mkdir(resolve(directory), { recursive: true });
  for (const [index, artifact] of artifacts.entries()) {
    const target = targets[index];
    if (target === undefined) continue;
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, artifact.data);
    written.push(target);
  }
  return written;
}

export async function writeArtifactsToZip(
  file: string,
  artifacts: readonly Artifact[],
): Promise<number> {
  for (const artifact of artifacts) {
    /* The same guard: a zip entry named `../x` is the original zip-slip, and
     * core's own `buildZip` stores names verbatim. */
    resolveArtifactPath('/seek-fw-zip-root', artifact.name);
  }
  const bytes = buildZip(artifacts);
  const target = resolve(file);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes);
  return bytes.length;
}

export interface OutputTarget {
  readonly directory: string | null;
  readonly zip: string | null;
}

/** Writes to whichever targets were asked for. At least one always is. */
export async function writeOutputs(
  target: OutputTarget,
  artifacts: readonly Artifact[],
): Promise<WrittenOutput> {
  const files: string[] = [];
  /* Core's own accounting of what a store-only archive holds, so the number
   * reported for a directory and the number reported for a zip cannot drift. */
  let bytes = zipTotalDataSize(artifacts);

  if (target.directory !== null) {
    files.push(...(await writeArtifactsToDirectory(target.directory, artifacts)));
  }
  if (target.zip !== null) {
    bytes = await writeArtifactsToZip(target.zip, artifacts);
    files.push(resolve(target.zip));
  }
  return {
    files,
    directory: target.directory === null ? null : resolve(target.directory),
    zip: target.zip === null ? null : resolve(target.zip),
    entries: zipEntryCount(artifacts),
    bytes,
  };
}

/** `./seek-dump-20260920-143000`, the default when neither --out nor --zip is given. */
export function defaultOutputDirectory(kind: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
  return join('.', `seek-${kind}-${stamp}`);
}

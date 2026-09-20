/**
 * The web layer's half of core's "a workflow returns bytes, it never saves a
 * file" rule. Core hands back `Artifact[]` and a ZIP as a `Uint8Array`; this is
 * the only module that knows what a `Blob` is.
 */

import { buildZip, type Artifact } from '@seek-fw/core';

/** The original revoked after a minute, which is long enough for the browser
 *  to have started writing the file and short enough not to leak a 4 MiB blob
 *  for the life of the tab. */
export const REVOKE_DELAY_MS = 60_000;

export interface DownloadDeps {
  readonly doc: Document;
  readonly createObjectURL: (blob: Blob) => string;
  readonly revokeObjectURL: (url: string) => void;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
}

function liveDeps(): DownloadDeps {
  return {
    doc: document,
    createObjectURL: (blob) => URL.createObjectURL(blob),
    revokeObjectURL: (url) => {
      URL.revokeObjectURL(url);
    },
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  };
}

/** Original `downloadBlob`: anchor, click, remove, revoke on a timer. */
export function downloadBlob(blob: Blob, filename: string, deps: DownloadDeps = liveDeps()): void {
  const url = deps.createObjectURL(blob);
  const anchor = deps.doc.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  deps.doc.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  deps.setTimeout(() => {
    deps.revokeObjectURL(url);
  }, REVOKE_DELAY_MS);
}

export function downloadBytes(
  data: Uint8Array,
  filename: string,
  type = 'application/octet-stream',
  deps: DownloadDeps = liveDeps(),
): void {
  downloadBlob(new Blob([data as BlobPart], { type }), filename, deps);
}

export interface ArchiveResult {
  readonly fileName: string;
  readonly fileCount: number;
  readonly bytes: number;
}

/**
 * Packs `artifacts` under a single top-level folder and downloads the archive,
 * exactly as the original did (`buildZip(files.map(f => dirName + "/" + f.name))`).
 */
export function downloadArchive(
  dirName: string,
  artifacts: readonly Artifact[],
  deps: DownloadDeps = liveDeps(),
): ArchiveResult {
  const zip = buildZip(
    artifacts.map((file) => ({ name: `${dirName}/${file.name}`, data: file.data })),
  );
  const fileName = `${dirName}.zip`;
  downloadBlob(new Blob([zip as BlobPart], { type: 'application/zip' }), fileName, deps);
  return { fileName, fileCount: artifacts.length, bytes: zip.length };
}

export function mib(bytes: number, digits = 1): string {
  return (bytes / (1024 * 1024)).toFixed(digits);
}

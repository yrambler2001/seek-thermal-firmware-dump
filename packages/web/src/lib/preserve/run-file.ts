/**
 * The run file: a store-only ZIP holding `preserve_run.json` plus every
 * checkpoint the run has produced so far. Built after EVERY completed step and
 * again on demand; the only memory a run has — the app keeps no browser
 * storage, so "resume" means "read this file back in".
 *
 * The layout follows the page: the run state and a generated README at the
 * top, then one folder per wizard step (`02-read-build/`, `03-patch-dump/`,
 * `04-restore-verify/`) holding what that step produced. The reader finds
 * checkpoints by file name in any folder, so the older flat run files still
 * load — and are re-saved in the folder layout.
 *
 * Building is core's `buildZip` (the same writer the dump archives use). The
 * reader side is here, and it is deliberately small: core ships only the
 * writer, and the files it writes are store-only (method 0), UTF-8-named,
 * CRC-checked and descriptor-free — exactly the narrow slice this reader
 * parses, with every entry verified against its CRC-32 before it is trusted.
 */

import { crc32, utf8 } from '@seek-fw/core';
import {
  CHECKPOINT_FILES,
  CHECKPOINT_STEP,
  PHASE_FOLDER,
  PRESERVE_BACKUP_FILE,
  PRESERVE_BANK_CAPTURE_FILE,
  PRESERVE_DUMP_ORIGINAL_FILE,
  PRESERVE_DUMP_POSTWRITE_FILE,
  PRESERVE_PATCHED_FILE,
  PRESERVE_PLAIN_NAME,
  PRESERVE_VERIFY_FILE,
  RUN_STATE_FILE,
  phaseOfStep,
  runFileName,
  type CheckpointName,
  type PreserveRunState,
} from './types';

/** The generated guide at the top of the run file. Rebuilt on every save. */
export const RUN_README_FILE = 'README.md';

/** Where a checkpoint lives in the run file: its step's folder. */
export function checkpointPath(name: CheckpointName): string {
  return `${PHASE_FOLDER[phaseOfStep(CHECKPOINT_STEP[name])]}/${name}`;
}

const FOLDERS: readonly string[] = Object.values(PHASE_FOLDER);

function inStepFolder(name: string): boolean {
  return FOLDERS.some((folder) => name.startsWith(`${folder}/`));
}

function baseName(name: string): string {
  return name.slice(name.lastIndexOf('/') + 1);
}

/** What each checkpoint is, in words, for the README. */
const CHECKPOINT_WHAT: Readonly<Record<CheckpointName, string>> = {
  [PRESERVE_BACKUP_FILE]:
    'the 31 blocks a stock camera serves, read before anything was written, at their flash ' +
    'addresses (0xFF where a block cannot be read this way)',
  [PRESERVE_BANK_CAPTURE_FILE]:
    'the firmware block the camera boots from, read twice (both reads agreed)',
  [PRESERVE_PLAIN_NAME]: 'the firmware image from that block, decrypted',
  [PRESERVE_PATCHED_FILE]: 'the same image with the temporary read patch applied',
  [PRESERVE_DUMP_POSTWRITE_FILE]:
    'the whole 4 MiB as read, with the patch still in the firmware block',
  [PRESERVE_DUMP_ORIGINAL_FILE]:
    "THE COMPLETE IMAGE: the whole 4 MiB with the original firmware block put back — the camera's original flash",
  [PRESERVE_VERIFY_FILE]:
    'the 31 blocks read again after the restore, laid out like the backup — it should equal it',
};

/** The README at the top of the run file: what is where, and the shas. */
export function runReadme(
  state: PreserveRunState,
  checkpoints: ReadonlyMap<CheckpointName, Uint8Array>,
  extra: ReadonlyMap<string, Uint8Array>,
  savedAt: Date,
): string {
  const lines: string[] = [
    `${RUN_README_TITLE}${state.runId}`,
    '',
    `Saved ${savedAt.toISOString()}; next step: ${state.nextStep}.` +
      (state.expectedVersion === undefined ? '' : ` Firmware ${state.expectedVersion}.`),
    '',
  ];
  if (checkpoints.has(PRESERVE_DUMP_ORIGINAL_FILE)) {
    lines.push(
      `**The complete flash image:** \`${checkpointPath(PRESERVE_DUMP_ORIGINAL_FILE)}\`` +
        (state.deliveredSha256 === undefined ? '' : ` (sha256 ${state.deliveredSha256})`),
      '',
    );
  }
  lines.push('One folder per step of the Preserve page:', '');
  for (const [phase, folder] of Object.entries(PHASE_FOLDER)) {
    const names = CHECKPOINT_FILES.filter(
      (name) => checkpoints.has(name) && phaseOfStep(CHECKPOINT_STEP[name]) === phase,
    );
    const others = [...extra.keys()].filter((name) => name.startsWith(`${folder}/`));
    if (names.length === 0 && others.length === 0) continue;
    lines.push(`- \`${folder}/\``);
    for (const name of names) lines.push(`  - \`${name}\` — ${CHECKPOINT_WHAT[name]}`);
    if (others.length > 0) {
      lines.push(
        `  - ${String(others.length)} more file(s): the backup decrypted, as the Dump & decrypt ` +
          'page would (`decrypted/`, `manifest.json`, `README.md`)',
      );
    }
  }
  lines.push(
    '',
    `\`${RUN_STATE_FILE}\` is the run's record: load this zip on the Preserve page to ` +
      'continue the run, or to look at it again.',
    '',
  );
  return lines.join('\n');
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
/** Central-directory entries can hide a 65,535-byte comment after the EOCD. */
const EOCD_MAX_COMMENT = 65_535;
const EOCD_SIZE = 22;
const CENTRAL_HEADER_SIZE = 46;
const LOCAL_HEADER_SIZE = 30;
const METHOD_STORE = 0;

export interface PreserveRunFile {
  readonly state: PreserveRunState;
  /** The checkpoints the run has produced, bytes as written. */
  readonly checkpoints: ReadonlyMap<CheckpointName, Uint8Array>;
  /**
   * Entries this version of the wizard does not know, kept verbatim so
   * saving the run again never drops another writer's files.
   */
  readonly extra: ReadonlyMap<string, Uint8Array>;
}

export interface RunFileEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** Packs the run state and its checkpoints into the run ZIP's bytes: the
 *  state and the README at the top, everything else in its step's folder. */
export function buildRunFile(
  state: PreserveRunState,
  checkpoints: ReadonlyMap<CheckpointName, Uint8Array>,
  extra: ReadonlyMap<string, Uint8Array> = new Map(),
  savedAt: Date = new Date(),
): Uint8Array {
  const json = utf8(`${JSON.stringify(state, null, 2)}\n`);
  const entries: RunFileEntry[] = [
    { name: RUN_STATE_FILE, data: json },
    { name: RUN_README_FILE, data: utf8(runReadme(state, checkpoints, extra, savedAt)) },
  ];
  for (const name of CHECKPOINT_FILES) {
    const data = checkpoints.get(name);
    if (data !== undefined) entries.push({ name: checkpointPath(name), data });
  }
  for (const [name, data] of extra) {
    if (name !== RUN_STATE_FILE && name !== RUN_README_FILE) entries.push({ name, data });
  }
  return buildStoreZip(entries);
}

/** Minimal store-only ZIP writer over core's `crc32` — `buildZip`'s layout. */
function buildStoreZip(entries: readonly RunFileEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const now = new Date();
  const time = dosTime(now);
  const date = dosDate(now);

  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const size = entry.data.length;
    const local = new Uint8Array(LOCAL_HEADER_SIZE + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIGNATURE, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, 0x0800, true); /* UTF-8 names */
    lv.setUint16(8, METHOD_STORE, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, LOCAL_HEADER_SIZE);
    parts.push(local, entry.data);

    const dir = new Uint8Array(CENTRAL_HEADER_SIZE + nameBytes.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, CENTRAL_SIGNATURE, true);
    dv.setUint16(4, 20, true);
    dv.setUint16(6, 20, true);
    dv.setUint16(8, 0x0800, true);
    dv.setUint16(10, METHOD_STORE, true);
    dv.setUint16(12, time, true);
    dv.setUint16(14, date, true);
    dv.setUint32(16, crc, true);
    dv.setUint32(20, size, true);
    dv.setUint32(24, size, true);
    dv.setUint16(28, nameBytes.length, true);
    dv.setUint32(42, offset, true);
    dir.set(nameBytes, CENTRAL_HEADER_SIZE);
    central.push(dir);
    offset += local.length + size;
  }

  const centralDirectorySize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(EOCD_SIZE);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, EOCD_SIGNATURE, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralDirectorySize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralDirectorySize + EOCD_SIZE);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  for (const part of central) {
    out.set(part, at);
    at += part.length;
  }
  out.set(eocd, at);
  return out;
}

function dosTime(date: Date): number {
  return (
    ((date.getHours() & 31) << 11) |
    ((date.getMinutes() & 63) << 5) |
    ((date.getSeconds() >> 1) & 31)
  );
}

function dosDate(date: Date): number {
  return (
    (((date.getFullYear() - 1980) & 127) << 9) |
    (((date.getMonth() + 1) & 15) << 5) |
    date.getDate()
  );
}

function u16(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8);
}

function u32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

/**
 * Parses a store-only ZIP: locates the end-of-central-directory record, walks
 * the central directory, slices each entry out of its local header and checks
 * its CRC-32. Anything compressed (method != 0) is refused — the run files
 * this app writes are stored, and a foreign deflated archive is not a run
 * file this wizard knows how to resume.
 */
export function parseZipEntries(zip: Uint8Array): RunFileEntry[] {
  /* Find the EOCD from the back; its signature can also appear inside a
   * comment, so take the LAST valid one whose directory fits the file. */
  let eocdAt = -1;
  for (
    let at = zip.length - EOCD_SIZE;
    at >= 0 && at >= zip.length - EOCD_SIZE - EOCD_MAX_COMMENT;
    at--
  ) {
    if (u32(zip, at) === EOCD_SIGNATURE) {
      eocdAt = at;
      break;
    }
  }
  if (eocdAt < 0) throw new Error('this file is not a ZIP archive (no end-of-central-directory)');

  const count = u16(zip, eocdAt + 10);
  const directorySize = u32(zip, eocdAt + 12);
  const directoryAt = u32(zip, eocdAt + 16);
  if (directoryAt + directorySize > zip.length) {
    throw new Error('this ZIP archive is truncated (its central directory runs past the file)');
  }

  const decoder = new TextDecoder('utf-8');
  const entries: RunFileEntry[] = [];
  let at = directoryAt;
  for (let index = 0; index < count; index++) {
    if (u32(zip, at) !== CENTRAL_SIGNATURE) {
      throw new Error(`this ZIP archive is damaged (entry ${String(index)} has no central header)`);
    }
    const method = u16(zip, at + 10);
    const crc = u32(zip, at + 16);
    const size = u32(zip, at + 24);
    const nameLen = u16(zip, at + 28);
    const extraLen = u16(zip, at + 30);
    const commentLen = u16(zip, at + 32);
    const localAt = u32(zip, at + 42);
    const name = decoder.decode(
      zip.subarray(at + CENTRAL_HEADER_SIZE, at + CENTRAL_HEADER_SIZE + nameLen),
    );

    if (method !== METHOD_STORE) {
      throw new Error(
        `${name} is compressed (method ${String(method)}) — a run file is store-only; ` +
          'this wizard cannot read it',
      );
    }
    if (u32(zip, localAt) !== LOCAL_SIGNATURE) {
      throw new Error(`${name} has no local header — the archive is damaged`);
    }
    const localNameLen = u16(zip, localAt + 26);
    const localExtraLen = u16(zip, localAt + 28);
    const dataAt = localAt + LOCAL_HEADER_SIZE + localNameLen + localExtraLen;
    const data = zip.slice(dataAt, dataAt + size);
    if (data.length !== size) {
      throw new Error(`${name} is truncated (${String(data.length)}/${String(size)} B)`);
    }
    const actual = crc32(data);
    if (actual !== crc) {
      throw new Error(
        `${name} failed its CRC-32 (stored ${hex8(crc)}, computed ${hex8(actual)}) — ` +
          'the run file is damaged; do not resume from it',
      );
    }
    entries.push({ name, data });
    at += CENTRAL_HEADER_SIZE + nameLen + extraLen + commentLen;
  }
  return entries;
}

function hex8(word: number): string {
  return `0x${word.toString(16).padStart(8, '0')}`;
}

/**
 * Parses a run ZIP: the state file must be present and must be a version the
 * wizard reads — 2 (the current schema, whose image derives from the camera)
 * or 1 (the older schema, whose steps still work off the same artifacts when
 * they carry the derived plaintext). Known checkpoints come back by name,
 * unknown files ride along in `extra` so a later save keeps them.
 */
export function parseRunFile(zip: Uint8Array): PreserveRunFile {
  const entries = parseZipEntries(zip);
  const stateEntry = entries.find((entry) => entry.name === RUN_STATE_FILE);
  /* The folder layout, or the older flat one (every file at the top). */
  const foldered = entries.some((entry) => inStepFolder(entry.name));
  if (stateEntry === undefined) {
    throw new Error(
      `this archive holds no ${RUN_STATE_FILE} — it is not a preserve run file ` +
        `(found: ${entries.map((entry) => entry.name).join(', ') || 'nothing'})`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder('utf-8').decode(stateEntry.data));
  } catch (error) {
    throw new Error(
      `${RUN_STATE_FILE} does not parse as JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error },
    );
  }
  /* The version is checked on the untyped parse, because the typed shape
   * cannot hold a foreign version — that is exactly what it must refuse. */
  const version: unknown = (raw as { version?: unknown }).version;
  if (version !== 1 && version !== 2) {
    throw new Error(
      `${RUN_STATE_FILE} says version ${String(version)}; this wizard reads version 1 and 2. ` +
        'Update the app (or re-run the run) to a matching version.',
    );
  }
  const state = raw as PreserveRunState;
  if (typeof state.runId !== 'string' || state.runId === '') {
    throw new Error(`${RUN_STATE_FILE} has no runId — not a usable run state`);
  }

  const checkpoints = new Map<CheckpointName, Uint8Array>();
  const extra = new Map<string, Uint8Array>();
  for (const entry of entries) {
    if (entry.name === RUN_STATE_FILE) continue;
    /* The generated README is rebuilt on every save (a flat run file's
     * top-level README is the backup's dump archive's, and is kept). */
    if (entry.name === RUN_README_FILE && isRunReadme(entry.data)) continue;
    const base = baseName(entry.name);
    if ((CHECKPOINT_FILES as readonly string[]).includes(base)) {
      checkpoints.set(base as CheckpointName, entry.data);
    } else if (foldered || !fromFlatBackup(entry.name)) {
      extra.set(entry.name, entry.data);
    } else {
      /* A flat run file's other files are the backup step's pre-flash dump
       * archive; they move into its folder. */
      extra.set(`${PHASE_FOLDER['read-build']}/${entry.name}`, entry.data);
    }
  }
  return { state, checkpoints, extra };
}

const RUN_README_TITLE = '# Seek Thermal preserve run ';

function isRunReadme(data: Uint8Array): boolean {
  return new TextDecoder('utf-8').decode(data.subarray(0, 64)).startsWith(RUN_README_TITLE);
}

/** The flat layout's files that came from the backup step's dump archive. */
function fromFlatBackup(name: string): boolean {
  return name.startsWith('decrypted/') || name === 'manifest.json' || name === 'README.md';
}

/** The name the wizard downloads: re-exported so callers share one rule. */
export { runFileName };

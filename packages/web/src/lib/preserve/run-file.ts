/**
 * The run file: a store-only ZIP holding `preserve_run.json` plus every
 * checkpoint the run has produced so far. Built after EVERY completed step and
 * again on demand; the only memory a run has — the app keeps no browser
 * storage, so "resume" means "read this file back in".
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
  RUN_STATE_FILE,
  runFileName,
  type CheckpointName,
  type PreserveRunState,
} from './types';

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

/** Packs the run state and its checkpoints into the run ZIP's bytes. */
export function buildRunFile(
  state: PreserveRunState,
  checkpoints: ReadonlyMap<CheckpointName, Uint8Array>,
  extra: ReadonlyMap<string, Uint8Array> = new Map(),
): Uint8Array {
  const json = utf8(`${JSON.stringify(state, null, 2)}\n`);
  const entries: RunFileEntry[] = [{ name: RUN_STATE_FILE, data: json }];
  for (const name of CHECKPOINT_FILES) {
    const data = checkpoints.get(name);
    if (data !== undefined) entries.push({ name, data });
  }
  for (const [name, data] of extra) {
    if (name !== RUN_STATE_FILE && !CHECKPOINT_FILES.includes(name as CheckpointName)) {
      entries.push({ name, data });
    }
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
 * Parses a run ZIP: the state file must be present and must be a version-1
 * run; known checkpoints come back by name, unknown files ride along in
 * `extra` so a later save keeps them.
 */
export function parseRunFile(zip: Uint8Array): PreserveRunFile {
  const entries = parseZipEntries(zip);
  const stateEntry = entries.find((entry) => entry.name === RUN_STATE_FILE);
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
  if (version !== 1) {
    throw new Error(
      `${RUN_STATE_FILE} says version ${String(version)}; this wizard reads version 1. ` +
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
    if ((CHECKPOINT_FILES as readonly string[]).includes(entry.name)) {
      checkpoints.set(entry.name as CheckpointName, entry.data);
    } else {
      extra.set(entry.name, entry.data);
    }
  }
  return { state, checkpoints, extra };
}

/** The name the wizard downloads: re-exported so callers share one rule. */
export { runFileName };

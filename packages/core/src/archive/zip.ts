/**
 * Dependency-free, store-only (method 0) ZIP writer, ported from
 * `legacy/index.html`'s `buildZip`. No compression is attempted: dumps are
 * already mostly-incompressible flash/firmware bytes, and storing lets the
 * writer stay a couple hundred lines of buffer arithmetic instead of an
 * Inflate/Deflate implementation.
 *
 * DIFFERENCE FROM THE ORIGINAL: the legacy page returned a browser `Blob`.
 * This module has to stay isomorphic (no DOM, no platform globals), so it
 * returns the raw `Uint8Array` instead — the web app wraps it in a `Blob`
 * itself, and the CLI writes it straight to disk.
 *
 * ZIP64 is deliberately NOT implemented: the classic format caps a single
 * entry (and the whole archive) at 4 GiB and the central directory at 65535
 * entries. A 4 MiB flash dump with a few dozen files is nowhere near either
 * limit, so this is a conscious scope cut, not an oversight.
 */

import type { Artifact } from '../events.js';
import { crc32 } from './crc32.js';

const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const VERSION_NEEDED = 20;
const VERSION_MADE_BY = 20;
const UTF8_NAME_FLAG = 0x0800;
const METHOD_STORE = 0;

const textEncoder: TextEncoder = /* @__PURE__ */ new TextEncoder();

/** MS-DOS time: 5 bits hour, 6 bits minute, 5 bits (seconds / 2). */
function dosTime(date: Date): number {
  return (
    ((date.getHours() & 31) << 11) |
    ((date.getMinutes() & 63) << 5) |
    ((date.getSeconds() >> 1) & 31)
  );
}

/** MS-DOS date: 7 bits (year - 1980), 4 bits month, 5 bits day. */
function dosDate(date: Date): number {
  return (
    (((date.getFullYear() - 1980) & 127) << 9) |
    (((date.getMonth() + 1) & 15) << 5) |
    (date.getDate() & 31)
  );
}

interface PreparedEntry {
  readonly nameBytes: Uint8Array;
  readonly data: Uint8Array;
  readonly crc: number;
  readonly localHeaderOffset: number;
}

/**
 * Builds a store-only ZIP archive from `files`. `now` fixes the single
 * DOS timestamp written into every entry (defaults to the current time),
 * which is what makes archive output reproducible in tests.
 */
export function buildZip(files: readonly Artifact[], now: Date = new Date()): Uint8Array {
  const time = dosTime(now);
  const date = dosDate(now);

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  const prepared: PreparedEntry[] = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = textEncoder.encode(file.name);
    const crc = crc32(file.data);
    const size = file.data.length;

    const localHeader = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(localHeader.buffer);
    lv.setUint32(0, LOCAL_FILE_HEADER_SIGNATURE, true);
    lv.setUint16(4, VERSION_NEEDED, true);
    lv.setUint16(6, UTF8_NAME_FLAG, true);
    lv.setUint16(8, METHOD_STORE, true);
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, size, true);
    lv.setUint32(22, size, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true);
    localHeader.set(nameBytes, 30);

    localParts.push(localHeader, file.data);
    prepared.push({ nameBytes, data: file.data, crc, localHeaderOffset: offset });

    offset += localHeader.length + size;
  }

  for (const entry of prepared) {
    const centralHeader = new Uint8Array(46 + entry.nameBytes.length);
    const cv = new DataView(centralHeader.buffer);
    cv.setUint32(0, CENTRAL_DIRECTORY_SIGNATURE, true);
    cv.setUint16(4, VERSION_MADE_BY, true);
    cv.setUint16(6, VERSION_NEEDED, true);
    cv.setUint16(8, UTF8_NAME_FLAG, true);
    cv.setUint16(10, METHOD_STORE, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, entry.crc, true);
    cv.setUint32(20, entry.data.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, entry.nameBytes.length, true);
    /* bytes 30..45 (extra len, comment len, disk#, internal attrs, external attrs) stay 0 */
    cv.setUint32(42, entry.localHeaderOffset, true);
    centralHeader.set(entry.nameBytes, 46);
    centralParts.push(centralHeader);
  }

  const centralDirectorySize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const centralDirectoryOffset = offset;

  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, END_OF_CENTRAL_DIRECTORY_SIGNATURE, true);
  ev.setUint16(4, 0, true); /* disk number */
  ev.setUint16(6, 0, true); /* disk with central directory start */
  ev.setUint16(8, files.length, true); /* entries on this disk */
  ev.setUint16(10, files.length, true); /* total entries */
  ev.setUint32(12, centralDirectorySize, true);
  ev.setUint32(16, centralDirectoryOffset, true);
  ev.setUint16(20, 0, true); /* comment length */

  let totalSize = 0;
  for (const part of localParts) totalSize += part.length;
  for (const part of centralParts) totalSize += part.length;
  totalSize += eocd.length;

  const out = new Uint8Array(totalSize);
  let at = 0;
  for (const part of localParts) {
    out.set(part, at);
    at += part.length;
  }
  for (const part of centralParts) {
    out.set(part, at);
    at += part.length;
  }
  out.set(eocd, at);

  return out;
}

/** Number of entries a ZIP built from `files` will contain. */
export function zipEntryCount(files: readonly Artifact[]): number {
  return files.length;
}

/** Total uncompressed byte count of every entry (store-only, so this is also the on-disk payload size). */
export function zipTotalDataSize(files: readonly Artifact[]): number {
  let total = 0;
  for (const file of files) total += file.data.length;
  return total;
}

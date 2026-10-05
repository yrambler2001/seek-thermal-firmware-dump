/**
 * Reads back the ZIPs the app downloads: every entry by its full path, its
 * bytes, and its CRC-32 checked. The app writes store-only archives; a deflated
 * entry is inflated anyway so this never has to change if that does.
 */

import { crc32, inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export function readZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let at = bytes.length - 22; at >= Math.max(0, bytes.length - 22 - 65_535); at--) {
    if (view.getUint32(at, true) === EOCD) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a ZIP: no end-of-central-directory record');
  const count = view.getUint16(eocd + 10, true);
  let at = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (view.getUint32(at, true) !== CENTRAL) throw new Error(`bad central header #${String(i)}`);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const packed = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(local, true) !== LOCAL) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const raw = bytes.subarray(start, start + packed);
    const data = method === 0 ? raw : new Uint8Array(inflateRawSync(raw));
    if (crc32(data) >>> 0 !== crc >>> 0) throw new Error(`CRC mismatch on ${name}`);
    entries.push({ name, data });
    at += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

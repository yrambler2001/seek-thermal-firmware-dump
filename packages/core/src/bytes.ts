/** Byte, hex and numeric helpers shared by every module. No platform APIs. */

/** `0x1f` — lower-case, optionally zero-padded to `width` digits. */
export function hex(value: number, width = 0): string {
  return `0x${(value >>> 0).toString(16).padStart(width, '0')}`;
}

/** `0x0000FFFF` — upper-case, padded to `width` digits (default 8). */
export function hexUp(value: number, width = 8): string {
  return `0x${(value >>> 0).toString(16).toUpperCase().padStart(width, '0')}`;
}

/** `14030000` — bare upper-case address, for use inside filenames. */
export function addrTag(value: number): string {
  return (value >>> 0).toString(16).toUpperCase().padStart(8, '0');
}

export function bytesToHex(bytes: Uint8Array, count?: number): string {
  const n = count === undefined ? bytes.length : Math.min(count, bytes.length);
  let out = '';
  for (let i = 0; i < n; i++) out += (bytes[i] ?? 0).toString(16).padStart(2, '0');
  return out;
}

export function hexToBytes(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new Error(`hex string has odd length: ${String(text.length)}`);
  const out = new Uint8Array(text.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error(`not hex: ${text.slice(i * 2, i * 2 + 2)}`);
    out[i] = byte;
  }
  return out;
}

/** Decodes up to the first NUL or 0xFF; non-printable bytes become '.'. */
export function asciiz(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) {
    if (b === 0 || b === 0xff) break;
    out += b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.';
  }
  return out;
}

/** Every offset at which `needle` occurs in `haystack`. */
export function findAll(haystack: Uint8Array, needle: Uint8Array): number[] {
  const hits: number[] = [];
  if (needle.length === 0 || needle.length > haystack.length) return hits;
  const last = haystack.length - needle.length;
  const first = needle[0];
  outer: for (let i = 0; i <= last; i++) {
    if (haystack[i] !== first) continue;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    hits.push(i);
  }
  return hits;
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

/** A DataView over exactly the bytes of `bytes`, honouring its byteOffset. */
export function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Accepts decimal or `0x`-prefixed hex. Returns `fallback` on anything else. */
export function parseNumber(text: string | null | undefined, fallback: number): number {
  if (text == null || text.trim() === '') return fallback;
  const trimmed = text.trim();
  const value = /^0x/i.test(trimmed)
    ? Number.parseInt(trimmed.slice(2), 16)
    : Number.parseInt(trimmed, 10);
  return Number.isNaN(value) ? fallback : value;
}

/** `2026-09-20T14-08-33Z` — filesystem-safe, sorts chronologically. */
export function isoStamp(now: Date = new Date()): string {
  return now
    .toISOString()
    .replace(/:/g, '-')
    .replace(/\.\d{3}Z$/, 'Z');
}

const encoder = /* @__PURE__ */ new TextEncoder();

export function utf8(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * The single host capability core depends on. Declaring the slice we use, rather
 * than pulling in `lib.dom` or `@types/node`, is what lets this package stay
 * genuinely isomorphic and dependency-free: WebCrypto is a global in browsers
 * and in Node 18+, and both satisfy this shape.
 */
interface WebCryptoLike {
  readonly subtle: { digest(algorithm: string, data: Uint8Array): Promise<ArrayBuffer> };
}

function webcrypto(): WebCryptoLike {
  const { crypto } = globalThis as unknown as { crypto?: WebCryptoLike };
  if (!crypto?.subtle) {
    throw new Error('WebCrypto is unavailable — a secure context (HTTPS or localhost) is required');
  }
  return crypto;
}

/** SHA-256 as lower-case hex. */
export async function sha256hex(bytes: Uint8Array): Promise<string> {
  const digest = await webcrypto().subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(digest));
}

/** 16-byte-per-row hex dump, for previews in the UI and in reports. */
export function hexDump(bytes: Uint8Array, bytesPerRow = 16): string {
  const lines: string[] = [];
  for (let off = 0; off < bytes.length; off += bytesPerRow) {
    const row = bytes.subarray(off, Math.min(off + bytesPerRow, bytes.length));
    lines.push(
      `${off.toString(16).padStart(4, '0')}  ${bytesToHex(row).replace(/(..)(?=.)/g, '$1 ')}`,
    );
  }
  return lines.join('\n');
}

/* ==================================================================== *
 * Image header, slot footer and the layout the bootloader derives from them.
 *
 * The header sits at 0x200 — inside the cipher's cleartext window — so the
 * bootloader can read `length` and the acceptance adjust word before it has
 * chosen a key. Everything else about a slot's geometry follows from
 * `header.length`, including where the "CODE" footer has to be.
 * ==================================================================== */

import { asciiz, viewOf } from '../bytes.js';

export const IMAGE_MAGIC = 0xa1b2c3d4;
export const HEADER_OFFSET = 0x200;
/** `image_header_t.length`, inside the verbatim header window. */
export const LENGTH_OFFSET = 0x204;
/** Reserved adjust word, also inside the verbatim window. */
export const ADJUST_OFFSET = 0x238;
/** Bytes of header the parser needs to see: 0x200..0x23F. */
export const HEADER_SIZE = 0x40;

export const FOOTER_TAG = 0x45444f43; /* "CODE" */
export const FOOTER_SIZE = 0x40;
export const FOOTER_MODEL_OFFSET = 16;
export const FOOTER_MODEL_LENGTH = 32;

/** `image_try_keys()` rejects any header.length >= this, so it would never boot. */
export const TRY_KEYS_MAX_LEN = 0x10000;
/** Upper gate for a plausible slot length when scanning a dump. */
export const MAX_IMAGE_LEN = 0x1c000;

export interface ImageHeader {
  /** Initial stack pointer, vector-table word 0. */
  readonly sp: number;
  /** Reset vector, vector-table word 1 (Thumb, so bit 0 is set). */
  readonly reset: number;
  readonly magic: number;
  readonly length: number;
  readonly imageId: number;
  readonly version: number;
  readonly entry: number;
  readonly adjust: number;
  readonly versionStr: string;
}

export function parseImageHeader(bytes: Uint8Array, base = 0): ImageHeader | null {
  if (bytes.length < base + HEADER_OFFSET + HEADER_SIZE) return null;
  const dv = viewOf(bytes);
  const version = dv.getUint32(base + HEADER_OFFSET + 12, true);
  return {
    sp: dv.getUint32(base + 0, true),
    reset: dv.getUint32(base + 4, true),
    magic: dv.getUint32(base + HEADER_OFFSET + 0, true),
    length: dv.getUint32(base + HEADER_OFFSET + 4, true),
    imageId: dv.getUint32(base + HEADER_OFFSET + 8, true),
    version,
    entry: dv.getUint32(base + HEADER_OFFSET + 16, true),
    adjust: dv.getUint32(base + ADJUST_OFFSET, true),
    versionStr: versionString(version),
  };
}

/** header.version is four bytes, low byte first: 0x00021204 -> "4.18.2.0". */
export function versionString(word: number): string {
  return [0, 8, 16, 24].map((sh) => (word >>> sh) & 0xff).join('.');
}

export interface ImageFooter {
  readonly offset: number;
  readonly tag: number;
  readonly length: number;
  readonly imageId: number;
  readonly version: number;
  readonly model: string;
  /** The 64 bytes verbatim — a device footer is carried over, not rebuilt. */
  readonly raw: Uint8Array;
}

export function parseFooter(bytes: Uint8Array, offset: number): ImageFooter | null {
  if (offset < 0 || offset + FOOTER_SIZE > bytes.length) return null;
  const dv = viewOf(bytes);
  const modelAt = offset + FOOTER_MODEL_OFFSET;
  return {
    offset,
    tag: dv.getUint32(offset, true),
    length: dv.getUint32(offset + 4, true),
    imageId: dv.getUint32(offset + 8, true),
    version: dv.getUint32(offset + 12, true),
    model: asciiz(bytes.subarray(modelAt, modelAt + FOOTER_MODEL_LENGTH)),
    raw: bytes.slice(offset, offset + FOOTER_SIZE),
  };
}

/**
 * Total slot payload size for a declared image length: image + 0xFF pad +
 * footer, rounded up to whole 0x4000 blocks. The bootloader derives the footer
 * address from header.length exactly this way, so the host must too.
 */
export function bankPayloadSize(length: number): number {
  return (((length >>> 14) + 1) * 0x4000) >>> 0;
}

export function footerOffsetFor(length: number): number {
  return bankPayloadSize(length) - FOOTER_SIZE;
}

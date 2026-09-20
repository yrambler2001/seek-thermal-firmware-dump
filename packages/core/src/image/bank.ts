/* ==================================================================== *
 * Bank payload construction — what actually gets streamed to a camera.
 *
 * The blob that has to be streamed is NOT just the image. Each slot holds
 * image + 0xFF pad + a 64-byte "CODE" footer at
 * ((header.length>>14)+1)*0x4000 - 0x40, and the bootloader takes the
 * monolithic boot path only if footer[0] == "CODE" && footer[1] ==
 * header.length. CompleteMemoryUpgrade erases the whole 64 KiB block and writes
 * back only what the host sent, and the camera never writes the footer itself —
 * so a bare-image upload destroys the footer, the bootloader falls into its
 * segmented loader, and the camera bricks. `buildBankPayload` always emits the
 * full bank, and `assertBankPayload` refuses to stream anything else.
 * ==================================================================== */

import { hex, viewOf } from '../bytes.js';
import { SeekError } from '../errors.js';
import { cryptBytes } from '../crypto/cipher.js';
import { stateFromKey } from '../crypto/keys.js';
import type { CipherProfile } from '../profiles/types.js';
import {
  ADJUST_OFFSET,
  FOOTER_SIZE,
  FOOTER_TAG,
  HEADER_OFFSET,
  HEADER_SIZE,
  LENGTH_OFFSET,
  bankPayloadSize,
  footerOffsetFor,
  parseFooter,
  type ImageFooter,
} from './header.js';

/** BeginFirmwareUpgrade caps a bank at 64 KiB; pass the profile's own value. */
export const DEFAULT_WINDOW_SIZE = 0x10000;

/** 32-bit little-endian word sum over the first `byteLen` bytes. */
export function wordSum32(bytes: Uint8Array, byteLen: number): number {
  const dv = viewOf(bytes);
  let acc = 0;
  for (let o = 0; o + 4 <= byteLen; o += 4) acc = (acc + dv.getUint32(o, true)) >>> 0;
  return acc >>> 0;
}

/** Device-side transfer checksum: 16-bit sum of every byte of the blob. */
export function transferSum16(bytes: Uint8Array): number {
  let s = 0;
  for (const b of bytes) s = (s + b) & 0xffff;
  return s;
}

export interface AcceptSumResult {
  /** A new array; the caller's image is untouched. */
  readonly image: Uint8Array;
  readonly length: number;
  readonly adjust: number;
  readonly sum: number;
}

/**
 * Stamp header.length to the real size, then tune the reserved adjust word at
 * 0x238 so the 32-bit word sum over header.length bytes equals the profile's
 * acceptance target. Both fields sit inside the verbatim header window, so they
 * survive encryption in clear — which is exactly why the bootloader can read
 * the length before it has a key.
 */
export function setAcceptSum(image: Uint8Array, profile: CipherProfile): AcceptSumResult {
  if (image.length < HEADER_OFFSET + HEADER_SIZE) {
    throw new SeekError(
      'image/malformed',
      `image is ${String(image.length)} B, too small to hold a header at ${hex(HEADER_OFFSET)}`,
    );
  }
  const out = image.slice();
  const dv = viewOf(out);
  if (dv.getUint32(LENGTH_OFFSET, true) !== out.length) {
    dv.setUint32(LENGTH_OFFSET, out.length >>> 0, true);
  }
  const length = dv.getUint32(LENGTH_OFFSET, true);
  dv.setUint32(ADJUST_OFFSET, 0, true);
  const adjust = (profile.acceptanceSum - wordSum32(out, length)) >>> 0;
  dv.setUint32(ADJUST_OFFSET, adjust, true);
  return { image: out, length, adjust, sum: wordSum32(out, length) };
}

export interface BankPayload {
  /** The encrypted bank, ready to stream. */
  readonly payload: Uint8Array;
  /** The plaintext image as stamped (length + adjust), before encryption. */
  readonly image: Uint8Array;
  readonly length: number;
  readonly adjust: number;
  readonly footerOffset: number;
  readonly footer: ImageFooter | null;
}

/**
 * image + 0xFF pad + "CODE" footer, encrypted with Key A. `footerTemplate` is
 * the 64-byte footer already on the device: its image_id, version and model
 * string are carried over and only footer[1] (length) is patched, so the blob
 * differs from a factory bank in exactly the bytes it has to.
 */
export function buildBankPayload(
  plain: Uint8Array,
  keyA: Uint8Array,
  footerTemplate: Uint8Array | null,
  profile: CipherProfile,
  windowSize: number = DEFAULT_WINDOW_SIZE,
): BankPayload {
  const { image, length, adjust, sum } = setAcceptSum(plain, profile);
  if (sum !== profile.acceptanceSum) {
    throw new SeekError('image/malformed', 'could not balance the acceptance sum', {
      detail: { sum, target: profile.acceptanceSum },
    });
  }

  const enc = cryptBytes(image, stateFromKey(keyA, profile.whiteningK), profile);
  const total = bankPayloadSize(length);
  const foff = footerOffsetFor(length);
  if (foff < length) {
    throw new SeekError(
      'flash/refused',
      `image of ${hex(length)} B overruns its footer slot at ${hex(foff)}`,
      { detail: { length, footerOffset: foff } },
    );
  }
  if (total > windowSize) {
    throw new SeekError(
      'flash/refused',
      `bank payload ${hex(total)} exceeds the ${hex(windowSize)} upgrade window`,
      { detail: { total, windowSize } },
    );
  }

  if (footerTemplate && footerTemplate.length < FOOTER_SIZE) {
    /* A device footer is read back whole or not at all. A short one means the
     * read was truncated, and half a footer is exactly the thing this file
     * refuses to stream. */
    throw new SeekError(
      'flash/refused',
      `footer template is ${String(footerTemplate.length)} B, not ${String(FOOTER_SIZE)}`,
    );
  }

  const payload = new Uint8Array(total).fill(0xff);
  payload.set(enc, 0);
  const footer = footerTemplate
    ? footerTemplate.slice(0, FOOTER_SIZE)
    : new Uint8Array(FOOTER_SIZE).fill(0xff);
  const fdv = new DataView(footer.buffer, footer.byteOffset, FOOTER_SIZE);
  fdv.setUint32(0, FOOTER_TAG, true);
  fdv.setUint32(4, length >>> 0, true);
  payload.set(footer, foff);

  return { payload, image, length, adjust, footerOffset: foff, footer: parseFooter(payload, foff) };
}

/**
 * Refuse to stream anything whose footer the bootloader would reject. This is
 * the guard that stands between a mistake here and a brick.
 *
 * header.length is read straight out of the encrypted payload: it lives in the
 * cleartext window, which is the same reason the bootloader can read it.
 */
export function assertBankPayload(payload: Uint8Array): void {
  if (payload.length < LENGTH_OFFSET + 4) {
    throw new SeekError(
      'flash/refused',
      `payload is ${String(payload.length)} B — too short to even hold a header length`,
    );
  }
  const dv = viewOf(payload);
  const length = dv.getUint32(LENGTH_OFFSET, true);
  const foff = footerOffsetFor(length);
  if (foff + FOOTER_SIZE > payload.length) {
    throw new SeekError('flash/refused', `payload is too short for a footer at ${hex(foff)}`, {
      detail: { length, footerOffset: foff, payloadLength: payload.length },
    });
  }
  const tag = dv.getUint32(foff, true);
  if (tag !== FOOTER_TAG) {
    throw new SeekError(
      'flash/refused',
      `footer at ${hex(foff)} is not "CODE" — the bootloader would fall into its segmented loader ` +
        'and brick the camera',
      { detail: { footerOffset: foff, tag } },
    );
  }
  const footerLength = dv.getUint32(foff + 4, true);
  if (footerLength !== length) {
    throw new SeekError(
      'flash/refused',
      `footer length ${hex(footerLength)} != header.length ${hex(length)} — the bootloader would ` +
        'reject this slot',
      { detail: { footerLength, length } },
    );
  }
}

/* ==================================================================== *
 * The image cipher.
 *
 * One keystream word is consumed per image word and the generator ALWAYS
 * advances — but the words in the profile's cleartext window (128..143, i.e.
 * bytes 0x200..0x23F: the image header) are stored verbatim. That is what lets
 * the bootloader read `length` and the acceptance adjust word before it has
 * chosen a key, and it is why encryption is self-inverse: the same pass over
 * ciphertext yields plaintext.
 * ==================================================================== */

import { viewOf } from '../bytes.js';
import type { CipherProfile } from '../profiles/types.js';
import { cloneState, xsNext, type Xorshift128State } from './xorshift128.js';

/**
 * Whether image word `index` is XORed with its keystream word.
 *
 * The unsigned wrap is load-bearing: for `index < lo` the subtraction
 * underflows to a huge unsigned value, which is `> span` and therefore
 * "encrypted", so one comparison covers both sides of the window. This is the
 * original's `isEnc` trick, kept verbatim because the whole file's behaviour
 * hangs off it.
 */
export function isEncryptedWord(index: number, clearWords: readonly [number, number]): boolean {
  const [lo, hi] = clearWords;
  return (index - lo) >>> 0 > hi - lo;
}

/**
 * The bootloader's acceptance sum: the 32-bit word sum of the DECRYPTED image
 * over `byteLen` bytes, computed straight off the ciphertext. `state` is not
 * mutated — a private copy is advanced.
 */
export function checksum32(
  view: DataView,
  base: number,
  byteLen: number,
  state: Xorshift128State,
  profile: CipherProfile,
): number {
  const s = cloneState(state);
  const clear = profile.clearWords;
  let acc = 0;
  const n = byteLen >>> 2;
  for (let i = 0; i < n; i++) {
    const k = xsNext(s);
    const w = view.getUint32(base + 4 * i, true);
    acc = (acc + (isEncryptedWord(i, clear) ? (k ^ w) >>> 0 : w)) >>> 0;
  }
  return acc >>> 0;
}

/**
 * Self-inverse xorshift128 pass over `byteLen` bytes at `base`. Encrypt and
 * decrypt are the same operation, hence the two names for one function.
 *
 * `byteLen` is processed a word at a time; any 1..3 trailing bytes are outside
 * the covered region and come back as zero (`cryptBytes` is the byte-level
 * entry point that copies them). `state` is not mutated.
 */
export function cryptImage(
  view: DataView,
  base: number,
  byteLen: number,
  state: Xorshift128State,
  profile: CipherProfile,
): Uint8Array {
  const s = cloneState(state);
  const clear = profile.clearWords;
  const out = new Uint8Array(byteLen);
  const ov = new DataView(out.buffer);
  const n = byteLen >>> 2;
  for (let i = 0; i < n; i++) {
    const k = xsNext(s);
    const w = view.getUint32(base + 4 * i, true);
    ov.setUint32(4 * i, (isEncryptedWord(i, clear) ? (k ^ w) >>> 0 : w) >>> 0, true);
  }
  return out;
}

/** The cipher is self-inverse; this is `cryptImage` under its reading name. */
export const decryptImage: typeof cryptImage = cryptImage;

/**
 * Byte-level pass: the 4-byte-aligned body goes through `cryptImage`, and the
 * uncovered tail is copied verbatim — the generator never reaches it, so a
 * partial word must not be transformed.
 */
export function cryptBytes(
  bytes: Uint8Array,
  state: Xorshift128State,
  profile: CipherProfile,
): Uint8Array {
  const whole = bytes.length & ~3;
  const out = new Uint8Array(bytes.length);
  out.set(cryptImage(viewOf(bytes), 0, whole, state, profile), 0);
  if (whole !== bytes.length) out.set(bytes.subarray(whole), whole);
  return out;
}

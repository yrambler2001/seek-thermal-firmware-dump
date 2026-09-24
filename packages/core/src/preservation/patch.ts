/**
 * The v1-family in-place patch builder — the preservation pipeline's plaintext
 * and ciphertext math.
 *
 * Ported from FW-V1 `ht-201/forge_v1_patch.py` (doc 34) and reduced to what the
 * in-place route needs. Everything here is pure: bytes in, bytes out, no
 * transport, no I/O — so the whole file is unit-testable without a camera.
 *
 * ---- The two domains, and the trap that costs a camera ---------------------
 *
 * A slot on the part does not hold the firmware image; it holds the image XOR
 * a keystream (the bootloader's at-rest cipher). The wire-79 reader serves the
 * SLOT BYTES — ciphertext. But the patch is a change to the PLAINTEXT (the
 * reader-cursor widening and the checksum rebalance are code edits in the
 * image). Writing the new plaintext bytes into a ciphertext capture corrupts
 * the slot: the first wire run of the FW-V1 chain did exactly that and the
 * part came back with garbage code bytes that stalled every vendor wire.
 *
 * The fix is one line of algebra: the wire payload is the capture with
 *
 *     wire[off] := wire[off] XOR old_plain[off] XOR new_plain[off]
 *
 * per patched byte — the keystream cancels, because it is the same on both
 * sides. `conjugateCapture` below is that line, and `buildV1Patch` derives
 * `old`/`new` from a known factory plaintext.
 *
 * ---- What the patch is -----------------------------------------------------
 *
 * Four instruction edits in the v1 update machinery (raw offsets in the
 * decrypted image; VMA = raw + 0x10080368), byte-identical across the 2014
 * builds 1.0.0.0 / 1.2.0.0 / 1.3.0.0 (doc 34 sec. 34.5):
 *
 *   0x3DB4  mov.w r3,#0x10000 -> #0x400000 — the reader window widens from
 *           64 KiB to the whole 4 MiB part (one constant feeds both the
 *           window-length stores);
 *   0x3C1C  ldrh r1,[r5,#12] -> ldr — the wire-79 reader loads its 32-bit
 *           cursor through a HALFWORD load, so reads wrapped every 64 KiB
 *           (measured on the wire);
 *   0x3C68  ldrh r2,[r4,#12] -> ldr — the cursor RE-load for the update step,
 *           still 16-bit even with the first load widened (run 3 still folded
 *           at 0x10200 with only the first site patched);
 *   0x3C70  strh r3,[r4,#12] -> str — the matching halfword STORE of the
 *           advanced cursor.
 *
 * Plus one free header word: the bootloader decrypts the slot and requires the
 * plaintext word sum to be 0, so word 142 (offset 0x238, inside the verbatim
 * header window) carries the negated sum of the patched image. On the factory
 * plaintext that word is 0 and the four sites move the sum, so the rebalance
 * is part of every diff set (for this exact patch set it is 0x30006240).
 *
 * NEVER SHIP A HAND-ASSEMBLED PATCH: every site carries its `before` bytes and
 * `buildV1Patch` refuses to run if the factory plaintext does not match them.
 * The Thumb lesson (doc 34 sec. 34.7) is that LDRH's immediate scales by 2 and
 * LDR's by 4 — three wrong encodings of one edit were measured on the wire
 * before the disassembler-backed builder landed.
 */

import { bytesToHex, hexUp } from '../bytes.js';
import { SeekError } from '../errors.js';

/** The R16 xorshift128 generator, seeded [k1,k2,k3,k0], no whitening — the
 *  2016-donor at-rest form (`forge_v1_patch.py keystream`). Only needed where
 *  the slot's key is known (the emulator's donor); the in-place wire patch
 *  itself never needs it, because the keystream cancels in the conjugation. */
export function keystream(
  keyWords: readonly [number, number, number, number],
  words: number,
): Uint32Array {
  const M = 0xffffffff;
  /* Local vars, not an array: the generator's rotations are fixed, and typed
   * index access keeps them numbers. */
  let s0 = keyWords[1];
  let s1 = keyWords[2];
  let s2 = keyWords[3];
  let s3 = keyWords[0];
  const out = new Uint32Array(words);
  for (let i = 0; i < words; i++) {
    const v1 = (s0 ^ ((s0 << 11) & M)) & M;
    s0 = s1;
    s1 = s2;
    const v2 = s3;
    s2 = v2;
    const v3 = (v2 ^ (v2 >>> 19) ^ v1 ^ (v1 >>> 8)) & M;
    s3 = v3;
    out[i] = v3;
  }
  return out;
}

/** XOR every 32-bit word with `ks`, except header words 128..143 (offsets
 *  0x200..0x23F), which are stored verbatim so the bootloader can read the
 *  length before it has a key. */
export function xorWindowVerbatim(image: Uint8Array, ks: Uint32Array): Uint8Array {
  const out = new Uint8Array(image.length);
  const dv = new DataView(image.buffer, image.byteOffset, image.byteLength);
  const ov = new DataView(out.buffer);
  const words = image.length >> 2;
  for (let i = 0; i < words; i++) {
    const w = dv.getUint32(i * 4, true);
    ov.setUint32(i * 4, i >= 0x80 && i <= 0x8f ? w : (w ^ (ks[i] ?? 0)) >>> 0, true);
  }
  /* A trailing partial word (images are word-multiple, but stay byte-exact). */
  for (let i = words * 4; i < image.length; i++) out[i] = (image[i] ?? 0) ^ 0;
  return out;
}

/** The 32-bit word sum the bootloader checks for 0 on the decrypted slot. */
export function wordSum(bytes: Uint8Array): number {
  const M = 0xffffffff;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let total = 0;
  const words = (bytes.length & ~3) >> 2;
  for (let i = 0; i < words; i++) total = (total + dv.getUint32(i * 4, true)) & M;
  return total >>> 0;
}

/** The plain u16 transfer checksum of the staged bytes (the wire's own gate). */
export function sum16(bytes: Uint8Array): number {
  let total = 0;
  for (const b of bytes) total = (total + b) & 0xffff;
  return total;
}

/** One instruction edit: raw offset in the decrypted image, the bytes that
 *  must already be there, the bytes that replace them. */
export interface PatchSite {
  readonly offset: number;
  readonly before: readonly number[];
  readonly after: readonly number[];
  readonly what: string;
}

/** The vma the raw image offsets map to (payload VMA = raw + 0x10080368). */
export const V1_PAYLOAD_VMA_BASE = 0x10080368;

/** The free header word that balances the plaintext sum: word 142, offset 0x238. */
export const REBALANCE_WORD_OFFSET = 142 * 4;

/** The four instruction sites of the 2014 builds (1.0.0.0 / 1.2.0.0 / 1.3.0.0). */
export const V1_2014_PATCH_SITES: readonly PatchSite[] = [
  {
    offset: 0x3db4,
    before: [0x4f, 0xf4, 0x80, 0x33],
    after: [0x4f, 0xf4, 0x80, 0x03],
    what:
      'mov.w r3,#0x10000 -> #0x400000 (VMA 0x1008411C): one constant feeds the d4 AND dc ' +
      'window-length stores — the wire-79 reader window becomes [0x14000000, 0x14400000)',
  },
  {
    offset: 0x3c1c,
    before: [0xa9, 0x89],
    after: [0xe9, 0x68],
    what:
      'ldrh r1,[r5,#12] -> ldr r1,[r5,#12] (VMA 0x10083F84): the wire-79 reader loads its ' +
      'd8 cursor as a HALFWORD, so reads wrap every 64 KiB. LDR imm T1 0x68E9, imm5=3 (offset 12)',
  },
  {
    offset: 0x3c68,
    before: [0xa2, 0x89],
    after: [0xe2, 0x68],
    what:
      'ldrh r2,[r4,#12] -> ldr r2,[r4,#12] (VMA 0x10083FD0): the cursor RE-load for the ' +
      'update step — still 16-bit, it truncated d8 at EVERY read even with the first site ' +
      'patched. LDR imm T1 0x68E2, imm5=3',
  },
  {
    offset: 0x3c70,
    before: [0xa3, 0x81],
    after: [0xe3, 0x60],
    what:
      'strh r3,[r4,#12] -> str r3,[r4,#12] (VMA 0x10083FD8): the matching halfword STORE ' +
      'of the advanced cursor. STR imm T1 0x60E3, imm5=3',
  },
];

/** The factory plaintext every assertion below hangs off. */
export interface V1Patch {
  /** The input, verbatim. */
  readonly factory: Uint8Array;
  /** `factory` with the four sites applied and word 142 rebalanced. */
  readonly patched: Uint8Array;
  /** Byte offsets where `patched` differs from `factory` — the pipeline's
   *  whole effect on the part, enumerated. For the 2014 patch set: exactly
   *  the ten bytes 0x238, 0x239, 0x23B, 0x3C1C, 0x3C1D, 0x3C68, 0x3C69,
   *  0x3C70, 0x3C71, 0x3DB7. */
  readonly diffOffsets: readonly number[];
  /** `factory[o] ^ patched[o]` per diff offset — the conjugation mask. */
  readonly mask: Uint8Array;
  /** The rebalance word, as stored (little-endian) at `REBALANCE_WORD_OFFSET`. */
  readonly rebalanceWord: number;
  /** Patched word sum — 0 by construction. */
  readonly patchedWordSum: number;
}

/**
 * Build the v1 2014-family patch from a factory plaintext.
 *
 * Refuses — before anything is derived — if the plaintext does not carry the
 * expected `before` bytes at every site, if its own word sum is not 0 (the
 * rebalance assumes a balanced input), or if the rebalance word is not free.
 */
export function buildV1Patch(plain: Uint8Array): V1Patch {
  if (plain.length & 3) {
    throw new SeekError(
      'pipeline/refused',
      `image length ${String(plain.length)} is not a multiple of 4`,
    );
  }
  if (plain.length < REBALANCE_WORD_OFFSET + 4) {
    throw new SeekError('pipeline/refused', 'image is too small to hold the header window');
  }
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  if (wordSum(plain) !== 0) {
    throw new SeekError(
      'pipeline/refused',
      'the factory plaintext word sum is not 0 — this builder only rebalances a balanced image',
    );
  }
  if (dv.getUint32(REBALANCE_WORD_OFFSET, true) !== 0) {
    throw new SeekError(
      'pipeline/refused',
      `the rebalance word at ${hexUp(REBALANCE_WORD_OFFSET)} is not free (0)`,
    );
  }

  const patched = new Uint8Array(plain);
  for (const site of V1_2014_PATCH_SITES) {
    for (let i = 0; i < site.before.length; i++) {
      if (patched[site.offset + i] !== site.before[i]) {
        throw new SeekError(
          'pipeline/refused',
          `bytes at raw ${hexUp(site.offset)} are not the expected ` +
            `${bytesToHex(Uint8Array.from(site.before))} — ` +
            `this image does not carry the v1 2014 update machinery this patch was derived ` +
            `from (${site.what})`,
        );
      }
    }
    patched.set(site.after, site.offset);
  }

  const total = wordSum(patched);
  const rebalanceWord = (0 - total) >>> 0;
  new DataView(patched.buffer).setUint32(REBALANCE_WORD_OFFSET, rebalanceWord, true);
  if (wordSum(patched) !== 0) {
    throw new SeekError('pipeline/refused', 'the rebalance did not bring the word sum to 0');
  }

  const diffOffsets: number[] = [];
  for (let i = 0; i < plain.length; i++) {
    if (plain[i] !== patched[i]) diffOffsets.push(i);
  }
  const mask = new Uint8Array(diffOffsets.length);
  diffOffsets.forEach((o, i) => {
    mask[i] = (plain[o] ?? 0) ^ (patched[o] ?? 0);
  });

  return {
    factory: plain,
    patched,
    diffOffsets,
    mask,
    rebalanceWord,
    patchedWordSum: wordSum(patched),
  };
}

/**
 * THE CIPHERTEXT RULE, as a function: apply the plaintext diff to a SLOT
 * CAPTURE (ciphertext) so the decrypted image changes by exactly the diff.
 *
 * `capture` is what the wire-79 reader served for the bank; `plain` and
 * `patched` are the builder's two plaintexts. The result is the staged
 * wire-80 payload: image-length only (the commit erases the whole 64 KiB
 * block and programs exactly the staged bytes, and the as-booted tail past
 * the image is already erased — a full 64 KiB stage would also overrun the
 * descriptor's staging buffer at 0x20002000 + 0xE000).
 */
export function conjugateCapture(
  capture: Uint8Array,
  patch: V1Patch,
  imageLen: number = patch.factory.length,
): Uint8Array {
  if (capture.length < imageLen) {
    throw new SeekError(
      'pipeline/refused',
      `the bank capture is ${String(capture.length)} B, shorter than the image ` +
        `(${String(imageLen)} B)`,
    );
  }
  const out = new Uint8Array(capture.subarray(0, imageLen));
  patch.diffOffsets.forEach((off, i) => {
    const m = patch.mask[i] ?? 0;
    if (m === 0) return; /* a zero mask byte is not a diff */
    if (off >= imageLen) {
      throw new SeekError(
        'pipeline/refused',
        `patch offset ${hexUp(off)} is past the image length`,
      );
    }
    out[off] = ((out[off] ?? 0) ^ m) & 0xff;
  });
  return out;
}

/**
 * Verify a bank capture against what the factory plaintext predicts, BEFORE
 * anything is written.
 *
 * Two checks, strongest first:
 *  - `expected` (the plain XOR keystream of the factory image, when the slot
 *    key is known — the emulator's donor case) must equal the capture's image
 *    prefix byte for byte;
 *  - ALWAYS, the verbatim header window (words 128..143, offsets 0x200..0x23F)
 *    of the capture must equal the factory plaintext's — that window is stored
 *    unencrypted, so this check needs no key material and works on hardware
 *    where the device key was never recovered.
 */
export function verifyCapture(
  capture: Uint8Array,
  plain: Uint8Array,
  expected?: Uint8Array,
): { ok: boolean; reason: string | null } {
  if (expected !== undefined) {
    if (capture.length < expected.length) {
      return {
        ok: false,
        reason: `capture ${String(capture.length)} B shorter than expected prefix`,
      };
    }
    for (let i = 0; i < expected.length; i++) {
      if (capture[i] !== expected[i]) {
        return {
          ok: false,
          reason:
            `capture byte ${hexUp(i)} is ${hexUp(capture[i] ?? 0, 2)}, expected ` +
            `${hexUp(expected[i] ?? 0, 2)} (the bank does not hold the factory image)`,
        };
      }
    }
    return { ok: true, reason: null };
  }
  const windowStart = 0x80 * 4;
  const windowEnd = (0x8f + 1) * 4;
  if (capture.length < windowEnd || plain.length < windowEnd) {
    return { ok: false, reason: 'capture or plaintext too short for the verbatim header window' };
  }
  for (let i = windowStart; i < windowEnd; i++) {
    if (capture[i] !== plain[i]) {
      return {
        ok: false,
        reason:
          `verbatim header word at ${hexUp(i)} differs — the bank does not hold the ` +
          'factory image (that window is stored unencrypted, so this is a real mismatch)',
      };
    }
  }
  return { ok: true, reason: null };
}

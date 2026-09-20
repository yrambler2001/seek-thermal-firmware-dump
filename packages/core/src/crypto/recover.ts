/* ==================================================================== *
 * Cryptanalytic key recovery — no key search.
 *
 * xorshift128 is linear over GF(2), so every keystream word is a linear
 * function of the 128-bit state. A Cortex-M image begins with a vector table
 * whose reserved slots at word indices 7,8,9,10 are 0x00000000; those words ARE
 * encrypted, so the ciphertext there IS the keystream. Those 128 known
 * keystream bits feed a 128x128 GF(2) solve that yields the state directly from
 * the image — the stored key is never needed and is never scanned for.
 *
 * The state alone decrypts an image. K only labels which build a recovered key
 * belongs to, and the acceptance TARGET only says which build profile the image
 * was cut for. A profile miss never aborts a slot: it is decrypted anyway and
 * the recovered material is reported with a per-slot confidence.
 * ==================================================================== */

import type { CipherProfile } from '../profiles/types.js';
import { bytesToHex } from '../bytes.js';
import { checksum32 } from './cipher.js';
import { keyFromState } from './keys.js';
import { cloneState, xsNext, type Xorshift128State } from './xorshift128.js';

/**
 * Reserved Cortex-M vectors that are 0x00000000 in a valid image. Words 7..10
 * are used as known-zero plaintext to solve for the state; word 13 is held back
 * to independently confirm the recovered state.
 */
export const KNOWN_ZERO_IDX: readonly number[] = [7, 8, 9, 10];
export const CHECK_ZERO_IDX = 13;

/**
 * Whitening constants to list a nominal key under. K is unidentifiable from
 * ciphertext alone, so every one of these is reported and the caller decides —
 * see `resolveWhitening` for the plaintext-evidence answer.
 */
export const CANDIDATE_K: readonly number[] = [0x00000000, 0x13579bdf];

/** Keystream words at the requested positions for a chosen initial state. */
function outsAtState(state: Xorshift128State, positions: readonly number[]): number[] {
  const s = cloneState(state);
  const maxP = Math.max(...positions);
  const want = new Set(positions);
  const got = new Map<number, number>();
  for (let i = 0; i <= maxP; i++) {
    const o = xsNext(s);
    if (want.has(i)) got.set(i, o);
  }
  return positions.map((p) => got.get(p) ?? 0);
}

/**
 * The GF(2) coefficient matrix (state bits -> keystream at KNOWN_ZERO_IDX)
 * depends only on the generator and those positions, so build it once. 128
 * unit-vector states x 11 generator steps: microseconds at module load.
 */
const A_ROWS: readonly bigint[] = /* @__PURE__ */ (() => {
  const rows = new Array<bigint>(128).fill(0n);
  for (let j = 0; j < 128; j++) {
    const st = new Uint32Array(4);
    st[j >> 5] = (1 << (j & 31)) >>> 0;
    const outs = outsAtState(st, KNOWN_ZERO_IDX);
    for (let p = 0; p < outs.length; p++) {
      const o = outs[p] ?? 0;
      for (let b = 0; b < 32; b++) {
        if ((o >>> b) & 1) rows[p * 32 + b] = (rows[p * 32 + b] ?? 0n) | (1n << BigInt(j));
      }
    }
  }
  return rows;
})();

/**
 * Solve `A * state = keystream(known-zero words)` over GF(2) by Gaussian
 * elimination on 129-bit augmented rows. Returns the recovered 128-bit initial
 * state as `[x, y, z, w]`.
 */
export function recoverState(view: DataView, base: number): Xorshift128State {
  let rhs = 0n;
  KNOWN_ZERO_IDX.forEach((idx, p) => {
    const c = view.getUint32(base + 4 * idx, true) >>> 0;
    for (let b = 0; b < 32; b++) if ((c >>> b) & 1) rhs |= 1n << BigInt(p * 32 + b);
  });
  const aug = A_ROWS.map((r, i) => r | (((rhs >> BigInt(i)) & 1n) << 128n));
  const where = new Array<number>(128).fill(-1);
  let pr = 0;
  for (let col = 0; col < 128 && pr < 128; col++) {
    const bit = BigInt(col);
    let sel = -1;
    for (let r = pr; r < 128; r++) {
      if (((aug[r] ?? 0n) >> bit) & 1n) {
        sel = r;
        break;
      }
    }
    if (sel < 0) continue;
    const tmp = aug[pr] ?? 0n;
    aug[pr] = aug[sel] ?? 0n;
    aug[sel] = tmp;
    const pivot = aug[pr] ?? 0n;
    for (let r = 0; r < 128; r++) {
      if (r !== pr && ((aug[r] ?? 0n) >> bit) & 1n) aug[r] = (aug[r] ?? 0n) ^ pivot;
    }
    where[col] = pr;
    pr++;
  }
  const st = new Uint32Array(4);
  for (let col = 0; col < 128; col++) {
    const row = where[col] ?? -1;
    /* A free column can only happen if the matrix is rank-deficient, which it
     * is not for these four positions; leaving the bit at 0 keeps the solve
     * total rather than throwing on an impossible case. */
    if (row < 0) continue;
    if (((aug[row] ?? 0n) >> 128n) & 1n)
      st[col >> 5] = ((st[col >> 5] ?? 0) | (1 << (col & 31))) >>> 0;
  }
  return Uint32Array.of(st[0] ?? 0, st[1] ?? 0, st[2] ?? 0, st[3] ?? 0);
}

export type KeyConfidence = 'VERIFIED(profile)' | 'VERIFIED(structural)' | 'UNVERIFIED';

export interface KeyUnderK {
  readonly K: number;
  readonly keyHex: string;
}

export interface RecoveredKey {
  /** The actual decryption secret. Everything else here is labelling. */
  readonly state: Xorshift128State;
  /** Acceptance sum the decrypted image produces. */
  readonly checksum: number;
  /** `checksum` equals the profile's acceptance target. */
  readonly matchesProfile: boolean;
  /** The decrypted reset vector looks like an LPC43xx Cortex-M entry. */
  readonly sane: boolean;
  /** Decrypted word 13, or null when the image is too short to hold one. */
  readonly word13: number | null;
  /** Word 13 decrypted to 0, as a valid vector table requires. */
  readonly selfConsistent: boolean;
  readonly confidence: KeyConfidence;
  /** The key under the profile's K when the profile matched, else the raw state. */
  readonly key: Uint8Array;
  readonly candidates: readonly KeyUnderK[];
}

/**
 * Recover everything about a slot from its ciphertext alone. Never throws for a
 * well-formed slot: an image that fails every check still comes back decrypted
 * and marked UNVERIFIED.
 */
export function recoverKeyInfo(
  view: DataView,
  base: number,
  byteLen: number,
  profile: CipherProfile,
  candidateKs: readonly number[] = CANDIDATE_K,
): RecoveredKey {
  const state = recoverState(view, base);
  const checksum = checksum32(view, base, byteLen, state, profile);
  const matchesProfile = checksum === profile.acceptanceSum;

  /* structural confidence (independent of K / TARGET) */
  const probe = cloneState(state);
  const sp = (xsNext(probe) ^ view.getUint32(base, true)) >>> 0;
  const entry = (xsNext(probe) ^ view.getUint32(base + 4, true)) >>> 0;
  const spPrefix = sp >>> 24;
  const sane = (spPrefix === 0x10 || spPrefix === 0x20) && (sp & 3) === 0 && (entry & 1) === 1;

  /* word 13 is a reserved vector NOT fed into the solve -> free consistency check */
  let word13: number | null = null;
  let selfConsistent = false;
  if (byteLen >= 4 * (CHECK_ZERO_IDX + 1)) {
    const probe2 = cloneState(state);
    let ks13 = 0;
    for (let i = 0; i <= CHECK_ZERO_IDX; i++) ks13 = xsNext(probe2);
    word13 = (ks13 ^ view.getUint32(base + 4 * CHECK_ZERO_IDX, true)) >>> 0;
    selfConsistent = word13 === 0;
  }

  const confidence: KeyConfidence = matchesProfile
    ? 'VERIFIED(profile)'
    : selfConsistent && sane
      ? 'VERIFIED(structural)'
      : 'UNVERIFIED';
  /* No profile match means K is unknown; K=0 makes the reported key the raw
   * state, which is the one form that is always true of the image. */
  const K = matchesProfile ? profile.whiteningK : 0x00000000;
  const key = keyFromState(state, K);
  const candidates = candidateKs.map((k) => ({ K: k, keyHex: bytesToHex(keyFromState(state, k)) }));
  return {
    state,
    checksum,
    matchesProfile,
    sane,
    word13,
    selfConsistent,
    confidence,
    key,
    candidates,
  };
}

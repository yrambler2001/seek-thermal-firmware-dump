import { describe, expect, it } from 'vitest';

import { bytesToHex, equalBytes, hexToBytes, viewOf } from '../src/bytes.js';
import {
  CANDIDATE_K,
  Xorshift128,
  checksum32,
  cloneState,
  cryptBytes,
  cryptImage,
  decryptImage,
  describeKeyTableMismatch,
  findEmbeddedKeyTable,
  findKeyCandidates,
  identifyKey,
  isEncryptedWord,
  keyFilenameSuffix,
  keyFromState,
  keyTableWhere,
  parseKeyFilenameSuffix,
  pickKeyTable,
  recoverKeyInfo,
  recoverState,
  resolveWhitening,
  sameState,
  stateFromKey,
  storeKeyOf,
  xsNext,
} from '../src/crypto/index.js';
import { setAcceptSum, wordSum32 } from '../src/image/bank.js';
import type { CipherProfile } from '../src/profiles/types.js';

/** The 2018+ "4.x" family: whitening 0x13579BDF, acceptance target 0xFFFF. */
const MODERN: CipherProfile = {
  whiteningK: 0x13579bdf,
  acceptanceSum: 0x0000ffff,
  clearWords: [128, 143],
};

const KEY_A = hexToBytes('0f1e2d3c4b5a69788796a5b4c3d2e1f0');
const KEY_B = hexToBytes('112233445566778899aabbccddeeff00');

/** Deterministic filler — no test in this file depends on real randomness. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

interface SynthOptions {
  readonly length?: number;
  readonly sp?: number;
  readonly entry?: number;
  readonly word13?: number;
}

/** A plausible Cortex-M image: zero reserved vectors, header magic at 0x200. */
function synthImage(opts: SynthOptions = {}): Uint8Array {
  const length = opts.length ?? 0x1000;
  const img = new Uint8Array(length);
  const dv = viewOf(img);
  const rnd = lcg(0xc0ffee);
  for (let o = 0; o + 4 <= length; o += 4) dv.setUint32(o, rnd(), true);
  dv.setUint32(0, opts.sp ?? 0x10004000, true);
  dv.setUint32(4, opts.entry ?? 0x14030401, true);
  for (const i of [7, 8, 9, 10]) dv.setUint32(4 * i, 0, true);
  dv.setUint32(4 * 13, opts.word13 ?? 0, true);
  dv.setUint32(0x200, 0xa1b2c3d4, true);
  dv.setUint32(0x204, length, true);
  dv.setUint32(0x208, 0x00000042, true);
  dv.setUint32(0x20c, 0x00021204, true);
  dv.setUint32(0x210, opts.entry ?? 0x14030401, true);
  dv.setUint32(0x238, 0, true);
  return img;
}

describe('xorshift128', () => {
  it('advances the state in place and is deterministic', () => {
    const a = Uint32Array.of(1, 2, 3, 4);
    const b = Uint32Array.of(1, 2, 3, 4);
    const first = [xsNext(a), xsNext(a), xsNext(a)];
    const second = [xsNext(b), xsNext(b), xsNext(b)];
    expect(first).toEqual(second);
    /* the state really moved: the same call again gives a different word */
    expect(xsNext(a)).not.toBe(first[2]);
  });

  it('never produces a word outside uint32', () => {
    const s = Uint32Array.of(0xffffffff, 0x80000000, 0x00000001, 0xdeadbeef);
    for (let i = 0; i < 64; i++) {
      const w = xsNext(s);
      expect(Number.isInteger(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      expect(w).toBeLessThanOrEqual(0xffffffff);
    }
  });

  it('Xorshift128.wordAt matches a manual run and never touches the caller state', () => {
    const seed = Uint32Array.of(0x13579bdf, 0x2468ace0, 0x0badc0de, 0xfeedface);
    const manual = cloneState(seed);
    let expected = 0;
    for (let i = 0; i <= 20; i++) expected = xsNext(manual);
    expect(new Xorshift128(seed).wordAt(20)).toBe(expected);
    expect(Array.from(seed)).toEqual([0x13579bdf, 0x2468ace0, 0x0badc0de, 0xfeedface]);
  });
});

describe('cipher', () => {
  it('leaves the clear window alone but still advances the generator over it', () => {
    /* This is the single most delicate fact in the cipher: words 128..143 are
     * stored verbatim, yet they each consume a keystream word. Encrypting zeros
     * exposes the raw keystream, so word 144 must equal keystream word 144 —
     * not keystream word 128, which is what a generator that skipped the window
     * would emit there. */
    const zeros = new Uint8Array(0x400);
    const state = Uint32Array.of(1, 2, 3, 4);
    const out = viewOf(cryptImage(viewOf(zeros), 0, zeros.length, state, MODERN));
    for (let i = 128; i <= 143; i++) expect(out.getUint32(4 * i, true)).toBe(0);
    expect(out.getUint32(4 * 127, true)).toBe(new Xorshift128(state).wordAt(127));
    expect(out.getUint32(4 * 144, true)).toBe(new Xorshift128(state).wordAt(144));
    expect(out.getUint32(4 * 255, true)).toBe(new Xorshift128(state).wordAt(255));
  });

  it('isEncryptedWord covers both sides of the window with one comparison', () => {
    const clear: readonly [number, number] = [128, 143];
    expect(isEncryptedWord(0, clear)).toBe(true);
    expect(isEncryptedWord(127, clear)).toBe(true);
    expect(isEncryptedWord(128, clear)).toBe(false);
    expect(isEncryptedWord(143, clear)).toBe(false);
    expect(isEncryptedWord(144, clear)).toBe(true);
    expect(isEncryptedWord(1 << 20, clear)).toBe(true);
  });

  it('honours a profile whose clear window is somewhere else', () => {
    const odd: CipherProfile = { whiteningK: 0, acceptanceSum: 0, clearWords: [2, 3] };
    const zeros = new Uint8Array(32);
    const state = Uint32Array.of(9, 8, 7, 6);
    const out = viewOf(cryptImage(viewOf(zeros), 0, zeros.length, state, odd));
    expect(out.getUint32(8, true)).toBe(0);
    expect(out.getUint32(12, true)).toBe(0);
    expect(out.getUint32(16, true)).toBe(new Xorshift128(state).wordAt(4));
  });

  it('round-trips an image and does not mutate the caller state', () => {
    const plain = synthImage();
    const state = stateFromKey(KEY_A, MODERN.whiteningK);
    const before = Array.from(state);
    const enc = cryptImage(viewOf(plain), 0, plain.length, state, MODERN);
    expect(equalBytes(enc, plain)).toBe(false);
    const back = decryptImage(viewOf(enc), 0, enc.length, state, MODERN);
    expect(equalBytes(back, plain)).toBe(true);
    expect(Array.from(state)).toEqual(before);
  });

  it('cryptBytes copies the uncovered tail verbatim', () => {
    const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10);
    const state = Uint32Array.of(0x11111111, 0x22222222, 0x33333333, 0x44444444);
    const enc = cryptBytes(bytes, state, MODERN);
    expect(enc.length).toBe(bytes.length);
    expect(Array.from(enc.subarray(8))).toEqual([9, 10]);
    expect(Array.from(enc.subarray(0, 8))).not.toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(equalBytes(cryptBytes(enc, state, MODERN), bytes)).toBe(true);
  });

  it('cryptBytes honours a subarray byteOffset', () => {
    const backing = new Uint8Array(64).fill(0xaa);
    const slice = backing.subarray(16, 48);
    const state = Uint32Array.of(5, 6, 7, 8);
    const enc = cryptBytes(slice, state, MODERN);
    expect(equalBytes(cryptBytes(enc, state, MODERN), slice)).toBe(true);
    expect(equalBytes(enc, cryptBytes(slice.slice(), state, MODERN))).toBe(true);
  });

  it('checksum32 off the ciphertext equals the word sum of the plaintext', () => {
    const plain = synthImage();
    const state = stateFromKey(KEY_A, MODERN.whiteningK);
    const enc = cryptImage(viewOf(plain), 0, plain.length, state, MODERN);
    expect(checksum32(viewOf(enc), 0, enc.length, state, MODERN)).toBe(
      wordSum32(plain, plain.length),
    );
  });
});

describe('key <-> state', () => {
  it('round-trips for every candidate K', () => {
    const rnd = lcg(0x5eed1234);
    for (let trial = 0; trial < 16; trial++) {
      const key = new Uint8Array(16);
      const kv = viewOf(key);
      for (let w = 0; w < 4; w++) kv.setUint32(w * 4, rnd(), true);
      for (const K of [...CANDIDATE_K, 0xffffffff]) {
        const state = stateFromKey(key, K);
        expect(equalBytes(keyFromState(state, K), key)).toBe(true);
        expect(sameState(stateFromKey(keyFromState(state, K), K), state)).toBe(true);
      }
    }
  });

  it('applies the documented word rotation k0=w, k1=x, k2=y, k3=z', () => {
    const state = Uint32Array.of(0x0a0b0c0d, 0x1a1b1c1d, 0x2a2b2c2d, 0x3a3b3c3d);
    const key = viewOf(keyFromState(state, 0));
    expect(key.getUint32(0, true)).toBe(0x3a3b3c3d);
    expect(key.getUint32(4, true)).toBe(0x0a0b0c0d);
    expect(key.getUint32(8, true)).toBe(0x1a1b1c1d);
    expect(key.getUint32(12, true)).toBe(0x2a2b2c2d);
  });

  it('refuses a key that is not 16 bytes', () => {
    expect(() => stateFromKey(new Uint8Array(15), 0)).toThrow(/16 bytes/);
  });
});

describe('GF(2) key recovery', () => {
  /** Stamped so the decrypted word sum hits the profile's acceptance target. */
  const plain = setAcceptSum(synthImage(), MODERN).image;
  const state = stateFromKey(KEY_A, MODERN.whiteningK);
  const enc = cryptImage(viewOf(plain), 0, plain.length, state, MODERN);

  it('recovers the exact state from ciphertext alone', () => {
    const recovered = recoverState(viewOf(enc), 0);
    expect(Array.from(recovered)).toEqual(Array.from(state));
    expect(equalBytes(decryptImage(viewOf(enc), 0, enc.length, recovered, MODERN), plain)).toBe(
      true,
    );
  });

  it('reports VERIFIED(profile) with word 13 checking out', () => {
    const info = recoverKeyInfo(viewOf(enc), 0, enc.length, MODERN);
    expect(sameState(info.state, state)).toBe(true);
    expect(info.checksum).toBe(MODERN.acceptanceSum);
    expect(info.matchesProfile).toBe(true);
    expect(info.word13).toBe(0);
    expect(info.selfConsistent).toBe(true);
    expect(info.sane).toBe(true);
    expect(info.confidence).toBe('VERIFIED(profile)');
    expect(bytesToHex(info.key)).toBe(bytesToHex(KEY_A));
    expect(info.candidates.map((c) => c.K)).toEqual([...CANDIDATE_K]);
  });

  it('word 13 is an independent check: it is not fed into the solve', () => {
    /* Corrupting word 13 must not disturb recovery, only its verdict. */
    const broken = plain.slice();
    viewOf(broken).setUint32(4 * 13, 0xdeadbeef, true);
    const badEnc = cryptImage(viewOf(broken), 0, broken.length, state, MODERN);
    const info = recoverKeyInfo(viewOf(badEnc), 0, badEnc.length, MODERN);
    expect(sameState(info.state, state)).toBe(true);
    expect(info.word13).toBe(0xdeadbeef);
    expect(info.selfConsistent).toBe(false);
  });

  it('falls back to structural confidence when no acceptance target matches', () => {
    const offSum = plain.slice();
    const dv = viewOf(offSum);
    dv.setUint32(0x800, (dv.getUint32(0x800, true) + 1) >>> 0, true);
    const info = recoverKeyInfo(
      viewOf(cryptImage(viewOf(offSum), 0, offSum.length, state, MODERN)),
      0,
      offSum.length,
      MODERN,
    );
    expect(info.matchesProfile).toBe(false);
    expect(info.confidence).toBe('VERIFIED(structural)');
    /* No profile => K unknown => the key is reported as the raw state (K=0). */
    expect(bytesToHex(info.key)).toBe(bytesToHex(keyFromState(state, 0)));
  });

  it('reports UNVERIFIED for an implausible reset vector yet still recovers the state', () => {
    const odd = setAcceptSum(synthImage({ sp: 0x12345678 }), MODERN).image;
    const dv = viewOf(odd);
    dv.setUint32(0x800, (dv.getUint32(0x800, true) + 1) >>> 0, true);
    const info = recoverKeyInfo(
      viewOf(cryptImage(viewOf(odd), 0, odd.length, state, MODERN)),
      0,
      odd.length,
      MODERN,
    );
    expect(info.sane).toBe(false);
    expect(info.confidence).toBe('UNVERIFIED');
    expect(sameState(info.state, state)).toBe(true);
  });

  it('recovers a state that has a zero word', () => {
    const zeroWordKey = keyFromState(Uint32Array.of(0, 0x12345678, 0, 0x9abcdef0), 0);
    const st = stateFromKey(zeroWordKey, 0);
    const ct = cryptImage(viewOf(plain), 0, plain.length, st, MODERN);
    expect(Array.from(recoverState(viewOf(ct), 0))).toEqual(Array.from(st));
  });
});

describe('bootloader key table', () => {
  function block(): Uint8Array {
    const b = new Uint8Array(0x100);
    const dv = viewOf(b);
    /* decoy: the slot-address table, another 0x14010000 followed by a flash
     * pointer rather than by key material */
    dv.setUint32(0x10, 0x14010000, true);
    dv.setUint32(0x14, 0x14030000, true);
    dv.setUint32(0x40, 0x14010000, true);
    b.set(KEY_A, 0x44);
    b.set(KEY_B, 0x54);
    return b;
  }

  it('anchors on 0x14010000 and skips the slot-address table', () => {
    const cands = findKeyCandidates(block());
    expect(cands.length).toBe(1);
    expect(cands[0]?.offset).toBe(0x40);
    expect(bytesToHex(cands[0]?.keyA ?? new Uint8Array())).toBe(bytesToHex(KEY_A));
    expect(bytesToHex(cands[0]?.keyB ?? new Uint8Array())).toBe(bytesToHex(KEY_B));
  });

  it('accepts only a candidate that reproduces a recovered state', () => {
    const cands = findKeyCandidates(block());
    const K = MODERN.whiteningK;
    expect(pickKeyTable(cands, [stateFromKey(KEY_A, K)], K)).toMatchObject({
      offset: 0x40,
      matchA: true,
      matchB: false,
    });
    expect(pickKeyTable(cands, [stateFromKey(KEY_B, K)], K)).toMatchObject({
      matchA: false,
      matchB: true,
    });
    /* a state from some third key is not this table */
    expect(pickKeyTable(cands, [Uint32Array.of(1, 2, 3, 4)], K)).toBeNull();
    expect(pickKeyTable(cands, [], K)).toBeNull();
    /* and the right key under the wrong whitening constant is not a match */
    expect(pickKeyTable(cands, [stateFromKey(KEY_A, K)], 0)).toBeNull();
  });

  it('storeKeyOf treats a blank device slot as "use Key B"', () => {
    const table = { keyA: KEY_A, keyB: KEY_B };
    expect(storeKeyOf(new Uint8Array(16).fill(0xff), table)).toMatchObject({
      name: 'Key B',
      programmed: false,
    });
    expect(storeKeyOf(new Uint8Array(16), table)).toMatchObject({ programmed: false });
    expect(storeKeyOf(null, table).key).toBe(KEY_B);
    expect(storeKeyOf(null, null).key).toBeNull();
    const device = hexToBytes('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
    expect(storeKeyOf(device, table)).toMatchObject({ name: 'per-device key', programmed: true });
  });

  it('identifyKey separates "which key" from "can the bootloader use it"', () => {
    const K = MODERN.whiteningK;
    const table = { keyA: KEY_A, keyB: KEY_B };
    const store = storeKeyOf(null, table);
    const underA = { state: stateFromKey(KEY_A, K), accepts: true };
    expect(identifyKey(underA, table, store, K)).toEqual({ name: 'Key A', bootable: true });

    const underB = { state: stateFromKey(KEY_B, K), accepts: true };
    expect(identifyKey(underB, table, store, K)).toEqual({ name: 'Key B', bootable: true });
    /* Key B is only bootable because it IS the store key here; with a
     * programmed per-device key the bootloader would never try Key B. */
    const device = hexToBytes('a0a1a2a3a4a5a6a7a8a9aaabacadaeaf');
    expect(identifyKey(underB, table, storeKeyOf(device, table), K)).toEqual({
      name: 'Key B',
      bootable: false,
    });

    /* a third key: checksums perfectly, still dead weight */
    const third = { state: stateFromKey(hexToBytes('00'.repeat(15) + '01'), K), accepts: true };
    expect(identifyKey(third, table, store, K)).toEqual({ name: 'unknown key', bootable: false });
    /* accepts=false can never be bootable */
    expect(identifyKey({ ...underA, accepts: false }, table, store, K).bootable).toBe(false);
    expect(identifyKey({ state: null, accepts: true }, table, store, K)).toEqual({
      name: null,
      bootable: false,
    });
  });
});

describe('embedded key table', () => {
  function image(placements: readonly (readonly [Uint8Array, number])[]): Uint8Array {
    const img = new Uint8Array(0x400);
    for (const [key, at] of placements) img.set(key, at);
    return img;
  }

  it('finds a non-adjacent pair — adjacency is common but not required', () => {
    const at = findEmbeddedKeyTable(
      image([
        [KEY_A, 0x100],
        [KEY_B, 0x280],
      ]),
      KEY_A,
      KEY_B,
    );
    expect(at).toEqual({ offsetA: 0x100, offsetB: 0x280, adjacent: false });
    expect(keyTableWhere(at ?? { offsetA: 0, offsetB: 0, adjacent: false })).toBe(
      '0x00000100 and 0x00000280',
    );
  });

  it('reports adjacency when Key B sits at Key A + 16', () => {
    const at = findEmbeddedKeyTable(
      image([
        [KEY_A, 0x100],
        [KEY_B, 0x110],
      ]),
      KEY_A,
      KEY_B,
    );
    expect(at).toEqual({ offsetA: 0x100, offsetB: 0x110, adjacent: true });
    expect(keyTableWhere(at ?? { offsetA: 0, offsetB: 0, adjacent: false })).toBe('0x00000100');
  });

  it('returns null when a key is missing or ambiguous', () => {
    /* missing Key B */
    expect(findEmbeddedKeyTable(image([[KEY_A, 0x100]]), KEY_A, KEY_B)).toBeNull();
    /* Key A twice: no unambiguous place to rewrite it */
    expect(
      findEmbeddedKeyTable(
        image([
          [KEY_A, 0x100],
          [KEY_A, 0x200],
          [KEY_B, 0x300],
        ]),
        KEY_A,
        KEY_B,
      ),
    ).toBeNull();
    /* Key B twice */
    expect(
      findEmbeddedKeyTable(
        image([
          [KEY_A, 0x100],
          [KEY_B, 0x200],
          [KEY_B, 0x300],
        ]),
        KEY_A,
        KEY_B,
      ),
    ).toBeNull();
    /* neither */
    expect(findEmbeddedKeyTable(image([]), KEY_A, KEY_B)).toBeNull();
    /* not a 16-byte key */
    expect(findEmbeddedKeyTable(image([[KEY_A, 0x100]]), KEY_A.subarray(0, 8), KEY_B)).toBeNull();
  });

  it('explains exactly why a named pair is not this image', () => {
    expect(describeKeyTableMismatch(image([]), KEY_A, KEY_B)).toBe(
      'neither key is anywhere in the image',
    );
    expect(describeKeyTableMismatch(image([[KEY_B, 0x40]]), KEY_A, KEY_B)).toMatch(
      /Key A is not in the image at all \(Key B is, at 0x00000040\)/,
    );
    expect(describeKeyTableMismatch(image([[KEY_A, 0x40]]), KEY_A, KEY_B)).toMatch(
      /Key B is not in the image at all/,
    );
    expect(
      describeKeyTableMismatch(
        image([
          [KEY_A, 0x40],
          [KEY_A, 0x80],
          [KEY_B, 0x300],
        ]),
        KEY_A,
        KEY_B,
      ),
    ).toMatch(/Key A appears 2 times/);
    expect(
      describeKeyTableMismatch(
        image([
          [KEY_A, 0x40],
          [KEY_B, 0x300],
          [KEY_B, 0x340],
        ]),
        KEY_A,
        KEY_B,
      ),
    ).toMatch(/Key B appears 2 times/);
  });

  it('round-trips the filename suffix', () => {
    const name = `dump_decrypted_14030000${keyFilenameSuffix(KEY_A, KEY_B)}.bin`;
    const parsed = parseKeyFilenameSuffix(name);
    expect(parsed && bytesToHex(parsed.keyA)).toBe(bytesToHex(KEY_A));
    expect(parsed && bytesToHex(parsed.keyB)).toBe(bytesToHex(KEY_B));
    /* only immediately before the extension, and only a full 32+32 hex pair */
    expect(parseKeyFilenameSuffix('plain.bin')).toBeNull();
    expect(parseKeyFilenameSuffix(`x${keyFilenameSuffix(KEY_A, KEY_B)}.bin.txt`)).toBeNull();
    expect(parseKeyFilenameSuffix(`-KeyA-${bytesToHex(KEY_A)}-KeyB-dead.bin`)).toBeNull();
    /* no extension at all is still a valid name */
    expect(parseKeyFilenameSuffix(keyFilenameSuffix(KEY_A, KEY_B))).not.toBeNull();
  });
});

describe('resolveWhitening', () => {
  const state = stateFromKey(KEY_A, MODERN.whiteningK);
  const profileForm = keyFromState(state, MODERN.whiteningK);
  const rawForm = keyFromState(state, 0);
  const CANDIDATES = [MODERN.whiteningK, 0];

  function plaintextWith(...keys: readonly Uint8Array[]): Uint8Array {
    const buf = new Uint8Array(0x400);
    keys.forEach((k, i) => {
      buf.set(k, 0x40 + i * 0x80);
    });
    return buf;
  }

  it('prefers the form that is actually in the image, against the profile default', () => {
    /* The measured regression: 32K_43X0_1.3.0.8_COMPACT-16HZ has acceptance sum
     * 0xFFFF, which the original paired with K=0x13579BDF — but the image's own
     * plaintext carries the UNWHITENED key. Evidence beats the pairing. */
    const r = resolveWhitening(plaintextWith(rawForm), state, CANDIDATES);
    expect(r.whiteningK).toBe(0);
    expect(r.evidence).toBe('plaintext');
    expect(r.keyHex).toBe(bytesToHex(rawForm));
    expect(r.keyHex).not.toBe(bytesToHex(profileForm));
  });

  it('keeps the profile default when that is the form present', () => {
    const r = resolveWhitening(plaintextWith(profileForm), state, CANDIDATES);
    expect(r.whiteningK).toBe(MODERN.whiteningK);
    expect(r.evidence).toBe('plaintext');
    expect(r.keyHex).toBe(bytesToHex(KEY_A));
  });

  it('falls back to the profile K when no form occurs', () => {
    const r = resolveWhitening(plaintextWith(), state, CANDIDATES);
    expect(r.whiteningK).toBe(MODERN.whiteningK);
    expect(r.evidence).toBe('profile-default');
    expect(r.keyHex).toBe(bytesToHex(profileForm));
  });

  it('ignores a form that occurs more than once — ambiguity is not evidence', () => {
    const twice = new Uint8Array(0x400);
    twice.set(rawForm, 0x40);
    twice.set(rawForm, 0x200);
    const r = resolveWhitening(twice, state, CANDIDATES);
    expect(r.evidence).toBe('profile-default');
    expect(r.whiteningK).toBe(MODERN.whiteningK);
  });

  it('breaks a tie towards the profile, which is listed first', () => {
    const r = resolveWhitening(plaintextWith(profileForm, rawForm), state, CANDIDATES);
    expect(r.whiteningK).toBe(MODERN.whiteningK);
    expect(r.evidence).toBe('plaintext');
  });

  it('survives an empty candidate list', () => {
    const r = resolveWhitening(plaintextWith(rawForm), state, []);
    expect(r).toEqual({
      whiteningK: 0,
      evidence: 'profile-default',
      keyHex: bytesToHex(rawForm),
    });
  });
});

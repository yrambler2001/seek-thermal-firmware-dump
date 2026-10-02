/* ==================================================================== *
 * The v1 in-place patch builder, unit-tested offline.
 *
 * Two populations:
 *  - SYNTHETIC images, which run everywhere: they prove the cipher algebra
 *    (keystream round-trip, the ciphertext conjugation) and the rebalance,
 *    independent of any vendored input.
 *  - THE CORPUS PLAINTEXT of Compact 1.3.0.0, when the emulator directory
 *    (SEEK_EMU_DIR, or FW-V1 beside this repository) carries it: the patch
 *    must produce EXACTLY the ten enumerated byte changes and the known
 *    rebalance word, and — when the 2016 donor dump is present too — the
 *    plain-XOR-keystream model must reproduce the donor's factory slot A
 *    byte for byte, which is the control that proves the whole cipher model.
 * ==================================================================== */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { bytesToHex, hexUp } from '../../src/bytes.js';
import {
  buildV1Patch,
  conjugateCapture,
  keystream,
  sum16,
  verifyCapture,
  wordSum,
  xorWindowVerbatim,
  REBALANCE_WORD_OFFSET,
  V1_2014_PATCH_SITES,
} from '../../src/preservation/patch.js';
import { emulatorDir } from '../emulator/harness.js';

/* ---- the 2016 donor's fixed device key (KeyB), as bytes and as words ---- */

const DONOR_KEYB_HEX = 'faacb3c6f1412469bd122fb82d78160d';
const DONOR_KEY_WORDS = ((): [number, number, number, number] => {
  const raw = new Uint8Array(DONOR_KEYB_HEX.match(/.{2}/g)!.map((h) => Number.parseInt(h, 16)));
  const dv = new DataView(raw.buffer);
  return [
    dv.getUint32(0, true),
    dv.getUint32(4, true),
    dv.getUint32(8, true),
    dv.getUint32(12, true),
  ];
})();

/* ---- corpus locations ---------------------------------------------------- */

const EMU = emulatorDir();

/** The vendored decrypted Compact 1.3.0.0 image. */
function corpusPlain1300(): Uint8Array | null {
  if (EMU === null) return null;
  const file = path.join(
    EMU,
    'data',
    'corpus',
    'compact',
    '2014.10.21-14.58.29-1.3.0.0',
    'no-serial',
    'subi_lpc43xx_lpcopen_1.3.0.0_-_compact_oct_21_2014_14-58-29_99.28_gabiz_ro_firmware.bin',
  );
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
}

/** The vendored 2016 donor dump (the chimera donor whose bank cipher the v1
 *  emulator runs under). */
function donorDump(): Uint8Array | null {
  if (EMU === null) return null;
  const file = path.join(
    EMU,
    'data',
    'corpus',
    'compact_pro',
    '2016.07.06-17.04.49-1.0.3.0',
    '0C21A1M5KP15',
    'compact_pro_android_uq-aaa.bin',
  );
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
}

/** The DONOR's own decrypted image — the plaintext its factory slot A holds.
 *  (The slot does NOT hold the v1 image; the v1 entry is a chimera ON this
 *  donor, and its app bank is re-encrypted under the donor's key.) */
function donorPlain(): Uint8Array | null {
  if (EMU === null) return null;
  const file = path.join(
    EMU,
    'data',
    'corpus',
    'compact_pro',
    '2016.07.06-17.04.49-1.0.3.0',
    'no-serial',
    '80k_4330_1.0.3.0-9hz_public_-_compact_pro_jul_6_2016_17-04-49_84.00_gabiz_ro_firmware.bin',
  );
  return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
}

/* ---- a synthetic factory image that carries the four patch sites --------- *
 *
 * 0x4000 bytes, word sum 0, the rebalance word free, and the exact `before`
 * bytes at every site — so `buildV1Patch` accepts it and every algebra test
 * runs without the corpus. */

function syntheticPlain(): Uint8Array {
  const bytes = new Uint8Array(0x4000);
  /* A deterministic non-uniform fill, so a misplaced XOR cannot cancel. */
  let state = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  for (const site of V1_2014_PATCH_SITES) bytes.set(site.before, site.offset);
  bytes[REBALANCE_WORD_OFFSET + 0] = 0;
  bytes[REBALANCE_WORD_OFFSET + 1] = 0;
  bytes[REBALANCE_WORD_OFFSET + 2] = 0;
  bytes[REBALANCE_WORD_OFFSET + 3] = 0;
  const dv = new DataView(bytes.buffer);
  /* The header's version word: the closed 1.x set, which the v1-2014 detect
   * carries — 0.9.0.7 shares this build's four sites byte for byte, and the
   * version word is the gate that keeps the table from matching both. */
  dv.setUint32(0x200, 0xa1b2c3d4, true);
  dv.setUint32(0x20c, 0x0000_0301, true); /* bytes 01 03 00 00 -> "1.3.0.0" */
  /* Balance the word sum through a word far from every site. */
  const scratch = 0x3ff0;
  dv.setUint32(scratch, 0, true);
  const total = wordSum(bytes);
  dv.setUint32(scratch, (0 - total) >>> 0, true);
  expect(wordSum(bytes)).toBe(0);
  return bytes;
}

/* ==================================================================== *
 * the cipher algebra (synthetic — runs everywhere)
 * ==================================================================== */

describe('v1 patch builder — the cipher algebra', () => {
  it('keystream + verbatim window round-trips: XOR twice is the identity', () => {
    const plain = syntheticPlain();
    const ks = keystream(DONOR_KEY_WORDS, plain.length >> 2);
    const slot = xorWindowVerbatim(plain, ks);
    expect(wordSum(slot)).not.toBe(0); /* the cipher moved the sum... */
    expect(wordSum(xorWindowVerbatim(slot, ks))).toBe(0); /* ...and XOR back restores it */
    expect(bytesToHex(xorWindowVerbatim(slot, ks))).toBe(bytesToHex(plain));
  });

  it('header words 128..143 pass through the cipher verbatim', () => {
    const plain = syntheticPlain();
    const ks = keystream(DONOR_KEY_WORDS, plain.length >> 2);
    const slot = xorWindowVerbatim(plain, ks);
    for (let i = 0x200; i < 0x240; i++) {
      expect(slot[i]).toBe(plain[i]);
    }
    /* ...and everything before and after them is actually encrypted. */
    let encrypted = 0;
    for (let i = 0; i < 0x200; i++) if (slot[i] !== plain[i]) encrypted++;
    expect(encrypted).toBeGreaterThan(0x100);
  });

  it('the ciphertext conjugation: capture XOR mask lands the patched plaintext', () => {
    const plain = syntheticPlain();
    const patch = buildV1Patch(plain);
    const ks = keystream(DONOR_KEY_WORDS, plain.length >> 2);
    const capture = xorWindowVerbatim(plain, ks); /* what the wire serves */
    const payload = conjugateCapture(capture, patch);
    /* The staged payload must be EXACTLY the patched plaintext under the same
     * cipher — the keystream cancelled, byte for byte. */
    expect(bytesToHex(payload)).toBe(bytesToHex(xorWindowVerbatim(patch.patched, ks)));
    /* And the staged payload decrypts (XOR ks) to the patched image. */
    expect(bytesToHex(xorWindowVerbatim(payload, ks))).toBe(bytesToHex(patch.patched));
    /* Padding past the image length is preserved from the capture. */
    const longer = new Uint8Array(capture.length + 16).fill(0xab);
    longer.set(capture);
    expect(conjugateCapture(longer, patch).length).toBe(plain.length);
  });

  it('the rebalance word: patched word sum returns to 0 through the free word', () => {
    const plain = syntheticPlain();
    const patch = buildV1Patch(plain);
    expect(patch.patchedWordSum).toBe(0);
    const dv = new DataView(patch.patched.buffer);
    expect(dv.getUint32(REBALANCE_WORD_OFFSET, true)).toBe(patch.rebalanceWord);
    /* The rebalance is INSIDE the verbatim header window, so it survives the
     * cipher unchanged — the bootloader reads its true value. */
    const ks = keystream(DONOR_KEY_WORDS, plain.length >> 2);
    const slot = xorWindowVerbatim(patch.patched, ks);
    expect(new DataView(slot.buffer).getUint32(REBALANCE_WORD_OFFSET, true)).toBe(
      patch.rebalanceWord,
    );
  });

  it('refuses an image whose site bytes do not match, and a non-zero-sum image', () => {
    const plain = syntheticPlain();
    const wrong = new Uint8Array(plain);
    wrong[0x3db4] = (wrong[0x3db4] ?? 0) ^ 0xff;
    /* Re-balance (scratch zeroed first, so the offset is exact) so ONLY the
     * site-bytes gate fires. */
    const wdv = new DataView(wrong.buffer);
    wdv.setUint32(0x3ff0, 0, true);
    wdv.setUint32(0x3ff0, (0 - wordSum(wrong)) >>> 0, true);
    expect(() => buildV1Patch(wrong)).toThrow(/does not carry the v1 2014 update machinery/);

    const unbalanced = new Uint8Array(plain);
    new DataView(unbalanced.buffer).setUint32(0x3ff0, 1, true);
    expect(() => buildV1Patch(unbalanced)).toThrow(/word sum is not 0/);

    const busy = new Uint8Array(plain);
    const bdv = new DataView(busy.buffer);
    bdv.setUint32(REBALANCE_WORD_OFFSET, 7, true);
    /* Re-balance through the scratch word (zeroed first) so ONLY the
     * free-word gate fires. */
    bdv.setUint32(0x3ff0, 0, true);
    bdv.setUint32(0x3ff0, (0 - wordSum(busy)) >>> 0, true);
    expect(wordSum(busy)).toBe(0);
    expect(() => buildV1Patch(busy)).toThrow(/is not free/);
  });

  it('verifyCapture: the full-prefix check and the keyless verbatim-window check', () => {
    const plain = syntheticPlain();
    const patch = buildV1Patch(plain);
    const ks = keystream(DONOR_KEY_WORDS, plain.length >> 2);
    const capture = xorWindowVerbatim(plain, ks);
    const expected = xorWindowVerbatim(plain, ks);

    expect(verifyCapture(capture, plain, expected)).toEqual({ ok: true, reason: null });
    const tampered = new Uint8Array(capture);
    tampered[123] = (tampered[123] ?? 0) ^ 0xff;
    const bad = verifyCapture(tampered, plain, expected);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/does not hold the factory image/);

    /* Keyless: the verbatim header window still binds the capture to the
     * factory plaintext, because those words are stored unencrypted. */
    expect(verifyCapture(capture, plain)).toEqual({ ok: true, reason: null });
    const reencrypted = xorWindowVerbatim(patch.patched, ks);
    const keyless = verifyCapture(reencrypted, plain);
    expect(keyless.ok).toBe(false);
    expect(keyless.reason).toMatch(/verbatim header word/);
  });

  it('the u16 transfer checksum of a staged payload is stable', () => {
    expect(sum16(new Uint8Array([0xff, 0xff]))).toBe(0x1fe);
    expect(sum16(new Uint8Array([1]))).toBe(1);
  });
});

/* ==================================================================== *
 * the zero-keystream case — the 2014 plaintext banks (synthetic)
 * ==================================================================== */

describe('v1 patch builder — the zero-keystream case (the 2014 plaintext banks)', () => {
  /** The 2014 bootloader has no cipher: a bank is the image AS STORED. In the
   *  algebra that is the keystream being all-zero, and every function here
   *  must reduce to its plaintext form. */
  it('a zero keystream is the identity: the stored bank IS the plaintext', () => {
    const plain = syntheticPlain();
    const zeros = new Uint32Array(plain.length >> 2);
    const stored = xorWindowVerbatim(plain, zeros);
    expect(bytesToHex(stored)).toBe(bytesToHex(plain));
    /* The as-stored word sum stays 0 — the 2014 bootloader's acceptance gate
     * reads the bytes as they lie on the part. */
    expect(wordSum(stored)).toBe(0);
  });

  it('the conjugation on a plaintext capture: the staged payload IS the patched image', () => {
    const plain = syntheticPlain();
    const patch = buildV1Patch(plain);
    const payload = conjugateCapture(plain, patch); /* the capture is the plaintext itself */
    expect(bytesToHex(payload)).toBe(bytesToHex(patch.patched));
    /* Exactly the ten enumerated bytes move — the wire-80 payload differs
     * from the capture by the mask and nothing else. */
    const applied: number[] = [];
    for (let i = 0; i < payload.length; i++) {
      if (payload[i] !== plain[i]) applied.push(i);
    }
    expect(applied).toEqual(EXPECTED_DIFF_OFFSETS);
  });

  it('verifyCapture with the plaintext as the expected prefix: the whole-image gate', () => {
    const plain = syntheticPlain();
    const patch = buildV1Patch(plain);
    /* The form the pipeline uses on the 2014 banks: the factory plaintext is
     * the expected prefix, so the gate compares every byte and needs no key. */
    expect(verifyCapture(plain, plain, plain)).toEqual({ ok: true, reason: null });
    const bad = verifyCapture(patch.patched, plain, plain);
    expect(bad.ok).toBe(false);
    expect(bad.reason).toMatch(/does not hold the factory image/);
  });

  it('the rebalance word still applies with no cipher: patched words sum to 0 as stored', () => {
    const plain = syntheticPlain();
    const patch = buildV1Patch(plain);
    const zeros = new Uint32Array(plain.length >> 2);
    const stored = xorWindowVerbatim(patch.patched, zeros);
    expect(wordSum(stored)).toBe(0);
    expect(new DataView(stored.buffer).getUint32(REBALANCE_WORD_OFFSET, true)).toBe(
      patch.rebalanceWord,
    );
  });
});

/* ==================================================================== *
 * the corpus plaintext (gated: needs the emulator directory's corpus)
 * ==================================================================== */

/** The ten bytes the 2014 patch set must move, bank-relative (doc 34.11). */
const EXPECTED_DIFF_OFFSETS = [
  0x238, 0x239, 0x23b, 0x3c1c, 0x3c1d, 0x3c68, 0x3c69, 0x3c70, 0x3c71, 0x3db7,
];

/** The rebalance word for this exact patch set (doc 34.5). */
const EXPECTED_REBALANCE_1300 = 0x30006240;

describe('v1 patch builder — the Compact 1.3.0.0 corpus plaintext', () => {
  const plain = corpusPlain1300();
  const dump = donorDump();
  const dplain = donorPlain();

  it.skipIf(plain === null)('is the balanced image the builder assumes', () => {
    expect(plain).not.toBeNull();
    const dv = new DataView(plain!.buffer, plain!.byteOffset, plain!.byteLength);
    expect(hexUp(dv.getUint32(0x200, true))).toBe(hexUp(0xa1b2c3d4)); /* image magic */
    expect(dv.getUint32(0x204, true)).toBe(plain!.length); /* header.length */
    expect(wordSum(plain!)).toBe(0); /* the boot gate's balance */
    expect(dv.getUint32(REBALANCE_WORD_OFFSET, true)).toBe(0); /* the free word */
  });

  it.skipIf(plain === null)('moves EXACTLY the ten enumerated bytes', () => {
    const patch = buildV1Patch(plain!);
    expect([...patch.diffOffsets]).toEqual(EXPECTED_DIFF_OFFSETS);
    expect(patch.diffOffsets.length).toBe(10);
  });

  it.skipIf(plain === null)('rebalances through word 142 = 0x30006240', () => {
    const patch = buildV1Patch(plain!);
    expect(hexUp(patch.rebalanceWord)).toBe(hexUp(EXPECTED_REBALANCE_1300));
    expect(patch.patchedWordSum).toBe(0);
  });

  it.skipIf(plain === null || dump === null || dplain === null)(
    'the cipher control: donor plain XOR keystream(KeyB) IS the donor factory slot A',
    () => {
      const ks = keystream(DONOR_KEY_WORDS, dplain!.length >> 2);
      const at = 0x50000; /* the donor's slot A */
      const factory = dump!.subarray(at, at + dplain!.length);
      const model = xorWindowVerbatim(dplain!, ks);
      let diffs = 0;
      for (let i = 0; i < dplain!.length; i++) {
        if (model[i] !== factory[i]) diffs++;
      }
      expect(diffs).toBe(0);
    },
  );

  it.skipIf(plain === null)(
    'conjugating the as-booted bank capture stages exactly the patched slot',
    () => {
      const patch = buildV1Patch(plain!);
      const ks = keystream(DONOR_KEY_WORDS, plain!.length >> 2);
      /* What the wire serves for the v1 chimera's app bank: the v1 plaintext
       * under the donor's cipher (the emulator test asserts the live capture
       * equals these bytes). */
      const capture = xorWindowVerbatim(plain!, ks);
      const payload = conjugateCapture(capture, patch);
      const want = xorWindowVerbatim(patch.patched, ks);
      let diffs = 0;
      for (let i = 0; i < payload.length; i++) {
        if (payload[i] !== want[i]) diffs++;
      }
      expect(diffs).toBe(0);
      /* The staged payload differs from the capture by the mask ONLY. */
      const applied: number[] = [];
      for (let i = 0; i < payload.length; i++) {
        if (payload[i] !== capture[i]) applied.push(i);
      }
      expect(applied).toEqual(EXPECTED_DIFF_OFFSETS);
    },
  );

  /* ---- the real 2014 dump's active bank, as stored -------------------------- */

  /** The jlink dump of the corpus camera, from FW-V1's targets tree beside the
   *  emulator — the ground truth the preservation suite boots. */
  function corpusCameraDump(): Uint8Array | null {
    if (EMU === null) return null;
    const file = path.resolve(EMU, '..', 'targets', 'compact_32k_1_3_0_8', 'jlink_dumps', '6.bin');
    return existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
  }

  const dump6 = corpusCameraDump();

  it.skipIf(plain === null || dump6 === null)(
    '6.bin slot A holds the corpus plaintext AS STORED, and passes the 2014 acceptance',
    () => {
      const at = 0x50000; /* the active bank (cfg[0]=0 -> slot A) */
      const stored = dump6!.subarray(at, at + plain!.length);
      /* Byte-identical to the factory plaintext — the plaintext-bank fact the
       * whole pipeline runs on. */
      let diffs = 0;
      for (let i = 0; i < plain!.length; i++) {
        if (stored[i] !== plain![i]) diffs++;
      }
      expect(diffs).toBe(0);
      /* The 2014 bootloader's own acceptance, read off the stored bytes:
       * magic 0xA1B2C3D4 at +0x200, length under 0x10000 at +0x204, and the
       * stored words summing to 0 over header.length. */
      const dv = new DataView(dump6!.buffer, dump6!.byteOffset + at, plain!.length);
      expect(hexUp(dv.getUint32(0x200, true))).toBe(hexUp(0xa1b2c3d4));
      expect(dv.getUint32(0x204, true)).toBe(plain!.length);
      expect(wordSum(stored)).toBe(0);
    },
  );
});

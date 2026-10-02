/* ==================================================================== *
 * The seam that turns a slot capture into the factory plaintext
 * (`solve.ts`) — the ruling's mechanism, unit-tested: the identity path for
 * the plain chain (structural validation, the image-length slice), and the
 * two cipher families' keystream solvers — the GF(2) crib solve, the layered
 * structural gates, and the closing keystream identity — against synthetic
 * ciphered captures and against the REAL fixtures (the native 1.0.3.0 and
 * 1.0.3.0-FF dumps, the decrypted twins, the corpus plaintexts). Pure bytes
 * in, result out — no camera, no emulator.
 * ==================================================================== */

import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { hexToBytes, viewOf } from '../../src/bytes.js';
import {
  REBALANCE_WORD_OFFSET,
  V1_2014_PATCH_SITES,
  keyWordsOf,
  keystream,
  wordSum,
} from '../../src/preservation/patch.js';
import { solvePlainFromCapture } from '../../src/preservation/solve.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/* ===================================================================== *
 * shared helpers
 * ===================================================================== */

const IMAGE_LENGTH = 0x4000;
const VERSION_WORD = 0x0000_0301; /* -> "1.3.0.0" */
const WINDOW_LO = 0x80;
const WINDOW_HI = 0x8f;

const LADDER_HEX = '00000614000005140000021400000014';
const WIDEN_2014_HEX = '4ff480336360e360';
const WIDEN_2016_HEX = '63614ff48033a3602361';
const GUARD_HEX = '022b06d10420';
const TOKEN_HEX = '5316103180dd00b74af9e417c594bed4';
const LADDER_AT = 0x3000;
const WIDEN_2014_AT = LADDER_AT - 0x4a; /* the measured widen->ladder span */
const WIDEN_2016_AT = LADDER_AT - 0x4c;
const GUARD_AT = LADDER_AT - 0x154; /* the measured guard->ladder span */

const KEY_FF = {
  block0: '5d7984797c47eb9354fa35898ab11701',
  block1: 'b5541579754be4b33b6f1ba975a8badc',
};
const KEY_CP103 = {
  block0: '67a3ea21824fecc4b3c3b0a8da514669',
  block1: 'faacb3c6f1412469bd122fb82d78160d',
};
const KEY_CP1032FF = {
  block0: '58d6abe5a94e4de650ae3a84f9f8f281',
  block1: '6da05a33f540100034e2c8947d05708c',
};

/** A synthetic factory plaintext, exactly as a 2014 bank stores it. */
function plainImage(): Uint8Array {
  const bytes = new Uint8Array(IMAGE_LENGTH);
  let state = 0x12345678;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  for (const site of V1_2014_PATCH_SITES) bytes.set(site.before, site.offset);
  const dv = new DataView(bytes.buffer);
  bytes.fill(0, REBALANCE_WORD_OFFSET, REBALANCE_WORD_OFFSET + 4);
  dv.setUint32(0x200, 0xa1b2c3d4, true);
  dv.setUint32(0x204, IMAGE_LENGTH, true);
  dv.setUint32(0x20c, VERSION_WORD, true);
  const scratch = 0x3ff0;
  dv.setUint32(scratch, 0, true);
  dv.setUint32(scratch, (0 - wordSum(bytes)) >>> 0, true);
  return bytes;
}

/** A 64 KiB bank window holding `image` at its head (the erased tail behind). */
function bankWindow(image: Uint8Array): Uint8Array {
  const window = new Uint8Array(0x10000).fill(0xff);
  window.set(image, 0);
  return window;
}

/* ---- the cipher families' synthetic plaintext ------------------------------ */

interface CipherPlainOptions {
  readonly targetSum: number; /* 0 for the 2016 line, 0xffff for the FF build */
  readonly widenAt: number;
  readonly widenHex: string;
  readonly guard: boolean;
  readonly keys: { readonly block0: string; readonly block1: string } | null;
}

/**
 * A synthetic plain image of the CIPHER line: the vector table's reserved
 * words zeroed (words 7..10 feed the crib solve and word 13 checks it), the
 * segmented container's descriptor at 0x290, the machinery shapes in the
 * Begin window, the token, the real key blocks, and the family's acceptance
 * sum balanced through the scratch word.
 */
function cipherPlainImage(options: CipherPlainOptions): Uint8Array {
  const bytes = new Uint8Array(IMAGE_LENGTH);
  let state = 0x2468ace1;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  const put = (at: number, hex: string): void => {
    bytes.set(hexToBytes(hex), at);
  };
  /* The Cortex-M vector table: SP, reset (Thumb), then the reserved zeros. */
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, 0x10002000, true);
  dv.setUint32(4, 0x100806a5, true);
  for (const word of [7, 8, 9, 10, 13]) dv.setUint32(word * 4, 0, true);
  /* The segmented container: the code-payload descriptor at 0x290. */
  dv.setUint32(0x240, 0x14009960, true);
  dv.setUint32(0x244, 0x10000000, true);
  dv.setUint32(0x248, 0x00000240, true);
  dv.setUint32(0x24c, 0x14009ba0, true);
  dv.setUint32(0x290, 0x140002c0, true);
  dv.setUint32(0x294, 0x10080628, true);
  dv.setUint32(0x298, 0x1000, true); /* the payload size, inside this image */
  dv.setUint32(0x29c, 0, true);
  /* The machinery, inside the Begin window (ladder - 0x800 .. ladder). */
  put(LADDER_AT, LADDER_HEX);
  put(options.widenAt, options.widenHex);
  if (options.guard) put(GUARD_AT, GUARD_HEX);
  put(0x2700, TOKEN_HEX);
  if (options.keys !== null) {
    put(0x2800, options.keys.block0);
    put(0x2810, options.keys.block1);
  }
  /* The header, and the acceptance balance LAST. */
  dv.setUint32(0x200, 0xa1b2c3d4, true);
  dv.setUint32(0x204, IMAGE_LENGTH, true);
  dv.setUint32(0x20c, VERSION_WORD, true);
  dv.setUint32(0x210, 0x100806a5, true); /* the entry word, == reset */
  dv.setUint32(REBALANCE_WORD_OFFSET, 0, true);
  const scratch = 0x3ff0;
  dv.setUint32(scratch, 0, true);
  dv.setUint32(scratch, ((options.targetSum - wordSum(bytes)) | 0) >>> 0, true);
  expect(wordSum(bytes) >>> 0).toBe(options.targetSum >>> 0);
  return bytes;
}

/** The at-rest form of `image` under `keyHex`'s keystream: XOR off the header
 *  window, the erased tail behind, exactly what the bootloader programs. */
function cipheredWindow(
  image: Uint8Array,
  keyHex: string,
  extra?: { readonly alsoKeyHex?: string; readonly flipByte?: number },
): Uint8Array {
  const words = Math.ceil(image.length / 4);
  const ks = keystream(keyWordsOf(keyHex), words);
  const ks2 =
    extra?.alsoKeyHex === undefined ? null : keystream(keyWordsOf(extra.alsoKeyHex), words);
  const window = new Uint8Array(0x10000).fill(0xff);
  const wv = viewOf(window);
  const iv = viewOf(image);
  for (let i = 0; i < image.length >> 2; i++) {
    const w = iv.getUint32(i * 4, true);
    const k = ks2 === null ? (ks[i] ?? 0) : ((ks[i] ?? 0) ^ (ks2[i] ?? 0)) >>> 0;
    wv.setUint32(i * 4, i >= WINDOW_LO && i <= WINDOW_HI ? w : (w ^ k) >>> 0, true);
  }
  if (extra?.flipByte !== undefined) {
    window[extra.flipByte] = (window[extra.flipByte] ?? 0) ^ 0x40;
  }
  return window;
}

/* ===================================================================== *
 * the identity path (the v1-2014 plain chain)
 * ===================================================================== */

describe('solvePlainFromCapture — the identity path (the v1-2014 plain chain)', () => {
  it('solves a plaintext bank to the image-length prefix, and names the method', () => {
    const image = plainImage();
    const solved = solvePlainFromCapture('v1-2014', bankWindow(image));
    if (!solved.ok) throw new Error(`expected ok, refused: ${solved.reason}`);
    expect(solved.plain).toEqual(image);
    expect(solved.plain.length).toBe(IMAGE_LENGTH);
    expect(solved.method).toMatch(/identity/);
    /* The result is its own buffer, not a view into the capture. */
    const window = bankWindow(image);
    const solved2 = solvePlainFromCapture('v1-2014', window);
    if (!solved2.ok) throw new Error(solved2.reason);
    solved2.plain[5] = (solved2.plain[5] ?? 0) ^ 0xff;
    expect(window[5]).toBe(image[5]);
  });

  it('is deterministic: the same capture solves to the same bytes', () => {
    const capture = bankWindow(plainImage());
    const a = solvePlainFromCapture('v1-2014', capture);
    const b = solvePlainFromCapture('v1-2014', capture);
    expect(a).toEqual(b);
  });

  it('refuses a capture too short to hold the header window', () => {
    const solved = solvePlainFromCapture('v1-2014', new Uint8Array(0x100));
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/too short to hold the image header/);
  });

  it('refuses a capture whose header magic is not the image magic — ciphered or foreign', () => {
    const image = plainImage();
    const dv = new DataView(image.buffer);
    dv.setUint32(0x200, 0xdeadbeef, true);
    const solved = solvePlainFromCapture('v1-2014', bankWindow(image));
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/ciphered \(or not a firmware image at all\)/);
  });

  it('refuses a header that declares zero, unaligned, oversized or overlong lengths', () => {
    const at = (patch: (dv: DataView) => void): Uint8Array => {
      const image = plainImage();
      patch(new DataView(image.buffer));
      return bankWindow(image);
    };
    const stamp = (dv: DataView, length: number): void => {
      dv.setUint32(0x204, length, true);
    };
    const zero = solvePlainFromCapture(
      'v1-2014',
      at((dv) => {
        stamp(dv, 0);
      }),
    );
    expect(zero.ok).toBe(false);
    if (!zero.ok) expect(zero.reason).toMatch(/length of 0/);

    const unaligned = solvePlainFromCapture(
      'v1-2014',
      at((dv) => {
        stamp(dv, 0x123);
      }),
    );
    expect(unaligned.ok).toBe(false);
    if (!unaligned.ok) expect(unaligned.reason).toMatch(/not a multiple of 4/);

    const oversized = solvePlainFromCapture(
      'v1-2014',
      at((dv) => {
        stamp(dv, 0x10000);
      }),
    );
    expect(oversized.ok).toBe(false);
    if (!oversized.ok) expect(oversized.reason).toMatch(/2014 bootloader's own bound/);

    const overlong = solvePlainFromCapture(
      'v1-2014',
      at((dv) => {
        stamp(dv, 0x20000);
      }),
    );
    expect(overlong.ok).toBe(false);
    if (!overlong.ok) expect(overlong.reason).toMatch(/does not hold the image it describes/);
  });
});

/* ===================================================================== *
 * the cipher families — synthetic captures, every layer of the solve
 * ===================================================================== */

describe('solvePlainFromCapture — the compact-2016 family (synthetic captures)', () => {
  const plain2016 = (): Uint8Array =>
    cipherPlainImage({
      targetSum: 0,
      widenAt: WIDEN_2016_AT,
      widenHex: WIDEN_2016_HEX,
      guard: true,
      keys: KEY_CP103,
    });

  it('solves a capture ciphered under key block 1 to the exact plain image', () => {
    const image = plain2016();
    const solved = solvePlainFromCapture('compact-2016', cipheredWindow(image, KEY_CP103.block1));
    if (!solved.ok) throw new Error(`expected ok, refused: ${solved.reason}`);
    expect(solved.plain).toEqual(image);
    expect(solved.method).toMatch(/r16-state-from-crib\+keyblock-verify/);
    expect(solved.method).toMatch(/device stream/);
    /* The result is its own buffer, not a view into the capture. */
    const capture = cipheredWindow(image, KEY_CP103.block1);
    const again = solvePlainFromCapture('compact-2016', capture);
    if (!again.ok) throw new Error(again.reason);
    again.plain[5] = (again.plain[5] ?? 0) ^ 0xff;
    expect(capture[5]).not.toBe(again.plain[5]);
  });

  it('is deterministic: the same capture solves to the same result', () => {
    const capture = cipheredWindow(plain2016(), KEY_CP103.block1);
    expect(solvePlainFromCapture('compact-2016', capture)).toEqual(
      solvePlainFromCapture('compact-2016', capture),
    );
  });

  it('solves the 1.0.3.2-FF line’s pair (cp1032ff) the same way', () => {
    const image = cipherPlainImage({
      targetSum: 0,
      widenAt: WIDEN_2016_AT,
      widenHex: WIDEN_2016_HEX,
      guard: true,
      keys: KEY_CP1032FF,
    });
    const solved = solvePlainFromCapture(
      'compact-2016',
      cipheredWindow(image, KEY_CP1032FF.block1),
    );
    if (!solved.ok) throw new Error(`expected ok, refused: ${solved.reason}`);
    expect(solved.plain).toEqual(image);
  });

  it('refuses one flipped capture byte — the sum rule dies on the decrypted image', () => {
    const image = plain2016();
    /* 0x1234 is inside the code payload, far from the crib and the window. */
    const capture = cipheredWindow(image, KEY_CP103.block1, { flipByte: 0x1234 });
    const solved = solvePlainFromCapture('compact-2016', capture);
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/word sum is 0x[0-9a-f]+, want 0x0/);
  });

  it('refuses a scrambled held-back vector word (13) — the crib’s own verdict', () => {
    const image = plain2016();
    const capture = cipheredWindow(image, KEY_CP103.block1);
    const wv = viewOf(capture);
    wv.setUint32(13 * 4, (wv.getUint32(13 * 4, true) ^ 1) >>> 0, true);
    const solved = solvePlainFromCapture('compact-2016', capture);
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/vector word 13 to zero/);
  });

  it('refuses a scrambled crib word (8) — a wrong state cannot decrypt word 13 to zero', () => {
    const image = plain2016();
    const capture = cipheredWindow(image, KEY_CP103.block1);
    const wv = viewOf(capture);
    wv.setUint32(8 * 4, (wv.getUint32(8 * 4, true) ^ 0x80) >>> 0, true);
    const solved = solvePlainFromCapture('compact-2016', capture);
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/crib assumption does not check out/);
  });

  it('refuses an UNCIPHERED image — the zero state’s stream is not the family’s', () => {
    /* A plain 1.0.3.x image solves to the zero state (its vector zeros are
     * the crib), decrypts to itself, passes the sum — and then no documented
     * stream of its own keys reproduces the capture. The identity family
     * owns plain captures, not this one. */
    const solved = solvePlainFromCapture('compact-2016', bankWindow(plain2016()));
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/keystream does not close/);
  });

  it('refuses an image without the family’s key blocks', () => {
    const image = cipherPlainImage({
      targetSum: 0,
      widenAt: WIDEN_2016_AT,
      widenHex: WIDEN_2016_HEX,
      guard: true,
      keys: null,
    });
    /* Cipher under a real key so the solve reaches the key-block gate. */
    const solved = solvePlainFromCapture('compact-2016', cipheredWindow(image, KEY_CP103.block1));
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/key blocks by value/);
  });

  it('refuses a capture whose verbatim header window is itself scrambled', () => {
    /* The XOR-0x5A shape: EVERY byte ciphered, the header window included —
     * no bootloader could read the length, so no family claims it. */
    const capture = bankWindow(plain2016()).map((b) => b ^ 0x5a);
    const solved = solvePlainFromCapture('compact-2016', capture);
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/verbatim window itself is scrambled/);
  });

  it('refuses the FF family’s sentinel under the 2016 acceptance', () => {
    const image = cipherPlainImage({
      targetSum: 0xffff,
      widenAt: WIDEN_2014_AT,
      widenHex: WIDEN_2014_HEX,
      guard: true,
      keys: KEY_FF,
    });
    const solved = solvePlainFromCapture('compact-2016', cipheredWindow(image, KEY_FF.block1));
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/want 0x0/);
  });
});

describe('solvePlainFromCapture — the v1-2014-ff family (synthetic captures)', () => {
  const plainFF = (): Uint8Array =>
    cipherPlainImage({
      targetSum: 0xffff,
      widenAt: WIDEN_2014_AT,
      widenHex: WIDEN_2014_HEX,
      guard: true,
      keys: KEY_FF,
    });

  it('solves the device-stream at-rest form (plain ^ ksD)', () => {
    const image = plainFF();
    const solved = solvePlainFromCapture('v1-2014-ff', cipheredWindow(image, KEY_FF.block1));
    if (!solved.ok) throw new Error(`expected ok, refused: ${solved.reason}`);
    expect(solved.plain).toEqual(image);
    expect(wordSum(solved.plain)).toBe(0xffff);
    expect(solved.method).toMatch(/device stream/);
  });

  it('solves the two-stream at-rest form (plain ^ ks0 ^ ksD) — one stream, the XOR of seeds', () => {
    const image = plainFF();
    const capture = cipheredWindow(image, KEY_FF.block0, { alsoKeyHex: KEY_FF.block1 });
    const solved = solvePlainFromCapture('v1-2014-ff', capture);
    if (!solved.ok) throw new Error(`expected ok, refused: ${solved.reason}`);
    expect(solved.plain).toEqual(image);
    expect(solved.method).toMatch(/two-stream store/);
  });

  it('refuses a capture ciphered under a stream the found keys do not explain', () => {
    const image = plainFF();
    /* Ciphered under block 0 ALONE — not a documented at-rest form of this
     * family, and not what the commit path stores. */
    const solved = solvePlainFromCapture('v1-2014-ff', cipheredWindow(image, KEY_FF.block0));
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/keystream does not close/);
  });

  it('refuses one flipped capture byte at the sentinel', () => {
    const image = plainFF();
    const solved = solvePlainFromCapture(
      'v1-2014-ff',
      cipheredWindow(image, KEY_FF.block1, { flipByte: 0x2100 }),
    );
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/word sum is 0x[0-9a-f]+, want 0xffff/);
  });

  it('refuses a 2016-line image at the FF sentinel (the families are mutually exclusive)', () => {
    const image = cipherPlainImage({
      targetSum: 0,
      widenAt: WIDEN_2016_AT,
      widenHex: WIDEN_2016_HEX,
      guard: true,
      keys: KEY_CP103,
    });
    const solved = solvePlainFromCapture('v1-2014-ff', cipheredWindow(image, KEY_CP103.block1));
    expect(solved.ok).toBe(false);
    if (!solved.ok) expect(solved.reason).toMatch(/want 0xffff/);
  });
});

describe('solvePlainFromCapture — the shared first gate (every family)', () => {
  it('every family refuses a capture too short for the header window, each naming itself', () => {
    for (const family of ['v1-2014', 'v1-2014-ff', 'compact-2016'] as const) {
      const solved = solvePlainFromCapture(family, new Uint8Array(0x100));
      expect(solved.ok).toBe(false);
      if (!solved.ok && family !== 'v1-2014') expect(solved.reason).toMatch(new RegExp(family));
    }
  });

  it('garbage refuses everywhere, each family with its own reason', () => {
    const garbage = new Uint8Array(0x10000).fill(0x5a);
    for (const family of ['v1-2014', 'v1-2014-ff', 'compact-2016'] as const) {
      const solved = solvePlainFromCapture(family, garbage);
      expect(solved.ok).toBe(false);
      if (!solved.ok && family === 'v1-2014')
        expect(solved.reason).toMatch(/not a plaintext 2014 image/);
      if (!solved.ok && family !== 'v1-2014') expect(solved.reason).toMatch(new RegExp(family));
    }
  });

  it('a declared length past the bootloader’s bound refuses before any decryption', () => {
    const image = plainImage();
    new DataView(image.buffer).setUint32(0x204, 0x10000, true);
    for (const family of ['v1-2014-ff', 'compact-2016'] as const) {
      const solved = solvePlainFromCapture(family, bankWindow(image));
      expect(solved.ok).toBe(false);
      if (!solved.ok) expect(solved.reason).toMatch(/bootloader's own bound/);
    }
  });

  it('a length too small for the segmented container refuses before the solve', () => {
    const image = plainImage();
    new DataView(image.buffer).setUint32(0x204, 0x280, true);
    for (const family of ['v1-2014-ff', 'compact-2016'] as const) {
      const solved = solvePlainFromCapture(family, bankWindow(image));
      expect(solved.ok).toBe(false);
      if (!solved.ok) expect(solved.reason).toMatch(/segmented container/);
    }
  });
});

/* ===================================================================== *
 * the real fixtures — the corpus dumps, twins and plaintexts
 *
 * Gated on file existence, as every corpus-gated suite here is: the dumps
 * live under SEEK_DUMPS beside the repository (SEEK_DUMPS_DIR overrides, and
 * overrides ONLY), the plaintexts under the vendored emulator corpus.
 * ===================================================================== */

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..', '..', '..');

function seekDumpsDir(): string | null {
  const override = process.env.SEEK_DUMPS_DIR;
  if (typeof override === 'string' && override.length > 0) {
    return existsSync(override) ? override : null;
  }
  const fallback = path.resolve(REPO_ROOT, '..', 'SEEK_DUMPS');
  return existsSync(fallback) ? fallback : null;
}

const EMU = (() => {
  const override = process.env.SEEK_EMU_DIR;
  if (typeof override === 'string' && override.length > 0) {
    return existsSync(override) ? override : null;
  }
  const fallback = path.resolve(REPO_ROOT, '..', 'FW-V1', 'emu');
  return existsSync(fallback) ? fallback : null;
})();

function emuFile(...parts: readonly string[]): string | null {
  if (EMU === null) return null;
  const file = path.join(EMU, 'data', 'corpus', ...parts);
  return existsSync(file) ? file : null;
}

function dumpsFile(...parts: readonly string[]): string | null {
  const dir = seekDumpsDir();
  if (dir === null) return null;
  const file = path.join(dir, 'firmwares', ...parts);
  return existsSync(file) ? file : null;
}

function firstExisting(...files: readonly (string | null)[]): string | null {
  return files.find((f) => f !== null) ?? null;
}

/** The native 1.0.3.0 camera (0C21A1M5KP15): the 4 MiB dump and the decrypted
 *  twin of its bank-A slot image (as-booted = plain ^ ks(key block 1)). */
const NATIVE_1030_DUMP = firstExisting(
  dumpsFile(
    'Compact Pro',
    '2016.07.06-17.04.49-1.0.3.0',
    '0C21A1M5KP15',
    'Compact Pro Android UQ-AAA.BIN',
  ),
  emuFile(
    'compact_pro',
    '2016.07.06-17.04.49-1.0.3.0',
    '0C21A1M5KP15',
    'compact_pro_android_uq-aaa.bin',
  ),
);
const NATIVE_1030_TWIN = dumpsFile(
  'Compact Pro',
  '2016.07.06-17.04.49-1.0.3.0',
  '0C21A1M5KP15',
  'Compact Pro Android UQ-AAA_decrypted_14050000.bin',
);
/** The native 1.0.3.0-FF camera (0B14A1JULD54): dump + plain OTA image — a
 *  2016-family build whose key pair is the cp1032ff one (doc 1032 sec. 3). */
const NATIVE_1030FF_DUMP = emuFile(
  'compact_pro',
  '2016.07.06-17.05.32-1.0.3.0-FF',
  '0B14A1JULD54',
  'compact_pro_ff_jul_6_2016_17-05-32_1.0.3.0_84.00_0b14a1juld54_gabiz_ro_dump.bin',
);
const PLAIN_1030FF = emuFile(
  'compact_pro',
  '2016.07.06-17.05.32-1.0.3.0-FF',
  '0B14A1JULD54',
  'compact_pro_ff_jul_6_2016_17-05-32_1.0.3.0_84.00_0b14a1juld54_gabiz_ro_firmware.bin',
);
const PLAIN_1030 = emuFile(
  'compact_pro',
  '2016.07.06-17.04.49-1.0.3.0',
  'no-serial',
  '80k_4330_1.0.3.0-9hz_public_-_compact_pro_jul_6_2016_17-04-49_84.00_gabiz_ro_firmware.bin',
);
const PLAIN_1032_9HZ = emuFile(
  'compact_pro',
  '2017.01.06-15.45.07-1.0.3.2',
  'no-serial',
  '80k_4330_1.0.3.2_compact-9hz_public_-_compact_pro_jan_6_2017_15-45-07_84.00_gabiz_ro_firmware.bin',
);
const PLAIN_1032_18HZFF = emuFile(
  'compact_pro',
  '2017.01.06-15.45.44-1.0.3.2-FF',
  'no-serial',
  '80k_4330_1.0.3.2_compact-18hz_public_-_compact_pro_jan_6_2017_15-45-44_84.00_gabiz_ro_firmware.bin',
);
const PLAIN_FF = emuFile(
  'compact',
  '2017.01.06-11.17.29-1.3.0.8-FF',
  'no-serial',
  '32k_43x0_1.3.0.8_compact-16hz_public_-_compact_ff_jan_6_2017_11-17-29_99.28_gabiz_ro_firmware.bin',
);

const FIXTURES_MISSING: readonly string[] = (
  [
    ['native 1.0.3.0 dump', NATIVE_1030_DUMP],
    ['native 1.0.3.0 twin', NATIVE_1030_TWIN],
    ['native 1.0.3.0-FF dump', NATIVE_1030FF_DUMP],
    ['1.0.3.0-FF plain', PLAIN_1030FF],
    ['1.0.3.0 plain', PLAIN_1030],
    ['1.0.3.2 9 Hz plain', PLAIN_1032_9HZ],
    ['1.0.3.2 18 Hz FF plain', PLAIN_1032_18HZFF],
    ['1.3.0.8-FF plain', PLAIN_FF],
  ] as const
)
  .filter(([, file]) => file === null)
  .map(([name]) => name);

describe('solvePlainFromCapture — the real fixtures (corpus-gated)', () => {
  it.skipIf(FIXTURES_MISSING.length > 0)(
    'every fixture is present, and the native dumps are the ones the RE records sha',
    () => {
      expect(FIXTURES_MISSING).toEqual([]);
      /* The two native dumps, by their record digests (doc 1032 sec. 3's
       * donor table): the 1.0.3.0 camera 0C21A1M5KP15 and the 1.0.3.0-FF
       * camera 0B14A1JULD54. The decrypted twin IS the corpus's own 1.0.3.0
       * plain image — one sha covers both names (families.test.ts pins it). */
      expect(
        sha256(new Uint8Array(readFileSync(NATIVE_1030_DUMP ?? '/'))),
        'the native 1.0.3.0 dump',
      ).toBe('db4efc84f5338815ef9e4fa8b8242d9d8fdfad7f118d97aaa0180cbbddae4dee');
      expect(
        sha256(new Uint8Array(readFileSync(NATIVE_1030_TWIN ?? '/'))),
        'the native 1.0.3.0 twin (== the corpus plain image)',
      ).toBe('5e1f3f24c8bc1e85bcb67e73e0ee23f301864ee7839a48135598fca961373e26');
      expect(
        sha256(new Uint8Array(readFileSync(NATIVE_1030FF_DUMP ?? '/'))),
        'the native 1.0.3.0-FF dump',
      ).toBe('e6a3354f4719fe2942957a94b56bba8721a4bbf2de0cedec3aea1e95c0f6597c');
    },
  );

  it.skipIf(NATIVE_1030_DUMP === null || NATIVE_1030_TWIN === null)(
    'the native 1.0.3.0 capture solves to the decrypted twin, byte for byte',
    () => {
      const dump = new Uint8Array(readFileSync(NATIVE_1030_DUMP ?? '/'));
      const twin = new Uint8Array(readFileSync(NATIVE_1030_TWIN ?? '/'));
      /* Bank A at 0x14050000 -> the dump's 0x50000; the slot holds the image
       * ciphered, the erased tail behind. */
      const capture = dump.slice(0x50000, 0x50000 + 0x10000);
      const solved = solvePlainFromCapture('compact-2016', capture);
      if (!solved.ok) throw new Error(`expected ok, refused: ${solved.reason}`);
      expect(solved.plain).toEqual(twin);
      expect(solved.plain.length).toBe(twin.length);
      expect(wordSum(solved.plain)).toBe(0);
      expect(solved.method).toMatch(/device stream, key block 1/);
    },
  );

  it.skipIf(NATIVE_1030FF_DUMP === null || PLAIN_1030FF === null)(
    'the native 1.0.3.0-FF capture solves through the cp1032ff pair to its plain image',
    () => {
      const dump = new Uint8Array(readFileSync(NATIVE_1030FF_DUMP ?? '/'));
      const plain = new Uint8Array(readFileSync(PLAIN_1030FF ?? '/'));
      const capture = dump.slice(0x50000, 0x50000 + 0x10000);
      const solved = solvePlainFromCapture('compact-2016', capture);
      if (!solved.ok) throw new Error(`expected ok, refused: ${solved.reason}`);
      expect(solved.plain).toEqual(plain);
      /* This build is the cipher line's — but no build in the patch table
       * carries it, so a run on that camera refuses at the caller's build
       * gates. The solver vouches for the plaintext; the table vouches for
       * the build. */
      expect(solved.method).toMatch(/device stream/);
    },
  );

  it.skipIf(NATIVE_1030_DUMP === null)(
    'a corrupted native capture refuses at the sum rule — the solve never guesses',
    () => {
      const dump = new Uint8Array(readFileSync(NATIVE_1030_DUMP ?? '/'));
      const capture = dump.slice(0x50000, 0x50000 + 0x10000);
      capture[0x1234] = (capture[0x1234] ?? 0) ^ 0x40;
      const solved = solvePlainFromCapture('compact-2016', capture);
      expect(solved.ok).toBe(false);
      if (!solved.ok) expect(solved.reason).toMatch(/word sum is 0x[0-9a-f]+, want 0x0/);
    },
  );

  it.skipIf(
    PLAIN_1030 === null ||
      PLAIN_1032_9HZ === null ||
      PLAIN_1032_18HZFF === null ||
      PLAIN_FF === null,
  )('the corpus plaintexts, ciphered under their RE-recorded block 1, solve to themselves', () => {
    /* The real plain images, re-ciphered into at-rest captures with the
     * key block the RE records name for each build, then solved back. This
     * pins the pair-per-build table AND the solve on real image bytes —
     * including 1.0.3.2's two variants and the cp1032ff pair. */
    const cases: readonly {
      readonly name: string;
      readonly file: string;
      readonly family: 'compact-2016' | 'v1-2014-ff';
      readonly block1: string;
      readonly targetSum: number;
    }[] = [
      {
        name: '1.0.3.0',
        file: PLAIN_1030 ?? '',
        family: 'compact-2016',
        block1: KEY_CP103.block1,
        targetSum: 0,
      },
      {
        name: '1.0.3.2 9 Hz',
        file: PLAIN_1032_9HZ ?? '',
        family: 'compact-2016',
        block1: KEY_CP103.block1,
        targetSum: 0,
      },
      {
        name: '1.0.3.2 18 Hz FF',
        file: PLAIN_1032_18HZFF ?? '',
        family: 'compact-2016',
        block1: KEY_CP1032FF.block1,
        targetSum: 0,
      },
      {
        name: '1.3.0.8-FF',
        file: PLAIN_FF ?? '',
        family: 'v1-2014-ff',
        block1: KEY_FF.block1,
        targetSum: 0xffff,
      },
    ];
    for (const c of cases) {
      const image = new Uint8Array(readFileSync(c.file));
      expect(wordSum(image) >>> 0, `${c.name}: the corpus image’s own sum`).toBe(c.targetSum >>> 0);
      const solved = solvePlainFromCapture(c.family, cipheredWindow(image, c.block1));
      if (!solved.ok) throw new Error(`${c.name}: expected ok, refused: ${solved.reason}`);
      expect(solved.plain, c.name).toEqual(image);
    }
  });

  it.skipIf(PLAIN_FF === null)(
    'the 1.3.0.8-FF plain image also solves from the two-stream form',
    () => {
      /* No native FF camera dump exists — the record's FF chimera runs on a
       * PLAINTEXT donor (the identity path's fixture) — so the genuinely
       * ciphered at-rest forms are proven on the real FF image here. */
      const image = new Uint8Array(readFileSync(PLAIN_FF ?? '/'));
      const capture = cipheredWindow(image, KEY_FF.block0, { alsoKeyHex: KEY_FF.block1 });
      const solved = solvePlainFromCapture('v1-2014-ff', capture);
      if (!solved.ok) throw new Error(`expected ok, refused: ${solved.reason}`);
      expect(solved.plain).toEqual(image);
      expect(solved.method).toMatch(/two-stream store/);
    },
  );
});

/** Guard the fixtures themselves: hexToBytes stays load-bearing for the
 *  suites that pin key blocks by value. */
describe('fixtures', () => {
  it('hexToBytes round-trips the header magic', () => {
    expect([...hexToBytes('d4c3b2a1')]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
  });
});

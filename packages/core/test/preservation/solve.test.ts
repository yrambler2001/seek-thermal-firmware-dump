/* ==================================================================== *
 * The seam that turns a slot capture into the factory plaintext
 * (`solve.ts`) — the ruling's mechanism, unit-tested: the identity path for
 * the plain chain (structural validation, the image-length slice), and the
 * cipher families' refusal until their keystream solvers land behind the
 * same signature. Pure bytes in, result out — no camera, no emulator.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';

import { hexToBytes } from '../../src/bytes.js';
import {
  REBALANCE_WORD_OFFSET,
  V1_2014_PATCH_SITES,
  wordSum,
} from '../../src/preservation/patch.js';
import { solvePlainFromCapture } from '../../src/preservation/solve.js';

const IMAGE_LENGTH = 0x4000;
const VERSION_WORD = 0x0000_0301; /* -> "1.3.0.0" */

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

describe('solvePlainFromCapture — the cipher families refuse until their solvers land', () => {
  it('the FF family refuses with the reason, and never hands over bytes', () => {
    const solved = solvePlainFromCapture('v1-2014-ff', bankWindow(plainImage()));
    expect(solved.ok).toBe(false);
    if (!solved.ok) {
      expect(solved.reason).toMatch(/v1-2014-ff keystream solver is not implemented/);
      expect(solved.reason).toMatch(/refuses rather than write/);
    }
  });

  it('the 2016 family refuses with the reason, and never hands over bytes', () => {
    const solved = solvePlainFromCapture('compact-2016', bankWindow(plainImage()));
    expect(solved.ok).toBe(false);
    if (!solved.ok)
      expect(solved.reason).toMatch(/compact-2016 keystream solver is not implemented/);
  });

  it('the identity refusal does not leak into the cipher stubs: each family names itself', () => {
    /* A garbage capture: every family refuses, each with its own reason. */
    const garbage = new Uint8Array(0x10000).fill(0x5a);
    for (const family of ['v1-2014', 'v1-2014-ff', 'compact-2016'] as const) {
      const solved = solvePlainFromCapture(family, garbage);
      expect(solved.ok).toBe(false);
      if (!solved.ok && family === 'v1-2014')
        expect(solved.reason).toMatch(/not a plaintext 2014 image/);
      if (!solved.ok && family !== 'v1-2014') expect(solved.reason).toMatch(new RegExp(family));
    }
  });
});

/** Guard the fixtures themselves: hexToBytes stays load-bearing for the
 *  families suites that pin key blocks by value. */
describe('fixtures', () => {
  it('hexToBytes round-trips the header magic', () => {
    expect([...hexToBytes('d4c3b2a1')]).toEqual([0xd4, 0xc3, 0xb2, 0xa1]);
  });
});

import { describe, expect, it } from 'vitest';

import { equalBytes, hexToBytes, utf8, viewOf } from '../src/bytes.js';
import { SeekError } from '../src/errors.js';
import { decryptImage, stateFromKey } from '../src/crypto/index.js';
import {
  ADJUST_OFFSET,
  FOOTER_SIZE,
  FOOTER_TAG,
  HEADER_OFFSET,
  LENGTH_OFFSET,
  assertBankPayload,
  bankPayloadSize,
  buildBankPayload,
  findImages,
  footerOffsetFor,
  parseFooter,
  parseImageHeader,
  setAcceptSum,
  transferSum16,
  versionString,
  wordSum32,
} from '../src/image/index.js';
import type { CipherProfile } from '../src/profiles/types.js';

const MODERN: CipherProfile = {
  whiteningK: 0x13579bdf,
  acceptanceSum: 0x0000ffff,
  clearWords: [128, 143],
};
/** The 2016 Compact Pro generation: no whitening, acceptance target 0. */
const LEGACY: CipherProfile = { whiteningK: 0, acceptanceSum: 0, clearWords: [128, 143] };

const KEY_A = hexToBytes('0f1e2d3c4b5a69788796a5b4c3d2e1f0');

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s;
  };
}

function synthImage(length = 0x1000, declaredLength = length): Uint8Array {
  const img = new Uint8Array(length);
  const dv = viewOf(img);
  const rnd = lcg(0xbadc0de);
  for (let o = 0; o + 4 <= length; o += 4) dv.setUint32(o, rnd(), true);
  dv.setUint32(0, 0x10004000, true);
  dv.setUint32(4, 0x14030401, true);
  for (const i of [7, 8, 9, 10]) dv.setUint32(4 * i, 0, true);
  dv.setUint32(4 * 13, 0, true);
  dv.setUint32(HEADER_OFFSET, 0xa1b2c3d4, true);
  dv.setUint32(LENGTH_OFFSET, declaredLength, true);
  dv.setUint32(HEADER_OFFSET + 8, 0x00000042, true);
  dv.setUint32(HEADER_OFFSET + 12, 0x00021204, true);
  dv.setUint32(HEADER_OFFSET + 16, 0x14030401, true);
  dv.setUint32(ADJUST_OFFSET, 0, true);
  return img;
}

/** A 64-byte footer as a camera would already hold one. */
function footerTemplate(): Uint8Array {
  const f = new Uint8Array(FOOTER_SIZE).fill(0);
  const dv = viewOf(f);
  dv.setUint32(0, 0, true); /* tag is stamped by buildBankPayload */
  dv.setUint32(4, 0xdeadbeef, true); /* stale length, must be overwritten */
  dv.setUint32(8, 0x00000099, true);
  dv.setUint32(12, 0x00021204, true);
  f.set(utf8('SEEK-TEST'), 16);
  return f;
}

/** The SeekError code a call throws, as a plain string, for readable failures. */
function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    return e instanceof SeekError ? e.code : `not a SeekError: ${String(e)}`;
  }
  return 'no error thrown';
}

describe('header', () => {
  it('parses the fields the bootloader reads in clear', () => {
    const h = parseImageHeader(synthImage());
    expect(h).not.toBeNull();
    expect(h?.magic).toBe(0xa1b2c3d4);
    expect(h?.length).toBe(0x1000);
    expect(h?.imageId).toBe(0x42);
    expect(h?.entry).toBe(0x14030401);
    expect(h?.sp).toBe(0x10004000);
    expect(h?.reset).toBe(0x14030401);
    expect(h?.adjust).toBe(0);
    expect(h?.versionStr).toBe('4.18.2.0');
  });

  it('parses at a base offset and returns null when the window is cut short', () => {
    const dump = new Uint8Array(0x2000);
    dump.set(synthImage(), 0x1000);
    expect(parseImageHeader(dump, 0x1000)?.magic).toBe(0xa1b2c3d4);
    expect(parseImageHeader(new Uint8Array(HEADER_OFFSET + 0x3f))).toBeNull();
    expect(parseImageHeader(dump, 0x1fff)).toBeNull();
  });

  it('versionString reads four bytes low-first', () => {
    expect(versionString(0x00021204)).toBe('4.18.2.0');
    expect(versionString(0x00000904)).toBe('4.9.0.0');
    expect(versionString(0xffffffff)).toBe('255.255.255.255');
  });

  it('parses a "CODE" footer and its model string', () => {
    const buf = new Uint8Array(0x100);
    const f = footerTemplate();
    viewOf(f).setUint32(0, FOOTER_TAG, true);
    buf.set(f, 0x80);
    const parsed = parseFooter(buf, 0x80);
    expect(parsed?.tag).toBe(FOOTER_TAG);
    expect(parsed?.imageId).toBe(0x99);
    expect(parsed?.model).toBe('SEEK-TEST');
    expect(parsed?.raw.length).toBe(FOOTER_SIZE);
    expect(parseFooter(buf, 0xc1)).toBeNull();
    expect(parseFooter(buf, -1)).toBeNull();
  });

  it('derives the bank geometry the bootloader derives', () => {
    expect(bankPayloadSize(0x1000)).toBe(0x4000);
    expect(footerOffsetFor(0x1000)).toBe(0x3fc0);
    expect(bankPayloadSize(0x4000)).toBe(0x8000);
    expect(footerOffsetFor(0x4000)).toBe(0x7fc0);
    expect(bankPayloadSize(0x3fc0)).toBe(0x4000);
    /* one word past the footer offset is exactly the case that overruns */
    expect(footerOffsetFor(0x3fd0)).toBe(0x3fc0);
    expect(bankPayloadSize(0x10000)).toBe(0x14000);
  });
});

describe('sums', () => {
  it('wordSum32 sums little-endian words and wraps at 32 bits', () => {
    const b = new Uint8Array(12);
    const dv = viewOf(b);
    dv.setUint32(0, 0xffffffff, true);
    dv.setUint32(4, 0x00000002, true);
    dv.setUint32(8, 0xcafebabe, true);
    expect(wordSum32(b, 8)).toBe(1);
    expect(wordSum32(b, 12)).toBe((1 + 0xcafebabe) >>> 0);
    /* trailing bytes that do not make a whole word are not summed */
    expect(wordSum32(b, 11)).toBe(1);
  });

  it('transferSum16 sums every byte modulo 2^16', () => {
    expect(transferSum16(new Uint8Array(0))).toBe(0);
    expect(transferSum16(Uint8Array.of(1, 2, 3))).toBe(6);
    expect(transferSum16(new Uint8Array(0x400).fill(0xff))).toBe((0x400 * 0xff) & 0xffff);
  });
});

describe('setAcceptSum', () => {
  it('hits the profile target exactly and leaves the caller image untouched', () => {
    const image = synthImage();
    const before = image.slice();
    const res = setAcceptSum(image, MODERN);
    expect(equalBytes(image, before)).toBe(true);
    expect(res.sum).toBe(MODERN.acceptanceSum);
    expect(wordSum32(res.image, res.length)).toBe(MODERN.acceptanceSum);
    expect(viewOf(res.image).getUint32(ADJUST_OFFSET, true)).toBe(res.adjust);
  });

  it('works for a profile whose target is 0', () => {
    const res = setAcceptSum(synthImage(), LEGACY);
    expect(res.sum).toBe(0);
    expect(wordSum32(res.image, res.length)).toBe(0);
  });

  it('stamps header.length to the real size', () => {
    const res = setAcceptSum(synthImage(0x1000, 0x800), MODERN);
    expect(res.length).toBe(0x1000);
    expect(viewOf(res.image).getUint32(LENGTH_OFFSET, true)).toBe(0x1000);
    expect(res.sum).toBe(MODERN.acceptanceSum);
  });

  it('is idempotent', () => {
    const once = setAcceptSum(synthImage(), MODERN);
    const twice = setAcceptSum(once.image, MODERN);
    expect(twice.adjust).toBe(once.adjust);
    expect(equalBytes(twice.image, once.image)).toBe(true);
  });

  it('refuses an image too small to hold a header', () => {
    expect(codeOf(() => setAcceptSum(new Uint8Array(0x100), MODERN))).toBe('image/malformed');
  });
});

describe('buildBankPayload', () => {
  const built = buildBankPayload(synthImage(), KEY_A, footerTemplate(), MODERN);

  it('emits the full bank: image + 0xFF pad + footer', () => {
    expect(built.payload.length).toBe(0x4000);
    expect(built.length).toBe(0x1000);
    expect(built.footerOffset).toBe(0x3fc0);
    /* everything between the image and the footer is erased flash */
    const pad = built.payload.subarray(built.length, built.footerOffset);
    expect(pad.every((b) => b === 0xff)).toBe(true);
  });

  it('encrypts the image under Key A, header window in clear', () => {
    const body = built.payload.subarray(0, built.length);
    expect(equalBytes(body, built.image)).toBe(false);
    const plain = decryptImage(
      viewOf(built.payload),
      0,
      built.length,
      stateFromKey(KEY_A, MODERN.whiteningK),
      MODERN,
    );
    expect(equalBytes(plain, built.image)).toBe(true);
    /* header.length is readable without a key — that is why the bootloader can
     * find the footer before it has chosen one */
    expect(viewOf(built.payload).getUint32(LENGTH_OFFSET, true)).toBe(built.length);
  });

  it('carries the device footer over and patches only tag and length', () => {
    expect(built.footer?.tag).toBe(FOOTER_TAG);
    expect(built.footer?.length).toBe(built.length);
    expect(built.footer?.imageId).toBe(0x99);
    expect(built.footer?.version).toBe(0x00021204);
    expect(built.footer?.model).toBe('SEEK-TEST');
  });

  it('does not mutate the caller footer template', () => {
    const template = footerTemplate();
    const before = template.slice();
    buildBankPayload(synthImage(), KEY_A, template, MODERN);
    expect(equalBytes(template, before)).toBe(true);
  });

  it('writes an all-0xFF footer when the device has none to carry over', () => {
    const blank = buildBankPayload(synthImage(), KEY_A, null, MODERN);
    expect(blank.footer?.tag).toBe(FOOTER_TAG);
    expect(blank.footer?.length).toBe(blank.length);
    expect(blank.footer?.model).toBe('');
    expect(() => {
      assertBankPayload(blank.payload);
    }).not.toThrow();
  });

  it('refuses a truncated footer template', () => {
    expect(
      codeOf(() => buildBankPayload(synthImage(), KEY_A, footerTemplate().slice(0, 32), MODERN)),
    ).toBe('flash/refused');
  });

  it('refuses an image that overruns its own footer slot', () => {
    expect(codeOf(() => buildBankPayload(synthImage(0x3fd0), KEY_A, null, MODERN))).toBe(
      'flash/refused',
    );
  });

  it('refuses a bank larger than the upgrade window', () => {
    expect(codeOf(() => buildBankPayload(synthImage(0x10000), KEY_A, null, MODERN))).toBe(
      'flash/refused',
    );
    /* the same image is fine against a larger window */
    expect(buildBankPayload(synthImage(0x10000), KEY_A, null, MODERN, 0x20000).payload.length).toBe(
      0x14000,
    );
  });
});

describe('assertBankPayload', () => {
  const built = buildBankPayload(synthImage(), KEY_A, footerTemplate(), MODERN);

  it('passes what buildBankPayload produced', () => {
    expect(() => {
      assertBankPayload(built.payload);
    }).not.toThrow();
  });

  it('rejects a footer that is not "CODE" — the segmented-loader brick', () => {
    const bad = built.payload.slice();
    viewOf(bad).setUint32(built.footerOffset, 0x45444f44, true);
    expect(
      codeOf(() => {
        assertBankPayload(bad);
      }),
    ).toBe('flash/refused');
    expect(() => {
      assertBankPayload(bad);
    }).toThrow(/CODE/);
  });

  it('rejects a footer length that disagrees with header.length', () => {
    const bad = built.payload.slice();
    viewOf(bad).setUint32(built.footerOffset + 4, built.length + 4, true);
    expect(
      codeOf(() => {
        assertBankPayload(bad);
      }),
    ).toBe('flash/refused');
  });

  it('rejects a bare image with no footer at all', () => {
    const bare = built.payload.slice(0, built.length);
    expect(
      codeOf(() => {
        assertBankPayload(bare);
      }),
    ).toBe('flash/refused');
  });

  it('rejects anything too short to even carry a header length', () => {
    expect(
      codeOf(() => {
        assertBankPayload(new Uint8Array(0x100));
      }),
    ).toBe('flash/refused');
  });

  it('rejects a payload whose header.length points past its end', () => {
    const bad = built.payload.slice();
    viewOf(bad).setUint32(LENGTH_OFFSET, 0x8000, true);
    expect(
      codeOf(() => {
        assertBankPayload(bad);
      }),
    ).toBe('flash/refused');
  });
});

describe('findImages', () => {
  function dump(): Uint8Array {
    const buf = new Uint8Array(0x50000);
    const dv = viewOf(buf);
    const put = (base: number, len: number): void => {
      dv.setUint32(base + HEADER_OFFSET, 0xa1b2c3d4, true);
      dv.setUint32(base + LENGTH_OFFSET, len, true);
    };
    put(0x00000, 0x1000); /* good */
    put(0x10000, 0x1c000); /* >= MAX_IMAGE_LEN */
    put(0x20000, 0x1002); /* not word-aligned */
    put(0x30000, 0x200); /* not longer than the header window */
    put(0x40000, 0x11000); /* runs past the end of the dump */
    put(0x08000, 0x1000); /* not on a 64 KiB boundary */
    return buf;
  }

  it('accepts only block-aligned slots with a sane declared length', () => {
    expect(findImages(viewOf(dump()))).toEqual([{ base: 0, len: 0x1000 }]);
  });

  it('finds every valid slot', () => {
    const buf = dump();
    const dv = viewOf(buf);
    dv.setUint32(0x20000 + LENGTH_OFFSET, 0x2000, true);
    dv.setUint32(0x30000 + LENGTH_OFFSET, 0x204, true);
    expect(findImages(dv)).toEqual([
      { base: 0, len: 0x1000 },
      { base: 0x20000, len: 0x2000 },
      { base: 0x30000, len: 0x204 },
    ]);
  });

  it('honours a length shorter than the buffer', () => {
    const buf = dump();
    const dv = viewOf(buf);
    dv.setUint32(0x20000 + LENGTH_OFFSET, 0x2000, true);
    expect(findImages(dv, 0x20000)).toEqual([{ base: 0, len: 0x1000 }]);
    expect(findImages(dv, 0x100)).toEqual([]);
  });

  it('returns nothing for a dump with no image magic', () => {
    expect(findImages(viewOf(new Uint8Array(0x20000)))).toEqual([]);
  });
});

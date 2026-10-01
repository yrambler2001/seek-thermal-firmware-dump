/* ==================================================================== *
 * The per-build patch table: the algebra of the two NEW staged forms, the
 * shape locators, the detection rules, and the capability/route gates.
 *
 * Two populations, the same split patch.test.ts uses:
 *  - SYNTHETIC images, which run everywhere: they carry the shapes (the
 *    window ladder, the widen tails, the guard, the arm-tail hook with a real
 *    callee), the REAL key-block values, and a balanced header, so every
 *    branch of the table is reachable without any vendored input.
 *  - THE CORPUS PLAINTEXTS of the five real builds, when the emulator
 *    directory (SEEK_EMU_DIR, or FW-V1 beside this repository) carries them:
 *    every derived value is pinned to the number its RE doc recorded —
 *    rebalance words, diff offsets, staged sums16 and sha256s — so a doc
 *    fact and a code fact cannot drift apart silently.
 * ==================================================================== */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { hexToBytes } from '../../src/bytes.js';
import { SeekError } from '../../src/errors.js';
import {
  BUILD_PATCH_PROFILES,
  buildV1Patch,
  conjugateCapture,
  keyWordsOf,
  keystream,
  stagedAcceptanceSum,
  stagedFormOf,
  sum16,
  wordSum,
  xorWindowVerbatim,
  REBALANCE_WORD_OFFSET,
  V1_PAYLOAD_VMA_BASE,
  type BuildPatchProfile,
  type CommitRouteId,
  type DrainCapability,
  type PreserveFamilyId,
  type RestoreFormId,
  type StagedFormId,
} from '../../src/preservation/patch.js';
import { describeStepGate, type PreserveRunState } from '../../src/preservation/steps.js';
import { emulatorDir } from '../emulator/harness.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const hexBytes = (hex: string): Uint8Array => hexToBytes(hex);

/** Every offset at which `hexNeedle` occurs in `plain`. */
function occurrencesOf(plain: Uint8Array, hexNeedle: string): number[] {
  const needle = hexBytes(hexNeedle);
  const out: number[] = [];
  outer: for (let i = 0; i + needle.length <= plain.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (plain[i + j] !== needle[j]) continue outer;
    }
    out.push(i);
  }
  return out;
}

/* ---- corpus locations ----------------------------------------------------- */

const EMU = emulatorDir();

function corpusFile(...parts: readonly string[]): string | null {
  if (EMU === null) return null;
  const file = path.join(EMU, 'data', 'corpus', ...parts);
  return existsSync(file) ? file : null;
}

/** The five real images, by their vendored corpus paths (the SEEK_DUMPS
 *  copies are byte-identical, sha-checked in the sibling repo's records). */
const CORPUS_IMAGES = {
  'compact-1.3.0.8-8hz': corpusFile(
    'compact',
    '2017.01.06-11.16.17-1.3.0.8',
    'no-serial',
    '32k_43x0_1.3.0.8_compact-insecure-8hz_public_-_compact_jan_6_2017_11-16-17_99.28_gabiz_ro_firmware.bin',
  ),
  'compact-1.3.0.8-ff': corpusFile(
    'compact',
    '2017.01.06-11.17.29-1.3.0.8-FF',
    'no-serial',
    '32k_43x0_1.3.0.8_compact-16hz_public_-_compact_ff_jan_6_2017_11-17-29_99.28_gabiz_ro_firmware.bin',
  ),
  'compact-pro-1.0.3.0': corpusFile(
    'compact_pro',
    '2016.07.06-17.04.49-1.0.3.0',
    'no-serial',
    '80k_4330_1.0.3.0-9hz_public_-_compact_pro_jul_6_2016_17-04-49_84.00_gabiz_ro_firmware.bin',
  ),
  'compact-pro-1.0.3.2-9hz': corpusFile(
    'compact_pro',
    '2017.01.06-15.45.07-1.0.3.2',
    'no-serial',
    '80k_4330_1.0.3.2_compact-9hz_public_-_compact_pro_jan_6_2017_15-45-07_84.00_gabiz_ro_firmware.bin',
  ),
  'compact-pro-1.0.3.2-18hzff': corpusFile(
    'compact_pro',
    '2017.01.06-15.45.44-1.0.3.2-FF',
    'no-serial',
    '80k_4330_1.0.3.2_compact-18hz_public_-_compact_pro_jan_6_2017_15-45-44_84.00_gabiz_ro_firmware.bin',
  ),
} as const;

const CORPUS_MISSING: readonly string[] = Object.entries(CORPUS_IMAGES)
  .filter(([, file]) => file === null)
  .map(([id]) => id);

const readImage = (file: string | null): Uint8Array => new Uint8Array(readFileSync(file ?? '/'));

/* ---- synthetic images ------------------------------------------------------
 *
 * One deterministic random fill, then the shapes placed at fixed offsets, the
 * real key-block values, a header, and a balance word — everything the
 * table's detect hooks read, nothing else for them to find.
 */

/* Version words as stored (little-endian bytes low first): 1.3.0.8 for BOTH
 * 1.3.0.8 builds — the whole point — and 1.0.3.2 / 1.0.3.0 for the Pro line. */
const VERSION_WORD_1308 = 0x0800_0301;
const VERSION_WORD_1032 = 0x0203_0001;
const VERSION_WORD_1030 = 0x0003_0001;

const LADDER_HEX = '00000614000005140000021400000014';
const WIDEN_2014_HEX = '4ff480336360e360';
const WIDEN_2016_HEX = '63614ff48033a3602361';
const GUARD_HEX = '022b06d10420';
const LADDER_AT = 0x3000;
const WIDEN_2014_AT = LADDER_AT - 0x4a; /* the measured widen->ladder span */
const WIDEN_2016_AT = LADDER_AT - 0x4c;
const GUARD_AT = LADDER_AT - 0x154; /* the measured guard->ladder span */
const GUARD_D1_AT = GUARD_AT + 3; /* the patched byte inside the shape */
const HOOK_AT = 0x2a00;
const HOOK_CALLEE_AT = 0x0400; /* raw; VMA = + V1_PAYLOAD_VMA_BASE */
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

/** Encodes the Thumb-2 BL from raw offset `src` to `targetVma`. */
function blBytes(src: number, targetVma: number): number[] {
  const base = (V1_PAYLOAD_VMA_BASE + src + 4) >>> 0;
  const diff = (targetVma - base) | 0;
  const field = (diff >> 1) & 0xffffff; /* arithmetic shift: the sign rides in */
  const s = (field >>> 23) & 1;
  const i1 = (field >>> 22) & 1;
  const i2 = (field >>> 21) & 1;
  const imm10 = (field >>> 11) & 0x3ff;
  const imm11 = field & 0x7ff;
  const j1 = ~(i1 ^ s) & 1;
  const j2 = ~(i2 ^ s) & 1;
  const hi = 0xf000 | (s << 10) | imm10;
  const lo = 0xd000 | (j1 << 13) | (j2 << 11) | imm11;
  return [hi & 0xff, (hi >> 8) & 0xff, lo & 0xff, (lo >> 8) & 0xff];
}

interface SyntheticOptions {
  readonly version: number;
  /** The raw word sum the image must carry (0, or the FF build's 0xFFFF). */
  readonly targetSum: number;
  readonly ladder: boolean;
  readonly widen2014?: boolean;
  readonly widen2016?: boolean;
  readonly guard?: boolean;
  /** The arm-tail hook: a real callee, a bx lr stub, or absent. */
  readonly hook?: 'real' | 'stub';
  readonly keys?: { readonly block0: string; readonly block1: string } | null;
}

function syntheticImage(options: SyntheticOptions): Uint8Array {
  const bytes = new Uint8Array(0x4000);
  let state = 0x2468ace1;
  for (let i = 0; i < bytes.length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    bytes[i] = state & 0xff;
  }
  const put = (at: number, hex: string): void => {
    bytes.set(hexBytes(hex), at);
  };
  if (options.ladder) put(LADDER_AT, LADDER_HEX);
  if (options.widen2014 === true) put(WIDEN_2014_AT, WIDEN_2014_HEX);
  if (options.widen2016 === true) put(WIDEN_2016_AT, WIDEN_2016_HEX);
  if (options.guard === true) put(GUARD_AT, GUARD_HEX);
  if (options.hook !== undefined) {
    bytes.set(
      [...blBytes(HOOK_AT, V1_PAYLOAD_VMA_BASE + HOOK_CALLEE_AT), 0x28, 0x46, 0x70, 0xbd],
      HOOK_AT,
    );
    if (options.hook === 'stub') {
      put(HOOK_CALLEE_AT, '7047'); /* bx lr: the harmless tail */
    } else {
      /* The real refresh: the measured prologue, then the struct literal at
       * callee + 0x18 that names WHICH struct it drives. */
      put(HOOK_CALLEE_AT, '054b1a8801321a809b78022b02d10520');
      put(HOOK_CALLEE_AT + 0x18, '28300010');
    }
  }
  if (options.keys != null) {
    put(0x2800, options.keys.block0);
    put(0x2810, options.keys.block1);
  }
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0x200, 0xa1b2c3d4, true);
  dv.setUint32(0x204, bytes.length, true);
  dv.setUint32(0x20c, options.version, true);
  dv.setUint32(REBALANCE_WORD_OFFSET, 0, true);
  /* Balance LAST, through a word far from every shape. */
  const scratch = 0x3ff0;
  dv.setUint32(scratch, 0, true);
  dv.setUint32(scratch, ((options.targetSum - wordSum(bytes)) | 0) >>> 0, true);
  expect(wordSum(bytes) >>> 0).toBe(options.targetSum >>> 0);
  return bytes;
}

const SYN_8HZ = (): Uint8Array =>
  syntheticImage({ version: VERSION_WORD_1308, targetSum: 0, ladder: true, widen2014: true });
const SYN_FF = (): Uint8Array =>
  syntheticImage({
    version: VERSION_WORD_1308,
    targetSum: 0xffff,
    ladder: true,
    widen2014: true,
    guard: true,
    keys: KEY_FF,
  });
const SYN_1030 = (): Uint8Array =>
  syntheticImage({
    version: VERSION_WORD_1030,
    targetSum: 0,
    ladder: true,
    widen2016: true,
    guard: true,
    hook: 'stub',
    keys: KEY_CP103,
  });
const SYN_1032 = (): Uint8Array =>
  syntheticImage({
    version: VERSION_WORD_1032,
    targetSum: 0,
    ladder: true,
    widen2016: true,
    guard: true,
    hook: 'real',
    keys: KEY_CP103,
  });

/* ==================================================================== *
 * detection: one profile per image, chosen by image properties
 * ==================================================================== */

describe('the build table — detection by image properties', () => {
  it('each synthetic build matches exactly its own profile', () => {
    expect(buildV1Patch(SYN_8HZ()).buildId).toBe('compact-1.3.0.8-8hz');
    expect(buildV1Patch(SYN_FF()).buildId).toBe('compact-1.3.0.8-ff');
    expect(buildV1Patch(SYN_1030()).buildId).toBe('compact-pro-1.0.3.0');
    expect(buildV1Patch(SYN_1032()).buildId).toBe('compact-pro-1.0.3.2-9hz');
  });

  it('1.3.0.8 and 1.3.0.8-FF carry the SAME version word and still get different builds', () => {
    const eightHz = buildV1Patch(SYN_8HZ());
    const ff = buildV1Patch(SYN_FF());
    expect(eightHz.buildId).not.toBe(ff.buildId);
    expect(eightHz.family).toBe('v1-2014');
    expect(ff.family).toBe('v1-2014-ff');
    expect(ff.route).toBe('recovery-only');
    expect(ff.stagedForm).toBe('xor-ks0-ksD');
    /* The discrimination is the properties, not the string. */
    expect(wordSum(SYN_FF()) >>> 0).toBe(0xffff);
    expect(wordSum(SYN_8HZ()) >>> 0).toBe(0);
  });

  it('the 8 Hz detect refuses the FF bytes (fed under the 8 Hz name, it does not build)', () => {
    const ff = SYN_FF();
    const eightHz = BUILD_PATCH_PROFILES.find((p) => p.buildId === 'compact-1.3.0.8-8hz');
    expect(eightHz, 'the 8 Hz profile is in the table').toBeDefined();
    expect(eightHz?.detect(ff) ?? false).toBe(false);
    /* ...and the legacy trio table refuses them too. */
    const legacy = BUILD_PATCH_PROFILES.find((p) => p.buildId === 'v1-2014');
    expect(legacy?.detect(ff) ?? false).toBe(false);
  });

  it('the arm-tail hook tells 1.0.3.0 from 1.0.3.2 — same key pair, different build', () => {
    const ten30 = buildV1Patch(SYN_1030());
    const ten32 = buildV1Patch(SYN_1032());
    expect(ten30.buildId).toBe('compact-pro-1.0.3.0');
    expect(ten30.sites.length).toBe(2); /* the stub hook needs no site */
    expect(ten32.buildId).toBe('compact-pro-1.0.3.2-9hz');
    expect(ten32.sites.length).toBe(3); /* the real hook gets its nop */
  });

  it('a 2018+ modern/nano image refuses, pointed at the standard dump workflow', () => {
    /* A 4.x image with none of the shapes: the modern generation needs no
     * widening patch, and the refusal says so instead of mumbling about
     * before-bytes. */
    const modern = syntheticImage({ version: 0x0701_0804, targetSum: 0, ladder: false });
    expect(() => buildV1Patch(modern)).toThrow(/standard dump workflow/);
    expect(() => buildV1Patch(modern)).toThrow(/63 of the 64 flash windows/);
  });

  it('a foreign image keeps the pinned refusal order: the word sum first', () => {
    /* The 3.bin shape: not any table build, unbalanced — the measured first
     * gate is the sum, not the shapes. */
    const foreign = syntheticImage({ version: 0xdeadbeef, targetSum: 0x9ad27d5f, ladder: false });
    expect(() => buildV1Patch(foreign)).toThrow(/word sum is not 0/);
    /* Balanced but shapeless: the legacy site gate, with the guidance. */
    const balanced = syntheticImage({ version: 0xdeadbeef, targetSum: 0, ladder: false });
    expect(() => buildV1Patch(balanced)).toThrow(/does not carry the v1 2014 update machinery/);
  });

  it('guard + widen + FF keys + the 0xFFFF sum is the FF build and nothing else', () => {
    /* A synthetic chimera that could plausibly straddle profiles: the 8 Hz
     * detect rejects it on the sum, the legacy table on its trio, the 2016
     * family on its shapes and keys. */
    const both = syntheticImage({
      version: VERSION_WORD_1308,
      targetSum: 0xffff,
      ladder: true,
      widen2014: true,
      guard: true,
      keys: KEY_FF,
    });
    expect(buildV1Patch(both).buildId).toBe('compact-1.3.0.8-ff');
  });

  it('every site is before-byte gated at its located offset', () => {
    /* Flip one byte, then re-balance through the scratch word back to the
     * image's original sum so ONLY the site gate can fire (the sum gate
     * predates it, and the FF sentinel is a sum too). */
    const flip = (img: Uint8Array, off: number): Uint8Array => {
      const wanted = wordSum(img) >>> 0;
      const out = new Uint8Array(img);
      out[off] = (out[off] ?? 0) ^ 0xff;
      const dv = new DataView(out.buffer);
      const scratch = 0x3ff0;
      dv.setUint32(scratch, 0, true);
      dv.setUint32(scratch, ((wanted - wordSum(out)) | 0) >>> 0, true);
      expect(wordSum(out) >>> 0).toBe(wanted);
      return out;
    };
    /* The guard's `06 d1`, precisely. */
    expect(() => buildV1Patch(flip(SYN_FF(), GUARD_D1_AT))).toThrow(SeekError);
    /* The widen byte of the 8 Hz build: the 8 Hz detect fails, nothing else
     * matches, and the fallback fires the legacy site message (with the
     * guidance appended). */
    expect(() => buildV1Patch(flip(SYN_8HZ(), WIDEN_2014_AT + 3))).toThrow(
      /does not carry the v1 2014 update machinery/,
    );
    /* The hook call's before-bytes are read from the image the shape located
     * (a BL encoding moves with its call site), so the hook's gate IS the
     * detection: corrupting the struct literal the callee reads stops the
     * 1.0.3.2 profile from matching — and the image then builds as the
     * harmless-tail 1.0.3.0 shape, with two sites. */
    const wrongStruct = flip(SYN_1032(), HOOK_CALLEE_AT + 0x18);
    const as1030 = buildV1Patch(wrongStruct);
    expect(as1030.buildId).toBe('compact-pro-1.0.3.0');
    expect(as1030.sites.length).toBe(2);
  });

  it('the hook detector reads the callee the BL names, not a fixed address', () => {
    const profile = BUILD_PATCH_PROFILES.find((p) => p.buildId === 'compact-pro-1.0.3.2-9hz');
    expect(profile?.detect(SYN_1032()) ?? false).toBe(true);
    /* The same shapes with a stub callee fall to the 1.0.3.0 profile. */
    expect(buildV1Patch(SYN_1030()).buildId).toBe('compact-pro-1.0.3.0');
  });
});

/* ==================================================================== *
 * the staged forms: the two new keystream algebras (synthetic)
 * ==================================================================== */

describe('the cipher families — staged forms and what the commit turns them into', () => {
  it('xor-ks0: staged = patched ^ ks0; the app transform reproduces the slot bytes', () => {
    const patch = buildV1Patch(SYN_1030());
    const plain = patch.factory;
    const ks0 = keystream(keyWordsOf(KEY_CP103.block0), plain.length >> 2);
    const ks1 = keystream(keyWordsOf(KEY_CP103.block1), plain.length >> 2);
    expect(patch.stagedForm).toBe('xor-ks0');
    expect(wordSum(patch.patched)).toBe(0); /* the 2016 acceptance: DECRYPTED sum 0 */

    /* The staged wire-80 payload of a commit. */
    const staged = stagedFormOf(patch, patch.patched);
    expect(staged).toStrictEqual(xorWindowVerbatim(patch.patched, ks0));
    /* Header words 128..143 pass verbatim; the rest is really encrypted. */
    for (let i = 0x200; i < 0x240; i++) expect(staged[i]).toBe(patch.patched[i]);
    let encrypted = 0;
    for (let i = 0x240; i < staged.length; i++) if (staged[i] !== patch.patched[i]) encrypted++;
    expect(encrypted).toBeGreaterThan(0x100);

    /* The commit's own two-stream transform: staged ^ ks0 ^ ks1 == the slot
     * bytes of the patched image — exactly what conjugating the capture
     * predicts, which is what the pre-check compares against. */
    const capture = xorWindowVerbatim(plain, ks1); /* the bank as stored */
    const slotAfterCommit = xorWindowVerbatim(xorWindowVerbatim(staged, ks0), ks1);
    expect(slotAfterCommit).toStrictEqual(conjugateCapture(capture, patch));

    /* The restore payload is the FACTORY image in staged form, and its
     * transform reproduces the original capture — the round trip that makes
     * the restore step correct on a cipher family. */
    const restore = stagedFormOf(patch, plain);
    expect(xorWindowVerbatim(xorWindowVerbatim(restore, ks0), ks1)).toStrictEqual(capture);
  });

  it('xor-ks0-ksD: the double accept collapses to sum(staged ^ ks0) == 0xFFFF', () => {
    const patch = buildV1Patch(SYN_FF());
    const plain = patch.factory;
    const ks0 = keystream(keyWordsOf(KEY_FF.block0), plain.length >> 2);
    const ksD = keystream(keyWordsOf(KEY_FF.block1), plain.length >> 2);
    expect(patch.stagedForm).toBe('xor-ks0-ksD');
    expect(patch.acceptanceSum).toBe(0xffff);

    const staged = stagedFormOf(patch, patch.patched);
    /* THE identity, end to end: staged ^ ks0 reads the 0xFFFF acceptance... */
    expect(stagedAcceptanceSum(patch, staged)).toBe(0xffff);
    /* ...and the commit's two-stream transform lands the PLAINTEXT in the
     * slot (the 2014 donor's banks are plaintext, and recovery is unchecked). */
    const slot = xorWindowVerbatim(xorWindowVerbatim(staged, ks0), ksD);
    expect(bytesEqual(slot, patch.patched)).toBe(true);
    /* The header window rode through both keystreams verbatim. */
    for (let i = 0x200; i < 0x240; i++) expect(slot[i]).toBe(patch.patched[i]);

    /* The rebalance word is NOT a raw-sum rebalance: the patched raw sum is
     * neither 0 nor 0xFFFF — the free header word is spent on the accept. */
    expect(patch.rebalanceWord).not.toBe(0);
    expect(patch.patchedWordSum >>> 0).not.toBe(0);
    expect(patch.patchedWordSum >>> 0).not.toBe(0xffff);
  });

  it('the FF rebalance is the exact solve of the acceptance: nudge it and it breaks', () => {
    const patch = buildV1Patch(SYN_FF());
    expect(stagedAcceptanceSum(patch, stagedFormOf(patch, patch.patched))).toBe(0xffff);
    for (const delta of [1, -1, 0x100, 0x12345678]) {
      const nudged = new Uint8Array(patch.patched);
      const dv = new DataView(nudged.buffer);
      dv.setUint32(REBALANCE_WORD_OFFSET, (patch.rebalanceWord + delta) >>> 0, true);
      const probe = { ...patch, patched: nudged };
      expect(stagedAcceptanceSum(probe, stagedFormOf(probe, nudged))).not.toBe(0xffff);
    }
  });
});

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* ==================================================================== *
 * the gates: capability table and commit route
 * ==================================================================== */

function handState(fields: {
  buildFamily: PreserveFamilyId;
  buildId?: string;
  stagedForm?: StagedFormId;
  restoreForm?: RestoreFormId;
  route?: CommitRouteId;
  routeNote?: string | null;
  capability?: DrainCapability;
  detection: NonNullable<PreserveRunState['detection']>;
}): PreserveRunState {
  return {
    version: 1,
    runId: 'families',
    imageSha256: 'ab',
    expectedVersion: '1.3.0.8',
    createdAt: '2026-10-01T00:00:00Z',
    nextStep: 'commit',
    steps: {
      backup: { status: 'done', notes: 'backup done' },
      patch: { status: 'done', notes: 'patch done' },
      /* The ordering gates sit in front of the capability/route checks; a
       * state past the commit is the one that reaches them. */
      commit: { status: 'done', notes: 'commit done' },
    },
    patch: {
      sites: [],
      rebalanceWord: 0x3000,
      stagedLength: 0x4000,
      chunkCount: 256,
      patchedSha256: 'ab',
    },
    ...fields,
  };
}

const DETECTED_A: NonNullable<PreserveRunState['detection']> = {
  cfgHex: '00000000',
  cfg0: 0,
  blank: true,
  bank: 'a',
  bankAddress: 0x14050000,
  bankMode: 7,
  verdict: 'blank -> bank A',
};

const neverLoader = (): Promise<Uint8Array | null> => Promise.resolve(null);

describe('the capability table and the commit route, in the gates', () => {
  it('a build with no whole-part drain refuses the DRAIN step with the documented reason', async () => {
    const note =
      'no whole-part single-arm drain exists on this build: 128 B is the lossless read ' +
      'unit (larger asks silently lose bytes), the EP0 sessions die at ~64-81 KB and the ' +
      'upgrade descriptors reset on re-enumeration, and the widened reach is proven ' +
      'byte-exact only to 0x13c00. This run supports backup, patch, commit, restore ' +
      'and verify — the whole-part dump is not one of them (doc 1032 sec. 5).';
    const state = handState({
      buildFamily: 'compact-2016',
      buildId: 'compact-pro-1.0.3.2-9hz',
      capability: { wholePart: false, losslessReadUnit: 128, maxPerArmReach: 0x13c00, note },
      detection: DETECTED_A,
    });
    const refusal = await describeStepGate('drain', state, neverLoader);
    expect(refusal).toMatch(/no whole-part single-arm drain exists on this build/);
    expect(refusal).toMatch(/128 B is the lossless read unit/);
    expect(refusal).toMatch(/EP0 sessions die at ~64-81 KB/);
    /* Every other step keeps its ordinary refusal, not this one. */
    for (const step of ['commit', 'restore'] as const) {
      const other = await describeStepGate(step, state, neverLoader);
      expect(other ?? '').not.toMatch(/whole-part/);
    }
  });

  it('a recovery-only route refuses A/B, and stays silent when recovery is detected', async () => {
    const onBankA = handState({
      buildFamily: 'v1-2014-ff',
      buildId: 'compact-1.3.0.8-ff',
      route: 'recovery-only',
      routeNote: 'the 2014 bootloader rejects the 0xFFFF sum at slots A/B',
      detection: DETECTED_A,
    });
    /* The commit gate's own "already done" check sits in front of the route
     * check, so the commit case runs on the pre-commit state. */
    const pendingCommit: PreserveRunState = JSON.parse(JSON.stringify(onBankA)) as PreserveRunState;
    delete pendingCommit.steps.commit;
    expect(await describeStepGate('commit', pendingCommit, neverLoader)).toMatch(
      /RECOVERY slot only \(mode 9\)/,
    );
    expect(await describeStepGate('commit', pendingCommit, neverLoader)).toMatch(/named bank a/);
    for (const step of ['drain', 'restore'] as const) {
      const refusal = await describeStepGate(step, onBankA, neverLoader);
      expect(refusal).toMatch(/RECOVERY slot only \(mode 9\)/);
      expect(refusal).toMatch(/named bank a/);
    }
    /* The same run against a cfg that selects recovery: no route refusal (any
     * remaining refusal is an ordinary prerequisite one). */
    const onRecovery: PreserveRunState = {
      ...onBankA,
      detection: {
        ...DETECTED_A,
        blank: false,
        cfg0: 2,
        bank: 'r',
        bankAddress: 0x14070000,
        bankMode: 9,
      },
    };
    const recoveryPending: PreserveRunState = JSON.parse(
      JSON.stringify(onRecovery),
    ) as PreserveRunState;
    delete recoveryPending.steps.commit;
    expect((await describeStepGate('commit', recoveryPending, neverLoader)) ?? '').not.toMatch(
      /RECOVERY slot only/,
    );
    for (const step of ['drain', 'restore'] as const) {
      const refusal = await describeStepGate(step, onRecovery, neverLoader);
      expect(refusal ?? '').not.toMatch(/RECOVERY slot only/);
    }
  });

  it('the FF build restoreForm is none: the gate refuses with the measured constant', async () => {
    /* The measured fact behind the refusal, from the corpus image when it is
     * here: accept1 on the factory two-stream staged form is 0xB7AB9D17, not
     * the 0xFFFF the app demands. */
    const ffImage = CORPUS_IMAGES['compact-1.3.0.8-ff'];
    if (ffImage !== null) {
      const patch = buildV1Patch(readImage(ffImage));
      expect(patch.restoreForm).toBe('none');
      const ksD = keystream(keyWordsOf(patch.keys?.block1Hex ?? ''), patch.factory.length >> 2);
      const accept1 = wordSum(xorWindowVerbatim(patch.factory, ksD) /* header at face value */);
      expect(accept1).toBe(0xb7ab9d17);
      expect(accept1).not.toBe(0xffff);
    }
    const state = handState({
      buildFamily: 'v1-2014-ff',
      buildId: 'compact-1.3.0.8-ff',
      restoreForm: 'none',
      detection: {
        ...DETECTED_A,
        blank: false,
        cfg0: 2,
        bank: 'r',
        bankAddress: 0x14070000,
        bankMode: 9,
      },
    });
    const refusal = await describeStepGate('restore', state, neverLoader);
    expect(refusal).toMatch(/the restore step refuses on compact-1\.3\.0\.8-ff/);
    expect(refusal).toMatch(/0xB7AB9D17/);
  });

  it('a cipher-family restore needs the factory plaintext; a plain-family restore does not', async () => {
    const cipher = handState({
      buildFamily: 'compact-2016',
      buildId: 'compact-pro-1.0.3.0',
      stagedForm: 'xor-ks0',
      detection: DETECTED_A,
    });
    const refusal = await describeStepGate('restore', cipher, neverLoader);
    expect(refusal).toMatch(/staged form \(xor-ks0\)[\s\S]*factory plaintext/);

    const plainOnly = handState({
      buildFamily: 'v1-2014',
      stagedForm: 'plain',
      detection: DETECTED_A,
    });
    const plainRefusal = await describeStepGate('restore', plainOnly, neverLoader);
    expect(plainRefusal ?? '').not.toMatch(/factory plaintext/);
  });
});

/* ==================================================================== *
 * the real builds (corpus-gated): every derived value pinned to its doc
 * ==================================================================== */

describe('the build table — the five real builds, pinned to the RE records', () => {
  it.skipIf(CORPUS_MISSING.length > 0)(
    'every corpus image is present and sha-identical to its RE record',
    () => {
      expect(CORPUS_MISSING).toEqual([]);
      const shas: Record<string, string> = {
        'compact-1.3.0.8-8hz': '2969d0df5bfeac74b88e6ee608ee8b2657fecf2e0234e9ce2731add2408f3d1c',
        'compact-1.3.0.8-ff': 'b97ced91fff9f0949a02f35fceab697634cc109a0fe2a2fbbfe6ccfadb7d4d16',
        'compact-pro-1.0.3.0': '5e1f3f24c8bc1e85bcb67e73e0ee23f301864ee7839a48135598fca961373e26',
        'compact-pro-1.0.3.2-9hz':
          'c776924773ed42468957de742284636461e9dafef8d4ab431f5627795b5cfa0c',
        'compact-pro-1.0.3.2-18hzff':
          '196560c05096369165c8858f6a3f66239b6651ad73ff84f26a3fccdcf8c193d3',
      };
      for (const [id, file] of Object.entries(CORPUS_IMAGES)) {
        expect(sha256(readImage(file ?? null)), id).toBe(shas[id] ?? '(no pin)');
      }
    },
  );

  it.skipIf(CORPUS_IMAGES['compact-1.3.0.8-8hz'] === null)(
    '1.3.0.8 8 Hz: ONE site, word 142 := 0x3000, two bytes move, staged == patched',
    () => {
      const patch = buildV1Patch(readImage(CORPUS_IMAGES['compact-1.3.0.8-8hz'] ?? null));
      expect(patch.buildId).toBe('compact-1.3.0.8-8hz');
      expect(patch.sites.length).toBe(1);
      expect(patch.sites[0]?.offset).toBe(0x3cba);
      expect(patch.rebalanceWord).toBe(0x3000);
      expect([...patch.diffOffsets]).toEqual([0x239, 0x3cbd]);
      /* Staged = plain bytes: the stored bank IS the image. */
      expect(patch.stagedForm).toBe('plain');
      const staged = stagedFormOf(patch, patch.patched);
      expect(staged.length).toBe(49128);
      expect(sum16(staged)).toBe(0x5a21);
      expect(sha256(staged)).toBe(
        '2a1814eed01ef861ca3a260e84e479c06c6fa19e29361b2bf9c01825cd4fc7d2',
      );
      expect(patch.capability.wholePart).toBe(true);
      expect(patch.route).toBe('active-bank');
    },
  );

  it.skipIf(CORPUS_IMAGES['compact-1.3.0.8-ff'] === null)(
    '1.3.0.8-FF: guard + widen, word 142 := 0x485523E8, six bytes, staged sha b31c19aa…',
    () => {
      const image = readImage(CORPUS_IMAGES['compact-1.3.0.8-ff'] ?? null);
      const patch = buildV1Patch(image);
      expect(patch.buildId).toBe('compact-1.3.0.8-ff');
      expect(patch.sites.length).toBe(2);
      expect(patch.sites[0]?.offset).toBe(0x3d68);
      expect(patch.sites[1]?.offset).toBe(0x3e6e);
      expect(patch.rebalanceWord).toBe(0x485523e8);
      expect([...patch.diffOffsets]).toEqual([0x238, 0x239, 0x23a, 0x23b, 0x3d69, 0x3e71]);
      expect(patch.patchedWordSum >>> 0).toBe(0x485602e7);
      /* The keys, located BY VALUE where the doc found them. */
      expect(patch.keys?.block0Hex).toBe(KEY_FF.block0);
      expect(patch.keys?.block1Hex).toBe(KEY_FF.block1);
      expect(occurrencesOf(image, KEY_FF.block0)).toEqual([0xb484]);
      expect(occurrencesOf(image, KEY_FF.block1)).toEqual([0xb494]);
      expect(patch.route).toBe('recovery-only');
      expect(patch.capability.wholePart).toBe(true);
      /* The staged form and its pinned transfer checksum. */
      const staged = stagedFormOf(patch, patch.patched);
      expect(staged.length).toBe(49308);
      expect(Math.ceil(staged.length / 64)).toBe(771);
      expect(sum16(staged)).toBe(0x9f58);
      expect(sha256(staged)).toBe(
        'b31c19aa8b8b02d83ecf9943856607d2958972b95f56a43af9b0c77f8338d7b6',
      );
      expect(sha256(patch.patched)).toBe(
        '52ed5611ed43dc72ff6abbd599acb9f21e4a81c39a497b443fe3f6e3a32209c7',
      );
      expect(stagedAcceptanceSum(patch, staged)).toBe(0xffff);
    },
  );

  it.skipIf(CORPUS_IMAGES['compact-pro-1.0.3.0'] === null)(
    '1.0.3.0: guard + widen, word 142 := 0xF1003000, the four-byte doc-33 diff',
    () => {
      const patch = buildV1Patch(readImage(CORPUS_IMAGES['compact-pro-1.0.3.0'] ?? null));
      expect(patch.buildId).toBe('compact-pro-1.0.3.0');
      expect(patch.sites.length).toBe(2); /* the hook is a bx lr stub here */
      expect(patch.sites[0]?.offset).toBe(0x352e);
      expect(patch.sites[1]?.offset).toBe(0x3636);
      expect(patch.rebalanceWord).toBe(0xf1003000);
      expect([...patch.diffOffsets]).toEqual([0x239, 0x23b, 0x352f, 0x3639]);
      expect(patch.stagedForm).toBe('xor-ks0');
      expect(patch.capability.wholePart).toBe(true);
      expect(patch.route).toBe('active-bank');
    },
  );

  for (const [id, reach, keyPair] of [
    ['compact-pro-1.0.3.2-9hz', 0x13c00, KEY_CP103],
    ['compact-pro-1.0.3.2-18hzff', 0x17500, KEY_CP1032FF],
  ] as const) {
    it.skipIf(CORPUS_IMAGES[id] === null)(
      `${id}: three sites, word 142 := 0x29FD6B0F, drain capability wholePart=false`,
      () => {
        const patch = buildV1Patch(readImage(CORPUS_IMAGES[id] ?? null));
        expect(patch.buildId).toBe(id);
        expect(patch.sites.length).toBe(3);
        expect(patch.sites[0]?.offset).toBe(0x3596);
        expect(patch.sites[1]?.offset).toBe(0x369e);
        expect(patch.sites[2]?.offset).toBe(0x36b6);
        expect([...(patch.sites[2]?.after ?? [])]).toEqual([0x00, 0xbf, 0x00, 0xbf]);
        expect(patch.rebalanceWord).toBe(0x29fd6b0f);
        expect([...patch.diffOffsets]).toEqual([
          0x238, 0x239, 0x23a, 0x23b, 0x3597, 0x36a1, 0x36b6, 0x36b7, 0x36b8, 0x36b9,
        ]);
        expect(patch.keys?.block0Hex).toBe(keyPair.block0);
        expect(patch.keys?.block1Hex).toBe(keyPair.block1);
        /* THE HARD LIMITS, encoded where the drain gate reads them. */
        expect(patch.capability.wholePart).toBe(false);
        expect(patch.capability.losslessReadUnit).toBe(128);
        expect(patch.capability.maxPerArmReach).toBe(reach);
      },
    );
  }

  it.skipIf(
    CORPUS_IMAGES['compact-1.3.0.8-8hz'] === null || CORPUS_IMAGES['compact-1.3.0.8-ff'] === null,
  )('the same version string, two different builds — and neither builds the other', () => {
    const eightHz = buildV1Patch(readImage(CORPUS_IMAGES['compact-1.3.0.8-8hz'] ?? null));
    const ff = buildV1Patch(readImage(CORPUS_IMAGES['compact-1.3.0.8-ff'] ?? null));
    /* Both images report 1.3.0.8 on the wire; the patch table told them apart
     * by the 0xFFFF sentinel and the key blocks, never the string. */
    expect(eightHz.buildId).toBe('compact-1.3.0.8-8hz');
    expect(ff.buildId).toBe('compact-1.3.0.8-ff');
    expect(ff.family).toBe('v1-2014-ff');
    /* The FF bytes can never build the 8 Hz patch: that one's staged form is
     * plain and its route the active bank — the opposite of what FF needs. */
    const eightHzProfile: BuildPatchProfile | undefined = BUILD_PATCH_PROFILES.find(
      (p) => p.buildId === 'compact-1.3.0.8-8hz',
    );
    expect(
      eightHzProfile?.detect(readImage(CORPUS_IMAGES['compact-1.3.0.8-ff'] ?? null)) ?? false,
    ).toBe(false);
  });
});

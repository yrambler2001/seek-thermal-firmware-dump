/**
 * The preservation pipeline's plaintext and ciphertext math, for every build
 * whose widening patch is derived and proven.
 *
 * Ported from FW-V1 `ht-201/forge_v1_patch.py` (doc 34) and reduced to what the
 * in-place route needs, then extended to the newly derived families (FW-V1
 * docs 35 — the two 1.3.0.8 builds — and the 1.0.3.x packaging doc,
 * `V1_WIDENING_1032`). Everything here is pure: bytes in, bytes out, no
 * transport, no I/O — so the whole file is unit-testable without a camera.
 *
 * ---- The two domains, and the trap that costs a camera ---------------------
 *
 * A slot on the part does not hold the firmware image; it holds the image XOR
 * a keystream (the bootloader's at-rest cipher) — or, on the 2014 builds, the
 * image itself (no cipher). The wire-79 reader serves the SLOT BYTES. But the
 * patch is a change to the PLAINTEXT (the reader-cursor widening and the
 * checksum rebalance are code edits in the image). Writing the new plaintext
 * bytes into a ciphertext capture corrupts the slot: the first wire run of the
 * FW-V1 chain did exactly that and the part came back with garbage code bytes
 * that stalled every vendor wire.
 *
 * The fix is one line of algebra: the wire payload is the capture with
 *
 *     wire[off] := wire[off] XOR old_plain[off] XOR new_plain[off]
 *
 * per patched byte — the keystream cancels, because it is the same on both
 * sides. `conjugateCapture` below is that line. On the plaintext 2014 banks
 * the conjugation is its own identity (the staged payload IS the patched
 * plaintext); on the cipher families the wire-80 bytes are the STAGED form
 * derived from the patched plaintext and the build's key blocks
 * (`stagedFormOf`), because the commit's own two-stream transform — not the
 * host — produces the slot bytes.
 *
 * ---- The build table -------------------------------------------------------
 *
 * `BUILD_PATCH_PROFILES` is one entry per build whose patch is derived. Each
 * entry carries a `detect` hook (image properties only — shapes, key-block
 * values, the FF word-sum sentinel — never the version string alone: 1.3.0.8
 * and 1.3.0.8-FF report the same version), a shape-locating `locate` for its
 * sites, its staged form, its acceptance rule, its commit route and its
 * measured drain capability. `buildV1Patch` dispatches over the table; the
 * four-site 2014 table keeps its exact gates (and its pinned refusal order
 * for a foreign image).
 *
 * NEVER SHIP A HAND-ASSEMBLED PATCH: every site carries its `before` bytes and
 * the builder refuses to run if the factory plaintext does not match them, at
 * the offset the SHAPE search found. The Thumb lesson (doc 34 sec. 34.7) is
 * that LDRH's immediate scales by 2 and LDR's by 4 — three wrong encodings of
 * one edit were measured on the wire before the disassembler-backed builder
 * landed.
 */

import { bytesToHex, findAll, hexToBytes, hexUp, viewOf } from '../bytes.js';
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

/* ==================================================================== *
 * the build table — families, site shapes, capabilities
 * ==================================================================== */

/** The three cipher/acceptance families the pipeline can drive. */
export type PreserveFamilyId = 'v1-2014' | 'v1-2014-ff' | 'compact-2016';

/** How the wire-80 staged bytes relate to the patched plaintext. */
export type StagedFormId = 'plain' | 'xor-ks0' | 'xor-ks0-ksD';

/** How (and whether) the RESTORE step can put the original bank back through
 *  the running app's own commit path.
 *
 *  - 'capture-verbatim': the 2014 plaintext chain — the capture IS the image,
 *    its stored word sum is 0, and the commit programs it as staged.
 *  - 'factory-staged': the 2016 cipher chain — the factory image ^ ks0
 *    satisfies the decrypted-sum-0 acceptance, and the commit's two-stream
 *    transform reproduces the original slot bytes.
 *  - 'none': NO staged form of the factory image passes the running app's
 *    acceptance while transforming back to the original slot bytes — the FF
 *    build: accept1 reads sum(P ^ ksD) and the factory carries 0xB7AB9D17
 *    there, not 0xFFFF (measured on the image), so the only payloads the app
 *    accepts land DIFFERENT bytes than the backup holds. The run ends with
 *    the delivered dump in hand and the patch in place. */
export type RestoreFormId = 'capture-verbatim' | 'factory-staged' | 'none';

/** Which bank the patch may be committed into. */
export type CommitRouteId = 'active-bank' | 'recovery-only';

/**
 * What the DRAIN step may promise on this build, as measured — never more.
 * `wholePart` false means the whole-part single-arm drain DOES NOT EXIST on
 * the build and the drain gate refuses; `losslessReadUnit` is the largest
 * wire-79 ask that does not silently lose bytes on it.
 */
export interface DrainCapability {
  readonly wholePart: boolean;
  readonly losslessReadUnit: number;
  /** The reach the widened window is proven byte-exact to, when it is bounded. */
  readonly maxPerArmReach?: number;
  readonly note: string;
}

/** The build's cipher key blocks, located BY VALUE (each occurs exactly once). */
export interface LocatedKeys {
  /** Key block 0 — seeds the wire-80 staged form (and the FF accept sum). */
  readonly block0Hex: string;
  /** Key block 1 — the at-rest slot seed; null on the plaintext families. */
  readonly block1Hex: string | null;
}

/** The four u32s a key block's hex seeds the xorshift128 with. */
export function keyWordsOf(keyHex: string): [number, number, number, number] {
  const raw = hexToBytes(keyHex);
  if (raw.length !== 16) {
    throw new SeekError('pipeline/refused', `a key block is 16 bytes, got ${String(raw.length)}`);
  }
  const dv = viewOf(raw);
  return [
    dv.getUint32(0, true),
    dv.getUint32(4, true),
    dv.getUint32(8, true),
    dv.getUint32(12, true),
  ];
}

/* ---- the shape needles -----------------------------------------------------
 *
 * Offsets move between builds (the guard sat at 0x352E in 1.0.3.0 and 0x3596
 * in 1.0.3.2); the bytes around them do not. Every site is FOUND by its shape
 * inside the update machinery — the function whose literal pool carries the
 * window ladder — and then gated on its before-bytes at the found offset.
 */

/** `14060000 14050000 14020000 14000000` — the head of the mode->window pool
 *  ladder every build here carries in BeginFirmwareUpgrade's literal pool.
 *  Exported for the cipher solvers (`solve.ts`), whose post-decrypt structural
 *  gates read the same RE-recorded shapes — one copy, so they cannot drift. */
export const NEEDLE_LADDER = '00000614000005140000021400000014';
/** The 2014-chain widen tail: `mov.w r3,#0x10000` feeding the d4 (+4) and
 *  dc (+12) stores (1.3.0.8, both variants). */
export const NEEDLE_WIDEN_2014 = '4ff480336360e360';
/** The 2016-chain widen tail: `str r3,[r4,#20]` / `mov.w r3,#0x10000` /
 *  `str r3,[r4,#8]` (d4) / `str r3,[r4,#16]` (dc) — also the 1.3.0.0
 *  generation's tail. */
export const NEEDLE_WIDEN_2016 = '63614ff48033a3602361';
/** The mode-2 guard: `cmp r3,#2` / `bne.n +6` / `movs r0,#4` (the refusal's
 *  first move). The patched byte is the `06 d1` at shape + 2. */
export const NEEDLE_GUARD = '022b06d10420';
/** The wire-82 token form's 16-byte constant — the ONE constant across the
 *  whole line (doc 33 sec. 11; doc 1032 sec. 3), carried by every build the
 *  table and the solvers name. */
export const NEEDLE_TOKEN_82 = '5316103180dd00b74af9e417c594bed4';
/** How far before the window ladder the Begin bodies sit (measured spans:
 *  guard->ladder 0x154, widen->ladder 0x4A..0x4C). */
export const CODE_WINDOW_BEFORE_LADDER = 0x800;
/** The Begin arm-tail ending: `mov r0,r5` / `pop {r4,r5,r6,pc}` — the return
 *  pair the tail's refresh call precedes. (The call's own bytes move with its
 *  call site, so the SHAPE is the tail; `tailHookCall` reads the BL before it
 *  and the callee it names.) */
const NEEDLE_TAIL = '284670bd';
/** `bx lr` — the stub callee that makes a tail hook harmless. */
const NEEDLE_BX_LR = '7047';

/** The FSM/op-mode struct 0x10003028: the one the 1.0.3.2 arm-tail refresh
 *  drives, whose state-2 dispatch wedges an accepting arm. */
const HOOK_WEDGE_STRUCT = 0x10003028;

function occurrences(plain: Uint8Array, hexNeedle: string, from = 0, to = plain.length): number[] {
  const needle = hexToBytes(hexNeedle);
  const hits: number[] = [];
  for (const at of findAll(plain, needle)) {
    if (at >= from && at + needle.length <= to) hits.push(at);
  }
  return hits;
}

function oneIn(
  plain: Uint8Array,
  hexNeedle: string,
  what: string,
  from = 0,
  to = plain.length,
): number {
  const hits = occurrences(plain, hexNeedle, from, to);
  const at = hits.at(0);
  if (hits.length !== 1 || at === undefined) {
    throw new SeekError(
      'pipeline/refused',
      `expected exactly one ${what} in this image and found ${String(hits.length)}`,
    );
  }
  return at;
}

/** The window ladder's offset, or null when this image carries none — the
 *  non-throwing form the detect hooks use. */
function findLadder(plain: Uint8Array): number | null {
  const hits = occurrences(plain, NEEDLE_LADDER);
  return hits.length === 1 ? (hits.at(0) ?? null) : null;
}

/** The window ladder's offset — the shape anchor for everything else. */
function ladderOffset(plain: Uint8Array): number {
  return oneIn(
    plain,
    NEEDLE_LADDER,
    'window-pool ladder head (14060000/14050000/14020000/14000000)',
  );
}

/** The guard site when this build carries one, at the found offset. */
function guardSite(plain: Uint8Array, ladder: number): PatchSite {
  const at = oneIn(
    plain,
    NEEDLE_GUARD,
    'mode-2 guard (cmp r3,#2 / bne.n +6 / movs r0,#4)',
    Math.max(0, ladder - CODE_WINDOW_BEFORE_LADDER),
    ladder,
  );
  return {
    offset: at + 2,
    before: [0x06, 0xd1],
    after: [0x06, 0xe0],
    what:
      'mode-2 guard: bne.n -> b.n at the cmp r3,#2 — mode 2 falls through to the ' +
      'normal validation and arms case 2 like any other mode',
  };
}

/** The 1.3.0.8-generation widen site, at the found offset. */
function widen2014Site(plain: Uint8Array, ladder: number): PatchSite {
  const at = oneIn(
    plain,
    NEEDLE_WIDEN_2014,
    'widen tail (mov.w r3,#0x10000; str [r4,#4]; str [r4,#12])',
    Math.max(0, ladder - CODE_WINDOW_BEFORE_LADDER),
    ladder,
  );
  return {
    offset: at,
    before: [0x4f, 0xf4, 0x80, 0x33],
    after: [0x4f, 0xf4, 0x80, 0x03],
    what:
      'widen: mov.w r3,#0x10000 -> #0x400000 — one constant feeds the d4 AND dc ' +
      'window-length stores, the wire-79 window becomes [0x14000000, 0x14400000)',
  };
}

/** The 2016-generation widen site, at the found offset. */
function widen2016Site(plain: Uint8Array, ladder: number): PatchSite {
  const at = oneIn(
    plain,
    NEEDLE_WIDEN_2016,
    'widen tail (str [r4,#20]; mov.w r3,#0x10000; str [r4,#8]; str [r4,#16])',
    Math.max(0, ladder - CODE_WINDOW_BEFORE_LADDER),
    ladder,
  );
  return {
    offset: at + 2,
    before: [0x4f, 0xf4, 0x80, 0x33],
    after: [0x4f, 0xf4, 0x80, 0x03],
    what:
      'widen: mov.w r3,#0x10000 -> #0x400000 — one constant feeds the d4 AND dc ' +
      'window-length stores, the wire-79 window becomes [0x14000000, 0x14400000)',
  };
}

/** Decodes the Thumb-2 BL at `off` to its target VMA, or null when the four
 *  bytes are not a BL pair. The payload VMA base applies — every call target
 *  here lives in that space. */
function blTargetVma(plain: Uint8Array, off: number): number | null {
  const hi = (plain[off] ?? 0) | ((plain[off + 1] ?? 0) << 8);
  const lo = (plain[off + 2] ?? 0) | ((plain[off + 3] ?? 0) << 8);
  if ((hi & 0xf800) !== 0xf000 || (lo & 0xd000) !== 0xd000) return null;
  const s = (hi >>> 10) & 1;
  const imm10 = hi & 0x3ff;
  const j1 = (lo >>> 13) & 1;
  const j2 = (lo >>> 11) & 1;
  const imm11 = lo & 0x7ff;
  const i1 = ~(j1 ^ s) & 1;
  const i2 = ~(j2 ^ s) & 1;
  let imm = ((s << 24) | (i1 << 23) | (i2 << 22) | (imm10 << 12) | (imm11 << 1)) >>> 0;
  if (s === 1) imm = imm - 0x2000000; /* sign-extend: bit 24 is the sign of the 25-bit field */
  return (V1_PAYLOAD_VMA_BASE + off + 4 + imm) >>> 0;
}

/**
 * The arm-tail hook call, when the build carries the WEDGING one: the Begin
 * tail `bl <refresh>; mov r0,r5; pop` whose callee drives the FSM/op-mode
 * struct 0x10003028 (the refresh an accepting arm fires, wedging the vendor
 * surface). Returns the call's offset, or null when this build's tail either
 * has no such call, calls a `bx lr` stub (the harmless tail), or calls a
 * refresh wired to a DIFFERENT struct — which is what 1.0.3.0 does: its
 * identical-looking callee reads 0x10003128 and never dispatches the mode
 * rebuild, so its arm completes and the hook needs no neutralizing.
 */
function tailHookCall(plain: Uint8Array, ladder: number): number | null {
  for (const at of inBeginWindow(plain, NEEDLE_TAIL, ladder)) {
    const call = at - 4;
    if (call < 0) continue;
    const calleeVma = blTargetVma(plain, call);
    if (calleeVma === null) continue;
    const callee = calleeVma - V1_PAYLOAD_VMA_BASE;
    if (callee < 0 || callee + 0x20 > plain.length) continue;
    /* A `bx lr` stub callee: the harmless tail (and the shape doc 1032's
     * Site C names for 1.0.3.0's sibling address). */
    if (occurrences(plain, NEEDLE_BX_LR, callee, callee + 2).length === 1) return null;
    /* The refresh function's `ldr r3,=struct` literal sits at callee + 0x18
     * (both measured callees: same prologue, 4-byte aligned, pc + 20). */
    const literal = viewOf(plain).getUint32(callee + 0x18, true);
    return literal === HOOK_WEDGE_STRUCT ? call : null;
  }
  return null;
}

/** Whether the build needs the hook neutralized (the 1.0.3.2 wedge). */
function tailHookApplies(plain: Uint8Array, ladder: number): boolean {
  return tailHookCall(plain, ladder) !== null;
}

/** The hook site, when the build needs it neutralized (1.0.3.2 only). The
 *  `before` bytes are the call's own — a BL encoding moves with its call
 *  site, so they are read from the image the shape just located. */
function tailHookSite(plain: Uint8Array, ladder: number): PatchSite | null {
  const call = tailHookCall(plain, ladder);
  if (call === null) return null;
  return {
    offset: call,
    before: [plain[call] ?? 0, plain[call + 1] ?? 0, plain[call + 2] ?? 0, plain[call + 3] ?? 0],
    after: [0x00, 0xbf, 0x00, 0xbf],
    what:
      'arm-tail hook: bl <fsm rebuild> -> nop;nop — the 1.0.3.2 builds wired a real ' +
      'FSM/op-mode refresh into the arm tail and an accepting arm wedges the vendor ' +
      'surface (1.0.3.0’s same-shaped call drives a different struct and is harmless)',
  };
}

/* ---- the key blocks, found by value ---------------------------------------- */

/** The build line's key pairs, by value. Shared with the cipher solvers
 *  (`solve.ts`): a decrypted capture vouches for itself by carrying exactly
 *  one of these pairs, and the at-rest stream is then recomputed from the
 *  FOUND blocks. Exported so the pair table stays single-sourced. */
export const KEY_PAIRS = {
  /** 1.3.0.8-FF (the R16-shaped 0xFFFF build): ks0/ksD seeds. */
  ff1308: {
    block0: '5d7984797c47eb9354fa35898ab11701',
    block1: 'b5541579754be4b33b6f1ba975a8badc',
  },
  /** The 1.0.3.0 / 1.0.3.2 9 Hz pair (the SAME pair across those builds). */
  cp103: {
    block0: '67a3ea21824fecc4b3c3b0a8da514669',
    block1: 'faacb3c6f1412469bd122fb82d78160d',
  },
  /** The 1.0.3.2 18 Hz FF pair (new to the record; proven on the wire) — and
   *  the 1.0.3.0-FF build's pair, measured the same (doc 1032 sec. 3). */
  cp1032ff: {
    block0: '58d6abe5a94e4de650ae3a84f9f8f281',
    block1: '6da05a33f540100034e2c8947d05708c',
  },
} as const;

/** Finds a key pair BY VALUE — each half must occur exactly once — or null. */
function findKeyPair(
  plain: Uint8Array,
  pair: { readonly block0: string; readonly block1: string } | null,
): LocatedKeys | null {
  if (pair === null) return null;
  for (const half of [pair.block0, pair.block1]) {
    if (occurrences(plain, half).length !== 1) return null;
  }
  return { block0Hex: pair.block0, block1Hex: pair.block1 };
}

function requireKeys(pair: LocatedKeys | null): LocatedKeys {
  if (pair === null) {
    throw new SeekError(
      'pipeline/refused',
      'this build key blocks were not found by value (each must occur exactly once)',
    );
  }
  return pair;
}

/* ---- the profiles ----------------------------------------------------------- */

/**
 * One build (or one build generation) whose widening patch is derived. `detect`
 * reads IMAGE PROPERTIES only — the version string alone must never select a
 * patch (1.3.0.8 and 1.3.0.8-FF report the same version; they are told apart
 * by the 0xFFFF word-sum sentinel and the key blocks).
 */
export interface BuildPatchProfile {
  readonly buildId: string;
  readonly family: PreserveFamilyId;
  /** The name the plan print shows. */
  readonly label: string;
  readonly detect: (plain: Uint8Array) => boolean;
  /** The sites at their located offsets, before-byte gated (throws). */
  readonly locate: (plain: Uint8Array) => readonly PatchSite[];
  readonly keysOf: (plain: Uint8Array) => LocatedKeys | null;
  readonly stagedForm: StagedFormId;
  readonly restoreForm: RestoreFormId;
  /** The content-acceptance constant of the family: 0 for a word-sum-0 gate,
   *  0xFFFF for the FF build's collapsed staged-form gate. */
  readonly acceptanceSum: number;
  readonly route: CommitRouteId;
  readonly routeNote: string | null;
  readonly capability: DrainCapability;
}

const PLAIN_BANK_CAPABILITY: DrainCapability = {
  wholePart: true,
  losslessReadUnit: 64,
  note:
    'one widened-window arm drains the whole 4 MiB part; the unpatched budget is 64 KiB ' +
    'per arm and the reader budget is consumed in asks — byte-exact at the 64-byte ask ' +
    '(one EP0 packet, serve == ask; TESTING.md 23.3)',
};

const CIPHER_2016_CAPABILITY: DrainCapability = {
  wholePart: true,
  losslessReadUnit: 64,
  note:
    'the whole 4 MiB drained in one session on this build (doc 33 sec. 11, in-place route ' +
    're-verified 2026-10-01); byte-exact at the 64-byte ask',
};

function matchesAt(plain: Uint8Array, site: PatchSite): boolean {
  for (let i = 0; i < site.before.length; i++) {
    if (plain[site.offset + i] !== site.before[i]) return false;
  }
  return true;
}

function inBeginWindow(plain: Uint8Array, hexNeedle: string, ladder: number): number[] {
  const from = Math.max(0, ladder - CODE_WINDOW_BEFORE_LADDER);
  return occurrences(plain, hexNeedle, from, ladder);
}

/** The shared 2016 shape test: one ladder, one guard, one widen — all inside
 *  the Begin window. Non-throwing, for the detect hooks. */
function detect2016Shapes(plain: Uint8Array): boolean {
  const ladder = findLadder(plain);
  if (ladder === null) return false;
  return (
    inBeginWindow(plain, NEEDLE_GUARD, ladder).length === 1 &&
    inBeginWindow(plain, NEEDLE_WIDEN_2016, ladder).length === 1
  );
}

/** The four-site 2014 chain (1.0.0.0 / 1.2.0.0 / 1.3.0.0): widen + the halfword
 *  reader trio at the doc-34 offsets, word-sum-0 acceptance, plaintext banks. */
const V1_2014_PROFILE: BuildPatchProfile = {
  buildId: 'v1-2014',
  family: 'v1-2014',
  label: 'v1 2014 chain',
  detect: (plain) => V1_2014_PATCH_SITES.every((site) => matchesAt(plain, site)),
  locate: (plain) =>
    V1_2014_PATCH_SITES.map((site) => {
      if (!matchesAt(plain, site)) {
        throw new SeekError(
          'pipeline/refused',
          `bytes at raw ${hexUp(site.offset)} are not the expected ` +
            `${bytesToHex(Uint8Array.from(site.before))} — this image does not carry the ` +
            `v1 2014 update machinery this patch was derived from (${site.what})`,
        );
      }
      return site;
    }),
  keysOf: () => null,
  stagedForm: 'plain',
  restoreForm: 'capture-verbatim',
  acceptanceSum: 0,
  route: 'active-bank',
  routeNote: null,
  capability: PLAIN_BANK_CAPABILITY,
};

/** Compact 1.3.0.8 8 Hz — the 2014 chain with the 2017 compiler's widened
 *  cursor: ONE site (the widen; no guard — mode 2 arms with the token — and
 *  the reader trio does not exist in this build), word-sum-0 acceptance,
 *  plaintext banks (doc 35.2). */
const COMPACT_1308_8HZ_PROFILE: BuildPatchProfile = {
  buildId: 'compact-1.3.0.8-8hz',
  family: 'v1-2014',
  label: 'Compact 1.3.0.8 (8 Hz, insecure)',
  detect: (plain) => {
    if (wordSum(plain) !== 0) return false;
    if (V1_2014_PROFILE.detect(plain)) return false; /* the trio builds keep their table */
    if (findKeyPair(plain, KEY_PAIRS.ff1308) !== null) return false; /* that is the FF build */
    const ladder = findLadder(plain);
    if (ladder === null) return false;
    /* Exactly one widen, and NO guard (doc 35.2.1). */
    return (
      inBeginWindow(plain, NEEDLE_WIDEN_2014, ladder).length === 1 &&
      inBeginWindow(plain, NEEDLE_GUARD, ladder).length === 0
    );
  },
  locate: (plain) => [widen2014Site(plain, ladderOffset(plain))],
  keysOf: () => null,
  stagedForm: 'plain',
  restoreForm: 'capture-verbatim',
  acceptanceSum: 0,
  route: 'active-bank',
  routeNote: null,
  capability: PLAIN_BANK_CAPABILITY,
};

/** Compact 1.3.0.8-FF 16 Hz — the R16-shaped 0xFFFF build: guard + widen, and
 *  a TWO-KEYSTREAM staged form S = P ^ ks0 ^ ksD whose double accept collapses
 *  to sum(S ^ ks0) == 0xFFFF. The 2014 bootloader rejects sum-not-0 images at
 *  A/B and boots recovery unchecked, so the route is the RECOVERY slot only
 *  (mode 9) (doc 35.3). */
const COMPACT_1308_FF_PROFILE: BuildPatchProfile = {
  buildId: 'compact-1.3.0.8-ff',
  family: 'v1-2014-ff',
  label: 'Compact 1.3.0.8 FF (16 Hz)',
  detect: (plain) => {
    if (wordSum(plain) !== 0xffff) return false; /* the 0xFFFF sentinel */
    if (findKeyPair(plain, KEY_PAIRS.ff1308) === null) return false;
    const ladder = findLadder(plain);
    if (ladder === null) return false;
    return (
      inBeginWindow(plain, NEEDLE_WIDEN_2014, ladder).length === 1 &&
      inBeginWindow(plain, NEEDLE_GUARD, ladder).length === 1
    );
  },
  locate: (plain) => {
    const ladder = ladderOffset(plain);
    return [guardSite(plain, ladder), widen2014Site(plain, ladder)];
  },
  keysOf: (plain) => requireKeys(findKeyPair(plain, KEY_PAIRS.ff1308)),
  stagedForm: 'xor-ks0-ksD',
  restoreForm: 'none',
  acceptanceSum: 0xffff,
  route: 'recovery-only',
  routeNote:
    'the 2014 bootloader rejects the 0xFFFF sum at slots A/B and boots the recovery bank ' +
    '0x14070000 unchecked — the patch is committed into recovery (mode 9) and nowhere else',
  capability: {
    wholePart: true,
    losslessReadUnit: 64,
    note:
      'commit + whole-part drain proven through the recovery route (doc 35.3.3: commit 0x0, ' +
      '4 MiB on one arm, dump == post-commit, 6 patch bytes vs as-booted); the IN-PLACE ' +
      'variant is derived, not yet run — this run does not promise it',
  },
};

/** Compact Pro 1.0.3.0 — the 2016 cipher chain: TWO sites (guard + widen),
 *  staged = plain ^ ks(block 0), acceptance = DECRYPTED word sum 0 (doc 33
 *  sec. 11). The arm-tail hook is a `bx lr` stub here and needs no site. */
const CP_1030_PROFILE: BuildPatchProfile = {
  buildId: 'compact-pro-1.0.3.0',
  family: 'compact-2016',
  label: 'Compact Pro 1.0.3.0 (9 Hz)',
  /* The shapes are checked first: they are what guarantees the ladder the
   * hook test reads through exists. */
  detect: (plain) =>
    detect2016Shapes(plain) &&
    findKeyPair(plain, KEY_PAIRS.cp103) !== null &&
    !tailHookApplies(plain, ladderOffset(plain)),
  locate: (plain) => {
    const ladder = ladderOffset(plain);
    return [guardSite(plain, ladder), widen2016Site(plain, ladder)];
  },
  keysOf: (plain) => requireKeys(findKeyPair(plain, KEY_PAIRS.cp103)),
  stagedForm: 'xor-ks0',
  restoreForm: 'factory-staged',
  acceptanceSum: 0,
  route: 'active-bank',
  routeNote: null,
  capability: CIPHER_2016_CAPABILITY,
};

/** Compact Pro 1.0.3.2 (both variants): the 1.0.3.0 sites PLUS the arm-tail
 *  hook nop (the 1.0.3.2 builds call a real FSM refresh there and an accepting
 *  arm wedges the vendor surface), and HARD drain limits: no whole-part
 *  single-arm drain exists (doc 1032 sec. 2/5). */
function cp1032Profile(
  buildId: string,
  label: string,
  keys: { readonly block0: string; readonly block1: string },
  maxPerArmReach: number,
): BuildPatchProfile {
  return {
    buildId,
    family: 'compact-2016',
    label,
    detect: (plain) =>
      detect2016Shapes(plain) &&
      findKeyPair(plain, keys) !== null &&
      tailHookApplies(plain, ladderOffset(plain)),
    locate: (plain) => {
      const ladder = ladderOffset(plain);
      const sites = [guardSite(plain, ladder), widen2016Site(plain, ladder)];
      const hook = tailHookSite(plain, ladder);
      return hook === null ? sites : [...sites, hook];
    },
    keysOf: (plain) => requireKeys(findKeyPair(plain, keys)),
    stagedForm: 'xor-ks0',
    restoreForm: 'factory-staged',
    acceptanceSum: 0,
    route: 'active-bank',
    routeNote: null,
    capability: {
      wholePart: false,
      losslessReadUnit: 128,
      maxPerArmReach,
      note:
        'no whole-part single-arm drain exists on this build: 128 B is the lossless read ' +
        'unit (larger asks silently lose bytes), the EP0 sessions die at ~64-81 KB and the ' +
        'upgrade descriptors reset on re-enumeration, and the widened reach is proven ' +
        `byte-exact only to 0x${maxPerArmReach.toString(16)}. This run supports backup, ` +
        'patch, commit, restore and verify — the whole-part dump is not one of them ' +
        '(doc 1032 sec. 5).',
    },
  };
}

/** The table, most specific first. Every pair of detects is mutually
 *  exclusive by image properties; two matches is a refusal, never a guess. */
export const BUILD_PATCH_PROFILES: readonly BuildPatchProfile[] = [
  cp1032Profile(
    'compact-pro-1.0.3.2-18hzff',
    'Compact Pro 1.0.3.2 FF (18 Hz)',
    KEY_PAIRS.cp1032ff,
    0x17500,
  ),
  cp1032Profile('compact-pro-1.0.3.2-9hz', 'Compact Pro 1.0.3.2 (9 Hz)', KEY_PAIRS.cp103, 0x13c00),
  CP_1030_PROFILE,
  COMPACT_1308_FF_PROFILE,
  COMPACT_1308_8HZ_PROFILE,
  V1_2014_PROFILE,
];

/* ---- building the patch ------------------------------------------------------ */

/** The factory plaintext every assertion below hangs off. */
export interface V1Patch {
  /** The input, verbatim. */
  readonly factory: Uint8Array;
  /** `factory` with the sites applied and word 142 rebalanced. */
  readonly patched: Uint8Array;
  /** Byte offsets where `patched` differs from `factory` — the pipeline's
   *  whole effect on the part, enumerated. For the 2014 patch set: exactly
   *  the ten bytes 0x238, 0x239, 0x23B, 0x3C1C, 0x3C1D, 0x3C68, 0x3C69,
   *  0x3C70, 0x3C71, 0x3DB7. */
  readonly diffOffsets: readonly number[];
  /** `factory[o] ^ patched[o]` per diff offset — the conjugation mask. */
  readonly mask: Uint8Array;
  /** The rebalance word, as stored (little-endian) at `REBALANCE_WORD_OFFSET`.
   *  On the FF build this word is NOT a raw-sum rebalance: it spends the free
   *  header word on the collapsed staged-form acceptance (sum(S ^ ks0) ==
   *  0xFFFF). */
  readonly rebalanceWord: number;
  /** The raw 32-bit word sum of `patched` — 0 on every family whose boot gate
   *  reads one; the FF build's is 0x485602E7 and that is fine (its route never
   *  touches the sum-checking slots). */
  readonly patchedWordSum: number;
  /* ---- the build the patch belongs to (additive) ------------------------- */
  readonly buildId: string;
  readonly family: PreserveFamilyId;
  readonly label: string;
  /** The sites at their located offsets — what the plan print shows. */
  readonly sites: readonly PatchSite[];
  readonly keys: LocatedKeys | null;
  readonly stagedForm: StagedFormId;
  readonly restoreForm: RestoreFormId;
  readonly acceptanceSum: number;
  readonly route: CommitRouteId;
  readonly routeNote: string | null;
  readonly capability: DrainCapability;
}

const NO_MATCH_GUIDANCE =
  'No build in the preservation table matches this image (looked for the 2014 widen + ' +
  'reader trio, the 1.3.0.8 widen, the 1.3.0.8-FF guard and key blocks, and the 2016 ' +
  'guard + widen + key blocks — or the image is already patched). If this is a ' +
  '2018-or-later build (Compact/Compact PRO 4.x, Compact XR, Nano 200/300, Mosaic), no ' +
  'widening patch is needed: the modern stock plan already reads 63 of the 64 flash ' +
  'windows (the whole flash except 0x14060000, which no selector can arm) — use the ' +
  'standard dump workflow (`seek-fw dump`, or the Dump view) instead.';

/**
 * Build the widening patch for whatever build the plaintext turns out to be.
 *
 * The table dispatch is on image properties (never the version string alone);
 * the per-family gates refuse — before anything is derived — when the
 * plaintext does not carry the expected `before` bytes at the located sites,
 * when its acceptance sum is not what the family assumes, or when the
 * rebalance word is not free.
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

  const matches = BUILD_PATCH_PROFILES.filter((profile) => profile.detect(plain));
  if (matches.length > 1) {
    throw new SeekError(
      'pipeline/refused',
      `this image matches ${String(matches.length)} build profiles ` +
        `(${matches.map((p) => p.buildId).join(', ')}) — refusing to guess`,
    );
  }
  const matched = matches.at(0);
  if (matched !== undefined) return buildWithProfile(plain, matched);

  /* No table entry matched. Reproduce the 2014 chain's own refusals first —
   * they are the pinned, measured messages — then widen the message with the
   * guidance above. */
  const sum = wordSum(plain);
  if (sum !== 0) {
    throw new SeekError(
      'pipeline/refused',
      `the factory plaintext word sum is not 0 (0x${sum.toString(16)}) — this builder only ` +
        `rebalances a balanced image. ${NO_MATCH_GUIDANCE}`,
    );
  }
  for (const site of V1_2014_PATCH_SITES) {
    if (!matchesAt(plain, site)) {
      throw new SeekError(
        'pipeline/refused',
        `bytes at raw ${hexUp(site.offset)} are not the expected ` +
          `${bytesToHex(Uint8Array.from(site.before))} — ` +
          `this image does not carry the v1 2014 update machinery this patch was derived ` +
          `from (${site.what}). ${NO_MATCH_GUIDANCE}`,
      );
    }
  }
  throw new SeekError(
    'pipeline/refused',
    `the rebalance word at ${hexUp(REBALANCE_WORD_OFFSET)} is not free (0). ` + NO_MATCH_GUIDANCE,
  );
}

function buildWithProfile(plain: Uint8Array, profile: BuildPatchProfile): V1Patch {
  const dv = new DataView(plain.buffer, plain.byteOffset, plain.byteLength);
  const rawSum = wordSum(plain);
  if (profile.family === 'v1-2014-ff') {
    /* The FF build's sentinel: its raw word sum is 0xFFFF on the factory
     * image, and the acceptance is carried by the staged form, not the raw
     * bytes (doc 35.3.1-35.3.2). */
    if (rawSum !== 0xffff) {
      throw new SeekError(
        'pipeline/refused',
        `the factory plaintext word sum is 0x${rawSum.toString(16)}, want the FF build's ` +
          '0xFFFF sentinel — this patch is derived from the 1.3.0.8-FF bytes',
      );
    }
  } else if (rawSum !== 0) {
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
  for (const site of profile.locate(plain)) {
    for (let i = 0; i < site.before.length; i++) {
      if (patched[site.offset + i] !== site.before[i]) {
        throw new SeekError(
          'pipeline/refused',
          `bytes at raw ${hexUp(site.offset)} are not the expected ` +
            `${bytesToHex(Uint8Array.from(site.before))} — ` +
            `this image does not carry the update machinery this patch was derived from ` +
            `(${site.what})`,
        );
      }
    }
    patched.set(site.after, site.offset);
  }

  const keys = profile.keysOf(plain);
  let rebalanceWord: number;
  if (profile.family === 'v1-2014-ff') {
    const block1Hex = keys?.block1Hex;
    if (keys == null || block1Hex == null) {
      throw new SeekError(
        'pipeline/refused',
        'the FF staged form needs both key blocks and they were not located by value',
      );
    }
    /* Solve the free header word for the ONE content constraint the double
     * accept collapses to: sum over (S ^ ks0), header words at face value,
     * == 0xFFFF. With S = P ^ ks0 ^ ksD off the header, that sum reads
     * P ^ ksD — so the solve is exact arithmetic on the patched plaintext. */
    const ks0 = keystream(keyWordsOf(keys.block0Hex), plain.length >> 2);
    const ksD = keystream(keyWordsOf(block1Hex), plain.length >> 2);
    const base = wordSum(xorWindowVerbatim(patched, ksD)); /* word 142 still 0 here */
    rebalanceWord = (0xffff - base) >>> 0;
    new DataView(patched.buffer).setUint32(REBALANCE_WORD_OFFSET, rebalanceWord, true);
    const staged = xorWindowVerbatim(xorWindowVerbatim(patched, ks0), ksD);
    if (wordSum(xorWindowVerbatim(staged, ks0)) !== 0xffff) {
      throw new SeekError(
        'pipeline/refused',
        'the rebalance did not bring the staged-form acceptance to 0xFFFF',
      );
    }
  } else {
    rebalanceWord = (0 - wordSum(patched)) >>> 0;
    new DataView(patched.buffer).setUint32(REBALANCE_WORD_OFFSET, rebalanceWord, true);
    if (wordSum(patched) !== 0) {
      throw new SeekError('pipeline/refused', 'the rebalance did not bring the word sum to 0');
    }
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
    buildId: profile.buildId,
    family: profile.family,
    label: profile.label,
    sites: profile.locate(plain),
    keys,
    stagedForm: profile.stagedForm,
    restoreForm: profile.restoreForm,
    acceptanceSum: profile.acceptanceSum,
    route: profile.route,
    routeNote: profile.routeNote,
    capability: profile.capability,
  };
}

/* ---- the staged forms -------------------------------------------------------- */

/**
 * The wire-80 staged bytes for `image` (the patched plaintext for a commit,
 * the factory plaintext for a restore) under the patch's family:
 *
 *  - 'plain'       the image itself — the 2014 banks hold it as stored, and
 *                  the commit path conjugates the capture instead (`plain` is
 *                  the identity here; the caller decides);
 *  - 'xor-ks0'     image ^ keystream(key block 0) — the 2016 staged form;
 *  - 'xor-ks0-ksD' image ^ keystream(block 0) ^ keystream(block 1) — the FF
 *                  build's staged form, whose commit transform folds it back
 *                  to the plaintext slot content.
 *
 * The header window (words 128..143) passes verbatim through every form; the
 * keystreams advance through it.
 */
export function stagedFormOf(patch: V1Patch, image: Uint8Array): Uint8Array {
  if (image.length !== patch.factory.length) {
    throw new SeekError(
      'pipeline/refused',
      `staged form: image is ${String(image.length)} B, the patch was built from ` +
        `${String(patch.factory.length)} B`,
    );
  }
  if (patch.stagedForm === 'plain') return image;
  if (patch.keys === null) {
    throw new SeekError(
      'pipeline/refused',
      'the staged form needs this build key blocks and they were not located by value',
    );
  }
  const words = image.length >> 2;
  const ks0 = keystream(keyWordsOf(patch.keys.block0Hex), words);
  let out = xorWindowVerbatim(image, ks0);
  if (patch.stagedForm === 'xor-ks0-ksD') {
    if (patch.keys.block1Hex === null) {
      throw new SeekError(
        'pipeline/refused',
        'the two-stream staged form needs key block 1 and it was not located by value',
      );
    }
    out = xorWindowVerbatim(out, keystream(keyWordsOf(patch.keys.block1Hex), words));
  }
  return out;
}

/**
 * The FF build's collapsed content gate, evaluated on staged bytes: the word
 * sum of (staged ^ ks0), header words at face value — what BOTH of the app's
 * accepts read (the two-stream transform sits between them, and accept 2's
 * device-stream decryption lands on the same sum). Must be 0xFFFF.
 */
export function stagedAcceptanceSum(patch: V1Patch, staged: Uint8Array): number {
  if (patch.keys === null) {
    throw new SeekError('pipeline/refused', 'the staged acceptance needs the build key blocks');
  }
  return wordSum(
    xorWindowVerbatim(staged, keystream(keyWordsOf(patch.keys.block0Hex), staged.length >> 2)),
  );
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

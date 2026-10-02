/**
 * The seam where a slot capture becomes the factory plaintext.
 *
 * THE RULING THIS MODULE EXISTS FOR: the preservation run has NO manual
 * plaintext-image selection anywhere — the image ALWAYS derives from the
 * camera itself. The backup step reads the active slot's image twice, requires
 * the two reads to agree, and hands the agreed capture here; what comes back
 * is the factory plaintext the patch derives from, or a refusal.
 *
 * ---- THE CONTRACT (stable; commit 63bb4bd) ---------------------------------
 *
 * `solvePlainFromCapture(family, capture)` is PURE: bytes in, result out, no
 * I/O, no transport, deterministic — the same capture always yields the same
 * result. It NEVER throws for content reasons; every refusal is the
 * `{ ok: false, reason }` shape, with `reason` in words a person at the
 * camera can act on. Refuse over guess, always.
 *
 * `family` selects the strategy:
 *
 *  - 'v1-2014'      IDENTITY — the 2014 chain stores the image in its slot
 *                   as-is (no at-rest cipher). Structural validation plus the
 *                   image-length slice.
 *  - 'v1-2014-ff'   KEYSTREAM-SOLVE — the R16-family at-rest cipher (below),
 *                   the FF build's acceptance (the 0xFFFF sentinel).
 *  - 'compact-2016' KEYSTREAM-SOLVE — the same cipher, the 2016 line's
 *                   acceptance (the decrypted word sum 0).
 *
 * THE CALLER (the backup step) NEVER TRUSTS A SOLVED PLAIN ON ITS OWN. The
 * derivation order is: identity first (a plain-chain capture solves there);
 * then each cipher family in turn; every candidate is then pushed through the
 * full structural gate set on the DERIVED image — the build table's detect
 * hooks and before-byte site gates (`buildV1Patch`, which refuses an
 * already-patched bank), and the version cross-check against the version the
 * camera itself reported. A candidate that passes all of them is the factory
 * plaintext by construction; a capture for which none passes is refused, and
 * the run never writes.
 *
 * ---- THE CIPHER, AND WHAT A CAPTURE IS --------------------------------------
 *
 * `capture` is what the wire-79 reader served for the active slot: the SLOT
 * BYTES, one whole 64 KiB window. The at-rest cipher is the R16 scheme — a
 * Marsaglia xorshift128 keystream, one word per image word, seeded from key
 * material the image itself carries (`keystream(keyWordsOf(block), words)`,
 * seeded `[k1,k2,k3,k0]`, no whitening): the 2016 line's slot is
 * `plain ⊕ ks(key block 1)` (doc 33 sec. 11.2, donor-verified full length on
 * two cameras), and the FF build's commit stores `plain ⊕ ks(block 0) ⊕
 * ks(block 1)` — the two-stream transform's output (doc 35.3). The header
 * window (words 128..143, offsets 0x200..0x23F) is stored VERBATIM in every
 * family — the cipher never touches it, so the image length at 0x204 is
 * readable before anything is solved. The result's `plain` is exactly the
 * image-length slice, as in the identity path.
 *
 * ---- THE ALGEBRA, AND WHY THE SOLVE IS FULLY DETERMINED ---------------------
 *
 * xorshift128 is linear over GF(2): keystream word i is `A^i · s` for a fixed
 * 128×128 step matrix A and the 128-bit seed s. An XOR of two generator
 * streams is itself a generator stream — from the XOR of their seeds — so
 * EVERY at-rest form above is one equation family:
 *
 *     capture[i] = plain[i] ^ (A^i · s)    for image words,
 *     capture[i] = plain[i]                 for the verbatim window 128..143.
 *
 * The plain image's Cortex-M vector table reserves words 7, 8, 9, 10 (and 13)
 * as 0x00000000 — byte-verified on every build in the record (1.0.3.0,
 * 1.0.3.2 both variants, 1.3.0.8-8Hz, 1.3.0.8-FF; the same fact the offline
 * decrypt's key recovery rests on). Those four words are therefore 128 known
 * KEYSTREAM bits, and the coefficient matrix of `A^(7..10) · s = capture`
 * has full rank 128, so the seed s is THE UNIQUE solution of a linear system
 * — no search, no candidates, no guess. This is the same `recoverState` the
 * offline decrypt runs on flash dumps; it is imported, not reimplemented.
 *
 * Every assumption is then VERIFIED, never trusted, in this order:
 *
 *   1. the verbatim header parses (magic, a sane `header.length`);
 *   2. word 13 — a reserved vector held BACK from the solve — must decrypt
 *      to 0, so a wrong crib or a wrong model dies right here;
 *   3. the decrypted image carries the family's acceptance sum (0 for the
 *      2016 line; the FF build's 0xFFFF sentinel);
 *   4. the decrypted image is structurally a slot image of this line: the
 *      segmented container (code-payload descriptor at 0x290), the reset
 *      vector agreeing with the header's entry word at 0x210, the window
 *      ladder, the mode-2 guard and the family's widen tail in the Begin
 *      window, and the wire-82 token;
 *   5. the family's key blocks are found BY VALUE, each exactly once (the
 *      app-key-table rule);
 *   6. the closing identity: `capture ^ plain`, off the header window, must
 *      equal the at-rest stream recomputed from the FOUND key blocks — the
 *      keystream is accounted for to the last word, or the solver refuses.
 *
 * Check 6 is what separates a genuinely ciphered capture from a plain one
 * (a plain capture "solves" to the zero state, and then no documented stream
 * of the image's own keys reproduces it — the identity family owns plain
 * captures, not these). A capture for which any layer fails is refused with
 * the reason; a `method` string names what was done, e.g.
 * `r16-state-from-crib+keyblock-verify (the at-rest device stream, key block 1)`.
 *
 * KNOWN LIMIT, STATED: the FF build's native at-rest form is only partially
 * in the record — no FF camera's flash dump exists (the emulator proofs run
 * the FF image on a PLAINTEXT donor, which the identity path solves). The
 * solver answers for the two forms the record proves — the device stream and
 * the two-stream store of the factory image — and refuses anything else (a
 * slot holding a post-OTA STAGED form decrypts to a non-sentinel sum and is
 * refused: the factory plaintext is not recoverable from it by this family's
 * rules). Refuse over guess.
 * ==================================================================== */

import { findAll, hexToBytes, hexUp, viewOf } from '../bytes.js';
import { cryptImage } from '../crypto/cipher.js';
import { CHECK_ZERO_IDX, recoverState } from '../crypto/recover.js';
import { cloneState, xsNext } from '../crypto/xorshift128.js';
import { IMAGE_MAGIC, TRY_KEYS_MAX_LEN, parseImageHeader } from '../image/header.js';
import type { CipherProfile } from '../profiles/types.js';
import {
  CODE_WINDOW_BEFORE_LADDER,
  KEY_PAIRS,
  NEEDLE_GUARD,
  NEEDLE_LADDER,
  NEEDLE_TOKEN_82,
  NEEDLE_WIDEN_2014,
  NEEDLE_WIDEN_2016,
  keyWordsOf,
  keystream,
  wordSum,
  type PreserveFamilyId,
} from './patch.js';

/** The result of turning a slot capture into the factory plaintext. */
export type SolvePlainResult =
  | { readonly ok: true; readonly plain: Uint8Array; readonly method: string }
  | { readonly ok: false; readonly reason: string };

/** The 2014 bootloader's own slot bound: an image whose header.length is at
 *  or past this never passes image_try_keys, so it is never the factory
 *  plaintext of a running 2014-chain build. (The 2016 line's own accept gates
 *  `length < 0x10000` the same way.) */
const MAX_2014_IMAGE_LEN = TRY_KEYS_MAX_LEN;

/** The verbatim header window: words 128..143, offsets 0x200..0x23F. */
const WINDOW_LO = 0x80;
const WINDOW_HI = 0x8f;

/** Smallest image that can carry the segmented container: the code-payload
 *  descriptor sits at 0x290..0x29F (doc 33 sec. 11.2). Every build in the
 *  record is ~0xC000. */
const MIN_SEGMENTED_LEN = 0x2a0;

/** The slot cipher's own reading of the generator: no whitening, and the
 *  header window verbatim — exactly what `xorWindowVerbatim` writes. */
const SLOT_CIPHER: CipherProfile = {
  whiteningK: 0x00000000,
  acceptanceSum: 0x00000000,
  clearWords: [WINDOW_LO, WINDOW_HI],
};

/** The at-rest forms the record proves, per family: which combination of the
 *  image's own key-block streams the slot bytes are. */
type AtRestForm = 'device' | 'two-stream';

interface FamilySolve {
  /** The word sum the DECRYPTED image must carry: the 2016 line's acceptance
   *  is 0; the FF build's plain image carries the 0xFFFF sentinel (doc 35.3). */
  readonly acceptanceSum: number;
  /** The family's widen tail, in the Begin window. */
  readonly widen: string;
  /** The key pairs this family's builds carry (found by value, each half
   *  exactly once). */
  readonly pairs: readonly {
    readonly block0: string;
    readonly block1: string;
  }[];
  /** The at-rest stream combinations the record proves for this family. */
  readonly forms: readonly AtRestForm[];
}

const FAMILY_SOLVES: Record<Exclude<PreserveFamilyId, 'v1-2014'>, FamilySolve> = {
  'v1-2014-ff': {
    acceptanceSum: 0xffff,
    widen: NEEDLE_WIDEN_2014,
    pairs: [KEY_PAIRS.ff1308],
    forms: ['device', 'two-stream'],
  },
  'compact-2016': {
    acceptanceSum: 0,
    widen: NEEDLE_WIDEN_2016,
    pairs: [KEY_PAIRS.cp103, KEY_PAIRS.cp1032ff],
    forms: ['device'],
  },
};

const FORM_NAMES: Record<AtRestForm, string> = {
  device: 'the at-rest device stream, key block 1',
  'two-stream': 'the two-stream store, key blocks 0+1',
};

function refuse(family: PreserveFamilyId, why: string): SolvePlainResult {
  return {
    ok: false,
    reason:
      `the capture cannot be solved as a ${family} slot image: ${why} — the run ` +
      'refuses rather than write over a slot it cannot read',
  };
}

/** How many times `hexNeedle` occurs in `plain[from..to)`. */
function countNeedle(plain: Uint8Array, hexNeedle: string, from = 0, to = plain.length): number {
  const needle = hexToBytes(hexNeedle);
  let hits = 0;
  for (const at of findAll(plain, needle)) {
    if (at >= from && at + needle.length <= to) hits++;
  }
  return hits;
}

/** Whether `capture ^ plain`, off the header window, is exactly `ks` over the
 *  image's words — the keystream accounted for to the last word. */
function streamAccountedFor(
  capture: Uint8Array,
  plain: Uint8Array,
  length: number,
  ks: Uint32Array,
): boolean {
  const cv = viewOf(capture);
  const pv = viewOf(plain);
  for (let i = 0; i < length >> 2; i++) {
    if (i >= WINDOW_LO && i <= WINDOW_HI) continue;
    if ((cv.getUint32(i * 4, true) ^ pv.getUint32(i * 4, true)) >>> 0 !== ks[i]) return false;
  }
  return true;
}

/** Layers 2..6 for one family, once the header has parsed. Layer 1 is the
 *  header itself, shared with the identity path's shape. */
function solveCipher(
  family: 'v1-2014-ff' | 'compact-2016',
  capture: Uint8Array,
  length: number,
): SolvePlainResult {
  const rules = FAMILY_SOLVES[family];

  /* LAYER 2 — the state from the crib, and the held-back word's verdict.
   * capture[7..10] IS the keystream (the reserved vectors are 0 in the plain
   * image), and the GF(2) system has full rank, so this state is the unique
   * seed consistent with the crib. */
  const state = recoverState(viewOf(capture), 0);
  const probe = cloneState(state);
  let ks13 = 0;
  for (let i = 0; i <= CHECK_ZERO_IDX; i++) ks13 = xsNext(probe);
  const word13 = (ks13 ^ viewOf(capture).getUint32(4 * CHECK_ZERO_IDX, true)) >>> 0;
  if (word13 !== 0) {
    return refuse(
      family,
      'the keystream state solved from the reserved vector words (7..10) does not decrypt ' +
        'the held-back vector word 13 to zero — these are not the at-rest bytes of a slot ' +
        'image of this line (the crib assumption does not check out)',
    );
  }

  /* The decrypt: self-inverse, header window verbatim, image-length slice. */
  const plain = cryptImage(viewOf(capture), 0, length, state, SLOT_CIPHER);

  /* LAYER 3 — the family's acceptance sum on the decrypted image. */
  const sum = wordSum(plain);
  if (sum !== rules.acceptanceSum) {
    const want = `0x${rules.acceptanceSum.toString(16)}`;
    const name =
      family === 'v1-2014-ff' ? "the FF build's 0xFFFF sentinel" : 'the 2016 line’s acceptance';
    return refuse(
      family,
      `the decrypted image's word sum is 0x${sum.toString(16)}, want ${want} — ${name} — ` +
        'the recovered state decrypts these bytes to something that is not a factory image',
    );
  }

  /* LAYER 4 — the container and the machinery, on the decrypted image. */
  const header = parseImageHeader(plain);
  if (header === null || header.reset !== header.entry || (header.reset & 1) !== 1) {
    return refuse(
      family,
      'the decrypted image’s reset vector (word 1) does not agree with the header’s ' +
        'entry word at 0x210 — not a bootable image of this line',
    );
  }
  const dv = viewOf(plain);
  const lma = dv.getUint32(0x290, true);
  const vma = dv.getUint32(0x294, true);
  const size = dv.getUint32(0x298, true);
  if (lma >>> 24 !== 0x14 || vma >>> 24 !== 0x10 || size === 0 || size > length) {
    return refuse(
      family,
      'the decrypted image’s segmented container does not parse (the code-payload ' +
        'descriptor at 0x290 is not a flash LMA / payload VMA / sane length) — every slot ' +
        'image of this line carries one',
    );
  }
  const ladderHits = countNeedle(plain, NEEDLE_LADDER);
  if (ladderHits !== 1) {
    return refuse(
      family,
      `the decrypted image carries ${String(ladderHits)} window-pool ladders, want exactly ` +
        'one — the BeginFirmwareUpgrade machinery of this line is not in these bytes',
    );
  }
  const ladder = findAll(plain, hexToBytes(NEEDLE_LADDER))[0] ?? 0;
  const from = Math.max(0, ladder - CODE_WINDOW_BEFORE_LADDER);
  const guards = countNeedle(plain, NEEDLE_GUARD, from, ladder);
  const widens = countNeedle(plain, rules.widen, from, ladder);
  if (guards !== 1 || widens !== 1) {
    return refuse(
      family,
      `the Begin window of the decrypted image carries ${String(guards)} mode-2 guard(s) and ` +
        `${String(widens)} widen tail(s), want one of each — the update machinery this ` +
        'family’s patch was derived from is not in these bytes',
    );
  }
  if (countNeedle(plain, NEEDLE_TOKEN_82) < 1) {
    return refuse(
      family,
      'the decrypted image does not carry the upgrade token (the line’s one constant) — ' +
        'not an image of this line',
    );
  }

  /* LAYER 5 — the key blocks, by value, each half exactly once. */
  let found: { readonly block0: string; readonly block1: string } | null = null;
  for (const pair of rules.pairs) {
    const both = countNeedle(plain, pair.block0) === 1 && countNeedle(plain, pair.block1) === 1;
    if (!both) continue;
    if (found !== null) {
      return refuse(
        family,
        'the decrypted image carries more than one of the line’s key pairs — refusing to ' +
          'pick one',
      );
    }
    found = pair;
  }
  if (found === null) {
    return refuse(
      family,
      'the decrypted image does not carry this family’s key blocks by value (each must ' +
        'occur exactly once) — a plain capture solves to the zero state and dies here, and ' +
        'so does anything that is not a factory image of this line',
    );
  }

  /* LAYER 6 — the closing identity: the capture must be the decrypted image
   * XOR a documented at-rest stream OF THE FOUND BLOCKS. */
  const words = length >> 2;
  const ks0 = keystream(keyWordsOf(found.block0), words);
  const ksD = keystream(keyWordsOf(found.block1), words);
  let form: AtRestForm | null = null;
  for (const candidate of rules.forms) {
    const ks = candidate === 'device' ? ksD : ks0.map((v, i) => (v ^ (ksD[i] ?? 0)) >>> 0);
    if (streamAccountedFor(capture, plain, length, ks)) {
      form = candidate;
      break;
    }
  }
  if (form === null) {
    return refuse(
      family,
      'the capture is not the decrypted image XOR any documented at-rest stream of its own ' +
        'key blocks (device, or the two-stream store) — the keystream does not close, so the ' +
        'solve cannot vouch for these bytes',
    );
  }
  return {
    ok: true,
    plain,
    method: `r16-state-from-crib+keyblock-verify (${FORM_NAMES[form]})`,
  };
}

/**
 * The identity solve: the 2014 chain's banks hold the image AS STORED, so the
 * factory plaintext is the capture's image-length prefix — once the verbatim
 * header window parses and the length is one a 2014 bootloader would accept.
 */
function solveIdentity(capture: Uint8Array): SolvePlainResult {
  if (capture.length < 0x240) {
    return {
      ok: false,
      reason: `the capture is ${String(capture.length)} B — too short to hold the image header`,
    };
  }
  const header = parseImageHeader(capture);
  if (header === null) {
    return { ok: false, reason: 'the capture has no parseable image header at 0x200' };
  }
  if (header.magic !== IMAGE_MAGIC) {
    return {
      ok: false,
      reason:
        `the capture is not a plaintext 2014 image: the header magic at 0x200 is ` +
        `0x${header.magic.toString(16).padStart(8, '0')}, want 0xa1b2c3d4 — the slot's ` +
        'content is ciphered (or not a firmware image at all)',
    };
  }
  const length = header.length;
  if (length === 0) {
    return { ok: false, reason: 'the capture’s header declares an image length of 0' };
  }
  if (length % 4 !== 0) {
    return {
      ok: false,
      reason:
        `the capture’s header declares an image length of ${String(length)} B, which is ` +
        'not a multiple of 4 — no Seek slot image is stored unaligned',
    };
  }
  if (length > capture.length) {
    return {
      ok: false,
      reason:
        `the capture’s header declares an image length of ${hexUp(length)} B but the ` +
        `capture is only ${String(capture.length)} B — the slot does not hold the image it ` +
        'describes',
    };
  }
  if (length >= MAX_2014_IMAGE_LEN) {
    return {
      ok: false,
      reason:
        `the capture’s header declares an image length of ${hexUp(length)} B, at or past ` +
        `the 2014 bootloader's own bound (0x${MAX_2014_IMAGE_LEN.toString(16)}) — no such ` +
        'image ever booted from a slot on this chain',
    };
  }
  return {
    ok: true,
    plain: capture.slice(0, length),
    method: 'identity — the 2014 chain stores the image in its slot as-is',
  };
}

/** The gate every family shares first: the capture must hold the verbatim
 *  header window, and its declared length must be sane BEFORE anything is
 *  decrypted with it (it bounds every later read). Returns the refusal, or
 *  null when the header is worth solving under. */
function headerGate(capture: Uint8Array, family: PreserveFamilyId): SolvePlainResult | null {
  if (capture.length < 0x240) {
    return refuse(
      family,
      `the capture is ${String(capture.length)} B — too short to hold the image header window`,
    );
  }
  const header = parseImageHeader(capture);
  if (header === null) {
    return refuse(family, 'the verbatim header window does not parse');
  }
  if (header.magic !== IMAGE_MAGIC) {
    return refuse(
      family,
      `the header magic at 0x200 is 0x${header.magic.toString(16).padStart(8, '0')}, want ` +
        '0xa1b2c3d4 — the verbatim window itself is scrambled, so these are not the at-rest ' +
        'bytes of a slot image (a real at-rest capture stores that window in clear)',
    );
  }
  const length = header.length;
  if (length === 0) return refuse(family, 'the header declares an image length of 0');
  if (length % 4 !== 0) {
    return refuse(
      family,
      `the header declares an image length of ${String(length)} B, which is not a multiple of 4`,
    );
  }
  if (length > capture.length) {
    return refuse(
      family,
      `the header declares an image length of 0x${length.toString(16)} B but the capture is ` +
        `only ${String(capture.length)} B — the slot does not hold the image it describes`,
    );
  }
  if (length >= MAX_2014_IMAGE_LEN) {
    return refuse(
      family,
      `the header declares an image length of 0x${length.toString(16)} B, at or past the ` +
        `bootloader's own bound (0x${MAX_2014_IMAGE_LEN.toString(16)}) — no such image ever ` +
        'booted from a slot on this line',
    );
  }
  if (length < MIN_SEGMENTED_LEN) {
    return refuse(
      family,
      `the header declares an image length of 0x${length.toString(16)} B — too short to hold ` +
        'the segmented container (the code-payload descriptor at 0x290) every slot image of ' +
        'this line carries',
    );
  }
  return null;
}

/**
 * Turn the agreed capture of the active slot into the factory plaintext, by
 * the strategy `family` names. See the module header for the contract and the
 * algebra — the signature is stable (commit 63bb4bd).
 */
export function solvePlainFromCapture(
  family: PreserveFamilyId,
  capture: Uint8Array,
): SolvePlainResult {
  if (family === 'v1-2014') return solveIdentity(capture);
  const gate = headerGate(capture, family);
  if (gate !== null) return gate;
  const length = parseImageHeader(capture)?.length ?? 0;
  return solveCipher(family, capture, length);
}

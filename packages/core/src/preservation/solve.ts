/**
 * The seam where a slot capture becomes the factory plaintext.
 *
 * THE RULING THIS MODULE EXISTS FOR: the preservation run has NO manual
 * plaintext-image selection anywhere — the image ALWAYS derives from the
 * camera itself. The backup step reads the active slot's image twice, requires
 * the two reads to agree, and hands the agreed capture here; what comes back
 * is the factory plaintext the patch derives from, or a refusal.
 *
 * ---- THE CONTRACT (stable; the per-family solvers land behind it) ----------
 *
 * `solvePlainFromCapture(family, capture)` is PURE: bytes in, result out, no
 * I/O, no transport, deterministic — the same capture always yields the same
 * result. It NEVER throws for content reasons; every refusal is the
 * `{ ok: false, reason }` shape, with `reason` in words a person at the
 * camera can act on.
 *
 * `family` names the cipher/acceptance family the run believes the build
 * belongs to, and selects the strategy:
 *
 *  - 'v1-2014'      IDENTITY — the 2014 chain stores the image in its slot
 *                   as-is (no at-rest cipher). The strategy is structural
 *                   validation plus the image-length slice: the header window
 *                   (0x200..0x23F) must parse (magic 0xA1B2C3D4), and
 *                   `header.length` must be a word-multiple that fits both
 *                   the capture and the 2014 bootloader's own slot bound
 *                   (an image at or past 0x10000 never boots). The result's
 *                   `plain` is exactly the image-length prefix.
 *  - 'v1-2014-ff'   KEYSTREAM-SOLVE — not implemented in this build yet (the
 *                   real solver lands behind this same signature). Refuses
 *                   with the reason until then.
 *  - 'compact-2016' KEYSTREAM-SOLVE — same as above.
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
 * ---- WHAT THE CIPHER SOLVERS WILL RECEIVE ----------------------------------
 *
 * `capture` is what the wire-79 reader served for the active slot: the SLOT
 * BYTES (image XOR the at-rest keystream), one whole 64 KiB window, with the
 * header window (words 128..143, offsets 0x200..0x23F) stored VERBATIM — the
 * cipher never touches it, so the image length at 0x204 is readable in every
 * family. The solver's job is to invert that family's keystream (seeded by the
 * build's key blocks, which `buildV1Patch` locates by value in the DERIVED
 * image) and return the factory plaintext as the same image-length slice the
 * identity path returns, with a `method` string naming the strategy. A solver
 * that cannot vouch for its answer returns `{ ok: false, reason }` — a wrong
 * plain will be caught by the caller's gates, but the seam's own rule is to
 * refuse rather than hand over a guess.
 * ==================================================================== */

import { IMAGE_MAGIC, parseImageHeader } from '../image/header.js';
import { hexUp } from '../bytes.js';
import type { PreserveFamilyId } from './patch.js';

/** The result of turning a slot capture into the factory plaintext. */
export type SolvePlainResult =
  | { readonly ok: true; readonly plain: Uint8Array; readonly method: string }
  | { readonly ok: false; readonly reason: string };

/** The 2014 bootloader's own slot bound: an image whose header.length is at
 *  or past this never passes image_try_keys, so it is never the factory
 *  plaintext of a running 2014-chain build. */
const MAX_2014_IMAGE_LEN = 0x10000;

/** The refused families, until their solvers land behind this signature. */
function solverNotImplemented(family: PreserveFamilyId, capture: Uint8Array): SolvePlainResult {
  return {
    ok: false,
    reason:
      `the ${family} keystream solver is not implemented in this build — the capture ` +
      `(${String(capture.length)} B of slot bytes) cannot be turned into the factory plaintext ` +
      'yet, and the run refuses rather than write over a slot it cannot read',
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

/**
 * Turn the agreed capture of the active slot into the factory plaintext, by
 * the strategy `family` names. See the module header for the contract — the
 * signature is stable, and the cipher families' real solvers land behind it.
 */
export function solvePlainFromCapture(
  family: PreserveFamilyId,
  capture: Uint8Array,
): SolvePlainResult {
  switch (family) {
    case 'v1-2014':
      return solveIdentity(capture);
    case 'v1-2014-ff':
      return solverNotImplemented(family, capture);
    case 'compact-2016':
      return solverNotImplemented(family, capture);
  }
}

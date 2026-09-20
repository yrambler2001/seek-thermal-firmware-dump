/* ==================================================================== *
 * Key material: the 16-byte form of a state, the bootloader's key table, and
 * the key table a firmware image carries for its own use.
 *
 * The stored key is never needed to DECRYPT anything — the GF(2) solve in
 * `recover.ts` produces the state directly. Keys matter for two other reasons:
 * naming a build, and flashing. Flash an image whose embedded table does not
 * match the target bootloader and every later upgrade lands under a key that
 * bootloader cannot try, which is an unrecoverable state on hardware with no
 * USB recovery path.
 * ==================================================================== */

import { bytesToHex, findAll, hexToBytes, hexUp } from '../bytes.js';
import { SeekError } from '../errors.js';
import { sameState, stateOf, type Xorshift128State } from './xorshift128.js';

/** The bootloader's `g_boot_config_base`, the anchor `findKeyCandidates` scans for. */
export const BOOT_CONFIG_BASE = 0x14010000;

/** key = state XOR K, word-rotated: k0 = w^K, k1 = x^K, k2 = y^K, k3 = z^K. */
export function keyFromState(state: Xorshift128State, K: number): Uint8Array {
  const key = new Uint8Array(16);
  const kv = new DataView(key.buffer);
  kv.setUint32(0, ((state[3] ?? 0) ^ K) >>> 0, true);
  kv.setUint32(4, ((state[0] ?? 0) ^ K) >>> 0, true);
  kv.setUint32(8, ((state[1] ?? 0) ^ K) >>> 0, true);
  kv.setUint32(12, ((state[2] ?? 0) ^ K) >>> 0, true);
  return key;
}

/**
 * `prng_seed_from_key()`: state[3] = k0^K, state[0] = k1^K, state[1] = k2^K,
 * state[2] = k3^K. The exact inverse of `keyFromState`, so the two round-trip.
 */
export function stateFromKey(key: Uint8Array, K: number): Xorshift128State {
  if (key.length !== 16) {
    throw new SeekError('image/key-table', `a key is 16 bytes, got ${String(key.length)}`);
  }
  const dv = new DataView(key.buffer, key.byteOffset, 16);
  return stateOf(
    dv.getUint32(4, true) ^ K,
    dv.getUint32(8, true) ^ K,
    dv.getUint32(12, true) ^ K,
    dv.getUint32(0, true) ^ K,
  );
}

/* ---- the bootloader's key table ----------------------------------------- */

export interface KeyPair {
  readonly keyA: Uint8Array;
  readonly keyB: Uint8Array;
}

export interface KeyTableCandidate extends KeyPair {
  /** Offset of the anchor word within the scanned block. */
  readonly offset: number;
}

export interface PickedKeyTable extends KeyTableCandidate {
  readonly matchA: boolean;
  readonly matchB: boolean;
}

/**
 * Key A and Key B live in the bootloader's .data image, in clear, as
 * `{ g_boot_config_base = 0x14010000, keyA[16], keyB[16] }`. The offset moves
 * between builds, so the anchor word is used and every hit is offered as a
 * candidate; `pickKeyTable` decides which one is real.
 */
export function findKeyCandidates(
  block: Uint8Array,
  bootConfigBase: number = BOOT_CONFIG_BASE,
): KeyTableCandidate[] {
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const anchor = bootConfigBase >>> 0;
  /* Flash-region prefix (0x14 for these parts): the OTHER 0x14010000 in flash
   * is the slot-address table, which is followed by more flash pointers rather
   * than by key material. */
  const regionPrefix = anchor >>> 24;
  const out: KeyTableCandidate[] = [];
  for (let o = 0; o + 36 <= block.length; o += 4) {
    if (dv.getUint32(o, true) !== anchor) continue;
    if (dv.getUint32(o + 4, true) >>> 24 === regionPrefix) continue;
    out.push({ offset: o, keyA: block.slice(o + 4, o + 20), keyB: block.slice(o + 20, o + 36) });
  }
  return out;
}

/**
 * Pick the candidate whose Key A or Key B reproduces a state already recovered
 * from a slot by GF(2) solve. That is an exact 128-bit match, so it cannot be a
 * coincidence, and it needs no trust in the offset.
 */
export function pickKeyTable(
  candidates: readonly KeyTableCandidate[],
  states: readonly Xorshift128State[],
  whiteningK: number,
): PickedKeyTable | null {
  for (const cand of candidates) {
    const stateA = stateFromKey(cand.keyA, whiteningK);
    const stateB = stateFromKey(cand.keyB, whiteningK);
    const matchA = states.some((st) => sameState(st, stateA));
    const matchB = states.some((st) => sameState(st, stateB));
    if (matchA || matchB) return { ...cand, matchA, matchB };
  }
  return null;
}

export interface StoreKey {
  readonly name: string;
  readonly key: Uint8Array | null;
  readonly programmed: boolean;
}

/**
 * `prng_seed_keyB_or_device()`: a real key programmed at 0x14000218 wins, and
 * an all-00 or all-FF slot means "blank", so Key B is used. This is the only
 * other key the bootloader will ever try besides Key A.
 */
export function storeKeyOf(deviceKeySlot: Uint8Array | null, keyTable: KeyPair | null): StoreKey {
  const programmed =
    !!deviceKeySlot &&
    deviceKeySlot.length === 16 &&
    !deviceKeySlot.every((b) => b === 0xff) &&
    !deviceKeySlot.every((b) => b === 0);
  return programmed
    ? { name: 'per-device key', key: deviceKeySlot, programmed: true }
    : { name: 'Key B', key: keyTable ? keyTable.keyB : null, programmed: false };
}

export interface SlotKeyEvidence {
  /** The state recovered from this slot, or null when recovery did not run. */
  readonly state: Xorshift128State | null;
  /** Whether the decrypted slot hit the bootloader's acceptance sum. */
  readonly accepts: boolean;
}

export interface KeyIdentity {
  readonly name: string | null;
  readonly bootable: boolean;
}

/**
 * Which key encrypted this slot, and — separately — whether the BOOTLOADER can
 * do anything with it.
 *
 * These are not the same question, and conflating them is misleading. The GF(2)
 * solve recovers whatever keystream the slot was written with, so a slot always
 * "decrypts" and can pass the acceptance sum under its own key.
 * `image_try_keys()` is narrower: it tries the store key, then Key A, and
 * nothing else. A slot written under any third key checksums perfectly and is
 * still dead weight — the bootloader has no way to derive that key and skips it.
 */
export function identifyKey(
  slot: SlotKeyEvidence,
  table: KeyPair | null,
  store: StoreKey | null,
  whiteningK: number,
): KeyIdentity {
  const recovered = slot.state;
  if (!recovered) return { name: null, bootable: false };
  const is = (k: Uint8Array | null): boolean =>
    !!k && k.length === 16 && sameState(recovered, stateFromKey(k, whiteningK));
  let name: string | null = null;
  if (table && is(table.keyA)) name = 'Key A';
  else if (table && is(table.keyB)) name = 'Key B';
  else if (store?.programmed && is(store.key)) name = 'per-device key';
  /* With no store key resolved we cannot say what the bootloader would try, so
   * only Key A is provably usable. Never guess "bootable" — that is the claim
   * this whole function exists to stop being made loosely. */
  const storeName = store ? store.name : null;
  const bootable = !!(slot.accepts && name && (name === 'Key A' || name === storeName));
  return { name: name ?? 'unknown key', bootable };
}

/* ---- the application's own embedded key table ---------------------------- *
 *
 * A firmware image carries its own g_keyA/g_keyB, and once it runs THOSE are
 * the keys it uses: Key A to decrypt an upload, Key B to re-encrypt it into
 * flash.
 *
 * The keys are locatable by value but not by offset — the pair has been found
 * at 0xf54, 0x9670, 0x9a10, 0x9a3c, 0x9a40 and 0xb484 across builds, with no
 * constant word around them to anchor on. What makes a value search safe is
 * uniqueness: each key must occur exactly once in the image, so there is no
 * ambiguity about which bytes to rewrite. They are usually adjacent, but that
 * is NOT required — a build is free to place them apart, and each is patched
 * where it is found. (An anchor-based read of the word that precedes the pair
 * in the 1.0.3.x images returned a plain data table as a "key pair" on an
 * unencrypted build; that is the mistake uniqueness rules out.)
 * ------------------------------------------------------------------------- */

export interface EmbeddedKeyTable {
  readonly offsetA: number;
  readonly offsetB: number;
  readonly adjacent: boolean;
}

export function findEmbeddedKeyTable(
  plain: Uint8Array,
  keyA: Uint8Array,
  keyB: Uint8Array,
): EmbeddedKeyTable | null {
  if (keyA.length !== 16 || keyB.length !== 16) return null;
  const a = findAll(plain, keyA);
  if (a.length !== 1) return null;
  const b = findAll(plain, keyB);
  if (b.length !== 1) return null;
  const offsetA = a[0] ?? 0;
  const offsetB = b[0] ?? 0;
  return { offsetA, offsetB, adjacent: offsetB === offsetA + 16 };
}

/** Where the pair lives, for display: one offset when they are adjacent. */
export function keyTableWhere(at: EmbeddedKeyTable): string {
  return at.adjacent ? hexUp(at.offsetA) : `${hexUp(at.offsetA)} and ${hexUp(at.offsetB)}`;
}

/**
 * Why a named key pair is not this image's table. Refusal path only, so the
 * extra scan costs nothing in the normal case.
 */
export function describeKeyTableMismatch(
  plain: Uint8Array,
  keyA: Uint8Array,
  keyB: Uint8Array,
): string {
  const a = findAll(plain, keyA);
  const b = findAll(plain, keyB);
  if (!a.length && !b.length) return 'neither key is anywhere in the image';
  if (!a.length) return `Key A is not in the image at all (Key B is, at ${hexUp(b[0] ?? 0)})`;
  if (!b.length) return `Key B is not in the image at all (Key A is, at ${hexUp(a[0] ?? 0)})`;
  if (a.length > 1) {
    return `Key A appears ${String(a.length)} times, so there is no unambiguous place to rewrite it`;
  }
  return `Key B appears ${String(b.length)} times, so there is no unambiguous place to rewrite it`;
}

/** `-KeyA-<32 hex>-KeyB-<32 hex>` immediately before the extension. */
export const KEY_SUFFIX_RE = /-KeyA-([0-9a-fA-F]{32})-KeyB-([0-9a-fA-F]{32})(?=\.[^.]*$|$)/;

export function keyFilenameSuffix(keyA: Uint8Array, keyB: Uint8Array): string {
  return `-KeyA-${bytesToHex(keyA)}-KeyB-${bytesToHex(keyB)}`;
}

/**
 * The pair a decrypted file's name claims to carry. A file whose name does not
 * carry its keys cannot be retargeted safely, so the flash path refuses it
 * rather than guessing.
 */
export function parseKeyFilenameSuffix(fileName: string): KeyPair | null {
  const named = KEY_SUFFIX_RE.exec(fileName);
  if (!named) return null;
  const [, a, b] = named;
  if (a === undefined || b === undefined) return null;
  return { keyA: hexToBytes(a.toLowerCase()), keyB: hexToBytes(b.toLowerCase()) };
}

/* ---- whitening resolution ------------------------------------------------ */

export interface WhiteningResolution {
  readonly whiteningK: number;
  /** `plaintext` when the key in that form is physically in the image. */
  readonly evidence: 'plaintext' | 'profile-default';
  readonly keyHex: string;
}

/**
 * Which whitening constant this build actually uses — decided by evidence, not
 * by the acceptance sum.
 *
 * The original paired K with the acceptance TARGET in one `DEC_PROFILES` entry
 * (`K=13579BDF <-> sum=FFFF`, `K=0 <-> sum=0`). Measured 2026-09-02: those are
 * INDEPENDENT axes. `32K_43X0_1.3.0.8_COMPACT-16HZ` has acceptance sum
 * 0x0000FFFF, so the original reports its key as `82e2d36a...` — yet the
 * image's own plaintext contains the UNWHITENED (K=0) form
 * `5d7984797c47eb93...` exactly once, at 0xb484, with a plausible g_keyB right
 * after it. That build is sum=FFFF with no whitening at all.
 *
 * So: derive the key under each candidate K and keep the form the image itself
 * contains. Uniqueness is what makes this sound, exactly as in
 * `findEmbeddedKeyTable` — a form that occurs twice is not evidence of
 * anything. K is unidentifiable from ciphertext alone, so when no form occurs
 * (a build that derives its key at runtime, or stores it elsewhere) the
 * profile's own K is reported and the caller is told the difference.
 *
 * By convention `candidateKs[0]` is the profile's K: it is both tried first —
 * so it wins a tie if two forms somehow both occur once — and used as the
 * fallback.
 */
export function resolveWhitening(
  plain: Uint8Array,
  state: Xorshift128State,
  candidateKs: readonly number[],
): WhiteningResolution {
  for (const K of candidateKs) {
    const key = keyFromState(state, K);
    if (findAll(plain, key).length === 1) {
      return { whiteningK: K, evidence: 'plaintext', keyHex: bytesToHex(key) };
    }
  }
  const fallbackK = candidateKs[0] ?? 0;
  return {
    whiteningK: fallbackK,
    evidence: 'profile-default',
    keyHex: bytesToHex(keyFromState(state, fallbackK)),
  };
}

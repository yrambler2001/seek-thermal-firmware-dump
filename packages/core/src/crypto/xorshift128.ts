/* ==================================================================== *
 * Marsaglia xorshift128 (shifts 11/8/19) — the whole of the Seek firmware
 * cipher. The bootloader seeds it from a stored 16-byte key and XORs one
 * keystream word into every image word.
 *
 * There is exactly one implementation of the generator in this package, and
 * every loop calls it. Two hand-inlined copies that drift apart by one shift
 * would produce a payload that flashes and never boots, which is the one
 * failure mode this library exists to prevent — the few nanoseconds a call
 * costs per word are not worth that risk.
 * ==================================================================== */

/**
 * The generator's 128-bit state, `[x, y, z, w]`. Always exactly four words;
 * shorter arrays read as zero rather than `undefined`.
 */
export type Xorshift128State = Uint32Array;

/** Advances `s` in place and returns the next keystream word. */
export function xsNext(s: Xorshift128State): number {
  const x = s[0] ?? 0;
  const v1 = (x ^ (x << 11)) >>> 0;
  s[0] = s[1] ?? 0;
  s[1] = s[2] ?? 0;
  const w = s[3] ?? 0;
  s[2] = w;
  const v3 = (w ^ (w >>> 19) ^ v1 ^ (v1 >>> 8)) >>> 0;
  s[3] = v3;
  return v3 >>> 0;
}

/** A private copy, so a caller's state is never advanced behind its back. */
export function cloneState(state: Xorshift128State): Xorshift128State {
  return Uint32Array.from(state);
}

export function stateOf(x: number, y: number, z: number, w: number): Xorshift128State {
  return Uint32Array.of(x >>> 0, y >>> 0, z >>> 0, w >>> 0);
}

/** Exact 128-bit equality. Two states that agree here decrypt identically. */
export function sameState(a: Xorshift128State | null, b: Xorshift128State | null): boolean {
  return !!a && !!b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
}

/**
 * Ergonomic wrapper for the places that pull a handful of words (probes,
 * consistency checks). It clones on construction; the hot paths in `cipher.ts`
 * call `xsNext` directly instead.
 */
export class Xorshift128 {
  readonly state: Xorshift128State;

  constructor(state: Xorshift128State) {
    this.state = cloneState(state);
  }

  next(): number {
    return xsNext(this.state);
  }

  /** The keystream word at `index`, counting from 0, having consumed all before it. */
  wordAt(index: number): number {
    let out = 0;
    for (let i = 0; i <= index; i++) out = xsNext(this.state);
    return out;
  }
}

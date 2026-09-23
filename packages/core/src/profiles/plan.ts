/**
 * From a firmware's own selector table to what a dump reads.
 *
 * One rule, stated once: a block is read through a selector ONLY when that
 * firmware's table gives that selector that block as a constant, and every
 * other block is a gap with a reason. The plan cannot put bytes at an address
 * their selector does not arm, because the address comes from the row.
 */

import { hex } from '../bytes.js';
import type { SelectorRow, UnreachableRange, WindowEntry, WindowPlan } from './types.js';

export interface WindowPlanInput {
  readonly table: string;
  readonly firmwareVersion: string | null;
  readonly selectors: readonly SelectorRow[];
  /**
   * A reason for every block no usable row reaches, and for nothing else.
   * Checked against the rows: a table whose holes and rows disagree is a
   * programming error and throws, so a reason cannot outlive the fact it
   * explains.
   */
  readonly holes: readonly UnreachableRange[];
  readonly flashBase: number;
  readonly flashSize: number;
  readonly windowSize: number;
  /** The payload for an authenticated row. Required when any usable row is `auth`. */
  readonly authPayload?: (subcmd: number) => Uint8Array;
  /** Mark plain entries `auth: false` explicitly, as the legacy map always has. */
  readonly markPlain?: boolean;
}

/** Plain beats the token channel, then the lowest subcommand: the cheapest door. */
function preference(a: SelectorRow, b: SelectorRow): number {
  if (a.channel !== b.channel) return a.channel === 'plain' ? -1 : 1;
  return a.subcmd - b.subcmd;
}

export function buildWindowPlan(input: WindowPlanInput): WindowPlan {
  const { flashBase, flashSize, windowSize } = input;
  const windows: WindowEntry[] = [];
  const uncovered: number[] = [];

  for (let address = flashBase; address < flashBase + flashSize; address += windowSize) {
    const row = input.selectors
      .filter((r) => r.address === address && r.channel !== 'refused')
      .sort(preference)[0];
    if (row === undefined) {
      uncovered.push(address);
      continue;
    }
    if (row.channel === 'auth') {
      if (input.authPayload === undefined) {
        throw new Error(`${input.table}: subcmd ${hex(row.subcmd)} needs a token and none is set`);
      }
      windows.push({
        subcmd: row.subcmd,
        address,
        auth: true,
        note: row.note,
        payload: input.authPayload(row.subcmd),
      });
    } else if (input.markPlain === true) {
      windows.push({ subcmd: row.subcmd, address, auth: false, note: row.note });
    } else {
      windows.push({ subcmd: row.subcmd, address, note: row.note });
    }
  }

  const holeBlocks = new Set<number>();
  for (const hole of input.holes) {
    for (let a = hole.address; a < hole.address + hole.length; a += windowSize) {
      if (holeBlocks.has(a)) throw new Error(`${input.table}: two holes claim ${hex(a, 8)}`);
      holeBlocks.add(a);
    }
  }
  const unexplained = uncovered.filter((a) => !holeBlocks.has(a));
  const covered = [...holeBlocks].filter((a) => !uncovered.includes(a));
  if (unexplained.length > 0 || covered.length > 0) {
    throw new Error(
      `${input.table}: holes and rows disagree — no reason for ` +
        `[${unexplained.map((a) => hex(a, 8)).join(', ')}], and a reason for readable ` +
        `[${covered.map((a) => hex(a, 8)).join(', ')}]`,
    );
  }

  return {
    firmwareVersion: input.firmwareVersion,
    table: input.table,
    selectors: input.selectors,
    windows,
    unreachable: [...input.holes].sort((a, b) => a.address - b.address),
  };
}

/**
 * The rows every table agrees on; a subcommand they disagree about keeps no
 * address, so nothing is read through it.
 *
 * This is what a profile uses when it cannot tell which of its builds it is
 * talking to. It is deliberately not "the most common answer": a build outside
 * the corpus, or one whose version did not come back, is exactly the case in
 * which a majority vote would write one build's block under another's address.
 */
export function agreedRows(
  tables: readonly (readonly SelectorRow[])[],
  why: (subcmd: number) => string,
): readonly SelectorRow[] {
  const first = tables[0];
  if (first === undefined) return [];
  return first.map((row) => {
    const rows = tables.map((t) => t.find((r) => r.subcmd === row.subcmd));
    const same = rows.every((r) => r?.address === row.address && r.channel === row.channel);
    return same
      ? row
      : { subcmd: row.subcmd, address: null, channel: row.channel, note: why(row.subcmd) };
  });
}

/** Subcommand -> the block it arms, for the rows a sweep may place bytes from. */
export function placeableAddresses(plan: WindowPlan): ReadonlyMap<number, number> {
  const out = new Map<number, number>();
  for (const row of plan.selectors) {
    if (row.address !== null && row.channel !== 'refused') out.set(row.subcmd, row.address);
  }
  return out;
}

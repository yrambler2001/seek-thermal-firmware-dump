/* ==================================================================== *
 * The bits both emulator suites share: what is available, what is
 * expected, how much runs at once, and how the result matrix is printed.
 *
 * SKIPPING IS A FIRST-CLASS OUTCOME. Nobody cloning this repository has the
 * emulator, and CI never will. `SEEK_EMU_DIR` absent (or pointing at nothing)
 * must produce a loud skip on stderr and a clean exit, exactly as the dump
 * corpus does — a suite that goes red for a missing optional input teaches
 * people to ignore red.
 * ==================================================================== */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { emulatorDir, loadManifest, type ManifestEntry } from './harness.js';

/* ---- availability ---------------------------------------------------- */

export const EMU_DIR = emulatorDir();

export function announceSkip(what: string): void {
  process.stderr.write(
    `\n[skip] ${what}: no emulator found. Set SEEK_EMU_DIR to a FW-V1 'emu' directory ` +
      `(one holding seek_emu.py and .venv/bin/python) to run it.\n`,
  );
}

export const ENTRIES: readonly ManifestEntry[] = EMU_DIR === null ? [] : loadManifest(EMU_DIR);

/* ---- the fill ---------------------------------------------------------
 *
 * The whole point of the round trip is that a returned byte can be told apart
 * from a byte that never arrived. Over erased flash it cannot: 70-96% of a real
 * Seek part is 0xFF, so a dump that lost a window still compares clean over most
 * of its length. `--fill-erased` replaces every wholly-erased 4 KB granule with a
 * seeded stream before the firmware boots, which makes a gap a diff.
 *
 * SEED AND SCOPE ARE PINNED, NOT TUNED — AND `safe` IS NOT THE TIMID CHOICE,
 * IT IS THE MEASURED ONE. The emulator's 51-firmware matrix was run three times,
 * at no fill, at `safe` and at `all`. `safe` reproduced the unfilled run exactly:
 * same tier, same USB identity, same RPC reply bytes, same decrypt, on all 51.
 * `all` did not — 18 of them (every 2014-2017 Compact) stopped enumerating, and
 * bisecting the protected set pinned it on the erased tail of the BOOT-CONFIG
 * BLOCK at 0x14011000..0x1401FFFF, which that firmware reads and expects blank.
 * So `safe` is what this suite uses; `all` is available and is a documented way
 * to reproduce that regression, not a better default.
 *
 * The cost of `safe` is stated rather than hidden: it leaves 429-780 KB of each
 * part still 0xFF (10-19%), and every run records exactly how much in
 * `bytesStillErased`. Those bytes remain ambiguous between "erased" and "never
 * transferred"; the other 81-90% no longer are.
 */
export const FILL_SEED = Number(process.env.SEEK_EMU_FILL_SEED ?? '388609'); /* 0x5EE01 */
export const FILL_SCOPE = (process.env.SEEK_EMU_FILL_SCOPE ?? 'safe') as 'safe' | 'all';

/* ---- timeouts ---------------------------------------------------------
 *
 * TENS OF SECONDS, DELIBERATELY. The emulator is roughly three orders of
 * magnitude slower than silicon; a 2 s default is exactly what defeated an
 * earlier capture tool against it (FW-V1 emu/hostbridge/README.md). These are
 * ceilings on failure, not waits: nothing here sleeps to make a test pass.
 */
export const BOOT_TIMEOUT_MS = Number(process.env.SEEK_EMU_BOOT_TIMEOUT_MS ?? '180000');
export const URB_TIMEOUT_MS = Number(process.env.SEEK_EMU_URB_TIMEOUT_MS ?? '30000');
/**
 * 900 s, and the reason is measured rather than chosen.
 *
 * Most firmwares probe in 5-10 s. The slowest do not: on a build whose
 * `GetOperationMode` never reads back 0, every one of the 63 selector arms pays
 * `ensureMode0()`'s full three-second settle before it can fail, which is ~190 s
 * of deliberate waiting by the toolkit's own design. At 300 s two firmwares hit
 * the wall. This is a ceiling on failure, not a wait: nothing sleeps to make a
 * test pass, and no number here was moved until a result looked right.
 *
 * MEASURED SINCE, so the headroom is stated rather than guessed: with the
 * emulator's gated clock (FW-V1 docs/EMULATOR.md sec.13.8) the slowest rows are
 * the 2014 Compacts at ~330 s, and they cost the same under deliberate CPU load,
 * because a gated emulator that is waiting costs no CPU at all. 900 s is ~2.7x
 * the worst row and, unlike before, that margin does not shrink with load.
 */
export const TIER1_TIMEOUT_MS = Number(process.env.SEEK_EMU_TIER1_TIMEOUT_MS ?? '900000');
export const TIER2_TIMEOUT_MS = Number(process.env.SEEK_EMU_TIER2_TIMEOUT_MS ?? '1800000');

/** Read chunk for the dump. 64 B is the toolkit's own default and the size that
 *  works on every camera; a larger one is faster and is reported when used. */
export const READ_CHUNK = Number(process.env.SEEK_EMU_CHUNK ?? '64');

/* ---- scratch space ---------------------------------------------------- */

const SCRATCH = path.join(tmpdir(), `seek-emu-suite-${String(process.pid)}`);

export function scratchFile(name: string): string {
  mkdirSync(SCRATCH, { recursive: true });
  return path.join(SCRATCH, name.replace(/[^\w.-]+/g, '_'));
}

/* ---- expectations ------------------------------------------------------
 *
 * GENERATED FROM MEASUREMENT, NEVER WRITTEN BY HAND. `scripts/update-emulator-
 * expectations.mjs` re-runs these very suites with SEEK_EMU_REGEN=1 and writes
 * what they observed, so an expectation cannot claim something the measurement
 * never made. Read the diff: a change here is a change in what real firmware
 * does over a real transport, not a routine update.
 *
 * A firmware that could not be measured is recorded with a `gap` carrying the
 * reason. The suite then runs it under `test.fails`, so the gap is a TRACKED
 * EXPECTATION: it stays green while it is still broken, and turns the suite RED
 * the day it starts working, which is the prompt to promote it.
 */

export interface KnownGap {
  readonly reason: string;
}

export interface ExpectationFile<T> {
  readonly note: string;
  readonly generatedBy: string;
  readonly fill: { readonly seed: number; readonly scope: string };
  readonly readChunk: number;
  readonly firmwares: Record<string, T & { readonly gap: KnownGap | null }>;
}

export const RPC_EXPECTATIONS = path.join(import.meta.dirname, 'expectations.rpc.json');
export const ROUNDTRIP_EXPECTATIONS = path.join(import.meta.dirname, 'expectations.roundtrip.json');

export function loadExpectations<T>(file: string): ExpectationFile<T> | null {
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, 'utf8')) as ExpectationFile<T>;
}

/** True when the suite is regenerating rather than asserting. */
export const REGENERATING = process.env.SEEK_EMU_REGEN === '1';

export function writeExpectations<T>(file: string, doc: ExpectationFile<T>): void {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(doc.firmwares).sort()) sorted[key] = doc.firmwares[key];
  writeFileSync(file, `${JSON.stringify({ ...doc, firmwares: sorted }, null, 2)}\n`);
  process.stderr.write(`\nexpectations written to ${file}\n`);
}

/* ---- the summary matrix ------------------------------------------------ */

export interface SummaryRow {
  readonly entryId: string;
  readonly family: string;
  readonly product: string;
  readonly version: string;
  readonly tier: 'tier1' | 'tier2';
  readonly status: 'supported' | 'known-gap' | 'failed';
  readonly detail: string;
  readonly seconds: number;
}

const rows: SummaryRow[] = [];

export function record(row: SummaryRow): void {
  rows.push(row);
}

export function summaryRows(): readonly SummaryRow[] {
  return rows;
}

/**
 * The work-in-progress picture at a glance: supported vs known-gap per family.
 * Printed to stderr, because stdout belongs to the reporter.
 */
export function printMatrix(title: string): void {
  if (rows.length === 0) return;
  const families = [...new Set(rows.map((r) => r.family))].sort();
  const out: string[] = ['', `--- ${title} ---`];
  out.push('family                supported  known-gap  failed  slowest');
  for (const family of families) {
    const mine = rows.filter((r) => r.family === family);
    const slowest = Math.max(...mine.map((r) => r.seconds));
    out.push(
      `${family.padEnd(20)}  ${String(mine.filter((r) => r.status === 'supported').length).padStart(9)}  ` +
        `${String(mine.filter((r) => r.status === 'known-gap').length).padStart(9)}  ` +
        `${String(mine.filter((r) => r.status === 'failed').length).padStart(6)}  ` +
        `${slowest.toFixed(1)}s`,
    );
  }
  const total = rows.length;
  const ok = rows.filter((r) => r.status === 'supported').length;
  const gap = rows.filter((r) => r.status === 'known-gap').length;
  const bad = total - ok - gap;
  out.push(
    `${'TOTAL'.padEnd(20)}  ${String(ok).padStart(9)}  ${String(gap).padStart(9)}  ` +
      String(bad).padStart(6),
  );
  out.push('');
  for (const row of [...rows].sort((a, b) => b.seconds - a.seconds)) {
    out.push(
      `  ${row.seconds.toFixed(1).padStart(7)}s  ${row.status.padEnd(10)}  ` +
        `${row.entryId.slice(0, 62).padEnd(62)}  ${row.detail}`,
    );
  }
  out.push('');
  process.stderr.write(out.join('\n'));
}

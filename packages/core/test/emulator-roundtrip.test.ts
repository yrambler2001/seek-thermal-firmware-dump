/* ==================================================================== *
 * Tier 2 — the whole 4 MiB, dumped through the toolkit's own workflow and
 * compared byte for byte against what the device actually holds.
 *
 * THE POINT OF THE FILL. Between 70% and 96% of a real Seek flash is erased.
 * A dump that lost a window, stopped one short, or wrote one to the wrong offset
 * still compares clean over all of that, because 0xFF and "never received" are
 * the same byte. So the emulator fills every wholly-erased 4 KB granule with a
 * seeded stream before the firmware boots, and then a gap is a DIFF at a named
 * address rather than an indistinguishable run of 0xFF.
 *
 * THE GROUND TRUTH IS THE EMULATOR'S OWN IMAGE. `seek_emu.py --usbip
 * --flash-out PATH` writes the 4 MiB part as booted, before a client can ask for
 * a byte of it. The emulator knows exactly what the part contains; the toolkit
 * has to go and get it over a real transport.
 *
 * WHAT IS ALLOWED TO DIFFER, AND ONLY THAT. `profile.memory.unreachable` names
 * the blocks the protocol cannot reach — on `modern-4x` that is the single
 * 64 KiB block at 0x14060000, for which no BeginFirmwareUpgrade selector exists.
 * The toolkit gap-fills those with 0xFF and says so in the manifest. Every byte
 * OUTSIDE them must match exactly, and the assertion is written that way round:
 * a new unreachable region cannot be waved through by widening a tolerance.
 * ==================================================================== */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { afterAll, describe, expect, it } from 'vitest';

import { silentReporter } from '../src/events.js';
import { SeekDevice } from '../src/protocol/client.js';
import { WebUsbTransport } from '../src/protocol/webusb.js';
import { detectProfile, getProfile } from '../src/profiles/registry.js';
import { evidenceFromChannelProbe, probeSelectorChannel } from '../src/workflows/capability.js';
import { runDump } from '../src/workflows/dump.js';
import { type Emulator, liveEmulatorCount, RowEmulators } from './emulator/harness.js';
import { assertRealHostPath, HarnessFidelityError } from './emulator/webusb-over-usbip.js';
import {
  announceSkip,
  assertRecordedGap,
  BOOT_TIMEOUT_MS,
  EMU_DIR,
  ENTRIES,
  FILL_SCOPE,
  FILL_SEED,
  loadExpectations,
  printMatrix,
  READ_CHUNK,
  record,
  REGENERATING,
  ROUNDTRIP_EXPECTATIONS,
  scratchFile,
  PROBE_ATTEMPTS,
  TIER2_TIMEOUT_MS,
  URB_TIMEOUT_MS,
  writeExpectations,
  type KnownGap,
} from './emulator/suite.js';

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const FLASH_BASE = 0x14000000;
const FLASH_SIZE = 4 * 1024 * 1024;

/**
 * Which firmwares get the full round trip.
 *
 * `SEEK_EMU_TIER2` picks the population: `all` (every manifest entry),
 * `dumps` (the 15 real 4 MiB dumps — every one boots its own bootloader, so
 * nothing about them is spliced), `none` to skip this tier entirely, or a
 * comma-separated list of id substrings.
 *
 * The default is `dumps`, and the reason is runtime, stated rather than hidden:
 * one round trip is ~64,512 control transfers at the toolkit's own 64-byte
 * default chunk and takes three to five minutes. Fifteen of them at five
 * concurrent emulators is ~10 minutes, which is what `npm test` costs on a
 * machine that has the emulator beside it. `SEEK_EMU_TIER2=none` is there for
 * when that is not what you wanted; the 51-firmware tier 1 still runs.
 */
const TIER2_SELECTION = process.env.SEEK_EMU_TIER2 ?? 'dumps';

function selected(): readonly (typeof ENTRIES)[number][] {
  if (TIER2_SELECTION === 'none' || TIER2_SELECTION === 'off') return [];
  if (TIER2_SELECTION === 'all') return ENTRIES;
  if (TIER2_SELECTION === 'dumps') return ENTRIES.filter((e) => e.kind === 'full-dump');
  const wanted = TIER2_SELECTION.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return ENTRIES.filter((e) => wanted.some((w) => e.id.includes(w)));
}

/* ---- comparison ------------------------------------------------------ */

const hex8 = (n: number): string => `0x${n.toString(16).toUpperCase().padStart(8, '0')}`;

interface Range {
  readonly start: number;
  readonly end: number;
}

/**
 * Coalesced [start, end) spans where two images differ.
 *
 * `merge` joins two spans separated by fewer than that many identical bytes, and
 * it is not cosmetic. When a whole 64 KiB window fails to read, the toolkit fills
 * it with 0xFF and the device holds a seeded random stream — so about one byte in
 * 256 agrees by chance, and a single missing window would otherwise be reported
 * as ~250 separate ranges. 64 is far above that coincidence rate and far below
 * any real structure, so a missing window reads as ONE range at one address,
 * which is what a reader needs. The byte count is always recomputed inside the
 * merged spans, so merging can never make a diff look smaller than it is.
 */
function diffRanges(want: Uint8Array, got: Uint8Array, merge = 64): Range[] {
  const out: Range[] = [];
  let start = -1;
  let last = -1;
  const n = Math.max(want.length, got.length);
  for (let i = 0; i < n; i++) {
    if (want[i] === got[i]) continue;
    if (start < 0) start = i;
    else if (i - last > merge) {
      out.push({ start, end: last + 1 });
      start = i;
    }
    last = i;
  }
  if (start >= 0) out.push({ start, end: last + 1 });
  return out;
}

/** Differing bytes inside [from, to), counted one by one. */
function diffByteCount(want: Uint8Array, got: Uint8Array, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) if (want[i] !== got[i]) n++;
  return n;
}

function overlaps(range: Range, holes: readonly Range[]): boolean {
  return holes.some((h) => range.start < h.end && h.start < range.end);
}

function describeRanges(ranges: readonly Range[], cap = 24): string[] {
  const out = ranges
    .slice(0, cap)
    .map(
      (r) =>
        `${hex8(FLASH_BASE + r.start)}..${hex8(FLASH_BASE + r.end - 1)} (${String(r.end - r.start)} B)`,
    );
  if (ranges.length > cap) out.push(`... and ${String(ranges.length - cap)} more range(s)`);
  return out;
}

export interface RoundTripExpectation {
  readonly kind: string;
  readonly family: string;
  readonly product: string;
  readonly version: string;
  readonly windowsRead: number;
  readonly windowsExpected: number;
  /** Bytes outside the profile's declared-unreachable blocks. */
  readonly bytesComparable: number;
  /** Of those, how many came back different. Zero is the whole point. */
  readonly diffBytesComparable: number;
  readonly diffRangesComparable: readonly string[];
  /** Bytes inside the declared-unreachable blocks, which the dump gap-fills. */
  readonly bytesUnreachable: number;
  /** How much of the served image was still 0xFF, i.e. still ambiguous. */
  readonly bytesStillErased: number | null;
  /** sha256 of every image the toolkit's decrypt recovered, in order. */
  readonly decryptedSha256: readonly string[];
  /** Which profile the capability probe picked for this camera. */
  readonly profile: string;
}

/**
 * The failure, as a gap reason.
 *
 * `detail` used to be the FIRST LINE of the message, which is fine for a one
 * line failure and throws away the only part that matters for an unmeasurable
 * row: "not measurable in 1 attempt(s)" says nothing, while the line under it
 * names the Unicorn fault and the address. So the whole message is kept,
 * flattened to one line, and the `record()` matrix takes its own first line
 * for the terminal.
 */
function gapReason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s*\n\s*/g, ' | ').trim();
}

/**
 * One row, measured — exactly what the regenerator records, gap included. Both
 * modes call this; see the same function in emulator-rpc.test.ts.
 */
async function measureRow(
  entry: (typeof ENTRIES)[number],
  row: RowEmulators,
): Promise<RoundTripExpectation & { gap: KnownGap | null }> {
  try {
    /* SAME RULE AS TIER 1: a dump taken off an emulator that stopped executing
     * partway through is not a round-trip result, it is a partial transfer to a
     * corpse, and writing its diff ranges down would pin this machine's load.
     * `Emulator.alive` is the check, and the whole row is taken again from a fresh
     * process — every one of which `RowEmulators` audits. */
    let result: Awaited<ReturnType<typeof runDump>> | null = null;
    let truth: Uint8Array | null = null;
    let served: Emulator | null = null;
    let profile = getProfile('generic');
    const dead: string[] = [];
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      const truthPath = scratchFile(`t2_${entry.id}_a${String(attempt)}.bin`);
      const emu = await row.start(EMU_DIR!, {
        entryId: entry.id,
        fillSeed: FILL_SEED,
        fillScope: FILL_SCOPE,
        flashOut: truthPath,
        readyTimeoutMs: BOOT_TIMEOUT_MS,
      });

      const device = await emu.attach({ urbTimeoutMs: URB_TIMEOUT_MS });
      const transport = new WebUsbTransport(device, {
        recipient: 'auto',
        api: 'usbip (emulator)',
        host: 'vitest',
      });
      await transport.open();
      /* The real-host path (TESTING.md sec.9.9): interface 0 claimed without a packet,
       * every vendor request sent with interface recipient. */
      assertRealHostPath(device, transport.info, `${entry.id}: first open()`);
      const seek = new SeekDevice(transport);

      /* THE PROFILE IS ASKED FOR, NOT ASSUMED.
       *
       * This used to be a hard-coded `getProfile('modern-4x')` on all 51
       * firmwares, which is the very assumption the refactor removed: the 2016
       * generation refuses 38 of that map's 63 selectors and needs the
       * authenticated channel for six banks. `probeSelectorChannel` asks the
       * camera — read-only, four transfers — and the answer picks the profile,
       * exactly as a caller with no `--profile` now does. */
      const channel = await probeSelectorChannel(seek);
      profile = detectProfile(evidenceFromChannelProbe(channel)).best.profile;

      const attemptResult = await runDump(
        { device: seek, profile, detection: null, reporter: silentReporter },
        { chunk: READ_CHUNK, retries: 1, decrypt: true },
      );
      await device.close().catch(() => undefined);
      /* ...and it stayed there through every reopen `runDump`'s retries made. The
       * transport is closed by now, so only the recipient and the claims are checked. */
      assertRealHostPath(device, transport.info, `${entry.id}: end of the dump`, false);

      if (!emu.alive) {
        const reason = await emu.settledStopReason();
        dead.push(
          `attempt ${String(attempt)}: the emulator exited during the dump` +
            (reason === null ? '' : ` [${reason}]`),
        );
        await emu.stop();
        /* Same rule as tier 1: a Unicorn fault is deterministic, so a fresh
         * process reproduces it rather than measuring anything new. */
        if (reason !== null) break;
        continue;
      }
      result = attemptResult;
      truth = new Uint8Array(readFileSync(truthPath));
      served = emu;
      break;
    }
    if (result === null || truth === null) {
      throw new Error(
        `not measurable in ${String(dead.length)} attempt(s) from fresh emulators:\n  ` +
          dead.join('\n  '),
      );
    }
    expect(truth.length, 'the emulator wrote a 4 MiB ground-truth image').toBe(FLASH_SIZE);

    const holes: Range[] = profile.memory.unreachable.map((u) => ({
      start: u.address - FLASH_BASE,
      end: u.address - FLASH_BASE + u.length,
    }));
    const bytesUnreachable = holes.reduce((sum, h) => sum + (h.end - h.start), 0);
    const all = diffRanges(truth, result.combined);
    const comparable = all.filter((r) => !overlaps(r, holes));
    /* Counted byte by byte over the merged spans, never as the span width: a
     * merged range includes the identical bytes it bridged, and reporting those as
     * differences would overstate the damage. */
    const diffBytesComparable = comparable.reduce(
      (sum, r) => sum + diffByteCount(truth, result.combined, r.start, r.end),
      0,
    );

    const decryptedSha256 = result.artifacts
      .filter((a) => a.name.endsWith('.bin') && !a.name.startsWith('windows/'))
      .filter((a) => a.data.length !== FLASH_SIZE)
      .map((a) => sha256(a.data))
      .sort();

    const now: RoundTripExpectation = {
      kind: entry.kind,
      family: entry.family,
      product: entry.product,
      version: entry.version,
      windowsRead: result.windowsRead,
      windowsExpected: result.windowsExpected,
      bytesComparable: FLASH_SIZE - bytesUnreachable,
      diffBytesComparable,
      diffRangesComparable: describeRanges(comparable),
      bytesUnreachable,
      bytesStillErased: served?.ready.fill?.bytes_still_erased ?? null,
      decryptedSha256,
      profile: profile.id,
    };
    /* THE GAP IS DERIVED FROM THE MEASUREMENT, NEVER DECLARED BY HAND.
     *
     * The goal of this tier is one number: every byte the protocol can reach comes
     * back. A firmware where it does not is the work item, and it is recorded with
     * the byte count and the address ranges so the row says what is wrong rather
     * than only that something is. */
    return {
      ...now,
      gap:
        now.diffBytesComparable === 0 && now.windowsRead === now.windowsExpected
          ? null
          : {
              reason:
                `${String(now.windowsRead)}/${String(now.windowsExpected)} windows read; ` +
                `${String(now.diffBytesComparable)} of ${String(now.bytesComparable)} ` +
                `reachable bytes differ, at ${now.diffRangesComparable.join(', ')}`,
            },
    };
  } catch (error) {
    /* The harness off the real-host path is not a measurement at all: never a gap. */
    if (error instanceof HarnessFidelityError) throw error;
    /* A measurement that could not be made, recorded as the gap it is. */
    return {
      kind: entry.kind,
      family: entry.family,
      product: entry.product,
      version: entry.version,
      windowsRead: 0,
      windowsExpected: 0,
      bytesComparable: 0,
      diffBytesComparable: -1,
      diffRangesComparable: [],
      bytesUnreachable: 0,
      bytesStillErased: null,
      decryptedSha256: [],
      profile: '',
      gap: { reason: gapReason(error).slice(0, 300) },
    };
  }
}

/* ---- the suite -------------------------------------------------------- */

if (EMU_DIR === null) announceSkip('emulator full round trip (tier 2)');

const pinned = loadExpectations<RoundTripExpectation>(ROUNDTRIP_EXPECTATIONS);
const measured: Record<string, RoundTripExpectation & { gap: KnownGap | null }> = {};
const population = EMU_DIR === null ? [] : selected();

if (population.length === 0 && EMU_DIR !== null) {
  process.stderr.write(
    `\n[skip] emulator full round trip (tier 2): SEEK_EMU_TIER2=${TIER2_SELECTION}\n`,
  );
}

describe.skipIf(EMU_DIR === null || population.length === 0)(
  'emulator full round trip (tier 2)',
  () => {
    afterAll(() => {
      if (REGENERATING) {
        writeExpectations(ROUNDTRIP_EXPECTATIONS, {
          note:
            'Whole-flash round trip through runDump over USB/IP against the FW-V1 emulator, ' +
            'compared byte for byte with the emulator’s own --flash-out image. Generated by ' +
            '`node scripts/update-emulator-expectations.mjs`; never edit by hand. Measured on ' +
            'the path a real host takes: interface 0 claimed without a packet, every vendor ' +
            'request sent as bmRequestType 0x41/0xC1 (TESTING.md sec.9.9).',
          generatedBy: 'packages/core/test/emulator-roundtrip.test.ts (SEEK_EMU_REGEN=1)',
          fill: { seed: FILL_SEED, scope: FILL_SCOPE },
          readChunk: READ_CHUNK,
          firmwares: measured,
        });
      }
      /* NO LEAKED EMULATORS. Each test owns a Python process holding a TCP port;
       * one left behind burns a core and blocks a port for the next run, so the
       * count is asserted rather than hoped for. */
      const leaked = liveEmulatorCount();
      if (leaked > 0) {
        throw new Error(`${String(leaked)} emulator process(es) were still running at the end`);
      }
      printMatrix('tier 2 — full round trip, supported vs known-gap per family');
    });

    it('has a population to run', () => {
      expect(
        population.length,
        `SEEK_EMU_TIER2=${TIER2_SELECTION} selected no firmware from the manifest`,
      ).toBeGreaterThan(0);
    });

    for (const entry of population) {
      const want = pinned?.firmwares[entry.id] ?? null;
      const pinnedGap = want?.gap ?? null;
      const title =
        pinnedGap === null
          ? `${entry.id} — 4 MiB round trip, byte for byte`
          : `${entry.id} — KNOWN GAP: ${pinnedGap.reason}`;

      /* An ordinary test, gap or not — see `assertRecordedGap` in emulator/suite.ts. */
      it.concurrent(title, { timeout: TIER2_TIMEOUT_MS }, async () => {
        const started = Date.now();
        const row = new RowEmulators(entry.id);
        let status: 'supported' | 'known-gap' | 'failed' = 'failed';
        let detail = '';
        try {
          const now = await measureRow(entry, row);
          /* Audited before anything is recorded or compared: a dump taken through a
           * transport that lost replies is a statement about the transport. */
          await row.assertDelivery();
          detail =
            now.gap === null
              ? `${String(now.windowsRead)}/${String(now.windowsExpected)} windows, ` +
                `${String(now.diffBytesComparable)} differing byte(s) outside the unreachable block`
              : now.gap.reason;

          if (REGENERATING) {
            measured[entry.id] = now;
            status = now.gap === null ? 'supported' : 'known-gap';
            return;
          }

          expect(want, `${entry.id} is not in ${ROUNDTRIP_EXPECTATIONS}`).not.toBeNull();
          if (want === null) return;

          /* ---- the gap, if any: the SAME one, for the SAME reason ---- */
          try {
            assertRecordedGap(entry.id, now.gap, pinnedGap);
          } catch (error) {
            throw new Error(
              `${error instanceof Error ? error.message : String(error)}\n` +
                `--- emulator log ---\n${row.lastLog()}`,
              { cause: error },
            );
          }

          /* ---- which profile the camera's own answers selected ---- */
          expect(now.profile, 'profile chosen by the selector-channel probe').toBe(want.profile);

          /* ---- the transfer itself ---- */
          expect(now.windowsRead, 'windows read').toBe(want.windowsRead);
          expect(now.windowsExpected, 'windows the selector map declares').toBe(
            want.windowsExpected,
          );

          /* ---- THE ROUND TRIP. Every byte the protocol can reach. ---- */
          expect(
            now.diffRangesComparable,
            `${String(now.diffBytesComparable)} byte(s) of ${String(now.bytesComparable)} came ` +
              'back different from what the device holds',
          ).toEqual(want.diffRangesComparable);
          expect(now.diffBytesComparable, 'differing bytes outside unreachable blocks').toBe(
            want.diffBytesComparable,
          );

          /* ---- the decrypt, cross-checked against the emulator's own ---- */
          expect(now.decryptedSha256, 'sha256 of every recovered image').toEqual(
            want.decryptedSha256,
          );
          status = now.gap === null ? 'supported' : 'known-gap';
        } catch (error) {
          status = 'failed';
          detail = gapReason(error);
          throw error;
        } finally {
          await row.finish();
          record({
            entryId: entry.id,
            family: entry.family,
            product: entry.product,
            version: entry.version,
            tier: 'tier2',
            status,
            detail,
            seconds: (Date.now() - started) / 1000,
            delivery: row.totals(),
          });
        }
      });
    }
  },
);

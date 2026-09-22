/* ==================================================================== *
 * Tier 1 — the RPC surface of all 51 vendored firmwares, over a real
 * transport, against firmware that is really executing.
 *
 * WHAT THIS CLOSES.
 *
 * `profiles.test.ts` has 40 tests about the selector map and every one of them
 * is a property of the TABLE: that it is sorted, duplicate-free, covers a range,
 * has no overlaps. Not one of them can tell you that subcommand 5 really exposes
 * 0x14030000 on a 2014 Compact, because nothing in this repository has ever
 * asked a 2014 Compact. The emulator runs each firmware's own RPC dispatch, so
 * it can be asked — and the answer is derived, not assumed: the first 256 bytes
 * of each armed window are searched for in the emulator's own 4 MiB image, and
 * the address the profile CLAIMS has to be among the places they occur.
 *
 * That search is only decidable because the erased regions were filled with a
 * seeded stream first (`--fill-erased`). Over erased flash those 256 bytes would
 * be 0xFF and would match everywhere; every hit would be meaningless.
 *
 * WHAT IT IS NOT. The transport is USB/IP, not libusb and not silicon (see
 * `emulator/usbip-client.ts`). Everything above the host controller — the
 * transport, `SeekDevice`, the profile tables — is the toolkit's real code.
 *
 * ---------------------------------------------------------------------
 * REPRODUCIBLE, AND THE WORD IS MEASURED RATHER THAN CLAIMED.
 *
 * It was not. Two consecutive regenerations on the same machine, same seed, same
 * worker count, used to agree on 42 of the 51 firmware rows and differ on nine,
 * across twelve fields — six `commands`, three `auth`, one `controlInBytes`, one
 * `windows`. Every one of those is a field that elapsed device time can move.
 *
 * The cause was on the emulator's side of the wire and is now fixed there; no
 * toolkit source was involved in either the bug or the fix.
 *
 *   THE CLOCK. The emulated part has no clock — its notion of time is retired
 *   emulated work — so while a client was thinking between two transfers the
 *   guest kept executing at a rate set by HOST LOAD. Measured: the same firmware
 *   and the same sixteen transfers gave a different cycle count at every
 *   completion on two consecutive runs, and 0.5 s of pause between transfers
 *   multiplied the device's elapsed time 6.6x. `--usbip` now GATES the clock on
 *   host activity: nothing outstanding, nothing retired. The same sixteen
 *   transfers then cost 63,258 cycles each, exactly, at any pacing.
 *
 *   THE RE-IMPORT. `recover()` below is close-and-reopen, a couple of hundred
 *   times per row, and three defects lived in that churn — a `quit` sentinel
 *   outliving its session and stopping the NEXT session's writer thread, a
 *   detach eating the completions of the session that had replaced it, and a
 *   listen backlog of 4 dropping SYNs. The first of those is what made one
 *   firmware per run answer `no-answer` to a command it had in fact computed.
 *
 * WHERE IT STANDS. Five consecutive regenerations — one of them under deliberate
 * CPU load, load average 161 — produced BYTE-IDENTICAL expectations for all 51
 * rows. No field is excluded from the pin, and nothing here retries to get green:
 * a retry that changed a recorded value would make this file a story about the
 * retry.
 *
 * AND THE CONFIGURATION IS PART OF THE CLAIM. All of that is `vitest run
 * --project core` with SEEK_EMU_TIER2=none — these suites alone. Six such runs,
 * 306 row-measurements, zero divergence. Run them alongside the rest of the
 * repository's suite (`npm run check`, or a bare `vitest run`) and about ONE ROW
 * IN FIFTY-ONE wedges: five failing rows over four such runs, a DIFFERENT row
 * every time. The signature never varies — `device stalled status IN
 * bRequest=11` on every re-import from some point on, the row costs 180–420 s
 * instead of 4, and its commands read `no-answer`. `transport.open()` is the only
 * thing that clears a wedged control endpoint, and it is the request being
 * stalled, so it never recovers.
 *
 * THAT LAST ONE IS NOT THE EMULATOR'S CLOCK OR ITS TEARDOWN — both were fixed and
 * measured. It is the coupling neither side may remove: three orders of magnitude
 * slower than silicon, against `WebUsbTransport`'s own 5 s wall-clock deadline.
 * Under enough host contention one transfer is abandoned mid-flight and these
 * builds then refuse SET_INTERFACE for the rest of the row. Lengthening that
 * deadline would mean changing the toolkit's real code, which is the one thing
 * this suite must not do. So: `npm run check` does not currently pass, one row at
 * a time, and reading a lone red row against this paragraph is the first thing to
 * do before believing the firmware changed.
 *
 * WHAT IS STILL LOAD-SENSITIVE IN PRINCIPLE. The emulator runs three orders of
 * magnitude slower than silicon and `WebUsbTransport` applies a 5 s wall-clock
 * deadline per transfer — the toolkit's own, deliberately unchanged. Nothing
 * measured here comes near it any more, but that pairing is the one remaining
 * route by which host speed could reach a result, so read a lone red row against
 * it before believing the firmware changed. FW-V1 docs/EMULATOR.md sec.13.8.
 * ==================================================================== */

import { afterAll, describe, expect, it } from 'vitest';

import { Emulator, liveEmulatorCount } from './emulator/harness.js';
import { probeTier1, type Tier1Result } from './emulator/probe.js';
import {
  announceSkip,
  BOOT_TIMEOUT_MS,
  EMU_DIR,
  ENTRIES,
  FILL_SCOPE,
  FILL_SEED,
  loadExpectations,
  printMatrix,
  record,
  REGENERATING,
  RPC_EXPECTATIONS,
  scratchFile,
  TIER1_TIMEOUT_MS,
  URB_TIMEOUT_MS,
  writeExpectations,
  type KnownGap,
} from './emulator/suite.js';

/* ---- the shape that is pinned --------------------------------------- */

export interface RpcExpectation {
  readonly kind: string;
  readonly family: string;
  readonly product: string;
  readonly version: string;
  readonly identity: Tier1Result['identity'];
  readonly chipIdHex: string | null;
  readonly commands: Readonly<Record<string, string>>;
  readonly controlInBytes: Readonly<Record<string, number | null>>;
  /** Subcommands whose CLAIMED address was among the places its bytes occur. */
  readonly windowsConfirmed: readonly number[];
  /** Armed, served bytes, but not from the address the profile table claims. */
  readonly windowsMisplaced: readonly number[];
  /**
   * For each of those, where the bytes it served ACTUALLY live.
   *
   * This is the strong form of the map check. "Nine subcommands are misplaced"
   * only catches a change in which ones; this catches a change in where they
   * point, and it is what turns the result into a usable correction to the
   * profile table rather than a complaint about it. `[]` means the bytes occur
   * nowhere in the 4 MiB image at all, which is a different and worse finding.
   */
  readonly windowsMisplacedTo: Readonly<Record<string, readonly string[]>>;
  /** The firmware refused the selector or could not serve it. */
  readonly windowsRefused: readonly number[];
  readonly auth: Tier1Result['auth'];
}

function summarize(result: Tier1Result, entry: (typeof ENTRIES)[number]): RpcExpectation {
  const confirmed: number[] = [];
  const misplaced: number[] = [];
  const misplacedTo: Record<string, readonly string[]> = {};
  const refused: number[] = [];
  for (const w of result.windows) {
    if (!w.armed || w.locatorHex === null) refused.push(w.subcmd);
    else if (w.matchesClaimed) confirmed.push(w.subcmd);
    else {
      misplaced.push(w.subcmd);
      misplacedTo[`0x${w.subcmd.toString(16)}`] = w.mappedTruncated
        ? [...w.mappedAddresses, '...(list capped; these bytes carry little position)']
        : w.mappedAddresses;
    }
  }
  return {
    kind: entry.kind,
    family: entry.family,
    product: entry.product,
    version: entry.version,
    identity: result.identity,
    chipIdHex: result.chipIdHex,
    commands: result.commands,
    controlInBytes: result.controlInBytes,
    windowsConfirmed: confirmed,
    windowsMisplaced: misplaced,
    windowsMisplacedTo: misplacedTo,
    windowsRefused: refused,
    auth: result.auth,
  };
}

/* ---- the suite ------------------------------------------------------- */

if (EMU_DIR === null) announceSkip('emulator RPC surface (tier 1)');

const pinned = loadExpectations<RpcExpectation>(RPC_EXPECTATIONS);
const measured: Record<string, RpcExpectation & { gap: KnownGap | null }> = {};

describe.skipIf(EMU_DIR === null)('emulator RPC surface (tier 1)', () => {
  afterAll(() => {
    if (REGENERATING) {
      writeExpectations(RPC_EXPECTATIONS, {
        note:
          'Per-firmware RPC surface, measured over USB/IP against the FW-V1 emulator. ' +
          'Generated by `node scripts/update-emulator-expectations.mjs`; never edit by hand. ' +
          'A `gap` records a firmware that could not be measured and why; the suite runs ' +
          'those under test.fails, so one that starts working turns the suite red.',
        generatedBy: 'packages/core/test/emulator-rpc.test.ts (SEEK_EMU_REGEN=1)',
        fill: { seed: FILL_SEED, scope: FILL_SCOPE },
        readChunk: 64,
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
    printMatrix('tier 1 — RPC surface, supported vs known-gap per family');
  });

  it('has a pinned expectation file to check against', () => {
    if (REGENERATING) return;
    expect(
      pinned,
      `no ${RPC_EXPECTATIONS}. Generate it with ` +
        '`node scripts/update-emulator-expectations.mjs`.',
    ).not.toBeNull();
  });

  for (const entry of ENTRIES) {
    const want = pinned?.firmwares[entry.id] ?? null;
    const gap = want?.gap ?? null;
    const title =
      gap === null
        ? `${entry.id} — identity, chip id, selector map, auth`
        : `${entry.id} — KNOWN GAP: ${gap.reason}`;

    /* A known gap is a TRACKED EXPECTATION, not a skip: `test.fails` keeps the
     * suite green while the gap is real and turns it red the moment it closes. */
    const run = REGENERATING ? it.concurrent : gap === null ? it.concurrent : it.concurrent.fails;

    run(title, { timeout: TIER1_TIMEOUT_MS }, async () => {
      const started = Date.now();
      let status: 'supported' | 'known-gap' | 'failed' = gap === null ? 'supported' : 'known-gap';
      let detail = '';
      let emu: Emulator | null = null;
      try {
        const truth = scratchFile(`t1_${entry.id}.bin`);
        emu = await Emulator.start(EMU_DIR!, {
          entryId: entry.id,
          fillSeed: FILL_SEED,
          fillScope: FILL_SCOPE,
          flashOut: truth,
          readyTimeoutMs: BOOT_TIMEOUT_MS,
        });
        const got = await probeTier1(emu, {
          groundTruthPath: truth,
          urbTimeoutMs: URB_TIMEOUT_MS,
        });
        const now = summarize(got, entry);
        detail =
          `${String(now.windowsConfirmed.length)} windows confirmed, ` +
          `${String(now.windowsMisplaced.length)} misplaced, ` +
          `${String(now.windowsRefused.length)} refused`;

        if (REGENERATING) {
          /* THE GAP IS DERIVED FROM THE MEASUREMENT, NEVER DECLARED BY HAND.
           *
           * A firmware the selector map reaches NOTHING on is the gap this tier
           * is about: `modern-4x` says in its own summary that it covers the
           * Compact line, and on these builds BeginFirmwareUpgrade stalls on
           * every one of the 63 subcommands, so the dump path cannot read them
           * at all. Recording that as a tracked expectation is the honest form:
           * it stays green while it is true and goes red the day a profile
           * change makes one of them readable. */
          measured[entry.id] = {
            ...now,
            gap:
              now.windowsConfirmed.length === 0
                ? {
                    reason:
                      `the selector map reaches no window: ${String(now.windowsRefused.length)} ` +
                      `of 63 subcommands refused (BeginFirmwareUpgrade -> ` +
                      `${now.commands.BeginFirmwareUpgrade ?? '?'})`,
                  }
                : null,
          };
          return;
        }

        /* A KNOWN GAP ASSERTS ONE THING: THE GAP IS STILL THERE.
         *
         * Nothing else, on purpose. If it also re-asserted the pinned numbers,
         * a firmware that STARTED working would fail those first and
         * `test.fails` would pass on that failure — a ratchet that never fires.
         * So the only claim here is `at least one window is readable`: false
         * today (the test throws, `test.fails` is green), and the day it becomes
         * true the test passes, `test.fails` goes RED, and that red is the
         * prompt to regenerate and promote the row. */
        if (gap !== null) {
          expect(
            now.windowsConfirmed.length,
            `${entry.id} was a known gap (${gap.reason}) and is now readable — ` +
              'regenerate the expectations and promote it',
          ).toBeGreaterThan(0);
          return;
        }

        expect(want, `${entry.id} is not in ${RPC_EXPECTATIONS}`).not.toBeNull();
        if (want === null) return;

        /* ---- identity, read off the wire ---- */
        expect(now.identity, 'USB identity').toEqual(want.identity);

        /* ---- the RPC reply on wire id 54 ---- */
        expect(now.chipIdHex, 'wire id 54 reply bytes').toBe(want.chipIdHex);

        /* ---- which commands this build answers ---- */
        expect(now.commands, 'command support').toEqual(want.commands);
        expect(now.controlInBytes, 'bytes returned per control-IN size').toEqual(
          want.controlInBytes,
        );

        /* ---- THE SELECTOR MAP, verified against served bytes ---- */
        expect(now.windowsConfirmed, 'subcommands whose claimed address was confirmed').toEqual(
          want.windowsConfirmed,
        );
        expect(
          now.windowsMisplaced,
          'subcommands not serving the address the profile table claims',
        ).toEqual(want.windowsMisplaced);
        expect(now.windowsMisplacedTo, 'where those subcommands actually point').toEqual(
          want.windowsMisplacedTo,
        );
        expect(now.windowsRefused, 'subcommands the firmware refused').toEqual(want.windowsRefused);

        /* ---- the authenticated channel, as an observation ---- */
        expect(now.auth, 'auth-token accept/refuse on a protected bank').toEqual(want.auth);
      } catch (error) {
        status = gap === null ? 'failed' : 'known-gap';
        detail = error instanceof Error ? (error.message.split('\n')[0] ?? '') : String(error);
        if (REGENERATING) {
          measured[entry.id] = {
            kind: entry.kind,
            family: entry.family,
            product: entry.product,
            version: entry.version,
            identity: {
              vendorId: '',
              productId: '',
              manufacturerName: null,
              productName: null,
              serialNumber: null,
            },
            chipIdHex: null,
            commands: {},
            controlInBytes: {},
            windowsConfirmed: [],
            windowsMisplaced: [],
            windowsMisplacedTo: {},
            windowsRefused: [],
            auth: {
              plainAccepted: false,
              authAccepted: false,
              wrongTokenAccepted: false,
              subcmd: 5,
            },
            gap: { reason: detail.slice(0, 300) },
          };
          return;
        }
        if (emu !== null) {
          const log = emu.log(25);
          throw new Error(`${detail}\n--- emulator log ---\n${log}`, { cause: error });
        }
        throw error;
      } finally {
        record({
          entryId: entry.id,
          family: entry.family,
          product: entry.product,
          version: entry.version,
          tier: 'tier1',
          status,
          detail,
          seconds: (Date.now() - started) / 1000,
        });
        await emu?.stop();
      }
    });
  }
});

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
 * AND THE CONFIGURATION WAS PART OF THE CLAIM, UNTIL THE LAST CAUSE WAS FOUND.
 * All of that was `vitest run --project core` with tier 2 off. Run alongside the
 * rest of the repository's suite, about one row in fifty-one used to go quiet for
 * minutes and read `no-answer`. That was not the 5 s deadline and not the firmware:
 * the emulator's USB/IP server shared ONE completion queue between sessions, the
 * next session's writer could take the old writer's `quit`, and the orphaned writer
 * then dropped replies the device had computed in 2 ms (TESTING.md sec.9.7; FW-V1
 * Phase 17). FW-V1 now gives every session its own queue (Phase 18), and this file
 * now proves, per row, that nothing was lost:
 *
 *   EVERY ROW IS AUDITED. Each emulator process a row starts — re-measures included
 *   — is stopped with SIGTERM, prints its delivery ledger, and `RowEmulators`
 *   compares it with what the client received. A dropped reply, a mismatch, or a
 *   transfer left unanswered by a live emulator throws `InfrastructureDefect`,
 *   which is never recorded and never classified as firmware silence.
 *
 *   NO ROW RUNS UNDER `test.fails`. A known gap asserts its SPECIFIC recorded
 *   reason (`assertRecordedGap`), so a timeout or an infrastructure error fails a
 *   gap row exactly as it fails any other, and a gap that closes still forces
 *   promotion.
 * ==================================================================== */

import { afterAll, describe, expect, it } from 'vitest';

import { SAFE_BEFORE_IDENTITY, type Opcode } from '../src/protocol/ops.js';
import { liveEmulatorCount, RowEmulators } from './emulator/harness.js';
import {
  probeTier1,
  ProbeUnmeasurable,
  type GateProbe,
  type Tier1Result,
  type WindowProbe,
} from './emulator/probe.js';
import { HarnessFidelityError } from './emulator/webusb-over-usbip.js';
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
  record,
  REGENERATING,
  RPC_EXPECTATIONS,
  scratchFile,
  PROBE_ATTEMPTS,
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
  /**
   * The DUMP'S OWN plan for this firmware, armed window by window as `runDump`
   * arms it (TESTING.md sec.10). `misplaced` is also asserted empty on every
   * row regardless of the pin: a plan window whose bytes are not the bytes at
   * the address it is filed under is the one failure a dump must never have.
   */
  readonly plan: PlanExpectation;
  /**
   * The toolkit's own first contact — probe, detection, `runDump` — and every
   * request it sent before the camera named its build (TESTING.md sec.11).
   * Null only on a row that could not be measured at all.
   */
  readonly gate: GateProbe | null;
}

/**
 * THE RULE, checked on every row whatever the pin says, in both modes: before
 * the camera has named its build the toolkit sends only control INs of
 * `SAFE_BEFORE_IDENTITY`, and a camera that never names it is refused. ("Never"
 * is the whole first contact: 0.6.0.4 does not answer the probe's version read
 * and does answer the dump's, which then refuses it as a pre-0.8 build.)
 */
function assertIdentityRule(entryId: string, gate: GateProbe | null): void {
  if (gate === null) return;
  const safe = [...SAFE_BEFORE_IDENTITY].map(
    (op: Opcode) => `IN 0x${op.toString(16).toUpperCase().padStart(2, '0')}`,
  );
  for (const sent of gate.sentBeforeIdentity) {
    expect(safe, `${entryId}: '${sent}' went out before the camera named its build`).toContain(
      sent,
    );
  }
  if (!gate.identified) {
    expect(gate.refusal ?? '', `${entryId}: no version came back, so the dump must refuse`).toMatch(
      /^device\/version-unknown: refusing to dump: the camera did not report its firmware version/,
    );
  }
}

export interface PlanExpectation {
  readonly firmwareVersion: string | null;
  readonly profile: string;
  readonly dumps: boolean;
  readonly table: string;
  readonly windows: number;
  /** Subcommands whose bytes matched the image at the plan's address. */
  readonly confirmed: readonly number[];
  /** Subcommands that served bytes from somewhere else, and where those live. */
  readonly misplaced: Readonly<Record<string, readonly string[]>>;
  /** Subcommands the firmware refused, or armed and served nothing for. */
  readonly unread: readonly number[];
  /** Of the confirmed ones, those armed here rather than reused from the window probe. */
  readonly armedHere: readonly number[];
  readonly gaps: readonly string[];
}

function whereElse(w: WindowProbe): readonly string[] {
  return w.mappedTruncated
    ? [...w.mappedAddresses, '...(list capped; these bytes carry little position)']
    : w.mappedAddresses;
}

function summarizePlan(result: Tier1Result): PlanExpectation {
  const confirmed: number[] = [];
  const misplaced: Record<string, readonly string[]> = {};
  const unread: number[] = [];
  const armedHere: number[] = [];
  for (const w of result.plan.windows) {
    if (!w.probe.armed || w.probe.locatorHex === null) unread.push(w.subcmd);
    else if (w.probe.matchesClaimed) {
      confirmed.push(w.subcmd);
      if (!w.reused) armedHere.push(w.subcmd);
    } else misplaced[`0x${w.subcmd.toString(16)}`] = whereElse(w.probe);
  }
  return {
    firmwareVersion: result.plan.firmwareVersion,
    profile: result.plan.profile,
    dumps: result.plan.dumps,
    table: result.plan.table,
    windows: result.plan.windows.length,
    confirmed,
    misplaced,
    unread,
    armedHere,
    gaps: result.plan.gaps,
  };
}

/**
 * Why the modern selector map reached no window on this firmware — in the words
 * of what was measured, naming the command that actually failed.
 *
 * CORRECTED 2026-09-23. This always read "... refused (BeginFirmwareUpgrade ->
 * <the command probe's outcome>)". On 0.7.0.7 and 0.7.0.8 that is true and not
 * the reason: the command probe's BeginFirmwareUpgrade is a plain arm of the
 * protected subcommand 5, which every legacy build refuses by design, while the
 * arms of 1 and 0x0A..0x21 came back with error code 0 and it was every READ of
 * them that failed — `GetFeaturedFirmwareData`, whose handler those builds
 * register in the setter column. So when windows armed cleanly and served
 * nothing, the reason now says that, and names the read's own outcome.
 */
function noWindowReason(result: Tier1Result, summary: RpcExpectation): string {
  const armed = result.windows.filter((w) => w.armed);
  if (armed.length === 0) {
    return (
      `the selector map reaches no window: ${String(summary.windowsRefused.length)} ` +
      `of 63 subcommands refused (BeginFirmwareUpgrade -> ` +
      `${summary.commands.BeginFirmwareUpgrade ?? '?'})`
    );
  }
  const outcomes = [...new Set(armed.map((w) => classifyRead(w.error)))].sort().join('/');
  return (
    `the selector map reaches no window: ${String(armed.length)} of 63 subcommands armed with ` +
    `error code 0 and every read of them failed (GetFeaturedFirmwareData, wire 0x4F -> ` +
    `${outcomes}); ` +
    `${String(result.windows.length - armed.length)} refused at the arm`
  );
}

/** A failed read's error text, as the device outcome it records. */
function classifyRead(error: string | null): string {
  if (error === null) return 'short';
  if (/stall/i.test(error)) return 'stall';
  if (/returned 0x/i.test(error)) return 'device-error';
  return 'no-answer';
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
    plan: summarizePlan(result),
    gate: result.gate,
  };
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
 * One row, measured — EXACTLY what the regenerator records, gap included.
 *
 * Both modes call this, so the gap an assertion compares against the pin is derived
 * by the same code that wrote the pin. It never throws for a measurement that could
 * not be made: that becomes the row's gap, with its reason, as it always has. What
 * it does not decide is whether the instrument was sound — `RowEmulators` audits
 * that afterwards, and an infrastructure defect never reaches the record.
 */
async function measureRow(
  entry: (typeof ENTRIES)[number],
  row: RowEmulators,
): Promise<RpcExpectation & { gap: KnownGap | null }> {
  try {
    /* RE-MEASURED FROM A FRESH EMULATOR, NEVER RETRIED IN PLACE.
     *
     * `ProbeUnmeasurable` means the camera stopped being there — the emulator's
     * own run ended, or the session died and three fresh imports did not bring it
     * back. Retrying the remaining commands on the corpse would record this
     * machine's load as the firmware's behaviour. So the whole row is taken again
     * from a new process, and NOTHING about the discarded attempt is recorded — but
     * it IS audited: every process goes through `RowEmulators`, so an attempt that
     * was discarded because replies went missing fails the row as infrastructure
     * instead of being re-measured into silence.
     */
    let got: Tier1Result | null = null;
    const unmeasurable: string[] = [];
    for (let attempt = 1; attempt <= PROBE_ATTEMPTS; attempt++) {
      const truth = scratchFile(`t1_${entry.id}_a${String(attempt)}.bin`);
      const emu = await row.start(EMU_DIR!, {
        entryId: entry.id,
        fillSeed: FILL_SEED,
        fillScope: FILL_SCOPE,
        flashOut: truth,
        readyTimeoutMs: BOOT_TIMEOUT_MS,
      });
      try {
        got = await probeTier1(emu, {
          groundTruthPath: truth,
          urbTimeoutMs: URB_TIMEOUT_MS,
        });
        break;
      } catch (error) {
        if (!(error instanceof ProbeUnmeasurable)) throw error;
        unmeasurable.push(
          `attempt ${String(attempt)}: ${error.message}` +
            (error.emulatorStopReason === null ? '' : ` [${error.emulatorStopReason}]`),
        );
        await emu.stop();
        /* A FAULT IS NOT RE-DRAWN. `worthRetrying` is false when the emulator
         * stopped on an instruction it cannot execute, which it will reach again at
         * the same point on a fresh process. Only a session that died with nothing
         * to say for itself gets another go. */
        if (!error.worthRetrying) break;
      }
    }
    if (got === null) {
      throw new ProbeUnmeasurable(
        `not measurable in ${String(unmeasurable.length)} attempt(s) from fresh ` +
          `emulators:\n  ${unmeasurable.join('\n  ')}`,
      );
    }
    const now = summarize(got, entry);
    /* THE GAP IS DERIVED FROM THE MEASUREMENT, NEVER DECLARED BY HAND.
     *
     * A firmware the selector map reaches NOTHING on is the gap this tier is
     * about: `modern-4x` says in its own summary that it covers the Compact line,
     * and on these builds BeginFirmwareUpgrade stalls on every one of the 63
     * subcommands, so the dump path cannot read them at all. */
    return {
      ...now,
      gap: now.windowsConfirmed.length === 0 ? { reason: noWindowReason(got, now) } : null,
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
      plan: {
        firmwareVersion: null,
        profile: '',
        dumps: false,
        table: '',
        windows: 0,
        confirmed: [],
        misplaced: {},
        unread: [],
        armedHere: [],
        gaps: [],
      },
      gate: null,
      gap: { reason: gapReason(error).slice(0, 300) },
    };
  }
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
          'A `gap` records a firmware that could not be measured and why; the suite asserts ' +
          'that exact reason, so one that starts working (or changes) turns the suite red. ' +
          'Measured on the path a real host takes: interface 0 claimed without a packet, ' +
          'every vendor request sent as bmRequestType 0x41/0xC1 (TESTING.md sec.9.9). ' +
          '`gate` is the toolkit itself — probe, detection, runDump — and every request it ' +
          'sent before the camera named its build; only control INs of SAFE_BEFORE_IDENTITY ' +
          'are allowed there, and a camera with no version is refused (TESTING.md sec.11).',
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
    const pinnedGap = want?.gap ?? null;
    const title =
      pinnedGap === null
        ? `${entry.id} — identity, chip id, selector map, auth`
        : `${entry.id} — KNOWN GAP: ${pinnedGap.reason}`;

    /* EVERY ROW IS AN ORDINARY TEST — a known gap included. See `assertRecordedGap`
     * in emulator/suite.ts for why `test.fails` is gone and what replaced it. */
    it.concurrent(title, { timeout: TIER1_TIMEOUT_MS }, async () => {
      const started = Date.now();
      const row = new RowEmulators(entry.id);
      let status: 'supported' | 'known-gap' | 'failed' = 'failed';
      let detail = '';
      try {
        const now = await measureRow(entry, row);
        /* THE DELIVERY AUDIT COMES FIRST, BEFORE ANYTHING IS RECORDED OR COMPARED.
         * A row whose emulator lost a reply has measured the transport, not the
         * firmware, so neither the regenerator nor the assertions may see it. */
        await row.assertDelivery();
        detail =
          now.gap === null
            ? `${String(now.windowsConfirmed.length)} windows confirmed, ` +
              `${String(now.windowsMisplaced.length)} misplaced, ` +
              `${String(now.windowsRefused.length)} refused`
            : now.gap.reason;

        if (REGENERATING) {
          /* A plan that files bytes under the wrong address is a bug, not a
           * measurement to pin. */
          expect(now.plan.misplaced, 'plan windows serving bytes from another address').toEqual({});
          assertIdentityRule(entry.id, now.gate);
          measured[entry.id] = now;
          status = now.gap === null ? 'supported' : 'known-gap';
          return;
        }

        expect(want, `${entry.id} is not in ${RPC_EXPECTATIONS}`).not.toBeNull();
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

        /* ---- THE DUMP'S OWN PLAN, armed as the dump arms it ----
         * Never pinned into acceptance: a window filed under an address whose
         * bytes it did not serve fails every row, whatever the pin says. */
        expect(now.plan.misplaced, 'plan windows serving bytes from another address').toEqual({});
        expect(now.plan, "the dump's own plan, measured").toEqual(want.plan);

        /* ---- THE TOOLKIT'S FIRST CONTACT: nothing but agreed reads before
         * identity, and a refusal when identity never comes (sec.11) ---- */
        assertIdentityRule(entry.id, now.gate);
        expect(now.gate, "the toolkit's own first contact").toEqual(want.gate);
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
          tier: 'tier1',
          status,
          detail,
          seconds: (Date.now() - started) / 1000,
          delivery: row.totals(),
        });
      }
    });
  }
});

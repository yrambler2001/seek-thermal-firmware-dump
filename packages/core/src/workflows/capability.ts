/* ==================================================================== *
 * Asking the camera what it can do, instead of assuming it from a name.
 *
 * WHY THIS EXISTS. Every profile in this toolkit used to be chosen from
 * evidence that is not about the protocol: a USB product string, a version
 * number, the acceptance sum of an image. Those are correlated with the
 * protocol and they are not it, and the correlation broke in both directions —
 * a Mosaic (10.9.1.31) and a Nano 200 (42.32.3.10) speak the modern selector
 * map perfectly and were scored zero for not being "4.x"; a 1.3.0.8 Compact
 * hits the 4.x acceptance sum and does NOT speak that map, refusing 38 of its
 * 63 selectors.
 *
 * The camera can be asked. Four transfers settle it:
 *
 *   1. `GetFirmwareInfo` — the running build's own version.
 *   2. a plain 2-byte arm of a PROTECTED bank — accepted on the modern line,
 *      refused on the legacy one.
 *   3. an 18-byte authenticated arm of the same bank — accepted on the legacy
 *      line when the token is right.
 *   4. a read of a bank that is open on BOTH lines — does the read command
 *      exist at all on this build?
 *
 * READ-ONLY BY CONSTRUCTION, and narrower than a dump. Only `OP.GET_ERROR_CODE`,
 * `OP.GET_OPERATION_MODE`, `OP.SET_OPERATION_MODE`, `OP.GET_FIRMWARE_INFO` and
 * `OP.BEGIN_FIRMWARE_UPGRADE` / `OP.GET_FEATURED_FIRMWARE_DATA` are ever sent,
 * and every one of them is in `READ_ONLY_OPS`, which `ops.ts` asserts is
 * disjoint from the write set at module load.
 *
 * AND NOTHING BUT THE VERSION READ UNTIL THE VERSION IS KNOWN. Steps 2-4 go
 * out only after step 1 came back with a version this toolkit can read windows
 * on (`identityGate`). A camera that does not answer step 1 gets nothing more:
 * wire ids mean different things on different builds, and the commands every
 * build reads the same way are listed in `SAFE_BEFORE_IDENTITY`.
 * ==================================================================== */

import { asciiz, hex } from '../bytes.js';
import { CancelledError, errorMessage, SeekError, type SeekErrorCode } from '../errors.js';
import type { SeekDevice } from '../protocol/client.js';
import { DEFAULT_READ_CHUNK, OP } from '../protocol/ops.js';
import { OLD_FW_UNLOCK_TOKEN, authPayload } from '../profiles/legacy-auth.js';
import { detectProfile } from '../profiles/registry.js';
import type { DetectionResult, DeviceEvidence } from '../profiles/types.js';

/**
 * The bank the plain/authenticated question is asked about.
 *
 * Subcommand 5. On the modern line it is slot A and opens on the plain channel;
 * on the legacy line it is one of the seven banks the handler locks — its guard
 * is literally `if (a2 == 2 && (unsigned)(mode - 2) <= 7) return BAD_KEY`, so
 * modes 2..9 are exactly the protected set (FW-V1
 * `codegen/fn/cmd_BeginFirmwareUpgrade.c`, variants `gcc49_shape` and
 * `c32k_1308`, both byte-exact reconstructions of a 2016/2017 build).
 */
export const PROBE_PROTECTED_SUBCMD = 5;

/**
 * The bank used to ask "can this build serve a window at all?".
 *
 * Subcommand 1, the config/factory area at 0x14020000. Open on the plain
 * channel on BOTH lines: the modern switch has `case 1: case 4: fw_op_dest =
 * 0x14020000`, and on the legacy one mode 1 is outside the protected 2..9 span.
 * Choosing a bank that is open everywhere is what makes a refusal here mean
 * something about the READ command rather than about the channel.
 */
export const PROBE_OPEN_SUBCMD = 1;

/** Bytes asked for from the open window. One 64-byte control IN. */
const PROBE_READ_BYTES = DEFAULT_READ_CHUNK;

/**
 * The oldest build that has a dump protocol at all.
 *
 * NOT A GUESS, AND IT IS A SAFETY GATE AS WELL AS A CAPABILITY ONE. Each
 * decrypted image carries its own RPC method table — an array whose entries name
 * the command at wire id index + 53, with a getter column (control IN) and a
 * setter column (control OUT) — and it was recovered from all 36 images of the
 * corpus into `test/firmware/facts.json`. Seven of them have no GETTER for wire
 * id 0x4F, which is the one read a dump sends, and on the oldest wire id 0x52
 * is something else too:
 *
 *   0.3.0.1   0x4F = UploadFirmwareRowSize (setter)   0x52 = EnterBootloaderMode
 *   0.5.0.2   0x4F = UploadFirmwareRowSize (setter)   0x52 = BeginFirmwareUpgrade
 *   0.5.1.0   0x4F = UploadFirmwareRowSize (setter)   0x52 = BeginFirmwareUpgrade
 *   0.5.1.3   0x4F = UploadFirmwareRowSize (setter)   0x52 = BeginFirmwareUpgrade
 *   0.6.0.4   0x4F = UploadFirmwareRowSize (setter)   0x52 = BeginFirmwareUpgrade
 *   0.7.0.7   0x4F = GetFeaturedFirmwareData, SETTER  0x52 = BeginFirmwareUpgrade
 *   0.7.0.8   0x4F = GetFeaturedFirmwareData, SETTER  0x52 = BeginFirmwareUpgrade
 *
 * `EnterBootloaderMode` is the one that matters for safety: a dump, a sweep and
 * this probe all send 0x52, and on a 0.3.0.1 camera that is a request to leave
 * the application. The two 0.7.0.x builds are the one that mattered for
 * correctness: their table has the right NAME at 0x4F, so a names-only check
 * passed them, and every read is then stalled because the handler is in the
 * write column. So a build older than 0.8 is not probed — the version read at
 * step 1 is enough to know, and nothing is sent afterwards.
 *
 * 0.8.0.0 is the first corpus build with a getter at 0x4F; every build from
 * there to 4.16.1.7 has every opcode the dump sends at the id it uses, in the
 * column it is sent to. (Corrected 2026-09-23: this was 0.7.)
 */
export const FIRST_DUMPABLE_MAJOR = 0;
export const FIRST_DUMPABLE_MINOR = 8;

/**
 * Is this version old enough that it has no read handler, or `0x52` may not be BeginFirmwareUpgrade?
 *
 * A question about a version, so `null` — no version — is not "old" and says
 * false. That is NOT permission to arm: `identityGate` refuses an unknown
 * version on its own terms, and every caller that decides whether to send an
 * arm goes through it rather than through this.
 */
export function predatesDumpProtocol(version: string | null): boolean {
  if (version === null) return false;
  const match = /^\s*(\d+)\.(\d+)/.exec(version);
  const major = match?.[1];
  const minor = match?.[2];
  if (major === undefined || minor === undefined) return false;
  const maj = Number.parseInt(major, 10);
  const min = Number.parseInt(minor, 10);
  if (maj !== FIRST_DUMPABLE_MAJOR) return maj < FIRST_DUMPABLE_MAJOR;
  return min < FIRST_DUMPABLE_MINOR;
}

/** Why a build `predatesDumpProtocol` says no, in one sentence for a user. */
export function predatesDumpProtocolReason(version: string): string {
  return (
    `firmware ${version} predates the dump protocol: its RPC method table has no read handler ` +
    'for GetFeaturedFirmwareData (on 0.7.0.7 and 0.7.0.8 it is registered as a setter only, ' +
    'and before that wire id 0x4F is UploadFirmwareRowSize), so no window can be read; on ' +
    '0.3.0.1 wire id 0x52 is EnterBootloaderMode rather than BeginFirmwareUpgrade'
  );
}

export interface RunningFirmware {
  /** `major.minor.patch.build` as the running firmware reports it, or null. */
  readonly version: string | null;
  /** The build date string that follows the version, when there was one. */
  readonly buildString: string | null;
  /** One line saying what was read, or why nothing was. */
  readonly note: string;
}

/** Why nothing beyond `SAFE_BEFORE_IDENTITY` goes out to a camera that has not said what it runs. */
export function versionUnknownReason(note: string): string {
  return (
    `the camera did not report its firmware version (${note}); a command number does not ` +
    'mean the same thing on every Seek firmware — on Compact 0.3.0.1 wire id 0x52, the id ' +
    'that arms a read window, is EnterBootloaderMode — so until the version is known nothing ' +
    'is sent but GetErrorCode, GetOperationMode and GetFirmwareInfo, the reads every build ' +
    'answers the same way'
  );
}

/** What the version read allows the toolkit to send next. */
export type IdentityGate =
  | { readonly permitsArming: true; readonly version: string }
  | {
      readonly permitsArming: false;
      /** `device/version-unknown` when there was no version; `profile/unsupported` when it predates. */
      readonly code: Extract<SeekErrorCode, 'device/version-unknown' | 'profile/unsupported'>;
      readonly reason: string;
    };

/**
 * THE ONE DECISION BEFORE ANYTHING IS ARMED, shared by the probe, the dump,
 * the sweep and the device-info read.
 *
 * An arm is wire id 0x52, and that id is `BeginFirmwareUpgrade` only on some
 * builds, so it may go out only once the camera has named its build and the
 * build is one whose table this toolkit reads (`predatesDumpProtocol`). With no
 * version there is no build to look up, and guessing is how 0x52 reaches a
 * 0.3.0.1's `EnterBootloaderMode`; so no version is a refusal too. On the
 * emulator Compact 0.5.1.0 and 0.5.1.3 stall every request for a while after
 * enumeration, `GetFirmwareInfo` included, which is exactly this case — and a
 * real camera that is slow to start is waited on for a bounded start-up window
 * (`VERSION_READ_STARTUP_READS`), then refused rather than guessed at, and
 * reads fine once it answers.
 */
export function identityGate(firmware: RunningFirmware): IdentityGate {
  if (firmware.version === null) {
    return {
      permitsArming: false,
      code: 'device/version-unknown',
      reason: versionUnknownReason(firmware.note),
    };
  }
  if (predatesDumpProtocol(firmware.version)) {
    return {
      permitsArming: false,
      code: 'profile/unsupported',
      reason: predatesDumpProtocolReason(firmware.version),
    };
  }
  return { permitsArming: true, version: firmware.version };
}

/**
 * The most unarmed `GetFirmwareInfo` reads one version read sends.
 *
 * Two whenever both are answered, whatever record the selector was left on:
 * the first clears it and the second is the build block (`readRunningFirmware`).
 * The rest of the budget is for reads that fail on the way — a lost first read
 * costs one more — and two failures in a row end it early.
 */
export const VERSION_READ_ATTEMPTS = 4;

/**
 * THE START-UP WINDOW: how many refused `GetFirmwareInfo` reads the version
 * read sends before it gives up on a camera that is still starting, and how
 * far apart. 26 reads, 20 ms apart: 500 ms from the first to the last.
 *
 * WHY THERE IS ONE. Seek firmware refuses every request on purpose while it
 * starts. The RPC dispatcher logs "Request sent during FW init" and returns
 * ERR_USBD_STALL while the SysTick state machine is still in an init state:
 * `g_systick_state <= 7` on the completed images and on 1.3.0.8
 * (FW-V1 `codegen/fn/rpc_dispatch_get_byid.c`,
 * `targets/compact_32k_1_3_0_8/src/rpc_cmds.c`), `<= 11` on 0.5.1.x and
 * `<= 8` on 0.6.0.4 (FW-V1 `docs/EMULATOR_CORPUS.md` sec.15). Measured:
 *
 *   Compact 1.3.0.8   STALL for ~9 ms after SET_CONFIGURATION (refused at
 *                     +1..+9 ms, answered at +10 ms; FW-V1 Phase 36)
 *   Compact 0.6.0.4   ~50-60k cycles, under one SysTick, and SILENT: no
 *                     STALL, the transfer times out
 *   Compact 0.5.1.x   STALL while its sensor watchdog restarts a sensor that
 *                     does not answer, ten times: ~58 ms of its own time. The
 *                     emulator has no sensor front end and stretches this to
 *                     millions of cycles; a camera with a sensor passes it at
 *                     once.
 *
 * The longest BOUNDED init step in the code sits inside the gate too:
 * 1.3.0.8's sensor poll (FSM state 2, `fsm_poll_step`) tries again every 50 ms
 * and gives up after the fifth time, ~250 ms from boot. 500 ms is twice that,
 * and 50 times the 9 ms measured. A camera that still refuses after it is
 * not starting up, and is refused as before.
 *
 * WHY A COUNT OF READS, NOT A DEADLINE. A real camera starts on its own clock,
 * so there the window is wall time: 25 pauses of at least 20 ms each (a timer
 * never fires early), so at least 500 ms. The emulator's clock is gated: its
 * device runs only while a request is outstanding, so a host that sleeps ages
 * it by nothing, and each refused read ages it by one EHCI interrupt threshold,
 * ~1 ms (FW-V1 `docs/EMULATOR.md` sec.24.3). There the 26 reads give the
 * device ~26 ms of its own time, 2.6 times the 10 ms 1.3.0.8 needs. A deadline
 * alone would give the emulated device as many reads as fit in 500 ms of a
 * loaded machine, which may be fewer than ten; a count gives both clocks what
 * they need, and gives the emulator's record the same number of reads on every
 * run.
 *
 * ONLY A STALL, AND ONLY BEFORE ANY ANSWER. A STALL is the gate's refusal. A
 * timeout already held the request out for the whole transfer deadline, far
 * longer than any start-up, and on the gated emulator the device ran all that
 * time; the ordinary rule (one more read) is what 0.6.0.4's silent refusal
 * needs. Once any read has been answered the dispatcher is running, and the
 * ordinary rule applies to what follows.
 */
export const VERSION_READ_STARTUP_READS = 26;

/** The pause between two refused reads of the start-up window. */
export const VERSION_READ_STARTUP_SPACING_MS = 20;

/** The start-up window on a camera's own clock: at least this long from the first read to the last. */
export const VERSION_READ_STARTUP_WINDOW_MS =
  (VERSION_READ_STARTUP_READS - 1) * VERSION_READ_STARTUP_SPACING_MS;

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A STALL: what a firmware's "sent during FW init" gate answers with. */
function isStall(error: unknown): boolean {
  return error instanceof SeekError && error.code === 'usb/stalled';
}

/** One unarmed GetFirmwareInfo, as it came back. */
type InfoRead =
  | { readonly answered: true; readonly bytes: Uint8Array }
  | { readonly answered: false; readonly error: unknown };

function versionOf(bytes: Uint8Array): string {
  return [bytes[0], bytes[1], bytes[2], bytes[3]].join('.');
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * The running build's version, from a command every build has.
 *
 * `GetFirmwareInfo` unarmed, NOT `readFwInfo(0, ...)`. The latter sends
 * `SetFirmwareInfoFeatures` first, which lives in `FLASH_OPS`; this stays
 * inside `READ_ONLY_OPS`, and inside `SAFE_BEFORE_IDENTITY`: `GetFirmwareInfo`
 * has a getter at 0x4E in all 36 corpus images.
 *
 * READ TWICE, AND TRUST ONLY THE READ THAT FOLLOWS AN ANSWERED ONE. The
 * getter answers whichever record the firmware-info selector names, and
 * selector 0 is the build block — `00 03 00 01`, `01 03 00 08`, `04 12 02 00`,
 * `0A 09 01 1F` and `2A 20 03 0A` on 0.3.0.1, 1.3.0.8, 4.18.2.0, 10.9.1.31 and
 * 42.32.3.10 over USB/IP, each followed by that build's own date string. But
 * the selector is 0 only after a reset or after a read. It is one u16 in RAM
 * (0x1000B3EE on the completed images) that `SetFirmwareInfoFeatures` (wire
 * 0x55) latches, and `SetFwOpCharFeatures` (wire 0x5B) latches too; no USB
 * reset or re-open clears it. What does clear it is the getter itself: every
 * FW-V1 reconstruction of `cmd_GetFirmwareInfo` (0.3.0.1, 1.3.0.8, the 2016
 * Compact PRO, 4.9.2.0, the Compact PRO FF, Compact XR, Mosaic 9 Hz and FF,
 * Nano 200 and 300) writes 0 to it on every path that returns data, and all
 * but 0.3.0.1 on the unsupported-record path as well. And it does so while
 * handling the SETUP stage, before the data stage leaves the camera. So one
 * read that was ANSWERED — data, of any length — leaves the selector at 0,
 * and the next read returns the build block, whatever an earlier program, or
 * an interrupted run of this one, left behind. Measured the other way round
 * on the emulator: after the tier-1 probe's `SetFirmwareInfoFeatures(1)`, a
 * single unarmed read on Compact 4.8.1.7 returned `2.0.2.3`, its
 * bootloader's version (TESTING.md sec.11.8).
 *
 * The first answer is therefore never the version: it is only proof that the
 * selector is now 0. A read that FAILED proves nothing — a stall may be the
 * dispatcher refusing before the getter runs, and a timeout may be a SETUP
 * the camera never took — so the rule is "an answered read, then another",
 * with up to `VERSION_READ_ATTEMPTS` reads and two failures in a row ending
 * it. A stale first answer is named in the note, because it is worth knowing
 * that something left the camera in that state.
 *
 * A CAMERA STILL STARTING UP. A STALL before any read has been answered may be
 * the firmware's own "sent during FW init" refusal. Such a read is sent again,
 * `VERSION_READ_STARTUP_SPACING_MS` later, up to `VERSION_READ_STARTUP_READS`
 * reads; each retry is logged as a warning, and the first answer ends the
 * waiting at once. Only GetFirmwareInfo is sent in the meantime. The refused
 * reads do not count against `VERSION_READ_ATTEMPTS`. When the window is used
 * up the version is unknown, as it was before. The wait does not consult the
 * caller's signal, as the rest of the version read does not: it is bounded,
 * and a cancel lands at the caller's next check, which on a dump is the head
 * of its window loop, before the first arm. (The emulator's first-contact
 * instrument relies on exactly that: it runs the dump with its signal already
 * aborted, TESTING.md sec.11.1.)
 *
 * Never throws for a refusal or a timeout — a camera that does not say is a
 * camera whose version is unknown, and `identityGate` says what that means:
 * nothing more is sent — but a cancellation propagates.
 */
export async function readRunningFirmware(device: SeekDevice): Promise<RunningFirmware> {
  const reads: InfoRead[] = [];
  let startupRefusals = 0;
  while (reads.length < VERSION_READ_ATTEMPTS) {
    let read: InfoRead;
    try {
      read = { answered: true, bytes: await device.rpcIn(OP.GET_FIRMWARE_INFO, 36) };
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      read = { answered: false, error };
    }

    if (!read.answered && isStall(read.error) && !reads.some((r) => r.answered)) {
      startupRefusals += 1;
      if (startupRefusals >= VERSION_READ_STARTUP_READS) {
        return {
          version: null,
          buildString: null,
          note:
            `GetFirmwareInfo did not answer (${errorMessage(read.error)}) on any of ` +
            `${String(startupRefusals)} reads ${String(VERSION_READ_STARTUP_SPACING_MS)} ms ` +
            `apart, a start-up window of ${String(VERSION_READ_STARTUP_WINDOW_MS)} ms; a camera ` +
            'still starting up answers within it',
        };
      }
      device.reporter.log(
        `GetFirmwareInfo was refused (${errorMessage(read.error)}), read ` +
          `${String(startupRefusals)} of up to ${String(VERSION_READ_STARTUP_READS)}: the ` +
          'camera may still be starting up; asking again in ' +
          `${String(VERSION_READ_STARTUP_SPACING_MS)} ms`,
        'warn',
      );
      await pause(VERSION_READ_STARTUP_SPACING_MS);
      continue;
    }

    const previous = reads.at(-1);
    reads.push(read);
    if (read.answered && previous?.answered === true) {
      return firmwareFrom(read.bytes, previous.bytes, startupRefusals);
    }
    if (!read.answered && previous?.answered === false) break;
  }

  const lastFailure = [...reads].reverse().find((read) => !read.answered);
  const answered = reads.filter((read) => read.answered).length;
  return {
    version: null,
    buildString: null,
    note:
      lastFailure === undefined
        ? `GetFirmwareInfo was never answered twice in a row in ${String(reads.length)} reads`
        : `GetFirmwareInfo did not answer (${errorMessage(lastFailure.error)})` +
          (answered > 0
            ? `; ${String(answered)} of ${String(reads.length)} reads answered, never two in a ` +
              'row, so none of them can be told from a record an earlier command left selected'
            : ''),
  };
}

/** The version the second of two answered reads carries, and what the first one said. */
function firmwareFrom(
  bytes: Uint8Array,
  first: Uint8Array,
  startupRefusals: number,
): RunningFirmware {
  const context =
    (sameBytes(first, bytes) || first.length < 4
      ? ''
      : `; the first read answered a different record (${versionOf(first)}), which an ` +
        'earlier command had left the firmware-info selector on — that read cleared it') +
    (startupRefusals === 0
      ? ''
      : `; it answered after refusing ${String(startupRefusals)} read(s) while starting up`);
  if (bytes.length < 4) {
    return {
      version: null,
      buildString: null,
      note: `GetFirmwareInfo answered ${String(bytes.length)} byte(s), too few for a version${context}`,
    };
  }
  const version = versionOf(bytes);
  const buildString = bytes.length > 4 ? asciiz(bytes.subarray(4)) : null;
  return {
    version,
    buildString,
    note:
      `the camera reports firmware ${version}${buildString === null ? '' : ` (${buildString})`}` +
      context,
  };
}

export interface SelectorChannelProbe {
  /** `major.minor.patch.build` as the running firmware reports it, or null. */
  readonly firmwareVersion: string | null;
  /** The build date string that follows the version, when there was one. */
  readonly buildString: string | null;
  /** The protected bank armed on the plain 2-byte channel. */
  readonly plainAccepted: boolean;
  /** The same bank armed on the 18-byte authenticated channel. */
  readonly authAccepted: boolean;
  /** A window open on both lines served bytes. */
  readonly openWindowReadable: boolean;
  /**
   * Nothing after the version read was sent: either the version said this
   * build predates the dump protocol, or there was no version at all — and in
   * both cases `0x52` may be `EnterBootloaderMode` (`identityGate`).
   */
  readonly skippedForSafety: boolean;
  /**
   * `identityGate`'s verdict on the version read, exactly as the probe acted
   * on it. A caller that refuses on it refuses for the reason the probe
   * stopped for, in the same words `planForDevice` would use.
   */
  readonly gate: IdentityGate;
  /** One line per step, for the reporter and the dump manifest. */
  readonly notes: readonly string[];
}

export interface ProbeOptions {
  /** The 16-byte token for the authenticated arm. Defaults to the known one. */
  readonly token?: Uint8Array;
  /** Skip the arm probes entirely (a caller that already knows the family). */
  readonly armProbes?: boolean;
}

/** True when the call came back without the device refusing or vanishing. */
async function succeeded(run: () => Promise<unknown>): Promise<boolean> {
  try {
    await run();
    return true;
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    return false;
  }
}

/**
 * Four read-only questions, and what the camera answered.
 *
 * Never throws for a refusal — a refusal IS the answer — but a cancellation
 * propagates, because a user who pressed Ctrl-C is not asking for one more
 * transfer.
 */
export async function probeSelectorChannel(
  device: SeekDevice,
  options: ProbeOptions = {},
): Promise<SelectorChannelProbe> {
  const notes: string[] = [];

  /* ---- 1. the version, from a command every build has ----------------- */
  const running = await readRunningFirmware(device);
  const firmwareVersion = running.version;
  const buildString = running.buildString;
  notes.push(running.note);

  const gate = identityGate(running);
  if (!gate.permitsArming) {
    notes.push(`${gate.reason}. Nothing further was sent.`);
    return {
      firmwareVersion,
      buildString,
      plainAccepted: false,
      authAccepted: false,
      openWindowReadable: false,
      skippedForSafety: true,
      gate,
      notes,
    };
  }

  if (options.armProbes === false) {
    return {
      firmwareVersion,
      buildString,
      plainAccepted: false,
      authAccepted: false,
      openWindowReadable: false,
      skippedForSafety: true,
      gate,
      notes: [...notes, 'the selector-channel probes were disabled by the caller'],
    };
  }

  /* ---- 2. the plain channel on a protected bank ----------------------- */
  const plainAccepted = await succeeded(() =>
    device.armWindow({
      subcmd: PROBE_PROTECTED_SUBCMD,
      address: 0,
      note: 'capability probe (plain)',
    }),
  );
  notes.push(
    `a plain 2-byte BeginFirmwareUpgrade(${hex(PROBE_PROTECTED_SUBCMD)}) was ` +
      (plainAccepted ? 'accepted' : 'REFUSED'),
  );

  /* ---- 3. the authenticated channel on the same bank ------------------
   *
   * Asked even when the plain one worked, because "the 18-byte form is
   * accepted" and "the token is checked" are different claims and the modern
   * handler accepts the long form without looking at the token
   * (`(req_len & 0xFFFFFFEF) != 2` is its only length test). Harmless there:
   * the same bank arms either way. */
  const token = options.token ?? OLD_FW_UNLOCK_TOKEN;
  const authAccepted = await succeeded(() =>
    device.armWindow({
      subcmd: PROBE_PROTECTED_SUBCMD,
      address: 0,
      note: 'capability probe (authenticated)',
      payload: authPayload(PROBE_PROTECTED_SUBCMD, token),
    }),
  );
  notes.push(
    `the 18-byte authenticated BeginFirmwareUpgrade(${hex(PROBE_PROTECTED_SUBCMD)}) was ` +
      (authAccepted ? 'accepted' : 'refused'),
  );

  /* ---- 4. can it serve a window at all? -------------------------------- */
  let openWindowReadable = false;
  try {
    await device.armWindow({
      subcmd: PROBE_OPEN_SUBCMD,
      address: 0,
      note: 'capability probe (open bank)',
    });
    const read = await device.readArmed(DEFAULT_READ_CHUNK, PROBE_READ_BYTES);
    openWindowReadable = read.data.length === PROBE_READ_BYTES;
    notes.push(
      openWindowReadable
        ? `a window open on every line served its first ${String(PROBE_READ_BYTES)} bytes`
        : `a window open on every line served only ${String(read.data.length)} byte(s)` +
            (read.stopReason === null ? '' : `: ${read.stopReason}`),
    );
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    notes.push(`no window could be read (${errorMessage(error)})`);
  }

  return {
    firmwareVersion,
    buildString,
    plainAccepted,
    authAccepted,
    openWindowReadable,
    skippedForSafety: false,
    gate,
    notes,
  };
}

/**
 * The probe, as evidence a profile can score.
 *
 * `plainSelectorRefused` is the field that did not exist until the probe did,
 * and it is the one that settles the legacy question: the two 1.x profiles and
 * `modern-4x` all said in their own comments that "a plain arm of a protected
 * bank, refused" was the observation nobody made.
 */
export function evidenceFromChannelProbe(probe: SelectorChannelProbe): DeviceEvidence {
  const base: DeviceEvidence = {
    ...(probe.firmwareVersion === null ? {} : { firmwareVersion: probe.firmwareVersion }),
    windowReadable: probe.openWindowReadable,
  };
  /* A probe that stopped at the version read observed nothing about the
   * channel, and must not be reported as having observed a refusal. */
  if (probe.skippedForSafety) return base;
  return {
    ...base,
    plainSelectorWorks: probe.plainAccepted,
    plainSelectorRefused: !probe.plainAccepted,
    authSelectorWorks: probe.authAccepted,
  };
}

/** What asking an attached camera settled, for a caller that has not named a profile. */
export interface CameraIdentification {
  /** The four questions and their answers (`probeSelectorChannel`). */
  readonly probe: SelectorChannelProbe;
  /** The USB descriptors plus the probe's answers, as `detectProfile` scored them. */
  readonly evidence: DeviceEvidence;
  /** The ranking. `detection.best.profile` is the family a run acts under. */
  readonly detection: DetectionResult;
  /**
   * Whether anything may be armed at all: `identityGate` on the version the
   * probe read. When it says no, the run is refused whatever the ranking says
   * — `planForDevice` would refuse it too, with the same reason.
   */
  readonly gate: IdentityGate;
}

/**
 * DETECTION ON AN ATTACHED CAMERA: the descriptors it enumerated with, the
 * four read-only answers of `probeSelectorChannel`, and `detectProfile` over
 * both. This is the CLI's `chooseProfileByProbe` without the CLI, so the
 * browser asks the camera the same questions and ranks the answers the same
 * way instead of asking the user which family the camera is.
 *
 * It CHOOSES; it does not permit. The run that follows still goes through
 * `planForDevice`, which reads the version again and applies `identityGate`
 * before the first arm, so a caller that ignores `gate` here (or a user who
 * picks a profile by hand and skips this altogether) gets the same refusal
 * one step later. Nothing here sends more than the probe does.
 */
export async function identifyCamera(
  device: SeekDevice,
  options: ProbeOptions = {},
): Promise<CameraIdentification> {
  const probe = await probeSelectorChannel(device, options);
  const description = device.transport.description;
  const evidence: DeviceEvidence = {
    ...(description.productName === null ? {} : { productName: description.productName }),
    vendorId: description.vendorId,
    productId: description.productId,
    ...evidenceFromChannelProbe(probe),
  };
  return { probe, evidence, detection: detectProfile(evidence), gate: probe.gate };
}

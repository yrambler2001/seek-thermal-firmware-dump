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
 * ==================================================================== */

import { asciiz, hex } from '../bytes.js';
import { CancelledError, errorMessage } from '../errors.js';
import type { SeekDevice } from '../protocol/client.js';
import { DEFAULT_READ_CHUNK, OP } from '../protocol/ops.js';
import { OLD_FW_UNLOCK_TOKEN, authPayload } from '../profiles/legacy-auth.js';
import type { DeviceEvidence } from '../profiles/types.js';

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
 * NOT A GUESS, AND IT IS A SAFETY GATE RATHER THAN A CAPABILITY ONE. Each
 * decrypted image carries its own RPC method table — an array whose entries name
 * the command at wire id index + 53 — and it was recovered from all 36 images of
 * the corpus into `test/firmware/facts.json`. Five of them do not have
 * `GetFeaturedFirmwareData` anywhere in that table, so wire id 0x4F is something
 * else, and on the oldest of the five wire id 0x52 is something else too:
 *
 *   0.3.0.1   0x4F = UploadFirmwareRowSize   0x52 = EnterBootloaderMode
 *   0.5.0.2   0x4F = UploadFirmwareRowSize   0x52 = BeginFirmwareUpgrade
 *   0.5.1.0   0x4F = UploadFirmwareRowSize   0x52 = BeginFirmwareUpgrade
 *   0.5.1.3   0x4F = UploadFirmwareRowSize   0x52 = BeginFirmwareUpgrade
 *   0.6.0.4   0x4F = UploadFirmwareRowSize   0x52 = BeginFirmwareUpgrade
 *
 * `EnterBootloaderMode` is the one that matters: a dump, a sweep and this probe
 * all send 0x52, and on a 0.3.0.1 camera that is a request to leave the
 * application. So a build older than 0.7 is not probed — the version read at
 * step 1 is enough to know, and nothing is sent afterwards.
 *
 * 0.7.0.7 is the first corpus build with the full set; every build from there
 * to 4.16.1.7 has all ten of the toolkit's opcodes at the ids it uses.
 */
export const FIRST_DUMPABLE_MAJOR = 0;
export const FIRST_DUMPABLE_MINOR = 7;

/** Is this version old enough that `0x52` may not be BeginFirmwareUpgrade? */
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
   * Nothing after the version read was sent, because the version said this
   * build predates the dump protocol and `0x52` may be `EnterBootloaderMode`.
   */
  readonly skippedForSafety: boolean;
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

  /* ---- 1. the version, from a command every build has -----------------
   *
   * `GetFirmwareInfo` unarmed, NOT `readFwInfo(0, ...)`. The latter sends
   * `SetFirmwareInfoFeatures` first, which lives in `FLASH_OPS`; this probe
   * stays inside `READ_ONLY_OPS`. Selector 0 is the default after a reset and
   * selector 0 is the build block, so the unarmed read returns it — measured on
   * 0.3.0.1, 1.3.0.8, 4.18.2.0, 10.9.1.31 and 42.32.3.10, which returned
   * 00 03 00 01, 01 03 00 08, 04 12 02 00, 0A 09 01 1F and 2A 20 03 0A
   * respectively, each followed by that build's own date string. */
  let firmwareVersion: string | null = null;
  let buildString: string | null = null;
  try {
    const raw = await device.rpcIn(OP.GET_FIRMWARE_INFO, 36);
    if (raw.length >= 4) {
      firmwareVersion = [raw[0], raw[1], raw[2], raw[3]].join('.');
      buildString = raw.length > 4 ? asciiz(raw.subarray(4)) : null;
    }
    notes.push(
      firmwareVersion === null
        ? `GetFirmwareInfo answered ${String(raw.length)} byte(s), too few for a version`
        : `the camera reports firmware ${firmwareVersion}${buildString === null ? '' : ` (${buildString})`}`,
    );
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    notes.push(`GetFirmwareInfo did not answer (${errorMessage(error)})`);
  }

  if (predatesDumpProtocol(firmwareVersion)) {
    notes.push(
      `firmware ${String(firmwareVersion)} predates the dump protocol: its RPC table has no ` +
        'GetFeaturedFirmwareData, and on 0.3.0.1 wire id 0x52 is EnterBootloaderMode rather ' +
        'than BeginFirmwareUpgrade. Nothing further was sent.',
    );
    return {
      firmwareVersion,
      buildString,
      plainAccepted: false,
      authAccepted: false,
      openWindowReadable: false,
      skippedForSafety: true,
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

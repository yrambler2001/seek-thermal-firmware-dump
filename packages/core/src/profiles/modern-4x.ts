/**
 * `modern-4x` — the 2018-and-later selector map.
 *
 * Every camera whose `BeginFirmwareUpgrade` exposes the whole 4 MiB part on the
 * plain 2-byte channel. Measured on eleven distinct builds across six product
 * lines, and the name is now the only thing about it that says "4.x".
 *
 * WHAT IT REALLY COVERS, AND HOW THAT IS KNOWN. The emulator sweep arms all 63
 * selectors of this map against each firmware and compares the 256 bytes served
 * with the 4 MiB image the emulated part actually holds, at the address this
 * table CLAIMS. 26 of the 51 corpus firmwares confirm all 63:
 *
 *   Compact       4.8.1.7, 4.8.1.9, 4.8.2.1, 4.16.1.7
 *   Compact Pro   4.9.1.15, 4.9.2.0, 4.18.2.0
 *   Compact XR    4.8.2.1
 *   Mosaic        10.9.1.31, 2.27.1.33
 *   Nano 200      42.32.3.10
 *   Nano 300      44.27.3.10
 *
 * Three of those version lines are not 4.x at all, and `detect()` used to score
 * them ZERO for that reason — a Mosaic or a Nano 200 fell through to `generic`,
 * which then refused to flash a camera whose map it had just read perfectly.
 * The family is the map, not the major version; see `detectModern`.
 *
 * THE MAP IS ALSO DERIVED, NOT ONLY MEASURED. FW-V1's byte-exact reconstruction
 * of `cmd_BeginFirmwareUpgrade` is the same switch statement in source form —
 * `codegen/fn/cmd_BeginFirmwareUpgrade.c`, variants `base` (Compact PRO FF,
 * Compact Pro 4.9.2.0), `nano_const`, `nano200_amend`, `compact_pro`,
 * `mosaic_ff` and `compact_xr`. Where this file and that switch disagree, one
 * of them is wrong about a real camera; today they agree everywhere, including
 * on the gap (see `GAP_ADDRESS`).
 *
 * Three other profiles reuse pieces of this one. `generic` falls back to this
 * selector map, exactly as the original did; `legacy-auth` and `compact-2016`
 * reuse only the flash geometry, because their selector map is genuinely
 * different. Those reuses are re-exported from here rather than copied, so a
 * correction to the map lands everywhere at once.
 */

import { hexUp } from '../bytes.js';
import type {
  BootPolicy,
  BootPrediction,
  CipherProfile,
  DetectionVerdict,
  DeviceEvidence,
  FirmwareProfile,
  MemoryLayout,
  ProfileCapabilities,
  SlotDescriptor,
  SlotKey,
  WindowEntry,
  WindowPlan,
} from './types.js';
import { SUPPORTED } from './types.js';
import { buildWindowPlan } from './plan.js';
import { primaryVersion, versionSource } from './version.js';

/* ---- memory layout ------------------------------------------------------ */

export const FLASH_BASE = 0x14000000;
export const FLASH_SIZE = 4 * 1024 * 1024;
export const WINDOW_SIZE = 0x10000;

/**
 * The one 64 KiB block in 0x14000000..0x143fffff no selector reaches.
 *
 * DERIVED, not inferred from a sweep coming back empty. FW-V1's byte-exact
 * `cmd_BeginFirmwareUpgrade` is a switch over the subcommand, and no arm of it
 * assigns `fw_op_dest = 0x14060000` on any variant this profile covers: cases
 * 7/8/9 are slot A, 0x14050000 and 0x14070000 (`base`, `nano200_amend`), 0x0A
 * starts the linear run at 0x14080000, and the default arm covers 0x22..0x41 as
 * `(subcmd + 5118) << 16`, i.e. 0x14200000 upward. The block is skipped in the
 * firmware's own table, so no sweep will ever find it.
 *
 * The legacy generation is the opposite and it is worth knowing which way
 * round: there 0x14060000 IS reachable, on subcommand 8 and only through the
 * authenticated channel. See `legacy-auth`.
 */
export const GAP_ADDRESS = 0x14060000;

/* ---- firmware slot / image layout (2018+ "4.x" family) ------------------ */
export const BOOT_CONFIG_BASE = 0x14010000;
export const SLOT_A_BASE = 0x14030000;
export const SLOT_B_BASE = 0x14050000;
export const SLOT_RECOVERY_BASE = 0x14070000;

/* BeginFirmwareUpgrade selectors used by the flash view. Subcommand 0 is the
 * one the camera resolves itself, to fw_update_slot_address() — the slot it did
 * NOT boot from. It is the only selector this page ever writes through. */
export const SUBCMD_UPDATE_TARGET = 0;
export const SUBCMD_BOOTLOADER = 2;
export const SUBCMD_BOOT_CONFIG = 3;
export const SUBCMD_SLOT_A = 5;
export const SUBCMD_SLOT_B = 8;
export const SUBCMD_RECOVERY = 9;

/** Offset of the per-device key slot inside the bootloader block. */
export const DEVICE_KEY_SLOT_OFFSET = 0x218;
export const DEVICE_KEY_SLOT_LENGTH = 16;

/** The bootloader's 32-bit acceptance target for this family. */
export const ACCEPT_SUM = 0x0000ffff;

/** The whitening constant of this device family. */
export const FLASH_K = 0x13579bdf;

/** Inclusive word indices left verbatim in the image (bytes 0x200..0x23F). */
export const HDR_LO = 128;
export const HDR_HI = 143;

/**
 * Inclusive selector range a sweep probes. 0x41 is the highest subcommand with a
 * known window; sweeping from 0 also re-probes the ones the map already names, so
 * a build that moved one shows up as a mismatch rather than as silence.
 */
export const MODERN_SWEEP_RANGE: readonly [number, number] = [0, 0x41];

/* ---- the selector map --------------------------------------------------- */

/**
 * The BeginFirmwareUpgrade selector map: which subcommand exposes which
 * 64 KiB block. Covers all of 0x14000000..0x143fffff except 0x14060000.
 *
 * The two generated runs are arithmetically one linear sequence —
 * `0x14080000 + (subcmd - 0x0a) * 0x10000` is `(subcmd + 5118) << 16` — but they
 * are kept as two loops with distinct notes, exactly as the original decoded
 * them, so a diff against `legacy/index.html` stays trivial.
 *
 * TWO ALIASES ARE DELIBERATELY ABSENT. The firmware's own switch also accepts
 * subcommand 4 (`case 1: case 4: fw_op_dest = 0x14020000`) and subcommand 7
 * (slot A plus `g_flash_base_offset`), so the real table has 65 live
 * subcommands, not 63. Both point at a block subcommands 1 and 5 already cover,
 * and a dump tiles the address space once: adding them would read 128 KiB twice
 * and change nothing about what comes back. They are recorded here rather than
 * in the map so that a future reader does not "discover" them as a gap.
 * Derived from `codegen/fn/cmd_BeginFirmwareUpgrade.c`, variant `base`.
 */
export function buildModernWindowMap(): readonly WindowEntry[] {
  const entries: WindowEntry[] = [
    { subcmd: 2, address: 0x14000000, note: 'SPIFI flash base' },
    { subcmd: 3, address: 0x14010000, note: 'boot config block' },
    { subcmd: 1, address: 0x14020000, note: 'config/factory area' },
    { subcmd: 5, address: 0x14030000, note: 'slot A' },
    { subcmd: 6, address: 0x14040000, note: '0x14040000 window' },
    { subcmd: 8, address: 0x14050000, note: 'slot B / active-bank selector' },
    { subcmd: 9, address: 0x14070000, note: 'recovery selector' },
  ];
  for (let subcmd = 0x0a; subcmd <= 0x21; subcmd++) {
    entries.push({
      subcmd,
      address: 0x14080000 + (subcmd - 0x0a) * WINDOW_SIZE,
      note: 'linear window',
    });
  }
  for (let subcmd = 0x22; subcmd <= 0x41; subcmd++) {
    entries.push({
      subcmd,
      address: (subcmd + 5118) << 16,
      note: 'linear high window',
    });
  }
  entries.sort((a, b) => a.address - b.address);
  return entries;
}

/* ---- shared descriptors ------------------------------------------------- */

export const MODERN_CIPHER: CipherProfile = {
  whiteningK: FLASH_K,
  acceptanceSum: ACCEPT_SUM,
  clearWords: [HDR_LO, HDR_HI],
};

export const MODERN_MEMORY: MemoryLayout = {
  flashBase: FLASH_BASE,
  flashSize: FLASH_SIZE,
  windowSize: WINDOW_SIZE,
  bootConfigBase: BOOT_CONFIG_BASE,
  deviceKeySlotOffset: DEVICE_KEY_SLOT_OFFSET,
  deviceKeySlotLength: DEVICE_KEY_SLOT_LENGTH,
  unreachable: [
    {
      address: GAP_ADDRESS,
      length: WINDOW_SIZE,
      reason: 'No BeginFirmwareUpgrade selector is exposed for this 64 KiB block.',
    },
  ],
};

/**
 * The plan for a post-2018 build, whatever its version.
 *
 * ONE TABLE FOR THE WHOLE FAMILY, AND THAT IS MEASURED, NOT ASSUMED. The
 * version is recorded and does not change the table: every post-2018 corpus
 * image's own window switch decodes to the same rows for modes 1..6 and
 * 0x0A..0x21 (`windowTable` in `test/firmware/facts.json`), and all 26 of those
 * firmwares confirm all 63 windows on the emulator at these addresses. The two
 * aliases the comment above `buildModernWindowMap` names are left out of the
 * rows as they are left out of the map.
 *
 * SUBCOMMAND 0 IS A ROW, WITH NO ADDRESS. It is the upgrade target: every
 * post-2018 image switches on it and computes the block at run time
 * (`fw_op_dest = fw_update_slot_address()`, every variant of FW-V1's
 * `cmd_BeginFirmwareUpgrade.c`; `kind: computed` for mode 0 on all 14 post-2018
 * images in `test/firmware/facts.json`). With no address it is never a window
 * and never places a sweep's bytes; it is here because the device read and the
 * write arm the upgrade-target selector only when the running build's table
 * carries it (`readDeviceInfo`, `writeFirmware`).
 */
export function modernWindowPlan(
  firmwareVersion: string | null,
  table = 'modern-4x: the post-2018 BeginFirmwareUpgrade table (one table, every build)',
): WindowPlan {
  return buildWindowPlan({
    table,
    firmwareVersion,
    selectors: [
      {
        subcmd: SUBCMD_UPDATE_TARGET,
        address: null,
        channel: 'plain',
        note: 'upgrade target: the camera picks the slot it did not boot from at run time (fw_update_slot_address())',
      },
      ...buildModernWindowMap().map((entry) => ({
        subcmd: entry.subcmd,
        address: entry.address,
        channel: 'plain' as const,
        note: entry.note,
      })),
    ],
    holes: MODERN_MEMORY.unreachable,
    flashBase: FLASH_BASE,
    flashSize: FLASH_SIZE,
    windowSize: WINDOW_SIZE,
  });
}

export const MODERN_SLOTS: readonly SlotDescriptor[] = [
  { key: 'a', name: 'Slot A', subcmd: SUBCMD_SLOT_A, address: SLOT_A_BASE },
  { key: 'b', name: 'Slot B', subcmd: SUBCMD_SLOT_B, address: SLOT_B_BASE },
  { key: 'r', name: 'Recovery', subcmd: SUBCMD_RECOVERY, address: SLOT_RECOVERY_BASE },
];

/**
 * The 4.x bootloader's own boot policy, replayed. `selectBootSlot` is a direct
 * port of `select_boot_slot()`, so the page can name the slot the camera booted
 * from and the one an upgrade would therefore overwrite.
 */
export const MODERN_BOOT: BootPolicy = {
  updateTargetSubcmd: SUBCMD_UPDATE_TARGET,

  describeCfg0(cfg0: number): string {
    if (cfg0 === 0 || cfg0 === 0xffffffff) return 'blank/0: prefer slot A, then B, then recovery';
    if (cfg0 === 1) return 'prefer slot B, then A, then recovery';
    return 'prefer recovery, then A, then B';
  },

  selectBootSlot(cfg0: number, isBootable: (key: SlotKey) => boolean): BootPrediction {
    /* bootable, NOT accepts: a slot the bootloader cannot key is skipped even
     * though it decrypts perfectly under the key it was written with. */
    const ok = (k: SlotKey): boolean => isBootable(k);
    const explicit = cfg0 !== 0 && cfg0 !== 0xffffffff;
    let booted: SlotKey;
    if (!explicit) booted = ok('a') ? 'a' : ok('b') ? 'b' : 'r';
    else if (cfg0 === 1) booted = ok('b') ? 'b' : ok('a') ? 'a' : 'r';
    else booted = ok('r') ? 'r' : ok('a') ? 'a' : 'b';
    /* fw_update_slot_address(): booted A -> write B, otherwise write A */
    return { booted, target: booted === 'a' ? 'b' : 'a' };
  },
};

const CAPABILITIES: ProfileCapabilities = {
  dump: SUPPORTED,
  sweep: SUPPORTED,
  decrypt: SUPPORTED,
  deviceInfo: SUPPORTED,
  /* The only profile that may write. Everything in the write path — the selector
   * map, the bank payload shape, the boot replay, the key table — was decoded
   * against and exercised on this family. */
  flash: SUPPORTED,
};

/* ---- detection ---------------------------------------------------------- */

/** Decisive: measured on the camera itself, not inferred. */
const SCORE_DECISIVE = 0.95;
/** Decisive plus a second, independent signal agreeing. */
const SCORE_CORROBORATED = 0.97;
/** One strong but indirect signal (a version string the camera reported). */
const SCORE_STRONG = 0.85;
/** Rules out other families without singling this one out. */
const SCORE_WEAK = 0.3;
/**
 * A plain arm of a protected bank, measured to WORK, with nothing else known.
 *
 * Above `CONFIDENT_SCORE` because the observation is direct and it is this
 * line's defining behaviour, and below the version and sum scores because the
 * earliest Compacts answer the plain channel on the open banks too. It is what
 * lets a camera with no readable version still be dumped with the right map
 * instead of the fallback's.
 */
const SCORE_MEASURED_PLAIN = 0.6;

/**
 * THE LEGACY LINE, AND NOTHING ELSE, IS RULED OUT BY VERSION.
 *
 * Seek's application versions are not one numbering line. `0.x` and `1.x` are
 * the 2014-2017 Compact / Compact PRO builds, whose BeginFirmwareUpgrade
 * refuses subcommands 2..9 on the plain channel and has no selector above
 * 0x141FFFFF; everything from 2018 on — `2.x`, `4.x`, `10.x`, `42.x`, `44.x` —
 * exposes the whole part on the plain channel. So the test is "is this the
 * legacy line", not "is this 4.x".
 *
 * The earlier test WAS "major === 4", and it cost three product families: a
 * Mosaic (10.9.1.31, 2.27.1.33), a Nano 200 (42.32.3.10) and a Nano 300
 * (44.27.3.10) scored zero here and fell through to `generic`, which refuses to
 * flash. All four of those builds are measured confirming every one of this
 * map's 63 windows at the address it claims.
 */
const LEGACY_MAJORS: readonly number[] = [0, 1];

function detectModern(evidence: DeviceEvidence): DetectionVerdict {
  const reasons: string[] = [];

  /* THE DECISIVE NEGATIVE, now that something actually makes the observation.
   * A protected bank that refused the plain 2-byte arm is the legacy locked
   * firmware's defining behaviour and no build on this line does it: 26 corpus
   * firmwares arm subcommand 5 plain, and the reconstruction says why — the
   * modern handler's only length test is `(req_len & 0xFFFFFFEF) != 2`, which
   * accepts 2 and 18 alike and compares no token at all. */
  if (evidence.plainSelectorRefused === true) {
    reasons.push(
      'a plain 2-byte BeginFirmwareUpgrade of a protected bank was REFUSED, which no build ' +
        'on this line does — its handler has no token check and accepts the plain channel ' +
        'on every bank',
    );
    return { score: 0, reasons };
  }

  /* An authenticated arm that WORKED does not rule this family out: the flag
   * says the payload armed a bank, not that the plain one was refused, and this
   * line's handler ignores the extra 16 bytes. Kept as a caveat, out of the
   * score — `plainSelectorRefused` above is the one that decides. */
  if (evidence.authSelectorWorks === true && evidence.plainSelectorRefused === undefined) {
    reasons.push(
      'a protected bank armed on the 18-byte authenticated selector; nothing tried the plain ' +
        'one there, so that does not place this camera off this line',
    );
  }

  const version = primaryVersion(evidence);
  if (version !== null && LEGACY_MAJORS.includes(version.major)) {
    /* Deliberately outranks the acceptance sum below. 32K_43X0_1.3.0.8_COMPACT
     * is measured to hit the 0x0000FFFF sum with NO whitening, so the sum on its
     * own cannot place a build on this line — a version can. */
    reasons.push(
      `${versionSource(evidence) === 'dump' ? 'the image header says' : 'the camera reports'} ` +
        `firmware ${version.text}, which is on the 0.x / 1.x legacy line (a different ` +
        'numbering line, not an older 4.x — and one of those builds hits the 0x0000FFFF ' +
        'sum too)',
    );
    return { score: 0, reasons };
  }

  const sums = evidence.observedAcceptanceSums ?? [];
  const hitsTarget = sums.some((sum) => sum >>> 0 === ACCEPT_SUM);
  if (sums.length > 0 && !hitsTarget) {
    /* The original's own negative test: this is the exact evidence on which it
     * refused to flash and called the camera "probably the 2016 generation". */
    reasons.push(
      `no slot decrypts to the ${hexUp(ACCEPT_SUM)} acceptance sum this family's bootloader demands`,
    );
    return { score: 0, reasons };
  }

  let score = 0;
  if (hitsTarget) {
    score = SCORE_DECISIVE;
    reasons.push(`a slot decrypts to the ${hexUp(ACCEPT_SUM)} acceptance sum`);
  }
  if (version !== null) {
    reasons.push(
      `firmware ${version.text} is on the post-2018 line this selector map covers ` +
        '(2.x / 4.x / 10.x / 42.x / 44.x: Compact, Compact Pro, Compact XR, Mosaic, Nano)',
    );
    score = hitsTarget ? SCORE_CORROBORATED : Math.max(score, SCORE_STRONG);
  }
  if (evidence.plainSelectorRefused === false) {
    /* MEASURED, and the mirror of the decisive negative above: the camera was
     * asked to arm a protected bank on the plain channel and it did. That is
     * this line's behaviour and the legacy firmware's refusal is what it rules
     * out — but the 2016 generation is ruled out by it too only because that
     * generation refuses; a camera answering plain could still be an early
     * Compact, which is why this corroborates rather than decides. */
    reasons.push(
      'a plain 2-byte BeginFirmwareUpgrade armed a protected bank, so the authenticated ' +
        'read channel is not in force',
    );
    score = Math.max(score, SCORE_MEASURED_PLAIN);
  } else if (score === 0 && evidence.plainSelectorWorks === true) {
    reasons.push(
      'a plain 2-byte BeginFirmwareUpgrade armed a protected bank, so this is not the locked legacy firmware',
    );
    score = SCORE_WEAK;
  }
  if (score === 0) reasons.push('no evidence placing this camera on the post-2018 line');
  return { score, reasons };
}

/* ---- the profile -------------------------------------------------------- */

export const modern4x: FirmwareProfile = {
  id: 'modern-4x',
  /* The id stays `modern-4x` — it is in scripts, in `--profile` invocations and
   * in every pinned expectation — but the NAME no longer claims a version line
   * the family does not have. */
  name: 'Modern (2018+ selector map)',
  summary:
    'Every camera whose BeginFirmwareUpgrade exposes the whole 4 MiB part on the plain 2-byte ' +
    'channel: Compact 4.8/4.16, Compact Pro 4.9/4.18, Compact Pro FF, Compact XR, Mosaic ' +
    '2.27/10.9, Nano 200 42.x, Nano 300 44.x. Measured confirming all 63 windows at the ' +
    'addresses this map claims. xorshift128 images under whitening K=0x13579BDF with a ' +
    '0x0000FFFF acceptance sum. The only profile whose write path has been exercised against ' +
    'hardware.',
  cipher: MODERN_CIPHER,
  memory: MODERN_MEMORY,
  capabilities: CAPABILITIES,
  slots: MODERN_SLOTS,
  boot: MODERN_BOOT,
  windowMap: buildModernWindowMap,
  windowPlan: (firmwareVersion) => modernWindowPlan(firmwareVersion),
  sweepRange: MODERN_SWEEP_RANGE,
  detect: detectModern,
};

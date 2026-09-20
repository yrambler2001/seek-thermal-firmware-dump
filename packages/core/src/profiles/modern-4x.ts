/**
 * `modern-4x` — the 2018+ "4.x" family.
 *
 * Covers the 4.8.x / 4.9.x / 4.18.x application line: Compact Pro, Compact Pro FF,
 * Compact XR and Nano 300. This is the family every part of the original tool was
 * written against and the only one whose write path has been exercised on hardware,
 * so it is the only profile that declares `flash` supported.
 *
 * Three other profiles reuse pieces of this one — the 2016 generation and the
 * unknown-camera fallback both fall back to this selector map, exactly as the
 * original did. Those reuses are re-exported from here rather than copied, so a
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
} from './types.js';
import { SUPPORTED } from './types.js';

/* ---- memory layout ------------------------------------------------------ */

export const FLASH_BASE = 0x14000000;
export const FLASH_SIZE = 4 * 1024 * 1024;
export const WINDOW_SIZE = 0x10000;

/** The one 64 KiB block in 0x14000000..0x143fffff no selector reaches. */
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

/** Major component of a dotted version string, or null when there is none. */
function versionMajor(version: string | undefined): number | null {
  if (version === undefined) return null;
  const match = /^\s*(\d+)\./.exec(version);
  const major = match?.[1];
  return major === undefined ? null : Number.parseInt(major, 10);
}

function detectModern(evidence: DeviceEvidence): DetectionVerdict {
  const reasons: string[] = [];

  /* A protected bank that only opens on the 18-byte channel is the legacy
   * firmware's signature; no 4.x build has that handler at all. */
  if (evidence.authSelectorRequired === true) {
    reasons.push(
      'a protected bank only armed after the 18-byte authenticated selector, which no 4.x build implements',
    );
    return { score: 0, reasons };
  }

  const major = versionMajor(evidence.firmwareVersion);
  if (major !== null && major !== 4) {
    /* Deliberately outranks the acceptance sum below. 32K_43X0_1.3.0.8_COMPACT
     * is measured to hit the 0x0000FFFF sum with NO whitening, so the sum on its
     * own cannot place a build on this line — a reported version can. */
    reasons.push(
      `reported firmware version ${String(evidence.firmwareVersion)} is not on the 4.x ` +
        'application line (the 1.0.3.x / 1.3.0.x images are a different numbering line, ' +
        'and one of them hits the 0x0000FFFF sum too)',
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
  if (major === 4) {
    reasons.push(
      `reported firmware version ${String(evidence.firmwareVersion)} is on the 4.x ` +
        'application line (Compact Pro / Compact Pro FF / Compact XR / Nano 300)',
    );
    score = hitsTarget ? SCORE_CORROBORATED : Math.max(score, SCORE_STRONG);
  }
  if (score === 0 && evidence.plainSelectorWorks === true) {
    /* Rules the legacy locked firmware out, but the 2016 generation also answers
     * plain selectors — so this alone stays below the confidence threshold. */
    reasons.push(
      'a plain 2-byte BeginFirmwareUpgrade armed a protected bank, so this is not the locked legacy firmware',
    );
    score = SCORE_WEAK;
  }
  if (score === 0) reasons.push('no evidence placing this camera on the 4.x line');
  return { score, reasons };
}

/* ---- the profile -------------------------------------------------------- */

export const modern4x: FirmwareProfile = {
  id: 'modern-4x',
  name: 'Modern 4.x',
  summary:
    'The 2018+ 4.x application line (4.8.x / 4.9.x / 4.18.x): Compact Pro, Compact Pro FF, ' +
    'Compact XR, Nano 300. Full 4 MiB selector map, xorshift128 images under whitening ' +
    'K=0x13579BDF with a 0x0000FFFF acceptance sum. The only profile whose write path has ' +
    'been exercised against hardware.',
  cipher: MODERN_CIPHER,
  memory: MODERN_MEMORY,
  capabilities: CAPABILITIES,
  slots: MODERN_SLOTS,
  boot: MODERN_BOOT,
  windowMap: buildModernWindowMap,
  sweepRange: MODERN_SWEEP_RANGE,
  detect: detectModern,
};

/**
 * `legacy-auth` — older / locked firmware (the PIR324 / Compact PRO builds).
 *
 * ---- Legacy ("older / locked firmware") algorithm -------------------
 *
 * Older Seek firmware differs from current firmware in two ways that defeat the
 * modern selector map:
 *
 *   1. The banks 0x14010000..0x14070000 (boot config, calibration, app images)
 *      are locked to an authenticated read channel. BeginFirmwareUpgrade rejects
 *      those subcommands on the plain 2-byte channel and requires an 18-byte
 *      payload (wLength 0x12) whose bytes 2..17 match a 16-byte token baked into
 *      the firmware; only then does it arm the read window. 0x14000000 (the live
 *      XIP/boot base) is hard-blocked on every channel and cannot be read at all.
 *   2. There is no selector for anything above 0x141fffff, so the upper 2 MiB is
 *      unreachable.
 *
 * This map sends the token on the protected banks and omits the blocks the legacy
 * protocol cannot reach; the dump records those as gaps (see `memory.unreachable`).
 * The subcommand -> address assignment is the old firmware's own (decoded from its
 * BeginFirmwareUpgrade jump table), which differs from the current map: e.g.
 * 0x14050000/0x14060000/0x14070000 are subcommands 7/8/9. The token selects a
 * read window only — nothing is written to the device.
 *
 * The 16-byte token is a per-build constant the firmware compares the payload
 * against (memcmp at the handler). It is build-specific: the value below was
 * recovered and verified against a Compact PRO (PIR324) unit and unlocks every
 * build sharing that image. On a unit with a different token the protected banks
 * simply stall and are gap-filled — same as the standard dump, and still safe.
 */

import { viewOf } from '../bytes.js';
import { SeekError } from '../errors.js';
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
  WindowEntry,
} from './types.js';
import { SUPPORTED, unsupported } from './types.js';
import { FLASH_BASE, FLASH_SIZE, HDR_HI, HDR_LO, WINDOW_SIZE } from './modern-4x.js';

/** Recovered and verified against one Compact PRO (PIR324) unit. */
export const OLD_FW_UNLOCK_TOKEN: Uint8Array = new Uint8Array([
  0x53, 0x16, 0x10, 0x31, 0x80, 0xdd, 0x00, 0xb7, 0x4a, 0xf9, 0xe4, 0x17, 0xc5, 0x94, 0xbe, 0xd4,
]);

/** The 18-byte (wLength 0x12) authenticated selector payload for one bank. */
export function authPayload(subcmd: number): Uint8Array {
  const bytes = new Uint8Array(2 + OLD_FW_UNLOCK_TOKEN.length);
  viewOf(bytes).setUint16(0, subcmd & 0xffff, true);
  bytes.set(OLD_FW_UNLOCK_TOKEN, 2);
  return bytes;
}

/** Highest address the legacy selector map reaches, inclusive of its window. */
const LEGACY_TOP = 0x14200000;

interface LegacyBank {
  readonly subcmd: number;
  readonly address: number;
  readonly auth: boolean;
  readonly note: string;
}

/* The old firmware's own subcommand -> address assignment. Note 7/8/9 for
 * 0x14050000/0x14060000/0x14070000 — the modern map uses 8 and 9 for
 * 0x14050000 and 0x14070000 and exposes nothing at 0x14060000 at all. */
const LEGACY_BANKS: readonly LegacyBank[] = [
  { subcmd: 0x3, address: 0x14010000, auth: true, note: 'boot config block (auth)' },
  { subcmd: 0x1, address: 0x14020000, auth: false, note: 'config/factory area' },
  { subcmd: 0x5, address: 0x14030000, auth: true, note: 'protected bank (auth)' },
  { subcmd: 0x6, address: 0x14040000, auth: true, note: 'protected bank (auth)' },
  { subcmd: 0x7, address: 0x14050000, auth: true, note: 'app image slot (auth)' },
  { subcmd: 0x8, address: 0x14060000, auth: true, note: 'app image slot (auth)' },
  { subcmd: 0x9, address: 0x14070000, auth: true, note: 'app image slot (auth)' },
];

/**
 * The legacy selector map. Auth banks carry the 18-byte payload; the plain banks
 * omit `payload` entirely rather than setting it to `undefined`, so the entry
 * itself says which channel it needs.
 */
export function buildLegacyWindowMap(): readonly WindowEntry[] {
  const entries: WindowEntry[] = LEGACY_BANKS.map((bank) =>
    bank.auth
      ? {
          subcmd: bank.subcmd,
          address: bank.address,
          auth: true,
          note: bank.note,
          payload: authPayload(bank.subcmd),
        }
      : { subcmd: bank.subcmd, address: bank.address, auth: false, note: bank.note },
  );
  for (let subcmd = 0x0a; subcmd <= 0x21; subcmd++) {
    entries.push({
      subcmd,
      address: 0x14080000 + (subcmd - 0x0a) * WINDOW_SIZE,
      auth: false,
      note: 'linear window',
    });
  }
  entries.sort((a, b) => a.address - b.address);
  return entries;
}

/* ---- descriptors -------------------------------------------------------- */

/**
 * Measured on the APK's `32K_43X0_1.3.0.8_COMPACT-16HZ` build: acceptance sum
 * 0x0000FFFF with NO whitening at all. This is the exact pairing the original's
 * `DEC_PROFILES` could not express — it assumed K=0x13579BDF whenever the sum was
 * 0xFFFF and so reported this family's keys wrong. K and TARGET are separate axes
 * here for that reason, and key *naming* must still resolve K from the image's own
 * plaintext rather than from this field.
 */
const LEGACY_CIPHER: CipherProfile = {
  whiteningK: 0x00000000,
  acceptanceSum: 0x0000ffff,
  clearWords: [HDR_LO, HDR_HI],
};

const LEGACY_MEMORY: MemoryLayout = {
  flashBase: FLASH_BASE,
  flashSize: FLASH_SIZE,
  windowSize: WINDOW_SIZE,
  bootConfigBase: 0x14010000,
  /* Same bootloader-block geometry as the 4.x line; the block itself is only
   * readable through the authenticated channel here. */
  deviceKeySlotOffset: 0x218,
  deviceKeySlotLength: 16,
  unreachable: [
    {
      address: FLASH_BASE,
      length: WINDOW_SIZE,
      reason: 'Live XIP/boot base — hard-blocked by the legacy firmware on every channel.',
    },
    {
      address: LEGACY_TOP,
      length: FLASH_BASE + FLASH_SIZE - LEGACY_TOP,
      reason: 'Upper 2 MiB — the legacy firmware exposes no read-window selector here.',
    },
  ],
};

/**
 * The three authenticated app-image banks, in address order.
 *
 * The legacy bootloader's slot roles were never decoded, so the a/b/r keys here
 * are positional, NOT a claim that 0x14050000 is "slot A" in the 4.x sense.
 * Nothing acts on the role: this profile refuses to flash, so the only consumer
 * is the dump report, which names banks by address.
 */
const LEGACY_SLOTS: readonly SlotDescriptor[] = [
  { key: 'a', name: 'App image bank 0x14050000', subcmd: 0x7, address: 0x14050000 },
  { key: 'b', name: 'App image bank 0x14060000', subcmd: 0x8, address: 0x14060000 },
  { key: 'r', name: 'App image bank 0x14070000', subcmd: 0x9, address: 0x14070000 },
];

const FLASH_REFUSAL =
  "this profile's write path was never validated against hardware and its selector map " +
  'differs from the 4.x one (0x14050000/0x14060000/0x14070000 are subcommands 7/8/9 here, ' +
  'and the protected banks answer only on the authenticated channel). Refusing is the only ' +
  'answer that cannot brick a camera.';

/**
 * No boot policy: the legacy bootloader's boot-config block was never decoded.
 *
 * `describeCfg0` stays safe to call so a UI can always print something, but
 * `selectBootSlot` refuses rather than replaying the 4.x `select_boot_slot()`
 * over a bootloader it was not read from — a fabricated "booted A, would write B"
 * is exactly the kind of confident wrong answer that costs someone a camera.
 * Callers reach this only on the flash path, which `capabilities.flash` already
 * refuses.
 */
const LEGACY_BOOT: BootPolicy = {
  /* A deliberate non-selector. There is no known subcommand that arms an upgrade
   * target on this generation, and -1 cannot be encoded as a uint16 subcommand,
   * so a stray write fails loudly instead of arming bank 0. */
  updateTargetSubcmd: -1,

  describeCfg0(cfg0: number): string {
    return `cfg0 ${String(cfg0 >>> 0)}: the legacy bootloader's boot-config layout was never decoded`;
  },

  selectBootSlot(): BootPrediction {
    throw new SeekError(
      'profile/unsupported',
      "Legacy locked firmware: the bootloader's slot-selection logic was never decoded, " +
        'so the booted slot cannot be predicted. ' +
        FLASH_REFUSAL,
      { detail: { profile: 'legacy-auth', capability: 'flash' } },
    );
  },
};

const CAPABILITIES: ProfileCapabilities = {
  dump: SUPPORTED,
  sweep: SUPPORTED,
  decrypt: SUPPORTED,
  deviceInfo: SUPPORTED,
  flash: unsupported(FLASH_REFUSAL),
};

/* ---- detection ---------------------------------------------------------- */

const SCORE_DECISIVE = 0.97;
const SCORE_CORROBORATED = 0.98;
const SCORE_STRONG = 0.75;

/** Major component of a dotted version string, or null when there is none. */
function versionMajor(version: string | undefined): number | null {
  if (version === undefined) return null;
  const match = /^\s*(\d+)\./.exec(version);
  const major = match?.[1];
  return major === undefined ? null : Number.parseInt(major, 10);
}

function detectLegacy(evidence: DeviceEvidence): DetectionVerdict {
  const reasons: string[] = [];

  /* A protected bank that opened on the plain 2-byte channel proves the
   * authenticated handler is not in the way — whatever this camera is, it is
   * not the locked legacy firmware. */
  if (evidence.plainSelectorWorks === true) {
    reasons.push(
      'a plain 2-byte BeginFirmwareUpgrade armed a protected bank, so the authenticated read channel is not in force',
    );
    return { score: 0, reasons };
  }

  const major = versionMajor(evidence.firmwareVersion);
  if (major !== null && major !== 1) {
    reasons.push(
      `reported firmware version ${String(evidence.firmwareVersion)} is not on the legacy ` +
        '1.0.3.x / 1.3.0.x numbering line',
    );
    return { score: 0, reasons };
  }

  let score = 0;
  const authRequired = evidence.authSelectorRequired === true;
  if (authRequired) {
    score = SCORE_DECISIVE;
    reasons.push(
      "a protected bank only armed after the 18-byte authenticated selector — the legacy firmware's signature",
    );
  }
  if (major === 1) {
    reasons.push(
      `reported firmware version ${String(evidence.firmwareVersion)} is on the legacy ` +
        '1.0.3.x / 1.3.0.x line, which is a different numbering line from the 4.x ' +
        'application versions, not an older 4.x',
    );
    score = authRequired ? SCORE_CORROBORATED : Math.max(score, SCORE_STRONG);
  }
  if (score === 0) reasons.push('nothing observed requires the authenticated read channel');
  return { score, reasons };
}

/* ---- the profile -------------------------------------------------------- */

export const legacyAuth: FirmwareProfile = {
  id: 'legacy-auth',
  name: 'Legacy locked firmware',
  summary:
    'Older locked builds (PIR324 / Compact PRO, 1.0.3.x / 1.3.0.x images). The protected ' +
    'banks open only to an 18-byte authenticated BeginFirmwareUpgrade carrying a per-build ' +
    '16-byte token; 0x14000000 is hard-blocked and everything above 0x141fffff has no ' +
    'selector. Read-only: the write path was never validated on this generation.',
  cipher: LEGACY_CIPHER,
  memory: LEGACY_MEMORY,
  capabilities: CAPABILITIES,
  slots: LEGACY_SLOTS,
  boot: LEGACY_BOOT,
  windowMap: buildLegacyWindowMap,
  /* The known map stops at 0x21, but a sweep probes the full 4.x range so a build
   * that exposes more selectors than this one shows up instead of going unnoticed. */
  sweepRange: [0, 0x41],
  detect: detectLegacy,
};

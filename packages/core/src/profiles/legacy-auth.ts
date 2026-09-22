/**
 * `legacy-auth` — the 2014-2017 locked line (Compact and Compact PRO).
 *
 * ---- The gate, in the firmware's own words --------------------------
 *
 * This profile used to describe a protocol that had been inferred. It is now
 * derived: FW-V1's byte-exact reconstruction of this generation's
 * `cmd_BeginFirmwareUpgrade` (`codegen/fn/cmd_BeginFirmwareUpgrade.c`, variant
 * `gcc49_shape` for the 2016 Compact PRO 1.0.3.0 and `c32k_1308` for the
 * Compact 1.3.0.8 — two independently decoded builds, identical window table)
 * opens with exactly this:
 *
 *     mode = arg0 & 0xFF;
 *     if (mode == 2)    return 0x20000;   // "Invalid memory region"
 *     if (mode > 0x21)  return 0x20000;   // "Invalid memory region"
 *     if (req_len != 2) {
 *         if (req_len != 0x12)              return 0x20100;  // "Invalid parameter"
 *         if (memcmp(arg + 2, KEY, 16) != 0) return 0x80000;  // "Invalid backdoor key"
 *     } else if ((unsigned)(mode - 2) <= 7) return 0x80000;  // "Invalid backdoor key"
 *
 * Every claim this file makes falls out of those five lines:
 *
 *   - `0x14000000` is blocked on EVERY channel, because `mode == 2` returns
 *     before the length and token tests are reached at all.
 *   - the protected set is modes 2..9 — boot config, the config/factory alias,
 *     and the five image banks — because that is what `(mode - 2) <= 7` spans
 *     on the plain channel.
 *   - there is nothing above `0x141FFFFF`, because `mode > 0x21` is rejected
 *     outright. 0x21 is the last linear window, 0x141F0000.
 *   - the 18-byte form is not a longer plain arm: the token is genuinely
 *     compared, and a wrong one is refused with a distinct status.
 *
 * ---- And measured on the wire ---------------------------------------
 *
 * The emulator sweep arms all 63 selectors of the modern map against each
 * firmware. Nine corpus builds — Compact PRO 1.0.3.0 (three parts), 1.0.3.0 FF,
 * 1.0.3.2, 1.0.3.2 FF, and Compact 1.3.0.8 and 1.3.0.8 FF — confirm exactly 25
 * and refuse exactly 38: subcommand 1 plus the 24 linear windows 0x0A..0x21 are
 * served, and the six protected banks plus the 32 selectors above 0x141FFFFF
 * are refused. That is the source arm above, counted. The same nine refuse a
 * plain arm of subcommand 5, accept the 18-byte one, and refuse an 18-byte
 * payload with one byte of the token flipped.
 *
 * The map here therefore sends the token on the protected banks and omits the
 * blocks the protocol cannot reach; the dump records those as gaps (see
 * `memory.unreachable`). The subcommand -> address assignment is this
 * generation's own and differs from the modern one: 0x14050000 / 0x14060000 /
 * 0x14070000 are subcommands 7 / 8 / 9 here, where the modern map uses 8 and 9
 * for 0x14050000 and 0x14070000 and exposes nothing at 0x14060000 at all. The
 * token selects a read window only — nothing is written to the device.
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
import { primaryVersion, versionSource } from './version.js';
import { FLASH_BASE, FLASH_SIZE, HDR_HI, HDR_LO, WINDOW_SIZE } from './modern-4x.js';

/**
 * The 16 bytes the legacy handler memcmp()s the 18-byte payload against.
 *
 * ONE TOKEN, NOT ONE PER BUILD — CORRECTED 2026-09-22. This constant carried
 * the note "recovered and verified against one Compact PRO (PIR324) unit ... it
 * is build-specific", and on a unit with a different token the protected banks
 * would simply stall. The first half is right and the second is not: searching
 * every decrypted image in the corpus for these exact bytes finds them in 22 of
 * them, once each, across two product lines and three years —
 *
 *   Compact      0.3.0.1 @0xE228 · 0.5.0.2 @0x8488 · 0.5.1.0 @0x8CE0 ·
 *                0.5.1.3 @0x8CD8 · 0.6.0.4 @0x97BC · 0.7.0.7 @0xAA50 ·
 *                0.7.0.8 @0xA354 · 0.8.0.0 @0xA540 · 0.9.0.2 @0xA5E0 ·
 *                0.9.0.6 @0xA510 · 0.9.0.7 @0xA5D0 · 0.9.1.0 @0xA5E0 ·
 *                0.10.0.0 @0xA5E0 · 1.0.0.0 @0xA5D0 · 1.2.0.0 @0xA5D4 ·
 *                1.3.0.0 @0xA5B0 · 1.3.0.8 @0xA6D0 · 1.3.0.8 FF @0xA6EC
 *   Compact PRO  1.0.3.0 @0xAC01 · 1.0.3.0 FF @0xAC11 ·
 *                1.0.3.2 @0xAC73 · 1.0.3.2 FF @0xAC73
 *
 * — and in none of the fourteen 2018-and-later images, which have no token
 * check to hold one. The offsets are regenerated into
 * `test/firmware/facts.json` and asserted there, so this claim is checked
 * rather than remembered.
 *
 * The 1.0.3.0 hit at raw 0xAC01 is the address FW-V1's reconstruction names
 * independently: "a 16-byte match at a1+2 against 0x100012A1 ... it occurs
 * exactly once in the whole image (raw 0xAC01)". Two derivations, one from the
 * handler's code and one from a byte search, landing on the same bytes.
 */
export const OLD_FW_UNLOCK_TOKEN: Uint8Array = new Uint8Array([
  0x53, 0x16, 0x10, 0x31, 0x80, 0xdd, 0x00, 0xb7, 0x4a, 0xf9, 0xe4, 0x17, 0xc5, 0x94, 0xbe, 0xd4,
]);

/**
 * The 18-byte (wLength 0x12) authenticated selector payload for one bank.
 *
 * `token` is a parameter because the one above is an observation about 22
 * images, not a law: a build outside the corpus may carry different bytes, and
 * a caller that has recovered them should be able to use them without editing
 * this file.
 */
export function authPayload(subcmd: number, token: Uint8Array = OLD_FW_UNLOCK_TOKEN): Uint8Array {
  const bytes = new Uint8Array(2 + token.length);
  viewOf(bytes).setUint16(0, subcmd & 0xffff, true);
  bytes.set(token, 2);
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
  /* Subcommand 4 is a second door onto 0x14020000 — `case 4` in the same switch
   * — but a LOCKED one, because 4 falls inside the protected 2..9 span while 1
   * does not. It is not in the map: the block is already tiled by subcommand 1
   * on the cheaper channel, and a dump covers each address once. */
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

export const LEGACY_MEMORY: MemoryLayout = {
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
export const LEGACY_SLOTS: readonly SlotDescriptor[] = [
  { key: 'a', name: 'App image bank 0x14050000', subcmd: 0x7, address: 0x14050000 },
  { key: 'b', name: 'App image bank 0x14060000', subcmd: 0x8, address: 0x14060000 },
  { key: 'r', name: 'App image bank 0x14070000', subcmd: 0x9, address: 0x14070000 },
];

/**
 * Inclusive selector range a sweep probes.
 *
 * The known map stops at 0x21 and the handler rejects `mode > 0x21` outright,
 * but a sweep probes the full modern range so a build that exposes more
 * selectors than this one shows up as an answer instead of going unnoticed.
 */
export const LEGACY_SWEEP_RANGE: readonly [number, number] = [0, 0x41];

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
export const LEGACY_BOOT: BootPolicy = {
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

/** The measurement that settles it: a protected bank refused the plain arm. */
const SCORE_DECISIVE = 0.95;
/** That refusal AND the authenticated channel working on the same bank. */
const SCORE_PROVEN = 0.98;
/** A legacy version and the authenticated channel, agreeing. */
const SCORE_CORROBORATED = 0.85;
/** One strong but indirect signal (a version, from the camera or a header). */
const SCORE_STRONG = 0.75;
/**
 * The authenticated channel alone. Deliberately under the registry's confidence
 * threshold: see `detectLegacy`.
 */
const SCORE_WEAK = 0.3;

/**
 * The two numbering lines this generation uses.
 *
 * `1.x` is the Compact PRO 1.0.3.x and the Compact 1.2/1.3.x; `0.x` is the 2014
 * Compact run from 0.3.0.1 to 0.10.0.0. They are ONE protocol: the RPC method
 * table recovered from each image puts GetErrorCode, SetOperationMode,
 * GetOperationMode, GetFirmwareInfo, GetFeaturedFirmwareData, CompleteMemoryUpgrade,
 * BeginFirmwareUpgrade and SetFirmwareInfoFeatures at 0x35, 0x3C, 0x3D, 0x4E,
 * 0x4F, 0x51, 0x52 and 0x55 on every build from 0.7.0.7 to 1.3.0.8 — the same
 * ids the modern line uses (`test/firmware/facts.json`). `0.x` was excluded
 * here until 2026-09-22 purely because the test was `major === 1`.
 *
 * The five builds OLDER than 0.7 are a different matter and have their own
 * profile; see `compact-2014`.
 */
const LEGACY_MAJORS: readonly number[] = [0, 1];

function detectLegacy(evidence: DeviceEvidence): DetectionVerdict {
  const reasons: string[] = [];

  /* THE OBSERVATION THIS PROFILE'S OWN COMMENTS SAID NOBODY MADE.
   * `probeSelectorChannel` sends a plain 2-byte arm at a bank this firmware
   * locks, precisely so the refusal can be seen. A refusal is this generation
   * and nothing else: 26 corpus firmwares accept that arm and nine refuse it,
   * and the nine are exactly the 1.0.3.x / 1.3.0.8 builds whose reconstructed
   * handler contains the `(mode - 2) <= 7` guard. */
  if (evidence.plainSelectorRefused === true) {
    reasons.push(
      'a plain 2-byte BeginFirmwareUpgrade of a protected bank was REFUSED, which is this ' +
        "generation's defining behaviour — its handler rejects modes 2..9 on the plain channel",
    );
    if (evidence.authSelectorWorks === true) {
      reasons.push(
        'and the same bank armed on the 18-byte authenticated channel, so the token in this ' +
          'profile is the one this build compares against',
      );
      return { score: SCORE_PROVEN, reasons };
    }
    return { score: SCORE_DECISIVE, reasons };
  }

  /* A protected bank that opened on the plain 2-byte channel proves the
   * authenticated handler is not in the way — whatever this camera is, it is
   * not the locked legacy firmware. */
  if (evidence.plainSelectorRefused === false || evidence.plainSelectorWorks === true) {
    reasons.push(
      'a plain 2-byte BeginFirmwareUpgrade armed a protected bank, so the authenticated read channel is not in force',
    );
    return { score: 0, reasons };
  }

  const version = primaryVersion(evidence);
  if (version !== null && !LEGACY_MAJORS.includes(version.major)) {
    reasons.push(
      `${versionSource(evidence) === 'dump' ? 'the image header says' : 'the camera reports'} ` +
        `firmware ${version.text}, which is not on the 0.x / 1.x legacy line`,
    );
    return { score: 0, reasons };
  }
  if (version !== null && version.major === 0 && version.minor < 7) {
    /* Older than the dump protocol itself. `compact-2014` owns those builds and
     * refuses to read them; scoring them here would hand a camera whose 0x52 is
     * EnterBootloaderMode to a profile that dumps. */
    reasons.push(
      `firmware ${version.text} is older than 0.7, whose RPC table has no ` +
        'GetFeaturedFirmwareData at all — that is compact-2014, not this profile',
    );
    return { score: 0, reasons };
  }

  let score = 0;
  /* "The authenticated channel worked" is not "the plain channel was refused".
   * A firmware that ignores the extra 16 bytes arms on it too — the modern one
   * demonstrably does — so on its own this stays below `CONFIDENT_SCORE` and
   * can corroborate a version without naming this family by itself. */
  const authWorks = evidence.authSelectorWorks === true;
  if (authWorks) {
    score = SCORE_WEAK;
    reasons.push(
      'a protected bank armed on the 18-byte authenticated selector, which is this ' +
        "firmware's channel — though nothing tried the plain one there, so this does not " +
        'prove the plain channel is refused',
    );
  }
  if (version !== null) {
    reasons.push(
      `firmware ${version.text} is on the 0.x / 1.x legacy line, which is a different ` +
        'numbering line from the post-2018 application versions, not an older 4.x',
    );
    score = authWorks ? SCORE_CORROBORATED : Math.max(score, SCORE_STRONG);
  }
  if (score === 0) reasons.push('nothing observed points at the authenticated read channel');
  return { score, reasons };
}

/* ---- the profile -------------------------------------------------------- */

export const legacyAuth: FirmwareProfile = {
  id: 'legacy-auth',
  name: 'Legacy locked firmware',
  summary:
    'The 2014-2017 locked line: Compact 0.7.0.7-1.3.0.8 and Compact PRO 1.0.3.x. Its ' +
    'BeginFirmwareUpgrade refuses subcommands 2..9 on the plain channel and opens them to an ' +
    '18-byte payload carrying a 16-byte token (the same token in all 22 corpus images that ' +
    'have one); 0x14000000 is blocked on every channel and there is no selector above ' +
    '0x141fffff. 25 of 63 windows answer plain, all 31 with the token. Read-only: the write ' +
    'path was never validated on this generation.',
  cipher: LEGACY_CIPHER,
  memory: LEGACY_MEMORY,
  capabilities: CAPABILITIES,
  slots: LEGACY_SLOTS,
  boot: LEGACY_BOOT,
  windowMap: buildLegacyWindowMap,
  sweepRange: LEGACY_SWEEP_RANGE,
  detect: detectLegacy,
};

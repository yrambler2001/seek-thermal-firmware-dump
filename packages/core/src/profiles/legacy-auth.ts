/**
 * `legacy-auth` — the 2014-2017 locked line (Compact and Compact PRO).
 *
 * ---- The gate, in the firmware's own words --------------------------
 *
 * This profile used to describe a protocol that had been inferred. It is now
 * derived: FW-V1's byte-exact reconstruction of this generation's
 * `cmd_BeginFirmwareUpgrade` (`targets/compact_pro_9hz_2016/src/rpc_cmds.c:2573`
 * for the 2016 Compact PRO 1.0.3.0, `targets/compact_32k_1_3_0_8/src/rpc_cmds.c:2273`
 * for the Compact 1.3.0.8 16 Hz build) opens with exactly this:
 *
 *     mode = arg0 & 0xFF;
 *     if (mode == 2)    return 0x20000;   // "Invalid memory region"
 *     if (mode > 0x21)  return 0x20000;   // "Invalid memory region"
 *     if (req_len != 2) {
 *         if (req_len != 0x12)              return 0x20100;  // "Invalid parameter"
 *         if (memcmp(arg + 2, KEY, 16) != 0) return 0x80000;  // "Invalid backdoor key"
 *     } else if ((unsigned)(mode - 2) <= 7) return 0x80000;  // "Invalid backdoor key"
 *
 * and then switches on the mode to pick the block. What follows from it:
 *
 *   - the protected set is modes 2..9 — boot config, the config/factory alias,
 *     and the five image banks — because that is what `(mode - 2) <= 7` spans
 *     on the plain channel.
 *   - there is nothing above `0x141FFFFF`, because `mode > 0x21` is rejected
 *     outright. 0x21 is the last linear window, 0x141F0000.
 *   - the 18-byte form is not a longer plain arm: the token is genuinely
 *     compared, and a wrong one is refused with a distinct status.
 *
 * ---- NOT ONE TABLE: THE BUILDS DIFFER, AND EACH ONE'S OWN IS USED ----
 *
 * CORRECTED 2026-09-23. This file used to carry one selector map for the whole
 * line, and it was wrong on nine builds. Each image's own window switch is now
 * decoded straight out of its bytes (`scripts/update-firmware-facts.mjs`, the
 * `windowTable` of every image in `test/firmware/facts.json`), and the line has
 * FOUR tables, not one:
 *
 *   build                         mode 1        mode 2                  mode 0x0E
 *   Compact 0.8.0.0               run time *    *(u32 *)0x14000000 **   0x140B0000
 *   Compact 0.9.0.2 .. 1.3.0.0    0x14020000    0x14000000, token       0x140B0000
 *   Compact 1.3.0.8               0x14020000    differs by build ***    0x140C0000
 *   Compact PRO 1.0.3.0, 1.0.3.2  0x14020000    refused outright        0x140C0000
 *
 *     *   `boot_record[1][4 + (boot_record[2] == 0)]`: an entry of the table the
 *         BOOTLOADER's boot record points at (the boot-config block), so the
 *         block depends on the bootloader, not on this image.
 *     **  a load THROUGH the word at 0x14000000, which arms whatever address that
 *         word holds — not a flash window.
 *     *** the 16 Hz image refuses mode 2 outright; the 8 Hz ("insecure") image
 *         has no mode-2 test at all and arms 0x14000000 with the token.
 *         GetFirmwareInfo reports 1.3.0.8 for both, so that block is not read.
 *
 * The one that costs a block silently is mode 0x0E: every 2014 image carries
 * the literal run 0x140A0000, 0x140B0000, 0x140B0000, 0x140D0000 in that switch,
 * so subcommand 0x0E arms 0x140B0000 again and NO subcommand arms 0x140C0000.
 * The shared map claimed 0x0E was 0x140C0000, so a dump of a 2014 Compact would
 * have written 0x140B0000's bytes at 0x140C0000. It now records 0x140C0000 as a
 * gap, with that reason, and reads 0x140B0000 once.
 *
 * ---- And measured on the wire ---------------------------------------
 *
 * The emulator sweep arms all 63 selectors of the MODERN map, on the plain
 * channel, against each firmware. The 2016-2017 builds answer 25 and refuse 38:
 * subcommand 1 plus the 24 linear windows 0x0A..0x21 are served; 2, 3, 5, 6, 8
 * and 9 are refused on that channel, and the 32 selectors above 0x21 are refused
 * outright. That is the gate above, counted — and it is a count of THAT list on
 * THAT channel, not of what this profile reads. With the token, and with
 * subcommand 7 (which the modern map does not contain), the same firmware
 * serves 31 distinct blocks, 0x14010000..0x141FFFFF, and that is what a dump
 * reads (tier 2: 31/31 windows, 0 differing bytes, on the three 1.0.3.0 dumps).
 * Tier 1 now also arms every window of each build's OWN plan, the way the dump
 * does, and checks the bytes against the emulator's image (`plan` in
 * `test/emulator/expectations.rpc.json`).
 *
 * The token selects a read window only — nothing is written to the device.
 */
import { hexUp, viewOf } from '../bytes.js';
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
  SelectorRow,
  SlotDescriptor,
  UnreachableRange,
  WindowEntry,
  WindowPlan,
} from './types.js';
import { SUPPORTED } from './types.js';
import { agreedRows, buildWindowPlan } from './plan.js';
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

/** The first block no legacy subcommand reaches: `mode > 0x21` is refused outright. */
const LEGACY_TOP = 0x14200000;

const UPPER_HOLE: UnreachableRange = {
  address: LEGACY_TOP,
  length: FLASH_BASE + FLASH_SIZE - LEGACY_TOP,
  reason:
    'Upper 2 MiB — the legacy handler refuses every subcommand above 0x21 (0x141F0000 is the ' +
    'last window it can arm), so nothing above 0x141FFFFF is reachable.',
};

/**
 * How one build's switch differs from its siblings'. Everything else in the
 * table is the same on every build from 0.5.0.2 to 1.3.0.8 (decoded from each
 * image; `test/firmware-facts.test.ts` holds these tables to those bytes).
 */
interface LegacyTraits {
  /** Mode 1: the constant 0x14020000, or an entry of the bootloader's config block. */
  readonly modeOne: 'literal' | 'boot-config';
  /**
   * Mode 2: refused before the channel test; armed on the token channel; armed
   * through a load of the word AT 0x14000000 (not a flash window); or different
   * between two builds that report the same version.
   */
  readonly modeTwo: 'refused' | 'auth' | 'indirect' | 'differs';
  /** The block subcommand 0x0E arms. */
  readonly modeFourteen: number;
}

const LINEAR_BASE = 0x14080000;

/** The build's own window table, one row per mode its switch handles (0..0x21). */
function legacyRows(traits: LegacyTraits): readonly SelectorRow[] {
  const rows: SelectorRow[] = [
    {
      subcmd: 0,
      address: null,
      channel: 'plain',
      note:
        traits.modeOne === 'boot-config'
          ? "reads entry 1 or 2 of the bootloader's config block at run time"
          : 'fw_update_slot_address(): arms 0x14050000 or 0x14060000 — the slot the roots' +
            ' active-slot word does not name (the upgrade target)',
    },
    traits.modeOne === 'literal'
      ? { subcmd: 1, address: 0x14020000, channel: 'plain', note: 'config/factory area' }
      : {
          subcmd: 1,
          address: null,
          channel: 'plain',
          note:
            "reads entry 4 or 5 of the bootloader's config block at run time (the table the boot " +
            "record's second word points at), so the block depends on the bootloader, not on this " +
            'image; subcommand 4 reaches 0x14020000 as a constant instead',
        },
  ];
  switch (traits.modeTwo) {
    case 'refused':
      rows.push({
        subcmd: 2,
        address: 0x14000000,
        channel: 'refused',
        note: 'refused outright (mode == 2), before the channel test',
      });
      break;
    case 'auth':
      rows.push({
        subcmd: 2,
        address: 0x14000000,
        channel: 'auth',
        note: 'SPIFI flash base / bootloader block (auth) — this build has no mode-2 refusal',
      });
      break;
    case 'indirect':
      rows.push({
        subcmd: 2,
        address: null,
        channel: 'auth',
        note: 'loads the word stored AT 0x14000000 and arms that as the address: not a flash window',
      });
      break;
    case 'differs':
      /* Both images carry the 0x14000000 literal; only the gate in front of the
       * switch differs. The address is the image's, and the channel is the
       * conservative one, since the version cannot say which gate is running. */
      rows.push({
        subcmd: 2,
        address: 0x14000000,
        channel: 'refused',
        note:
          'the 16 Hz build refuses mode 2 outright and the 8 Hz build arms 0x14000000 with the ' +
          'token; both report the same version, so this table takes the refusal',
      });
      break;
  }
  rows.push(
    { subcmd: 3, address: 0x14010000, channel: 'auth', note: 'boot config block (auth)' },
    {
      subcmd: 4,
      address: 0x14020000,
      channel: 'auth',
      note: 'config/factory area, second door (auth)',
    },
    { subcmd: 5, address: 0x14030000, channel: 'auth', note: 'protected bank (auth)' },
    { subcmd: 6, address: 0x14040000, channel: 'auth', note: 'protected bank (auth)' },
    { subcmd: 7, address: 0x14050000, channel: 'auth', note: 'app image slot (auth)' },
    { subcmd: 8, address: 0x14060000, channel: 'auth', note: 'app image slot (auth)' },
    { subcmd: 9, address: 0x14070000, channel: 'auth', note: 'app image slot (auth)' },
  );
  for (let subcmd = 0x0a; subcmd <= 0x21; subcmd++) {
    const linear = LINEAR_BASE + (subcmd - 0x0a) * WINDOW_SIZE;
    const address = subcmd === 0x0e ? traits.modeFourteen : linear;
    rows.push({
      subcmd,
      address,
      channel: 'plain',
      note:
        address === linear
          ? 'linear window'
          : `this build's own table gives 0x0E the address ${hexUp(address)}, not ${hexUp(linear)}`,
    });
  }
  return rows;
}

/** The reasons for every block a build's rows leave unread. */
function legacyHoles(traits: LegacyTraits): readonly UnreachableRange[] {
  const holes: UnreachableRange[] = [UPPER_HOLE];
  const bootReason: Record<LegacyTraits['modeTwo'], string | null> = {
    refused:
      'Bootloader block — this build refuses mode 2 outright (the `mode == 2` test runs before ' +
      'the channel test), so no payload arms it.',
    auth: null,
    indirect:
      "Bootloader block — this build's mode 2 does not arm it: the handler loads the word stored " +
      'at 0x14000000 and arms THAT as the address, which is not a flash window, so it is not sent.',
    differs:
      'Bootloader block — 1.3.0.8 ships as a 16 Hz build that refuses mode 2 outright and an 8 Hz ' +
      'build that arms it with the token. GetFirmwareInfo reports 1.3.0.8 for both, so it is not ' +
      'read.',
  };
  const boot = bootReason[traits.modeTwo];
  if (boot !== null) holes.push({ address: FLASH_BASE, length: WINDOW_SIZE, reason: boot });
  const gapFourteen = LINEAR_BASE + (0x0e - 0x0a) * WINDOW_SIZE;
  if (traits.modeFourteen !== gapFourteen) {
    holes.push({
      address: gapFourteen,
      length: WINDOW_SIZE,
      reason:
        `No subcommand arms ${hexUp(gapFourteen)} on this build: its own window table gives ` +
        `subcommand 0x0E the address ${hexUp(traits.modeFourteen)}, the same block as 0x0D (the ` +
        'image carries that literal twice). Left as a gap rather than filled from another address.',
    });
  }
  return holes;
}

/**
 * Every build of this line whose table has been decoded from its image, by the
 * version its GetFirmwareInfo reports. `test/firmware-facts.test.ts` fails if a
 * corpus image of this line is missing here, or if a row disagrees with that
 * image's own switch.
 *
 * Builds older than 0.8.0.0 are not here: their tables decode too, but they have
 * no read command a dump can use (see `compact-2014`).
 */
const LEGACY_BUILDS: ReadonlyMap<string, LegacyTraits> = new Map<string, LegacyTraits>([
  ['0.8.0.0', { modeOne: 'boot-config', modeTwo: 'indirect', modeFourteen: 0x140b0000 }],
  ...['0.9.0.2', '0.9.0.6', '0.9.0.7', '0.9.1.0', '0.10.0.0', '1.0.0.0', '1.2.0.0', '1.3.0.0'].map(
    (v): [string, LegacyTraits] => [
      v,
      { modeOne: 'literal', modeTwo: 'auth', modeFourteen: 0x140b0000 },
    ],
  ),
  ['1.3.0.8', { modeOne: 'literal', modeTwo: 'differs', modeFourteen: 0x140c0000 }],
  ['1.0.3.0', { modeOne: 'literal', modeTwo: 'refused', modeFourteen: 0x140c0000 }],
  ['1.0.3.2', { modeOne: 'literal', modeTwo: 'refused', modeFourteen: 0x140c0000 }],
]);

/** The versions `legacyWindowPlan` has a decoded table for, in no particular order. */
export const LEGACY_KNOWN_VERSIONS: readonly string[] = [...LEGACY_BUILDS.keys()];

/** The table a version's own image decodes to, or null for a build not in the corpus. */
export function legacySelectorRows(version: string): readonly SelectorRow[] | null {
  const traits = LEGACY_BUILDS.get(version);
  return traits === undefined ? null : legacyRows(traits);
}

/** `1.3.0.8`, from whatever GetFirmwareInfo's four bytes became. */
function normalisedVersion(version: string | null): string | null {
  if (version === null) return null;
  const match = /^\s*(\d+)\.(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (match === null) return null;
  return match
    .slice(1, 5)
    .map((n) => String(Number.parseInt(n, 10)))
    .join('.');
}

/**
 * The builds of this line whose own decoded mode-0 row is the upgrade target —
 * `fw_update_slot_address()` over the roots' active-slot word. Every image from
 * 0.9.0.2 on computes mode 0 the same way (loads `0x10000200`, the roots word
 * GetFirmwareInfo selector 10 reports, and `0x14060000`;
 * `test/firmware/facts.json`), and FW-V1's reconstruction of the function names
 * it: active_slot 0 -> slot B, anything else -> slot A. 0.8.0.0 computes mode 0
 * through the bootloader's own config table instead, and nothing has measured
 * where that lands, so the plaintext-chain write path is decoded for these
 * builds and refuses the rest.
 */
export function legacyUpgradeTargetBuild(version: string | null): string | null {
  const v = normalisedVersion(version);
  if (v === null) return null;
  const traits = LEGACY_BUILDS.get(v);
  return traits !== undefined && traits.modeOne !== 'boot-config' ? v : null;
}

/** The first build with a read handler for GetFeaturedFirmwareData (see `compact-2014`). */
function predatesReadHandler(version: string): boolean {
  const [major, minor] = version.split('.').map((n) => Number.parseInt(n, 10));
  return major === 0 && (minor ?? 0) < 8;
}

const plainOrAuth = {
  flashBase: FLASH_BASE,
  flashSize: FLASH_SIZE,
  windowSize: WINDOW_SIZE,
  authPayload: (subcmd: number) => authPayload(subcmd),
  markPlain: true,
} as const;

/**
 * The plan for one build of this line: its own table when the version is one
 * this file has decoded, the rows every decoded build agrees on otherwise.
 *
 * `compact-2016` uses this too: the two profiles differ in their cipher, not in
 * their selector tables.
 */
export function legacyWindowPlan(firmwareVersion: string | null): WindowPlan {
  const version = normalisedVersion(firmwareVersion);

  if (version !== null && predatesReadHandler(version)) {
    return {
      firmwareVersion,
      table: `none: ${version} predates the read handler (see compact-2014)`,
      selectors: [],
      windows: [],
      unreachable: [
        {
          address: FLASH_BASE,
          length: FLASH_SIZE,
          reason:
            `Firmware ${version} has no read handler for GetFeaturedFirmwareData, so no window ` +
            'can be read on it whatever the selector map says.',
        },
      ],
    };
  }

  const traits = version === null ? undefined : LEGACY_BUILDS.get(version);
  if (traits !== undefined && version !== null) {
    return buildWindowPlan({
      ...plainOrAuth,
      table: `legacy ${version}: this build's own BeginFirmwareUpgrade table`,
      firmwareVersion,
      selectors: legacyRows(traits),
      holes: legacyHoles(traits),
    });
  }

  /* Not a build this file knows, or no version at all: only what every known
   * build agrees on. Mode 1 disagrees (0.8.0.0 computes it), so 0x14020000 is
   * read through subcommand 4 and the token; mode 2 and mode 0x0E disagree, so
   * 0x14000000 and 0x140C0000 are gaps that say why. */
  const known = [...LEGACY_BUILDS.values()].map(legacyRows);
  const agreed = agreedRows(
    known,
    (subcmd) =>
      `the builds this profile knows disagree about subcommand ${hexUp(subcmd, 2)}, and the ` +
      'version did not say which one this is',
  );
  const unknown =
    version === null
      ? 'the firmware version could not be read'
      : `firmware ${version} is not a build whose table has been decoded`;
  const unknownSentence =
    version === null
      ? 'The firmware version could not be read'
      : `Firmware ${version} is not a build whose table has been decoded`;
  return buildWindowPlan({
    ...plainOrAuth,
    table: `legacy, version unknown: the rows every decoded build agrees on (${unknown})`,
    firmwareVersion,
    selectors: agreed,
    holes: [
      UPPER_HOLE,
      {
        address: FLASH_BASE,
        length: WINDOW_SIZE,
        reason:
          `Bootloader block — ${unknown}, and the builds disagree about mode 2 (refused outright, ` +
          'armed with the token, or armed through a pointer), so it is not read.',
      },
      {
        address: LINEAR_BASE + (0x0e - 0x0a) * WINDOW_SIZE,
        length: WINDOW_SIZE,
        reason:
          `${unknownSentence}, and subcommand 0x0E arms 0x140C0000 on the 2016-2017 builds but ` +
          '0x140B0000 on the 2014 ones, so it is not read.',
      },
    ],
  });
}

/**
 * The selector map when the version is not known — `legacyWindowPlan(null)`.
 *
 * Kept for listings and for callers with no camera to ask. A dump, a sweep and
 * a device read resolve the version and use `legacyWindowPlan` itself.
 */
export function buildLegacyWindowMap(): readonly WindowEntry[] {
  return legacyWindowPlan(null).windows;
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
  /* Same bootloader-block geometry as the 4.x line. Whether the block itself
   * can be read is a per-build question: see `legacyWindowPlan`. */
  deviceKeySlotOffset: 0x218,
  deviceKeySlotLength: 16,
  /* Only what NO build of this line reaches. The bootloader block used to be
   * listed here as "hard-blocked on every channel"; that is true of the 2016
   * Compact PRO and the 1.3.0.8 16 Hz build and false of the 2014 Compacts from
   * 0.9.0.2 on, which arm it with the token. */
  unreachable: [UPPER_HOLE],
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

/**
 * No replayable boot policy: this generation's `select_boot_slot()` has not
 * been reconstructed into this profile, so `selectBootSlot` refuses rather than
 * replaying the 4.x one over a bootloader it was not read from — a fabricated
 * "booted A, would write B" is exactly the kind of confident wrong answer that
 * costs someone a camera.
 *
 * THE WRITE PATH DOES NOT NEED THE REPLAY. On the 2014 plaintext chain the
 * camera answers for itself: `fw_update_slot_address()` — mode 0, the selector
 * `readDeviceInfo` confirms on the wire — reads the roots' active-slot word and
 * arms the OTHER bank, so the device-info read names the booted and target
 * slots from that word and never replays cfg[0] (`legacyUpgradeTargetBuild`
 * holds this to the builds whose own decoded table says so).
 */
export const LEGACY_BOOT: BootPolicy = {
  /* A deliberate non-selector in the PROFILE POLICY: `upgradeSelectorIn` only
   * arms the profile's number when the running build's own table carries it,
   * and this profile's number is used by no generic path. The plaintext chain's
   * write sets the state's selector itself, from the build's decoded mode-0 row
   * and the chain gate — never from this field. -1 cannot be encoded as a
   * uint16 subcommand, so a stray write fails loudly instead of arming bank 0. */
  updateTargetSubcmd: -1,

  describeCfg0(cfg0: number): string {
    return `cfg0 ${String(cfg0 >>> 0)}: the legacy bootloader's boot-config layout was never decoded`;
  },

  selectBootSlot(): BootPrediction {
    throw new SeekError(
      'profile/unsupported',
      "Legacy locked firmware: this generation's select_boot_slot() has not been " +
        'reconstructed, so the booted slot cannot be replayed from cfg[0]. On the 2014 ' +
        "plaintext chain the write path does not replay it — the camera's own active-slot " +
        'word names both ends of an upgrade (mode 0, fw_update_slot_address()).',
      { detail: { profile: 'legacy-auth', capability: 'flash' } },
    );
  },
};

const CAPABILITIES: ProfileCapabilities = {
  dump: SUPPORTED,
  sweep: SUPPORTED,
  decrypt: SUPPORTED,
  deviceInfo: SUPPORTED,
  /* The write path is the preservation campaign's, measured against the real
   * 1.3.0.0 dump's chain (TESTING.md sec.23): BeginFirmwareUpgrade(0) arms
   * fw_update_slot_address(), SetFeaturedFirmwareData stages IMAGE LENGTH ONLY
   * (the descriptor's staging buffer holds 0xE000), CompleteMemoryUpgrade
   * checks the u16 sum of the staged bytes and programs exactly those bytes.
   * THE GATE is what keeps it off everything else: only the 2014 plaintext
   * chain — banks stored plain, word sum 0, no key material — passes it, and
   * every other build of the line is refused with that reason. Where the
   * refusal lived before, per profile, it now lives per chain, because the
   * line's own decoded tables and the v1 campaign settled what is and is not
   * staged on it. */
  flash: SUPPORTED,
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
 * The builds OLDER than 0.8 are a different matter and have their own profile;
 * see `compact-2014`. Five have no GetFeaturedFirmwareData at all, and 0.7.0.7
 * and 0.7.0.8 have it at 0x4F with the right name and the handler in the SETTER
 * column, so a read cannot be dispatched (corrected 2026-09-23: this said 0.7).
 */
const LEGACY_MAJORS: readonly number[] = [0, 1];

function detectLegacy(evidence: DeviceEvidence): DetectionVerdict {
  const reasons: string[] = [];

  /* FIRST, BEFORE ANY CHANNEL EVIDENCE. A 0.7.0.x camera refuses the plain arm
   * of a protected bank exactly as this line does — its handler is this line's —
   * and then cannot serve a byte, because its read command has no getter. The
   * version is what separates them, so it is asked before the refusal can
   * score. */
  const early = primaryVersion(evidence);
  if (early !== null && early.major === 0 && early.minor < 8) {
    reasons.push(
      `firmware ${early.text} is older than 0.8.0.0: its RPC table has no read handler for ` +
        'GetFeaturedFirmwareData (none at all before 0.7.0.7, and a setter only on 0.7.0.7 and ' +
        '0.7.0.8) — that is compact-2014, not this profile',
    );
    return { score: 0, reasons };
  }

  /* THE OBSERVATION THIS PROFILE'S OWN COMMENTS SAID NOBODY MADE.
   * `probeSelectorChannel` sends a plain 2-byte arm at a bank this firmware
   * locks, precisely so the refusal can be seen. A refusal is this generation
   * and nothing else: the 26 post-2018 corpus firmwares accept that arm, and the
   * ones that refuse it are exactly the builds whose handler contains the
   * `(mode - 2) <= 7` guard — FW-V1's reconstructions of 1.0.3.0 and 1.3.0.8,
   * and every 2014 image's own switch from 0.5.0.2 on (`plainChannelLockedModes`
   * in `test/firmware/facts.json`). */
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
    'The 2014-2017 locked line: Compact 0.8.0.0-1.3.0.8 and Compact PRO 1.0.3.x. Its ' +
    'BeginFirmwareUpgrade refuses subcommands 2..9 on the plain channel and opens them to an ' +
    '18-byte payload carrying a 16-byte token (the same token in all 22 corpus images that ' +
    'have one), and there is no selector above 0x141fffff. Each build is dumped with its own ' +
    'selector table: 31 blocks on the 2016-2017 builds (25 of the modern map answer plain), ' +
    'and on the 2014 builds 0x140C0000 is out of reach because their table gives subcommand ' +
    '0x0E the address of 0x0D. Flashing works on the 2014 plaintext chain — banks stored ' +
    'plain, word sum 0, no keys, the staged bytes verbatim — and the device-info gate ' +
    'refuses every other build of the line with that reason.',
  cipher: LEGACY_CIPHER,
  memory: LEGACY_MEMORY,
  capabilities: CAPABILITIES,
  slots: LEGACY_SLOTS,
  boot: LEGACY_BOOT,
  windowMap: buildLegacyWindowMap,
  windowPlan: legacyWindowPlan,
  sweepRange: LEGACY_SWEEP_RANGE,
  detect: detectLegacy,
};

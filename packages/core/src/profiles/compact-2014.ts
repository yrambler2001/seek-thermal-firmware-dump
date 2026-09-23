/**
 * `compact-2014` — the seven earliest Compact builds, which have no read path
 * a dump can use and must not be sent one.
 *
 * WHY A PROFILE FOR A CAMERA THIS CANNOT READ. Because the alternative is
 * worse than not reading it. Every other profile answers "which selector map",
 * and for these builds the honest answer is a different question: the command
 * the dump reads with is either missing or registered as a write, and on the
 * oldest build one of the other opcodes takes the camera out of the application.
 *
 * ---- What the images say ---------------------------------------------
 *
 * Each decrypted Seek image carries its own RPC method table: an array of
 * 16-byte records {name, getter, setter, flags}, with wire id = index + 53.
 * FW-V1's byte-exact reconstruction names that structure (`g_rpc_method_table`,
 * `targets/compact_pro_ff/src/rpc_cmds.c`), and
 * `scripts/update-firmware-facts.mjs` recovers it from all 36 decrypted images
 * in the corpus into `test/firmware/facts.json` — both handler columns, since
 * 2026-09-23. The dispatcher routes a control IN to the GETTER column and a
 * control OUT to the setter; an empty column is a stall. Seven builds cannot
 * serve the read a dump sends:
 *
 *   build     0x4F                                  0x52
 *   0.3.0.1   UploadFirmwareRowSize (setter only)   EnterBootloaderMode
 *   0.5.0.2   UploadFirmwareRowSize (setter only)   BeginFirmwareUpgrade
 *   0.5.1.0   UploadFirmwareRowSize (setter only)   BeginFirmwareUpgrade
 *   0.5.1.3   UploadFirmwareRowSize (setter only)   BeginFirmwareUpgrade
 *   0.6.0.4   UploadFirmwareRowSize (setter only)   BeginFirmwareUpgrade
 *   0.7.0.7   GetFeaturedFirmwareData, SETTER ONLY  BeginFirmwareUpgrade
 *   0.7.0.8   GetFeaturedFirmwareData, SETTER ONLY  BeginFirmwareUpgrade
 *
 * `GetFeaturedFirmwareData` is the ONLY command this toolkit reads flash with.
 * On the first five it is not in the table at all. On 0.7.0.7 and 0.7.0.8 it is,
 * with the right name, and its handler sits in the setter column with no getter
 * — so the control-IN read cannot be dispatched, however the window is armed.
 * Measured on the emulator (TESTING.md sec.9.10): the arms of 1 and 0x0A..0x21
 * come back with error code 0, and every read stalls at 64, 32, 16 and 8 bytes.
 * The first build with a getter there is 0.8.0.0.
 *
 * CORRECTED 2026-09-23. This profile used to stop at 0.6.0.4 and call 0.7.0.7
 * "the first corpus build with the full set", because the facts recorded names
 * and not columns. Whether the bulk transport reaches the 0.7.0.x handler was
 * not tried; this toolkit reads over control transfers only.
 *
 * ---- And why that makes a refusal the safe answer -------------------
 *
 * On 0.3.0.1 specifically, wire id 0x52 is `EnterBootloaderMode`. A dump arms
 * its windows and a sweep probes 66 selectors with that id; against that camera,
 * every one of those is a request to leave the application, with a two-byte
 * argument it will interpret as something of its own. Confirmed on the wire:
 * against emulated 0.3.0.1 the toolkit's own `armWindow` gets a clean control-OUT
 * for subcommands 0, 1 and 0x0A..0x21, a stall for 2..9, and `GetErrorCode` then
 * reports 0x00400000 — a status outside the documented vocabulary of every later
 * build — while `GetFeaturedFirmwareData` stalls at offset 0. The camera is
 * answering; it is answering a different protocol.
 *
 * So this profile refuses `dump`, `sweep` and `flash`, and says which command
 * it would otherwise have sent. `decrypt` stays available because a dump
 * obtained by other means (an SPI programmer, a J-Link SPIFI read) decrypts
 * perfectly well, and `deviceInfo` stays available because `GetFirmwareInfo`
 * (0x4E) and `GetErrorCode` (0x35) ARE at their usual ids, with getters, on all
 * seven builds.
 *
 * ---- What this profile does NOT claim --------------------------------
 *
 * That these cameras cannot be read at all. It claims that THIS protocol cannot
 * read them, which is a statement about seven recovered method tables. If a
 * 0.5.x camera turns out to serve flash through `UploadFirmwareRowSize` or some
 * command not in the table, or a 0.7.0.x one serves the setter's reader over the
 * bulk endpoint, that is a new read path and this profile is where it would go.
 */

import type {
  DetectionVerdict,
  DeviceEvidence,
  FirmwareProfile,
  MemoryLayout,
  ProfileCapabilities,
} from './types.js';
import { unsupported, SUPPORTED } from './types.js';
import { FLASH_BASE, FLASH_SIZE, HDR_HI, HDR_LO, WINDOW_SIZE } from './modern-4x.js';
import { LEGACY_BOOT, LEGACY_SLOTS } from './legacy-auth.js';
import { primaryVersion, versionSource } from './version.js';
import type { CipherProfile, WindowEntry } from './types.js';

/**
 * The first build with a read path.
 *
 * 0.8.0.0 (Sep 2014): the first corpus build whose method table has a GETTER
 * for `GetFeaturedFirmwareData` at 0x4F. 0.7.0.7 and 0.7.0.8 have the name
 * there with a setter only; every build before them has neither. (Corrected
 * 2026-09-23 from 0.7.0.7.)
 */
export const FIRST_READABLE_VERSION = '0.8.0.0';

const NO_READ_COMMAND =
  'firmware older than 0.8.0.0 has no read handler for GetFeaturedFirmwareData, the only ' +
  'command this toolkit reads flash with. On 0.7.0.7 and 0.7.0.8 it is in the RPC method ' +
  'table at 0x4F but registered as a setter (write handler) only, so the control-IN read a ' +
  'dump sends cannot be dispatched; before 0.7.0.7 wire id 0x4F is UploadFirmwareRowSize, and ' +
  'on 0.3.0.1 wire id 0x52 — the one a dump arms with — is EnterBootloaderMode rather than ' +
  'BeginFirmwareUpgrade, so sending it would ask the camera to leave the application. ' +
  "Recovered from the images' own method tables, both handler columns; see " +
  'test/firmware/facts.json.';

const NO_WRITE_PATH =
  'the upgrade protocol on this generation is UploadFirmware / VerifyFirmwareSendCRC16 / ' +
  'EnterBootloaderMode, none of which this toolkit implements, and its selector map, key ' +
  'table and bank layout were all decoded against later builds.';

/**
 * No selector map. An EMPTY map, not the modern one borrowed.
 *
 * `generic` borrows the modern map because a dump that might work is better
 * than none; here a dump that might work is the hazard. An empty map also makes
 * `capabilities.dump` and the map agree, so a caller that bypasses the
 * capability gate still issues nothing.
 */
function buildEmptyWindowMap(): readonly WindowEntry[] {
  return [];
}

const CIPHER: CipherProfile = {
  /* These images decrypt like the rest of the legacy line: no whitening. The
   * acceptance sum is 0x00000000 on every 0.x image in the corpus. Used only to
   * NAME a recovered key — the cryptanalytic recovery reads the state out of
   * the image itself and needs neither field. */
  whiteningK: 0x00000000,
  acceptanceSum: 0x00000000,
  clearWords: [HDR_LO, HDR_HI],
};

const MEMORY: MemoryLayout = {
  flashBase: FLASH_BASE,
  flashSize: FLASH_SIZE,
  windowSize: WINDOW_SIZE,
  bootConfigBase: 0x14010000,
  deviceKeySlotOffset: 0x218,
  deviceKeySlotLength: 16,
  unreachable: [
    {
      address: FLASH_BASE,
      length: FLASH_SIZE,
      reason: 'The whole part is out of reach over USB on this generation: ' + NO_READ_COMMAND,
    },
  ],
};

const CAPABILITIES: ProfileCapabilities = {
  dump: unsupported(NO_READ_COMMAND),
  sweep: unsupported(
    'a sweep probes 66 BeginFirmwareUpgrade selectors, and on 0.3.0.1 that wire id is ' +
      'EnterBootloaderMode. ' +
      NO_READ_COMMAND,
  ),
  /* Both of these read nothing off the camera's flash. A dump obtained another
   * way decrypts normally, and the info commands are at their usual wire ids. */
  decrypt: SUPPORTED,
  deviceInfo: SUPPORTED,
  flash: unsupported(NO_WRITE_PATH),
};

/* ---- detection ---------------------------------------------------------- */

/** The camera reported a version older than the read path existed. */
const SCORE_DECISIVE = 0.95;
/** A dump's image headers say so, which is the same fact one step removed. */
const SCORE_STRONG = 0.8;

/** Is this version older than 0.8.0.0? */
function predatesReadPath(major: number, minor: number): boolean {
  return major === 0 && minor < 8;
}

function detectCompact2014(evidence: DeviceEvidence): DetectionVerdict {
  const reasons: string[] = [];
  const version = primaryVersion(evidence);

  if (version === null) {
    /* NO GUESSING FROM A MISSING VERSION. This profile refuses to read, so a
     * false positive costs the user a dump they could have taken. It names
     * itself only when a version says so. */
    reasons.push('no firmware version was reported or found in an image header');
    return { score: 0, reasons };
  }

  if (!predatesReadPath(version.major, version.minor)) {
    reasons.push(
      `firmware ${version.text} is ${FIRST_READABLE_VERSION} or later, so its RPC table has ` +
        'a getter for GetFeaturedFirmwareData and the ordinary read path applies',
    );
    return { score: 0, reasons };
  }

  const fromDump = versionSource(evidence) === 'dump';
  reasons.push(
    `${fromDump ? 'the image header says' : 'the camera reports'} firmware ${version.text}, ` +
      `which is older than ${FIRST_READABLE_VERSION} — the first build whose RPC method table ` +
      'has a read handler (getter) for GetFeaturedFirmwareData',
  );
  if (evidence.windowReadable === false) {
    reasons.push('and no window could be read, which is what that predicts');
  }
  return { score: fromDump ? SCORE_STRONG : SCORE_DECISIVE, reasons };
}

/* ---- the profile -------------------------------------------------------- */

export const compact2014: FirmwareProfile = {
  id: 'compact-2014',
  name: 'Early Compact (pre-0.8)',
  summary:
    'The 2014 Compact builds older than 0.8.0.0 (0.3.0.1, 0.5.0.2, 0.5.1.0, 0.5.1.3, 0.6.0.4, ' +
    '0.7.0.7, 0.7.0.8). None has a read handler for GetFeaturedFirmwareData: before 0.7.0.7 ' +
    'wire id 0x4F is UploadFirmwareRowSize, and on 0.7.0.7 and 0.7.0.8 it is registered as a ' +
    'setter only, so the read a dump sends cannot be dispatched. On 0.3.0.1 wire id 0x52 is ' +
    'EnterBootloaderMode rather than BeginFirmwareUpgrade. Dumping and sweeping are refused ' +
    'rather than attempted; decrypting a dump taken by other means still works.',
  cipher: CIPHER,
  memory: MEMORY,
  capabilities: CAPABILITIES,
  /* Positional and unused: nothing here writes, and the boot policy refuses
   * rather than replaying a bootloader nobody has decoded on this generation. */
  slots: LEGACY_SLOTS,
  boot: LEGACY_BOOT,
  windowMap: buildEmptyWindowMap,
  windowPlan: (firmwareVersion) => ({
    firmwareVersion,
    table: 'none: no read handler on this generation',
    selectors: [],
    windows: [],
    unreachable: MEMORY.unreachable,
  }),
  /* An empty range. `sweepRange` is inclusive, so lo > hi means "probe nothing";
   * the capability gate refuses first, and this is the belt to that's braces. */
  sweepRange: [1, 0],
  detect: detectCompact2014,
};

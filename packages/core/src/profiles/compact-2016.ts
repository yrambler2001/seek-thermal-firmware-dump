/**
 * `compact-2016` — the 2016 generation, which is `legacy-auth`'s protocol with
 * a different cipher.
 *
 * The original never identified this generation positively. It identified it by
 * elimination, in the device-info path:
 *
 *   "The 2016 Compact Pro generation uses K=0 / acceptance sum 0 and a different
 *    BeginFirmwareUpgrade map. Nothing here is valid for it."
 *
 * and then, when no slot decrypted to the 0x0000FFFF target:
 *
 *   "no slot on this camera decrypts to the 0x0000FFFF acceptance sum this view
 *    expects — it is probably the 2016 generation. Flashing is disabled."
 *
 * That negative test is encoded here as a real profile: the cipher it actually
 * uses is declared, the read paths stay open, and `capabilities.flash` refuses
 * with the reason the original only logged.
 *
 * ---- WHAT CHANGED, 2026-09-22, AND WHY IT MATTERS -------------------
 *
 * This profile used to carry the MODERN selector map and say so in its own
 * summary: "UNVERIFIED SELECTOR MAP — the map below is the 4.x one ... this
 * generation is known to use a different BeginFirmwareUpgrade map, so windows
 * may stall and be gap-filled." It knew it was wrong and shipped anyway.
 *
 * It is not unverified any more, in either direction. The generation this
 * profile is named after IS the one `legacy-auth` describes:
 *
 *   - FW-V1's byte-exact reconstruction of the 2016 Compact PRO 1.0.3.0's
 *     `cmd_BeginFirmwareUpgrade` (`codegen/fn/cmd_BeginFirmwareUpgrade.c`,
 *     variant `gcc49_shape`, target `compact_pro_9hz_2016`) is the handler with
 *     the `(mode - 2) <= 7` plain-channel guard and the 16-byte `memcmp`. Its
 *     window table is `0x14050000`/`0x14060000` for the case-0 image-id gate,
 *     then `0x14020000`, `0x14000000`, `0x14010000`, `0x14020000`,
 *     `0x14030000` .. `0x141F0000` for cases 1..0x21 — which is `legacy-auth`'s
 *     map, bank for bank.
 *   - Measured, the three 2016 parts and the four 1.0.3.x images answer 25 of
 *     the modern map's 63 selectors and refuse 38: the six protected banks and
 *     every selector above 0x141FFFFF.
 *
 * So the old arrangement gap-filled the six banks that hold the boot config and
 * the firmware images — the most interesting 384 KiB on the part — and spent 32
 * refused selectors on 2 MiB of address space this generation does not decode.
 * It now uses the map its firmware has, with the token on the protected banks.
 *
 * AND WHY IT BARELY MATTERS WHICH OF THE TWO A LIVE CAMERA LANDS ON. They now
 * share a selector map, so the DUMP is the same either way; the only thing the
 * choice decides is which acceptance sum a decrypted slot is compared against,
 * and once there is a dump the sum itself settles that. On a camera the
 * capability probe has no sums to offer and `legacy-auth` wins on the version,
 * which used to mean reading 25 windows instead of 31 and now means reading the
 * same 31 with a different label on the confidence line.
 *
 * WHAT IS STILL ITS OWN, and why this is not simply `legacy-auth`: the cipher.
 * A 1.0.3.x part decrypts to a 0x00000000 acceptance sum, a 1.3.0.8 Compact to
 * 0x0000FFFF, and both under no whitening at all. The toolkit's own
 * `CipherProfile` keeps K and TARGET as separate axes for exactly this reason,
 * and the two profiles differ in one field.
 */

import { hexUp } from '../bytes.js';
import type {
  DetectionVerdict,
  DeviceEvidence,
  FirmwareProfile,
  CipherProfile,
  ProfileCapabilities,
} from './types.js';
import { SUPPORTED, unsupported } from './types.js';
import { HDR_HI, HDR_LO } from './modern-4x.js';
import {
  buildLegacyWindowMap,
  LEGACY_BOOT,
  LEGACY_MEMORY,
  LEGACY_SLOTS,
  LEGACY_SWEEP_RANGE,
  legacyWindowPlan,
} from './legacy-auth.js';
import { primaryVersion, versionSource } from './version.js';

/** No whitening and a zero acceptance target — the original's second DEC_PROFILE. */
const COMPACT_2016_CIPHER: CipherProfile = {
  whiteningK: 0x00000000,
  acceptanceSum: 0x00000000,
  clearWords: [HDR_LO, HDR_HI],
};

const FLASH_REFUSAL =
  'the 2016 generation uses a different BeginFirmwareUpgrade selector map, and nothing in the ' +
  'write path is valid for it: the slot bases, the update-target selector, the boot-config ' +
  'replay and the key table were all decoded against the post-2018 line. The original disabled ' +
  'flashing on exactly this evidence and this profile keeps that refusal.';

const CAPABILITIES: ProfileCapabilities = {
  /* Reads stay open, and now on the right map: the six protected banks are
   * reachable with the token rather than gap-filled. */
  dump: SUPPORTED,
  sweep: SUPPORTED,
  decrypt: SUPPORTED,
  deviceInfo: SUPPORTED,
  flash: unsupported(FLASH_REFUSAL),
};

/* ---- detection ---------------------------------------------------------- */

/** Every slot summing to zero is the defining measurement for this generation. */
const SCORE_DECISIVE = 0.9;
/** The zero sum AND the plain channel measured refused on a protected bank. */
const SCORE_CORROBORATED = 0.96;
/** The legacy line is numbered 0.x/1.x, but so is the locked Compact firmware. */
const SCORE_WEAK = 0.35;

const MODERN_ACCEPT_SUM = 0x0000ffff;

const LEGACY_MAJORS: readonly number[] = [0, 1];

function detectCompact2016(evidence: DeviceEvidence): DetectionVerdict {
  const reasons: string[] = [];
  const sums = evidence.observedAcceptanceSums ?? [];

  /* A build with no read handler is compact-2014's, whatever it sums to: the
   * 2014 images sum to zero as well, and this profile dumps. */
  const early = primaryVersion(evidence);
  if (early !== null && early.major === 0 && early.minor < 8) {
    reasons.push(
      `firmware ${early.text} is older than 0.8.0.0 and has no read handler for ` +
        'GetFeaturedFirmwareData — that is compact-2014, not this profile',
    );
    return { score: 0, reasons };
  }

  if (sums.some((sum) => sum >>> 0 === MODERN_ACCEPT_SUM)) {
    reasons.push(
      `a slot decrypts to the ${hexUp(MODERN_ACCEPT_SUM)} acceptance sum, which is not ` +
        "this generation's target",
    );
    return { score: 0, reasons };
  }

  /* A camera that armed a protected bank on the plain channel is not on the
   * locked line at all, whatever its slots sum to. Measured, not inferred. */
  if (evidence.plainSelectorRefused === false) {
    reasons.push(
      'a plain 2-byte BeginFirmwareUpgrade armed a protected bank, so this camera is not on ' +
        'the locked line this profile shares with legacy-auth',
    );
    return { score: 0, reasons };
  }

  let score = 0;
  if (sums.some((sum) => sum >>> 0 === 0)) {
    score = SCORE_DECISIVE;
    reasons.push(
      `a slot decrypts to the ${hexUp(0)} acceptance sum, which is this generation's target`,
    );
    if (evidence.plainSelectorRefused === true) {
      reasons.push(
        'and a protected bank refused the plain 2-byte arm, which is the locked handler',
      );
      score = SCORE_CORROBORATED;
    }
  }

  const version = primaryVersion(evidence);
  if (version !== null && LEGACY_MAJORS.includes(version.major)) {
    /* Weak on purpose: the locked Compact firmware is numbered 0.x/1.x too, and
     * a measured 1.3.0.8 build hits 0xFFFF rather than 0. A version alone must
     * not decide between the two, which is exactly what the acceptance sum is
     * for. */
    reasons.push(
      `${versionSource(evidence) === 'dump' ? 'the image header says' : 'the camera reports'} ` +
        `firmware ${version.text}, on the 0.x / 1.x line this generation shares with the ` +
        'locked legacy firmware',
    );
    score = Math.max(score, SCORE_WEAK);
  } else if (version !== null) {
    reasons.push(`firmware ${version.text} is not on the 0.x / 1.x line`);
    return { score: 0, reasons };
  }

  if (score === 0) reasons.push('no slot was observed decrypting to a zero acceptance sum');
  return { score, reasons };
}

/* ---- the profile -------------------------------------------------------- */

export const compact2016: FirmwareProfile = {
  id: 'compact-2016',
  name: '2016 Compact Pro',
  summary:
    'The 2016 Compact Pro generation: xorshift128 images with no whitening (K=0) and a ' +
    '0x00000000 acceptance sum. Its BeginFirmwareUpgrade is the locked one — the same handler ' +
    'legacy-auth describes, decoded byte-exactly from a 1.0.3.0 build — so it uses that ' +
    'selector map and the 18-byte token on the six protected banks. Read-only: flashing is ' +
    'refused because nothing in the write path is valid here.',
  cipher: COMPACT_2016_CIPHER,
  /* The legacy geometry, not the modern one: 0x14000000 is blocked on every
   * channel and there is no selector above 0x141FFFFF, so the dump's gap list
   * has to say so or it will claim it read bytes it never asked for. */
  memory: LEGACY_MEMORY,
  capabilities: CAPABILITIES,
  slots: LEGACY_SLOTS,
  boot: LEGACY_BOOT,
  windowMap: buildLegacyWindowMap,
  windowPlan: legacyWindowPlan,
  sweepRange: LEGACY_SWEEP_RANGE,
  detect: detectCompact2016,
};

/**
 * `compact-2016` — the 2016 Compact Pro generation.
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
import {
  buildModernWindowMap,
  HDR_HI,
  HDR_LO,
  MODERN_BOOT,
  MODERN_MEMORY,
  MODERN_SLOTS,
  MODERN_SWEEP_RANGE,
} from './modern-4x.js';

/** No whitening and a zero acceptance target — the original's second DEC_PROFILE. */
const COMPACT_2016_CIPHER: CipherProfile = {
  whiteningK: 0x00000000,
  acceptanceSum: 0x00000000,
  clearWords: [HDR_LO, HDR_HI],
};

const FLASH_REFUSAL =
  'the 2016 Compact Pro generation uses a different BeginFirmwareUpgrade selector map, and ' +
  'nothing in the write path is valid for it: the slot bases, the update-target selector, the ' +
  'boot-config replay and the key table were all decoded against the 4.x line. The original ' +
  'disabled flashing on exactly this evidence and this profile keeps that refusal.';

const CAPABILITIES: ProfileCapabilities = {
  /* Reads stay open. The modern map is what the original fell back to on these
   * cameras, and a window that is not there simply stalls and is gap-filled. */
  dump: SUPPORTED,
  sweep: SUPPORTED,
  decrypt: SUPPORTED,
  deviceInfo: SUPPORTED,
  flash: unsupported(FLASH_REFUSAL),
};

/* ---- detection ---------------------------------------------------------- */

/** Every slot summing to zero is the defining measurement for this generation. */
const SCORE_DECISIVE = 0.9;
/** The 2016 line is numbered 1.x, but so is the locked legacy firmware. */
const SCORE_WEAK = 0.35;

const MODERN_ACCEPT_SUM = 0x0000ffff;

/** Major component of a dotted version string, or null when there is none. */
function versionMajor(version: string | undefined): number | null {
  if (version === undefined) return null;
  const match = /^\s*(\d+)\./.exec(version);
  const major = match?.[1];
  return major === undefined ? null : Number.parseInt(major, 10);
}

function detectCompact2016(evidence: DeviceEvidence): DetectionVerdict {
  const reasons: string[] = [];
  const sums = evidence.observedAcceptanceSums ?? [];

  if (sums.some((sum) => sum >>> 0 === MODERN_ACCEPT_SUM)) {
    reasons.push(
      `a slot decrypts to the ${hexUp(MODERN_ACCEPT_SUM)} acceptance sum, which is not ` +
        "this generation's target",
    );
    return { score: 0, reasons };
  }

  let score = 0;
  if (sums.some((sum) => sum >>> 0 === 0)) {
    score = SCORE_DECISIVE;
    reasons.push(
      `a slot decrypts to the ${hexUp(0)} acceptance sum, which is this generation's target`,
    );
  }

  const major = versionMajor(evidence.firmwareVersion);
  if (major === 1) {
    /* Weak on purpose: the locked legacy firmware is numbered 1.x too, and a
     * measured 1.3.0.8 build hits 0xFFFF rather than 0. A version string alone
     * must not decide between the two 1.x families. */
    reasons.push(
      `reported firmware version ${String(evidence.firmwareVersion)} is on the 1.x line the ` +
        '2016 generation shares with the locked legacy firmware',
    );
    score = Math.max(score, SCORE_WEAK);
  } else if (major !== null) {
    reasons.push(
      `reported firmware version ${String(evidence.firmwareVersion)} is not on the 1.x line`,
    );
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
    '0x00000000 acceptance sum. UNVERIFIED SELECTOR MAP — the map below is the 4.x one, ' +
    'which is what the original fell back to on these cameras; this generation is known to ' +
    'use a different BeginFirmwareUpgrade map, so windows may stall and be gap-filled. ' +
    'Read-only: flashing is refused because nothing in the write path is valid here.',
  cipher: COMPACT_2016_CIPHER,
  /* Reused from the 4.x profile along with the map, so the one recorded gap
   * (0x14060000) stays consistent with the selectors actually being issued. */
  memory: MODERN_MEMORY,
  capabilities: CAPABILITIES,
  /* Positional, and unverified for this generation — see `summary`. Nothing
   * writes through them because `capabilities.flash` refuses first. */
  slots: MODERN_SLOTS,
  boot: MODERN_BOOT,
  windowMap: buildModernWindowMap,
  sweepRange: MODERN_SWEEP_RANGE,
  detect: detectCompact2016,
};

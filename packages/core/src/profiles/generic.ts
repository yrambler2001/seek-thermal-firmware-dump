/**
 * `generic` — the fallback when nothing matches confidently.
 *
 * This profile exists so that an unrecognised camera is still useful: it dumps,
 * it sweeps, it decrypts, and it reports what it found. What it will not do is
 * write. Flashing needs a Key A that is right for THIS camera, and the whole
 * point of landing here is that the firmware family could not be identified —
 * so Key A cannot be trusted, and a wrong Key A poisons the upgrade path on a
 * real camera (a bench unit has been left accepting flashes its own bootloader
 * then refuses to boot, for exactly that reason).
 *
 * Its detect() returns a constant, deliberately low score. It is not competing
 * on evidence; it is the floor every other profile has to clear.
 */

import type {
  DetectionVerdict,
  DeviceEvidence,
  FirmwareProfile,
  ProfileCapabilities,
} from './types.js';
import { SUPPORTED, unsupported } from './types.js';
import {
  buildModernWindowMap,
  MODERN_BOOT,
  MODERN_CIPHER,
  MODERN_MEMORY,
  MODERN_SLOTS,
  MODERN_SWEEP_RANGE,
  modernWindowPlan,
} from './modern-4x.js';

/**
 * The constant score of the fallback. Every other profile scores 0 when its
 * evidence is absent, so `generic` wins by default; and the registry's
 * confidence threshold sits above this value, so "generic won" always reads as
 * an ambiguous detection.
 */
export const GENERIC_BASELINE = 0.1;

const FLASH_REFUSAL =
  'the firmware family could not be identified, so Key A cannot be trusted. Writing an image ' +
  'keyed for the wrong family leaves a camera that accepts the flash and then refuses to boot ' +
  'it. Dump and decrypt this camera, identify it from the dump, then pick the profile ' +
  'explicitly.';

const CAPABILITIES: ProfileCapabilities = {
  dump: SUPPORTED,
  /* A sweep is precisely the tool for an unknown map: it probes every selector
   * and reports which ones answered. */
  sweep: SUPPORTED,
  decrypt: SUPPORTED,
  deviceInfo: SUPPORTED,
  flash: unsupported(FLASH_REFUSAL),
};

function detectGeneric(_evidence: DeviceEvidence): DetectionVerdict {
  return {
    score: GENERIC_BASELINE,
    reasons: [
      'fallback: no firmware family matched confidently, so reads stay available and writes do not',
    ],
  };
}

export const generic: FirmwareProfile = {
  id: 'generic',
  name: 'Unidentified camera',
  summary:
    'Fallback for a camera no profile matched. Uses the 4.x selector map and cipher defaults ' +
    'so a dump and a decrypt attempt still work, and refuses to flash because the family — ' +
    'and therefore Key A — is unknown.',
  /* Defaults, not findings. Decryption does not actually depend on these: the
   * cryptanalytic recovery derives the xorshift state from the image itself, and
   * the acceptance sum is only used to *name* the result. */
  cipher: MODERN_CIPHER,
  memory: MODERN_MEMORY,
  capabilities: CAPABILITIES,
  slots: MODERN_SLOTS,
  boot: MODERN_BOOT,
  windowMap: buildModernWindowMap,
  windowPlan: (firmwareVersion) =>
    modernWindowPlan(firmwareVersion, 'generic: the post-2018 table, borrowed without evidence'),
  sweepRange: MODERN_SWEEP_RANGE,
  detect: detectGeneric,
};

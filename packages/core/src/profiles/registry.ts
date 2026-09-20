/**
 * The firmware-profile registry.
 *
 * This module owns the *mechanism* — registration, lookup, scoring, capability
 * gating — and holds no knowledge of any individual family beyond the four lines
 * that register the built-ins. Adding a fifth family is one new file plus one
 * `registerProfile` call; nothing below branches on `ProfileId`.
 *
 * Scoring convention, shared by every profile's `detect()`:
 *
 *   0.0        ruled out — the evidence directly contradicts this family
 *   0.1        the `generic` fallback's constant baseline
 *   0.3 – 0.5  weak: narrows the field without singling this family out
 *   0.7 – 0.85 strong but indirect (a version string the camera reported)
 *   0.9 – 1.0  decisive, measured on the device or the image itself
 */

import { SeekError } from '../errors.js';
import type {
  DetectionResult,
  DeviceEvidence,
  FirmwareProfile,
  ProfileCapabilities,
  ProfileId,
  ProfileMatch,
} from './types.js';
import { compact2016 } from './compact-2016.js';
import { generic, GENERIC_BASELINE } from './generic.js';
import { legacyAuth } from './legacy-auth.js';
import { modern4x } from './modern-4x.js';

/** The operations a profile can support or refuse. */
export type CapabilityName = keyof ProfileCapabilities;

/**
 * How far a winner must clear the fallback's baseline before the match counts as
 * confident. Derived from `GENERIC_BASELINE` rather than written as a literal so
 * the two cannot drift apart.
 */
export const AMBIGUITY_MARGIN = 0.25;

/** Anything at or below this is "no better than not knowing". */
export const CONFIDENT_SCORE = GENERIC_BASELINE + AMBIGUITY_MARGIN;

/**
 * How close a runner-up may come before the winner stops being a clear answer.
 * Two families scoring 0.97 and 0.90 on contradictory evidence is not a match,
 * it is a coin toss, and the UI should say so.
 */
export const TIE_MARGIN = 0.15;

/* Keyed by `string`, not `ProfileId`, so the registry mechanism itself imposes no
 * ceiling on the set of families — only the `ProfileId` union in types.ts does. */
const profiles = new Map<string, FirmwareProfile>();

/**
 * Adds (or replaces) a profile. Public so a future firmware family is one file
 * plus one call; re-registering the same id overwrites, which is what a caller
 * shimming a built-in for a bench experiment wants.
 */
export function registerProfile(profile: FirmwareProfile): void {
  profiles.set(profile.id, profile);
}

/**
 * Removes a profile. Returns whether one was there. Exists so a host can retire a
 * family it has superseded — and so the extensibility claim above is testable
 * without leaving a fixture behind in module state.
 */
export function unregisterProfile(id: ProfileId): boolean {
  return profiles.delete(id);
}

/** Throws rather than returning undefined: an unknown id is a programming error. */
export function getProfile(id: ProfileId): FirmwareProfile {
  const profile = profiles.get(id);
  if (profile === undefined) {
    throw new SeekError('profile/unsupported', `no firmware profile is registered as '${id}'`, {
      detail: { requested: id, registered: [...profiles.keys()] },
    });
  }
  return profile;
}

/** Registration order, which is also the tie-break order in `detectProfile`. */
export function listProfiles(): readonly FirmwareProfile[] {
  return [...profiles.values()];
}

/**
 * Scores every registered profile against the evidence and ranks them.
 *
 * The ranking is the whole answer: `best` is a suggestion, `ranked` lets the UI
 * offer a manual override, and `ambiguous` is the honest admission that the
 * evidence did not settle it. A caller that respects `ambiguous` and the
 * capability gate cannot be talked into writing an image on a guess.
 */
export function detectProfile(evidence: DeviceEvidence): DetectionResult {
  const ranked: readonly ProfileMatch[] = listProfiles()
    .map((profile): ProfileMatch => {
      const verdict = profile.detect(evidence);
      return { profile, score: verdict.score, reasons: verdict.reasons };
    })
    /* Stable, so equal scores keep registration order. */
    .sort((a, b) => b.score - a.score);

  const best = ranked[0];
  if (best === undefined) {
    throw new SeekError('profile/unsupported', 'no firmware profiles are registered');
  }

  const runnerUp = ranked[1];
  const ambiguous =
    best.score < CONFIDENT_SCORE ||
    (runnerUp !== undefined && best.score - runnerUp.score < TIE_MARGIN);

  return { best, ranked, ambiguous };
}

/**
 * The gate every destructive operation goes through. Throws
 * `SeekError('profile/unsupported')` carrying the capability's own reason, so the
 * refusal a profile author wrote is the refusal the user reads.
 */
export function requireCapability(profile: FirmwareProfile, op: CapabilityName): void {
  const support = profile.capabilities[op];
  if (support.supported) return;
  throw new SeekError(
    'profile/unsupported',
    `${profile.name} does not support ${op}: ${support.reason}`,
    { detail: { profile: profile.id, capability: op, reason: support.reason } },
  );
}

/** Whether a profile allows an operation, without throwing. */
export function hasCapability(profile: FirmwareProfile, op: CapabilityName): boolean {
  return profile.capabilities[op].supported;
}

/* ---- built-ins ---------------------------------------------------------- */

/* Registered at module load so `getProfile` works for anyone importing this file
 * directly, not only through the barrel. Order here is the tie-break order:
 * most specific family first, fallback last. */
registerProfile(modern4x);
registerProfile(legacyAuth);
registerProfile(compact2016);
registerProfile(generic);

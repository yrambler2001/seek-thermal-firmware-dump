/**
 * Reading a firmware version out of the evidence, in one place.
 *
 * TWO FIELDS CARRY A VERSION AND ONLY ONE WAS EVER READ. `DeviceEvidence` has
 * both `firmwareVersion` (what an attached camera reported through
 * `GetFirmwareInfo`) and `imageVersions` (what the image headers in a dump say,
 * at offset 0x20C, inside the cleartext window). Every `detect()` consulted the
 * first and none consulted the second — so `evidenceFromDump` went to the
 * trouble of parsing the headers and the answer was then decided entirely by
 * the acceptance sum. That is how a 1.3.0.8 Compact, whose own header says
 * `1.3.0.8`, was detected as `modern-4x`: it hits the 0x0000FFFF sum, and the
 * one piece of evidence that contradicts the 4.x line was in the evidence
 * object, unread.
 *
 * `versionsIn` returns both, device-reported first, so a profile can rule
 * itself in or out from a dump as readily as from a camera.
 */

import type { DeviceEvidence } from './types.js';

export interface FirmwareVersion {
  readonly text: string;
  readonly major: number;
  readonly minor: number;
}

/** `4.18.2.0` -> {major: 4, minor: 18}. Null when it is not a dotted version. */
export function parseVersion(version: string | undefined): FirmwareVersion | null {
  if (version === undefined) return null;
  const match = /^\s*(\d+)\.(\d+)/.exec(version);
  const major = match?.[1];
  const minor = match?.[2];
  if (major === undefined || minor === undefined) return null;
  return {
    text: version.trim(),
    major: Number.parseInt(major, 10),
    minor: Number.parseInt(minor, 10),
  };
}

/** Every version this evidence carries: the camera's own first, then the dump's. */
export function versionsIn(evidence: DeviceEvidence): readonly FirmwareVersion[] {
  const out: FirmwareVersion[] = [];
  const reported = parseVersion(evidence.firmwareVersion);
  if (reported !== null) out.push(reported);
  for (const text of evidence.imageVersions ?? []) {
    const parsed = parseVersion(text);
    /* A dump holds up to four slots and they are usually the same build; the
     * duplicate carries no extra information and would double-count in a
     * reason list. */
    if (parsed !== null && !out.some((v) => v.text === parsed.text)) out.push(parsed);
  }
  return out;
}

/**
 * The single version a profile should reason about, or null.
 *
 * The camera's own report wins. Failing that, a dump's images: if they disagree
 * — a part whose slot A and slot B are different builds — this returns null
 * rather than picking one, because "which of these two is the camera" is not a
 * question a version string can answer and a profile must not pretend it did.
 */
export function primaryVersion(evidence: DeviceEvidence): FirmwareVersion | null {
  const reported = parseVersion(evidence.firmwareVersion);
  if (reported !== null) return reported;
  const fromImages = versionsIn(evidence);
  if (fromImages.length !== 1) return null;
  return fromImages[0] ?? null;
}

/** Where the version came from, for a human-readable reason line. */
export function versionSource(evidence: DeviceEvidence): 'camera' | 'dump' | 'none' {
  if (parseVersion(evidence.firmwareVersion) !== null) return 'camera';
  return versionsIn(evidence).length === 1 ? 'dump' : 'none';
}

/**
 * Which firmware family a run acts under: asked of the camera, or named by
 * hand by someone who knows better.
 *
 * The page used to ask the USER — a "Start dump" that always meant the
 * post-2018 map, a separate "Dump legacy firmware" for the 2014-2017 line, and
 * a profile menu on the flash view whose "auto" read under `modern-4x` without
 * asking anything. Core can answer that itself now: `identifyCamera` reads the
 * version, and only when that build can be read at all asks the three channel
 * questions and ranks the answers, and `planForDevice` then picks that build's
 * own selector table. This module is the page's one way in to that.
 *
 * A HAND-PICKED FAMILY IS NOT A WAY AROUND THE SAFETY CHECK. It skips the
 * probe, exactly as the CLI's `--profile` does, and nothing else: the run it
 * starts — `runDump`, `runSweep` or `readDeviceInfo` — reads the version first
 * through `planForDevice` and applies `identityGate` before its first arm, so a
 * camera that does not name its build, or one older than 0.8.0.0, is refused
 * whichever family was chosen. There is no code path here that reaches a
 * workflow without going through that.
 */

import {
  getProfile,
  identifyCamera,
  identityRefusal,
  isSeekError,
  type DetectionResult,
  type FirmwareProfile,
  type LogLevel,
  type PlannedOperation,
  type ProfileId,
  type SeekDevice,
  type SeekErrorCode,
} from '@seek-fw/core';
import { hintFor } from './hints';

/** 'auto' asks the camera; a profile id names the family by hand. */
export type ProfileChoice = ProfileId | 'auto';

/** What a run acts under, and how that was decided. */
export interface ActingProfile {
  readonly profile: FirmwareProfile;
  /** The ranking, when the camera was asked; null when the family was named by hand. */
  readonly detection: DetectionResult | null;
  /** The version the probe read, when the camera was asked. */
  readonly firmwareVersion: string | null;
  /** The build date string that came with it. */
  readonly buildString: string | null;
  /** True when the family was named by hand rather than detected. */
  readonly forced: boolean;
}

type Log = (text: string, level: LogLevel) => void;

/**
 * Asks the camera which family it is (`choice === 'auto'`), or takes the
 * hand-picked one.
 *
 * When the camera is asked and its identity gate stays shut — no version came
 * back, or the build predates the dump protocol — this throws the same
 * `SeekError` `planForDevice` would have thrown one step later, so the refusal
 * the user reads names the reason and nothing is armed either way.
 */
export async function chooseActingProfile(
  device: SeekDevice,
  choice: ProfileChoice,
  operation: PlannedOperation,
  log: Log,
): Promise<ActingProfile> {
  if (choice !== 'auto') {
    const profile = getProfile(choice);
    log(
      `acting under ${profile.name} (${profile.id}), chosen by hand — the camera's firmware ` +
        'version is still read and checked before anything is armed',
      'warn',
    );
    return { profile, detection: null, firmwareVersion: null, buildString: null, forced: true };
  }

  log('asking the camera which firmware it runs ...', 'detail');
  const identification = await identifyCamera(device);
  for (const note of identification.probe.notes) log(`  ${note}`, 'detail');

  const { detection, gate, probe } = identification;
  const best = detection.best;
  if (!gate.permitsArming) {
    throw identityRefusal(gate, probe.firmwareVersion, operation, best.profile.id);
  }
  log(
    `detected ${best.profile.name} (${best.profile.id}), confidence ${best.score.toFixed(2)}` +
      (detection.ambiguous ? ' — the evidence did not settle it, so this is a guess' : ''),
    detection.ambiguous ? 'warn' : 'ok',
  );
  return {
    profile: best.profile,
    detection,
    firmwareVersion: probe.firmwareVersion,
    buildString: probe.buildString,
    forced: false,
  };
}

/** A run the toolkit refused before it read anything, and why, for the page to show. */
export interface Refusal {
  readonly code: Extract<SeekErrorCode, 'device/version-unknown' | 'profile/unsupported'>;
  readonly message: string;
  /** What to do about it, or null when there is nothing honest to suggest. */
  readonly hint: string | null;
}

/**
 * The refusals worth more than a log line: the camera would not say which
 * build it runs, or the build (or the family picked for it) cannot do what was
 * asked. Anything else — a USB failure, a cancel — is not a refusal and stays
 * in the transcript, as it always has.
 */
export function refusalOf(error: unknown, userAgent?: string): Refusal | null {
  if (!isSeekError(error)) return null;
  if (error.code !== 'device/version-unknown' && error.code !== 'profile/unsupported') {
    return null;
  }
  return { code: error.code, message: error.message, hint: hintFor(error, userAgent) };
}

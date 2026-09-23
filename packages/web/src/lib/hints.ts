/**
 * The web's half of the CLI's `describeError`: a failure's message says what
 * went wrong, this says what to do about it.
 *
 * The browser needs this MORE than the CLI does, not less. WebUSB cannot claim
 * interface 0 whenever a system driver or another program already holds the
 * camera, and on Linux and Windows that is the ordinary first-run state — a
 * bare "could not claim USB interface 0: Access denied." leaves the user with
 * nowhere to go. The platform prose is the page's own platform-notes section
 * and the README's, so there is exactly one wording to keep true.
 *
 * Deliberately NOT imported from `@seek-fw/cli`: the web bundle must not pull
 * in a package that reaches for `process` and `node:fs`.
 */

import {
  errorMessage,
  isSeekError,
  type LogLevel,
  type SeekError,
  type SeekErrorCode,
} from '@seek-fw/core';

/** Only the three the advice actually differs for. */
export type HostPlatform = 'linux' | 'windows' | 'other';

export const UDEV_HINT =
  'On Linux the camera needs a udev rule before the browser can open it:\n' +
  '\n' +
  '  # /etc/udev/rules.d/70-seek-thermal.rules\n' +
  '  SUBSYSTEM=="usb", ATTR{idVendor}=="289d", MODE="0666", TAG+="uaccess"\n' +
  '\n' +
  '  sudo udevadm control --reload-rules && sudo udevadm trigger\n' +
  '\n' +
  'Then unplug and replug the camera. Snap and Flatpak Chromium builds are often sandboxed ' +
  'away from raw USB devices; the .deb or .rpm build is the reliable one.';

export const WINDOWS_HINT =
  'Windows needs the WinUSB driver bound to the camera before any browser can reach it. Use ' +
  'Zadig (https://zadig.akeo.ie/): Options → List All Devices, pick the entry named after your ' +
  'camera — for example "CompactPRO FF" — choose WinUSB, and click Replace Driver.';

/** The macOS/Android case, and the fallback when the UA says nothing useful. */
export const HOLDING_HINT =
  'Another program or a system driver is holding the camera — only one process can hold the USB ' +
  'interface at a time. Quit anything else that talks to it, then unplug and replug the camera.';

/** The way out that needs no driver work at all, appended to every platform's advice. */
const RECIPIENT_FALLBACK =
  'Or set recipient to "device" in the read options, which does not need the interface claimed.';

/* Android and ChromeOS both advertise Linux, and neither can act on a udev
 * rule — a phone has no /etc to write to and ChromeOS hands USB devices out
 * through its own permission prompt. Both have to be ruled out first. */
export function hostPlatform(userAgent: string): HostPlatform {
  if (/android|cros/i.test(userAgent)) return 'other';
  if (/windows/i.test(userAgent)) return 'windows';
  if (/linux|x11/i.test(userAgent)) return 'linux';
  return 'other';
}

/** The platform-specific "the browser cannot open this device" advice. */
export function permissionHint(userAgent: string): string {
  const platform = hostPlatform(userAgent);
  if (platform === 'linux') return `${UDEV_HINT}\n\n${RECIPIENT_FALLBACK}`;
  if (platform === 'windows') return `${WINDOWS_HINT}\n\n${RECIPIENT_FALLBACK}`;
  return `${HOLDING_HINT} ${RECIPIENT_FALLBACK}`;
}

/**
 * True for the failures a driver or a permission fixes, including the one the
 * CLI never sees: `claimInterface` rejecting. Core turns that into
 * `usb/not-open` with "could not claim USB interface 0" in the message when
 * the recipient is pinned to interface, and Chrome's own DOMException says
 * "Unable to claim interface" — both have to match.
 */
export function looksLikeAccessError(error: unknown): boolean {
  const text = errorMessage(error).toLowerCase();
  return (
    text.includes('claim interface') ||
    text.includes('claim usb interface') ||
    text.includes('access denied') ||
    text.includes('insufficient permissions') ||
    text.includes('permission denied') ||
    text.includes('securityerror') ||
    text.includes('not allowed to access')
  );
}

/**
 * Per-code advice, the CLI's table translated into what this page can offer:
 * there is no `--chunk` or `seek-fw profiles` here, there are form controls,
 * a dump that asks the camera which family it is, and a hand-picked family
 * for the camera that detection gets wrong.
 */
const SEEK_HINTS: Partial<Record<SeekErrorCode, string>> = {
  'options/invalid': 'Open "Read options" and check the note under the fields for each range.',
  'usb/timeout':
    'The camera accepted the request and never answered. Unplug and replug it, then try a ' +
    'smaller chunk (64 is the value that works everywhere).',
  'usb/stalled':
    'The camera rejected the request. This usually means the firmware does not implement it — ' +
    'if detection picked the wrong family, name the family by hand ("Choose the firmware ' +
    'family yourself" on the dump page, the profile menu on the flash page).',
  'usb/not-open':
    'Another program or a system driver is holding the camera. Close it, or set recipient to ' +
    '"device" in the read options, which does not need the interface claimed.',
  'usb/transfer-failed': 'Unplug and replug the camera, then try again.',
  'device/mode':
    'The camera would not leave imaging mode. Unplug it, wait for it to power down fully, and ' +
    'plug it back in.',
  'device/window':
    'The selector map this profile uses did not match the camera. Run "Dump all selectors" to ' +
    'see what the camera actually exposes.',
  'device/version-unknown':
    'Nothing that could change the camera was sent. Unplug it, let it finish starting up, plug ' +
    'it back in and try again; a camera that reports its firmware version is read normally.',
  'image/malformed': 'The file is not a decrypted Seek firmware image.',
  'image/unsupported': 'This image cannot be packaged for the camera as it is.',
  'image/key-table':
    'The image does not carry the key pair its filename claims. Use the decrypted file exactly ' +
    'as the dump wrote it, name and all.',
  'flash/refused': 'Nothing was written to the camera.',
  'flash/commit':
    'The commit was rejected. The camera checks the transfer checksum before it erases ' +
    'anything, so a rejected commit leaves the flash untouched.',
  'profile/unsupported':
    'The firmware family chosen for this camera does not support that. Leave the family on ' +
    'auto so the camera is asked, or pick one that does.',
};

/**
 * The version gate's refusal of a build that predates the dump protocol, as
 * opposed to a profile's own capability refusal: the same code, but no family
 * the user could pick changes it, so the per-code advice above would send them
 * round in a circle. Told apart by what `planForDevice` puts in the detail —
 * the version it read — which `requireCapability` never does.
 */
export const FIRMWARE_TOO_OLD_HINT =
  'No firmware family can read this build over USB: its firmware has no command that serves ' +
  'flash, so nothing that could be misread was sent to it. A dump taken with an SPI programmer ' +
  'or over SWD/J-Link can still be decrypted on this page, under "Decrypt a dump you already ' +
  'have".';

function isFirmwareTooOld(error: SeekError): boolean {
  return error.code === 'profile/unsupported' && typeof error.detail?.firmwareVersion === 'string';
}

function liveUserAgent(): string {
  return typeof navigator === 'undefined' ? '' : navigator.userAgent;
}

/** What to try next, or null when there is nothing honest to suggest. */
export function hintFor(error: unknown, userAgent: string = liveUserAgent()): string | null {
  /* The permission case first: it is the one whose remedy depends on the
   * machine rather than on which opcode failed. */
  if (looksLikeAccessError(error)) return permissionHint(userAgent);
  if (isSeekError(error)) {
    if (isFirmwareTooOld(error)) return FIRMWARE_TOO_OLD_HINT;
    return SEEK_HINTS[error.code] ?? null;
  }
  return null;
}

/**
 * Logs the hint under the failure a panel has just reported, if there is one.
 * Takes the log function rather than a reporter handle so each call site keeps
 * its own wording for the error line itself.
 */
export function logHint(
  log: (text: string, level: LogLevel) => void,
  error: unknown,
  userAgent?: string,
): void {
  const hint = hintFor(error, userAgent);
  if (hint !== null) log(hint, 'warn');
}

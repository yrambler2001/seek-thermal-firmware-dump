/**
 * Exit codes, the CLI's own error type, and the translation from core's
 * `SeekError.code` into something a person can act on.
 *
 * The rule here is that a user never sees a raw libusb string or a stack trace
 * unless they asked for one with `--verbose`. Every failure the tool can
 * anticipate gets a hint that names the next thing to try.
 */

import { CancelledError, isSeekError, type SeekErrorCode } from '@seek-fw/core';

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_USAGE = 2;
export const EXIT_CANCELLED = 130;

/** A failure the CLI itself diagnosed. Carries the exit code it deserves. */
export class CliError extends Error {
  readonly exitCode: number;
  readonly hint: string | undefined;
  readonly code: string;

  constructor(
    message: string,
    options: { readonly exitCode?: number; readonly hint?: string; readonly code?: string } = {},
  ) {
    super(message);
    this.name = 'CliError';
    this.exitCode = options.exitCode ?? EXIT_FAILED;
    this.hint = options.hint;
    this.code = options.code ?? 'cli/failed';
  }
}

/** Bad command line. Always exit 2, and always accompanied by usage text. */
export class UsageError extends CliError {
  constructor(message: string, hint?: string) {
    super(
      message,
      hint === undefined
        ? { exitCode: EXIT_USAGE, code: 'cli/usage' }
        : { exitCode: EXIT_USAGE, code: 'cli/usage', hint },
    );
    this.name = 'UsageError';
  }
}

export const UDEV_HINT =
  'On Linux the camera needs a udev rule before a normal user can open it:\n' +
  '\n' +
  '  # /etc/udev/rules.d/70-seek-thermal.rules\n' +
  '  SUBSYSTEM=="usb", ATTR{idVendor}=="289d", MODE="0666", TAG+="uaccess"\n' +
  '\n' +
  '  sudo udevadm control --reload-rules && sudo udevadm trigger\n' +
  '\n' +
  'Then unplug and replug the camera.';

export const WINDOWS_HINT =
  'On Windows the camera needs the WinUSB driver bound to it with Zadig ' +
  '(https://zadig.akeo.ie/) — pick the entry named after your camera, e.g. "CompactPRO FF".';

/** The platform-specific "you probably cannot open the device" advice. */
export function permissionHint(platform: string): string {
  if (platform === 'linux') return UDEV_HINT;
  if (platform === 'win32') return WINDOWS_HINT;
  return 'Close any other program that might be holding the camera, then unplug and replug it.';
}

/** True for the libusb permission failures that a udev rule fixes. */
export function looksLikeAccessError(error: unknown): boolean {
  const text = (error instanceof Error ? error.message : String(error)).toLowerCase();
  return (
    text.includes('libusb_error_access') ||
    text.includes('access denied') ||
    text.includes('insufficient permissions') ||
    text.includes('permission denied') ||
    text.includes('operation not permitted') ||
    text.includes('eacces')
  );
}

const SEEK_HINTS: Partial<Record<SeekErrorCode, string>> = {
  'options/invalid': 'Run `seek-fw --help` for the accepted range of each option.',
  'usb/timeout':
    'The camera accepted the request and never answered. Unplug and replug it, then try a ' +
    'smaller --chunk (64 is the value that works everywhere).',
  'usb/stalled':
    'The camera rejected the request. This usually means the firmware does not implement it — ' +
    'check `seek-fw profiles` and try --profile with the family your camera belongs to.',
  'usb/not-open':
    'Another program or a system driver is holding the camera. Close it, or try ' +
    '--recipient device, which does not need the interface claimed.',
  'usb/transfer-failed': 'Unplug and replug the camera, then try again.',
  'device/mode':
    'The camera would not leave imaging mode. Unplug it, wait for it to power down fully, ' +
    'and plug it back in.',
  'device/window':
    'The selector map this profile uses did not match the camera. Try `seek-fw sweep` to see ' +
    'what the camera actually exposes.',
  'image/malformed': 'The file is not a decrypted Seek firmware image.',
  'image/unsupported': 'This image cannot be packaged for the camera as it is.',
  'image/key-table':
    'The image does not carry the key pair its filename claims. Use the decrypted file exactly ' +
    'as `seek-fw dump` wrote it, name and all.',
  'flash/refused': 'Nothing was written to the camera.',
  'flash/commit':
    'The commit was rejected. The camera checks the transfer checksum before it erases ' +
    'anything, so a rejected commit leaves the flash untouched.',
  'profile/unsupported':
    'Override detection with --profile <id> only if you know which family the camera is; ' +
    '`seek-fw profiles` lists them.',
};

/** `retryDelayMs` -> `retry-delay`: core's field names as this CLI spells them. */
function flagFor(option: string): string {
  if (option === 'retryDelayMs') return 'retry-delay';
  return option.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}

export interface DescribedError {
  readonly code: string;
  readonly message: string;
  readonly hint: string | undefined;
  readonly exitCode: number;
  readonly cancelled: boolean;
}

/** Turns anything thrown into the message, hint and exit code to report. */
export function describeError(error: unknown, platform: string = process.platform): DescribedError {
  if (error instanceof CancelledError) {
    return {
      code: 'cancelled',
      message: 'cancelled',
      hint: undefined,
      exitCode: EXIT_CANCELLED,
      cancelled: true,
    };
  }
  if (error instanceof CliError) {
    return {
      code: error.code,
      message: error.message,
      hint: error.hint,
      exitCode: error.exitCode,
      cancelled: false,
    };
  }
  if (isSeekError(error)) {
    const access = looksLikeAccessError(error);
    /* A rejected option is a usage error wherever it was caught: core names the
     * offending field in `detail.option`, so the message can point at the flag
     * the user typed rather than at the internal field name. */
    if (error.code === 'options/invalid') {
      const option = error.detail?.option;
      const flag = typeof option === 'string' ? `--${flagFor(option)}: ` : '';
      return {
        code: error.code,
        message: `${flag}${error.message}`,
        hint: SEEK_HINTS['options/invalid'],
        exitCode: EXIT_USAGE,
        cancelled: false,
      };
    }
    return {
      code: error.code,
      message: error.message,
      hint: access ? permissionHint(platform) : SEEK_HINTS[error.code],
      exitCode: EXIT_FAILED,
      cancelled: false,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    code: 'cli/failed',
    message,
    hint: looksLikeAccessError(error) ? permissionHint(platform) : undefined,
    exitCode: EXIT_FAILED,
    cancelled: false,
  };
}

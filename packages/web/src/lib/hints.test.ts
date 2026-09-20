import { describe, expect, it } from 'vitest';
import { CancelledError, SeekError } from '@seek-fw/core';
import {
  HOLDING_HINT,
  UDEV_HINT,
  WINDOWS_HINT,
  hintFor,
  hostPlatform,
  logHint,
  looksLikeAccessError,
  permissionHint,
} from './hints';

const LINUX = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/141.0.0.0';
const WINDOWS = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/141.0.0.0';
const MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/141.0.0.0';
const CHROMEOS = 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/141.0.0.0';

describe('hostPlatform', () => {
  it('tells the three platforms whose remedy differs apart', () => {
    expect(hostPlatform(LINUX)).toBe('linux');
    expect(hostPlatform(WINDOWS)).toBe('windows');
    expect(hostPlatform(MAC)).toBe('other');
    expect(hostPlatform('')).toBe('other');
  });

  it('does not send Android or ChromeOS after a udev rule', () => {
    /* Both advertise Linux and neither has an /etc the user can write to. */
    expect(hostPlatform(ANDROID)).toBe('other');
    expect(hostPlatform(CHROMEOS)).toBe('other');
  });
});

describe('permissionHint', () => {
  it('gives the udev rule on Linux and Zadig on Windows', () => {
    expect(permissionHint(LINUX)).toContain('70-seek-thermal.rules');
    expect(permissionHint(LINUX)).toContain('idVendor}=="289d"');
    expect(permissionHint(WINDOWS)).toContain('zadig.akeo.ie');
    expect(permissionHint(MAC)).toContain('only one process can hold the USB interface');
  });

  it('always offers the recipient fallback, which needs no driver work', () => {
    for (const ua of [LINUX, WINDOWS, MAC]) {
      expect(permissionHint(ua)).toContain('recipient to "device"');
    }
  });
});

describe('looksLikeAccessError', () => {
  it('matches both spellings of a failed interface claim', () => {
    /* Core's, when the recipient is pinned to interface ... */
    expect(
      looksLikeAccessError(
        new SeekError('usb/not-open', 'could not claim USB interface 0: Access denied.'),
      ),
    ).toBe(true);
    /* ... and Chrome's own DOMException, which never reaches core. */
    expect(looksLikeAccessError(new Error('Unable to claim interface.'))).toBe(true);
  });

  it('leaves ordinary device faults alone', () => {
    expect(looksLikeAccessError(new SeekError('usb/timeout', 'no answer in 5000 ms'))).toBe(false);
  });
});

describe('hintFor', () => {
  it('prefers the platform remedy for a permission failure', () => {
    const error = new SeekError('usb/not-open', 'could not claim USB interface 0: Access denied.');
    expect(hintFor(error, LINUX)).toBe(permissionHint(LINUX));
    expect(hintFor(error, LINUX)).toContain(UDEV_HINT);
    expect(hintFor(error, WINDOWS)).toContain(WINDOWS_HINT);
    expect(hintFor(error, MAC)).toContain(HOLDING_HINT);
  });

  it('maps a SeekError code to what to try next', () => {
    expect(hintFor(new SeekError('usb/timeout', 'timed out'), MAC)).toContain('smaller chunk');
    expect(hintFor(new SeekError('flash/commit', 'rejected'), MAC)).toContain(
      'leaves the flash untouched',
    );
    expect(hintFor(new SeekError('image/key-table', 'wrong keys'), MAC)).toContain('name and all');
  });

  it('stays quiet when it has nothing to add', () => {
    expect(hintFor(new Error('something unexpected'), MAC)).toBeNull();
    expect(hintFor(new SeekError('device/error-code', '0x04'), MAC)).toBeNull();
    /* A cancel is not a failure and never earns advice. */
    expect(hintFor(new CancelledError(), MAC)).toBeNull();
  });
});

describe('logHint', () => {
  it('logs one warn line, or nothing at all', () => {
    const lines: { text: string; level: string }[] = [];
    const log = (text: string, level: string): void => {
      lines.push({ text, level });
    };

    logHint(log, new SeekError('usb/transfer-failed', 'stalled'), MAC);
    expect(lines).toEqual([
      { text: 'Unplug and replug the camera, then try again.', level: 'warn' },
    ]);

    logHint(log, new Error('no idea'), MAC);
    expect(lines).toHaveLength(1);
  });
});

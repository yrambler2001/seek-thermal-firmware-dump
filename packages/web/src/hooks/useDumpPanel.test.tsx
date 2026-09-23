/**
 * The dump path against a fake camera, with an eye on one behaviour in
 * particular: cancelling must still hand the user an archive.
 *
 * Core stops the selector loop on abort and returns a complete result — the
 * partial image, a manifest that records which windows ran, and a README — so
 * the web layer must package and download it rather than treating the cancel
 * as a failure. That is the promise the Cancel button's own label makes.
 */

import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OP,
  SAFE_BEFORE_IDENTITY,
  WINDOW_SIZE,
  WebUsbTransport,
  hex,
  type Artifact,
  type Opcode,
  type WebUsbDevice,
} from '@seek-fw/core';
import { renderHook } from '../test-helpers';
import { FIRMWARE_TOO_OLD_HINT, permissionHint } from '../lib/hints';
import type { ProfileChoice } from '../lib/identify';
import { DEFAULT_OPTIONS_FORM, type OptionsFailure } from '../lib/options';
import { scriptedCamera, type CameraCall } from '../test-fixtures';
import { useDumpPanel, type DumpMode } from './useDumpPanel';
import { useRunner } from './useRunner';
import type { DeviceHandle } from './useDevice';

const downloads: { dirName: string; artifacts: readonly Artifact[] }[] = [];

vi.mock('../lib/download', () => ({
  downloadArchive: (dirName: string, artifacts: readonly Artifact[]) => {
    downloads.push({ dirName, artifacts });
    return {
      fileName: `${dirName}.zip`,
      fileCount: artifacts.length,
      bytes: 4096,
      dataBytes: 2048,
    };
  },
  mib: (bytes: number, digits = 1) => (bytes / (1024 * 1024)).toFixed(digits),
}));

/**
 * The smallest camera that answers the five read-only opcodes. Every window
 * reads back as a single 0xA5-filled block, so no firmware image is found and
 * the decrypt stage stays out of the way. It reports firmware 4.18.2.0: a
 * dump refuses a camera that does not say which build it runs (core
 * identity-gate.test.ts), and this fake used to answer GetFirmwareInfo empty.
 */
function fakeCamera(onWindowRead?: (count: number) => void): WebUsbDevice {
  let opened = false;
  let windowsRead = 0;
  return {
    vendorId: 0x289d,
    productId: 0x0011,
    manufacturerName: 'Seek Thermal',
    productName: 'Fake PIR324',
    serialNumber: '0E1CA0Z16D19',
    configuration: { configurationValue: 1 },
    get opened(): boolean {
      return opened;
    },
    open: () => {
      opened = true;
      return Promise.resolve();
    },
    close: () => {
      opened = false;
      return Promise.resolve();
    },
    selectConfiguration: () => Promise.resolve(),
    claimInterface: () => Promise.resolve(),
    releaseInterface: () => Promise.resolve(),
    controlTransferIn: (setup, length) => {
      if (setup.request === OP.GET_ERROR_CODE) {
        return Promise.resolve({ status: 'ok', data: new DataView(new ArrayBuffer(4)) });
      }
      if (setup.request === OP.GET_OPERATION_MODE) {
        return Promise.resolve({ status: 'ok', data: new DataView(new ArrayBuffer(2)) });
      }
      if (setup.request === OP.GET_FIRMWARE_INFO) {
        const build = new Uint8Array(36);
        build.set([4, 18, 2, 0], 0);
        return Promise.resolve({ status: 'ok', data: new DataView(build.buffer) });
      }
      if (setup.request === OP.GET_FEATURED_FIRMWARE_DATA) {
        windowsRead += 1;
        onWindowRead?.(windowsRead);
        const block = new Uint8Array(length).fill(0xa5);
        return Promise.resolve({ status: 'ok', data: new DataView(block.buffer) });
      }
      return Promise.resolve({ status: 'ok', data: new DataView(new ArrayBuffer(0)) });
    },
    controlTransferOut: () => Promise.resolve({ status: 'ok', bytesWritten: 2 }),
  };
}

function deviceHandle(camera: WebUsbDevice): DeviceHandle {
  return {
    device: null,
    description: 'Fake PIR324',
    generation: 1,
    canForgetDevice: false,
    connect: () => Promise.resolve({ kind: 'cancelled' }),
    forget: () => Promise.resolve({ kind: 'cancelled' }),
    makeTransport: () => new WebUsbTransport(camera, { recipient: 'interface' }),
  };
}

const failures: (OptionsFailure | null)[] = [];

function useHarness(
  camera: WebUsbDevice,
  overrides: Partial<typeof DEFAULT_OPTIONS_FORM> = {},
  choice: ProfileChoice = 'auto',
) {
  const runner = useRunner();
  const panel = useDumpPanel({
    id: 'dump',
    runner,
    device: deviceHandle(camera),
    /* One control-IN per window keeps the fake protocol chatter down. */
    form: { ...DEFAULT_OPTIONS_FORM, chunk: String(WINDOW_SIZE), ...overrides },
    choice,
    dirPrefix: 'seek_flash4m_',
    sweepPrefix: 'seek_selectors_',
    onOptionsFailure: (failure) => failures.push(failure),
  });
  return { panel, runner };
}

beforeEach(() => {
  downloads.length = 0;
  failures.length = 0;
});

describe('useDumpPanel', () => {
  it('packages a finished dump into one archive with a manifest and a README', async () => {
    const camera = fakeCamera();
    const { result, unmount } = renderHook(() => useHarness(camera));

    await act(async () => {
      await result.current.panel.start('dump');
    });

    expect(downloads).toHaveLength(1);
    const archive = downloads[0];
    if (archive === undefined) throw new Error('no archive');
    expect(archive.dirName).toMatch(/^seek_flash4m_\d{4}-\d{2}-\d{2}T/);

    const names = archive.artifacts.map((file) => file.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('README.md');
    expect(names).toContain('flash_4m_usb_partial_gap_ff.bin');
    expect(names.filter((name) => name.startsWith('windows/')).length).toBeGreaterThan(50);

    const status = result.current.panel.reporter.progress.text;
    expect(status).toMatch(/^Done — \d+\/\d+ windows read\. Check your downloads\.$/);
    expect(status).not.toContain('(cancelled)');
    unmount();
  }, 30_000);

  it('still downloads what it read when the run is cancelled', async () => {
    let cancel: (() => void) | null = null;
    const camera = fakeCamera((count) => {
      /* Pull the plug a few windows in, the way the Cancel button does. */
      if (count === 3) cancel?.();
    });
    const { result, unmount } = renderHook(() => useHarness(camera));
    cancel = () => {
      result.current.panel.cancel();
    };

    await act(async () => {
      await result.current.panel.start('dump');
    });

    /* The archive is the point: a cancel is a partial capture, not a failure. */
    expect(downloads).toHaveLength(1);
    const archive = downloads[0];
    if (archive === undefined) throw new Error('no archive');
    const names = archive.artifacts.map((file) => file.name);
    expect(names).toContain('manifest.json');
    expect(names).toContain('flash_4m_usb_partial_gap_ff.bin');

    const manifest = archive.artifacts.find((file) => file.name === 'manifest.json');
    if (manifest === undefined) throw new Error('no manifest');
    const parsed = JSON.parse(new TextDecoder().decode(manifest.data)) as {
      cancelled: boolean;
      usbReadableWindows: number;
      expectedReadableWindows: number;
    };
    expect(parsed.cancelled).toBe(true);
    expect(parsed.usbReadableWindows).toBeLessThan(parsed.expectedReadableWindows);

    expect(result.current.panel.reporter.progress.text).toContain('(cancelled)');
    expect(result.current.panel.reporter.progress.text).toContain('Check your downloads.');
    unmount();
  }, 30_000);

  it('tells the user how to get the camera back when the claim fails', async () => {
    /* The browser's commonest failure, and the one whose remedy is off the
     * page entirely: a udev rule, Zadig, or quitting whatever holds it. */
    const camera = fakeCamera();
    const denied: WebUsbDevice = {
      ...camera,
      claimInterface: () => Promise.reject(new Error('Access denied.')),
    };
    const { result, unmount } = renderHook(() => useHarness(denied));

    await act(async () => {
      await result.current.panel.start('dump');
    });

    expect(downloads).toHaveLength(0);
    const lines = result.current.panel.reporter.lines;
    /* Which remedy is right depends on the machine, so compare against the
     * one this test run's own user agent earns. */
    expect(lines.map((line) => line.text)).toContain(permissionHint(navigator.userAgent));
    expect(lines.at(-1)?.level).toBe('warn');
    unmount();
  });

  it('rejects an out-of-range option with the original message and packages nothing', async () => {
    const camera = fakeCamera();
    const { result, unmount } = renderHook(() => useHarness(camera, { gapFill: '0x1ff' }));

    await act(async () => {
      await result.current.panel.start('dump');
    });

    expect(downloads).toHaveLength(0);
    expect(failures.at(-1)).toEqual({
      field: 'gapFill',
      message: 'gap-fill must be a single byte, got 0x1ff',
    });
    expect(result.current.panel.reporter.lines.map((line) => line.text)).toContain(
      'ERROR: gap-fill must be a single byte, got 0x1ff',
    );
    expect(result.current.panel.reporter.progress.text).toBe('Failed — see the log above.');
    unmount();
  });
});

/* ---- the camera says which family it is ------------------------------- */

/** Only control INs of `SAFE_BEFORE_IDENTITY` went out, and never an arm. */
function expectOnlySafeReads(calls: readonly CameraCall[], what: string): void {
  expect(calls.length, `${what}: something was asked`).toBeGreaterThan(0);
  for (const call of calls) {
    const label = `${what}: ${call.dir.toUpperCase()} ${hex(call.request)}`;
    expect(call.dir, label).toBe('in');
    expect(SAFE_BEFORE_IDENTITY.has(call.request as Opcode), label).toBe(true);
  }
  expect(calls.some((call) => call.request === OP.BEGIN_FIRMWARE_UPGRADE)).toBe(false);
}

async function run(camera: WebUsbDevice, choice: ProfileChoice = 'auto', mode: DumpMode = 'dump') {
  const handle = renderHook(() => useHarness(camera, {}, choice));
  await act(async () => {
    await handle.result.current.panel.start(mode);
  });
  return handle;
}

describe('useDumpPanel detects the camera instead of asking', () => {
  it('dumps a post-2018 camera under modern-4x, having asked it', async () => {
    const { camera, calls } = scriptedCamera({ version: [4, 18, 2, 0] });
    const { result, unmount } = await run(camera);

    expect(result.current.panel.refusal).toBeNull();
    const acting = result.current.panel.acting;
    expect(acting?.forced).toBe(false);
    expect(acting?.profile.id).toBe('modern-4x');
    expect(acting?.firmwareVersion).toBe('4.18.2.0');
    expect(acting?.detection?.best.profile.id).toBe('modern-4x');

    /* The first request is the version read, and it is the only thing sent
     * before the camera named its build. */
    expect(calls[0]?.request).toBe(OP.GET_FIRMWARE_INFO);
    expect(calls[0]?.dir).toBe('in');
    /* The probe asked the channel question: a plain arm of subcommand 5. */
    expect(
      calls.some(
        (call) =>
          call.request === OP.BEGIN_FIRMWARE_UPGRADE && call.length === 2 && call.data?.[0] === 5,
      ),
    ).toBe(true);
    expect(downloads).toHaveLength(1);
    const lines = result.current.panel.reporter.lines.map((line) => line.text);
    expect(lines).toContain('asking the camera which firmware it runs ...');
    expect(lines.some((line) => line.startsWith('detected ') && line.includes('(modern-4x)'))).toBe(
      true,
    );
    unmount();
  }, 30_000);

  it('dumps a locked 2016 camera under legacy-auth, token and all, without being told', async () => {
    /* What "Dump legacy firmware" used to be for. The camera refuses the plain
     * arm of a protected bank and accepts the token, and that settles it. */
    const { camera, calls } = scriptedCamera({ version: [1, 0, 3, 0], legacy: true });
    const { result, unmount } = await run(camera);

    expect(result.current.panel.refusal).toBeNull();
    expect(result.current.panel.acting?.profile.id).toBe('legacy-auth');
    expect(result.current.panel.acting?.forced).toBe(false);

    /* The dump armed the protected banks with the 18-byte token form: 3, 5, 6,
     * 7, 8 and 9 on 1.0.3.0's own table (TESTING.md sec.10.1). */
    const tokenArms = new Set(
      calls
        .filter((call) => call.request === OP.BEGIN_FIRMWARE_UPGRADE && call.length === 18)
        .map((call) => call.data?.[0]),
    );
    for (const subcmd of [3, 5, 6, 7, 8, 9]) expect(tokenArms.has(subcmd), hex(subcmd)).toBe(true);
    expect(downloads).toHaveLength(1);
    const manifest = downloads[0]?.artifacts.find((file) => file.name === 'manifest.json');
    if (manifest === undefined) throw new Error('no manifest');
    expect(new TextDecoder().decode(manifest.data)).toContain('legacy-auth');
    unmount();
  }, 30_000);

  it('says why, and reads nothing, when the camera does not report its version', async () => {
    const { camera, calls } = scriptedCamera({ version: null });
    const { result, unmount } = await run(camera);

    const refusal = result.current.panel.refusal;
    expect(refusal?.code).toBe('device/version-unknown');
    expect(refusal?.message).toContain('refusing to dump');
    expect(refusal?.message).toContain('did not report its firmware version');
    expect(refusal?.hint).toContain('let it finish starting up');
    expect(result.current.panel.acting).toBeNull();
    expect(result.current.panel.reporter.progress.text).toBe(
      'Refused — nothing was read. See the message above the log.',
    );
    expect(downloads).toHaveLength(0);
    expectOnlySafeReads(calls, 'auto dump of a versionless camera');
    unmount();
  });

  it('says why, and sends no arm, when the build predates the dump protocol', async () => {
    /* On 0.3.0.1 wire id 0x52 is EnterBootloaderMode. */
    const { camera, calls } = scriptedCamera({ version: [0, 3, 0, 1], legacy: true });
    const { result, unmount } = await run(camera);

    const refusal = result.current.panel.refusal;
    expect(refusal?.code).toBe('profile/unsupported');
    expect(refusal?.message).toContain('firmware 0.3.0.1 predates the dump protocol');
    expect(refusal?.hint).toBe(FIRMWARE_TOO_OLD_HINT);
    expect(downloads).toHaveLength(0);
    expect(calls.map((call) => call.request)).toEqual([OP.GET_FIRMWARE_INFO]);
    unmount();
  });

  it('refuses the sweep the same way', async () => {
    const { camera, calls } = scriptedCamera({ version: null });
    const { result, unmount } = await run(camera, 'auto', 'sweep');
    expect(result.current.panel.refusal?.message).toContain('refusing to sweep');
    expectOnlySafeReads(calls, 'auto sweep of a versionless camera');
    unmount();
  });
});

describe('a family picked by hand still goes through the identity gate', () => {
  it('skips the questions and nothing else: the version is read before the first arm', async () => {
    const { camera, calls } = scriptedCamera({ version: [4, 18, 2, 0] });
    const { result, unmount } = await run(camera, 'modern-4x');

    expect(result.current.panel.acting?.forced).toBe(true);
    expect(result.current.panel.acting?.detection).toBeNull();
    expect(calls[0]?.request).toBe(OP.GET_FIRMWARE_INFO);
    /* No probe: the 18-byte capability arm of subcommand 5 was never sent. */
    expect(
      calls.some((call) => call.request === OP.BEGIN_FIRMWARE_UPGRADE && call.length === 18),
    ).toBe(false);
    expect(downloads).toHaveLength(1);
    unmount();
  }, 30_000);

  it('cannot dump a camera that does not report its version, whichever family', async () => {
    for (const choice of ['legacy-auth', 'modern-4x', 'compact-2016', 'generic'] as const) {
      downloads.length = 0;
      const { camera, calls } = scriptedCamera({ version: null });
      const { result, unmount } = await run(camera, choice);
      expect(result.current.panel.refusal?.code, choice).toBe('device/version-unknown');
      expect(downloads, choice).toHaveLength(0);
      expectOnlySafeReads(calls, `${choice} on a versionless camera`);
      unmount();
    }
  });

  it('cannot send an arm to 0.3.0.1, whichever family', async () => {
    for (const choice of ['legacy-auth', 'modern-4x', 'generic'] as const) {
      const { camera, calls } = scriptedCamera({ version: [0, 3, 0, 1], legacy: true });
      const { result, unmount } = await run(camera, choice);
      expect(result.current.panel.refusal?.code, choice).toBe('profile/unsupported');
      expect(result.current.panel.refusal?.message, choice).toContain('predates');
      expect(
        calls.map((call) => call.request),
        choice,
      ).toEqual([OP.GET_FIRMWARE_INFO]);
      unmount();
    }
  });
});

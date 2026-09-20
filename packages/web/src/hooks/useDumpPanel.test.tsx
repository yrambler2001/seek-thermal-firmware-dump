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
import { OP, WINDOW_SIZE, WebUsbTransport, type Artifact, type WebUsbDevice } from '@seek-fw/core';
import { renderHook } from '../test-helpers';
import { permissionHint } from '../lib/hints';
import { DEFAULT_OPTIONS_FORM, type OptionsFailure } from '../lib/options';
import { useDumpPanel } from './useDumpPanel';
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
 * the decrypt stage stays out of the way.
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

function useHarness(camera: WebUsbDevice, overrides: Partial<typeof DEFAULT_OPTIONS_FORM> = {}) {
  const runner = useRunner();
  const panel = useDumpPanel({
    id: 'dump',
    runner,
    device: deviceHandle(camera),
    /* One control-IN per window keeps the fake protocol chatter down. */
    form: { ...DEFAULT_OPTIONS_FORM, chunk: String(WINDOW_SIZE), ...overrides },
    profileId: 'modern-4x',
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

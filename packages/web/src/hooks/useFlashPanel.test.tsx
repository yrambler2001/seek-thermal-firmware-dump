/**
 * The flash view's state machine.
 *
 * The behaviour under test is narrow but was completely broken in review: a
 * finished `readInfo` must LEAVE its analysis in place. Key A, the target slot
 * and the footer template all belong to one camera, so the analysis is dropped
 * whenever the device changes — and if that "device changed" effect fires for
 * any other reason, the flash view destroys the state it just built and the
 * Write button can never be enabled.
 *
 * It fired on every log line, because the effect depended on a callback that
 * closed over the reporter handles, and a reporter handle is a new object on
 * every line it prints.
 */

import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OP, WebUsbTransport, type WebUsbDevice } from '@seek-fw/core';
import { renderHook } from '../test-helpers';
import { DEFAULT_OPTIONS_FORM } from '../lib/options';
import { useFlashPanel } from './useFlashPanel';
import { useRunner } from './useRunner';
import type { DeviceHandle } from './useDevice';

vi.mock('../lib/download', () => ({
  downloadArchive: () => ({ fileName: 'x.zip', fileCount: 0, bytes: 0 }),
  mib: (bytes: number, digits = 1) => (bytes / (1024 * 1024)).toFixed(digits),
}));

/**
 * A camera that answers every read with 0xA5. No slot carries an image header,
 * so the analysis comes back with `canFlash: false` — which is the correct
 * answer for this fake and is all this test needs: a NON-NULL DeviceState.
 */
function fakeCamera(): WebUsbDevice {
  let opened = false;
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
      const block = new Uint8Array(length).fill(0xa5);
      return Promise.resolve({ status: 'ok', data: new DataView(block.buffer) });
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

function useHarness(camera: WebUsbDevice) {
  const runner = useRunner();
  const panel = useFlashPanel({
    runner,
    device: deviceHandle(camera),
    form: DEFAULT_OPTIONS_FORM,
    profileChoice: 'auto',
    onOptionsFailure: () => undefined,
  });
  return { panel, runner };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('useFlashPanel', () => {
  it('keeps the analysis a finished read produced', async () => {
    const camera = fakeCamera();
    const { result, unmount } = renderHook(() => useHarness(camera));

    await act(async () => {
      await result.current.panel.readInfo();
    });

    /* The regression: this was null, because the device-changed effect fired
     * on the log lines the read itself emitted. */
    expect(result.current.panel.deviceState).not.toBeNull();

    /* ...and the user was told they had swapped cameras. */
    expect(result.current.panel.infoReporter.progress.text).not.toContain('New device selected');
    expect(result.current.panel.flashReporter.progress.text).not.toContain('New device selected');

    unmount();
  }, 30_000);

  it('survives further reporter traffic once the analysis is in place', async () => {
    const camera = fakeCamera();
    const { result, unmount } = renderHook(() => useHarness(camera));

    await act(async () => {
      await result.current.panel.readInfo();
    });
    expect(result.current.panel.deviceState).not.toBeNull();

    /* Any log line re-rendered the hook with a fresh reporter handle, which is
     * what used to invalidate the analysis. It must not. */
    act(() => {
      result.current.panel.flashReporter.log('an ordinary line', 'info');
      result.current.panel.infoReporter.log('another one', 'detail');
    });
    act(() => {
      result.current.panel.infoReporter.setStatus('still here');
    });

    expect(result.current.panel.deviceState).not.toBeNull();

    unmount();
  }, 30_000);

  it('still drops the analysis when the camera really does change', async () => {
    const camera = fakeCamera();
    let generation = 1;
    const { result, rerender, unmount } = renderHook(() => {
      const runner = useRunner();
      const panel = useFlashPanel({
        runner,
        device: { ...deviceHandle(camera), generation },
        form: DEFAULT_OPTIONS_FORM,
        profileChoice: 'auto',
        onOptionsFailure: () => undefined,
      });
      return { panel, runner };
    });

    await act(async () => {
      await result.current.panel.readInfo();
    });
    expect(result.current.panel.deviceState).not.toBeNull();

    /* The guard that matters: a payload built for one camera must never be
     * carried across to another. */
    act(() => {
      generation = 2;
      rerender();
    });

    expect(result.current.panel.deviceState).toBeNull();
    expect(result.current.panel.infoReporter.progress.text).toContain('read the device info again');

    unmount();
  }, 30_000);
});

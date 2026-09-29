/* ==================================================================== *
 * What a real host does with a control transfer the camera answers late or
 * never, and what the toolkit does about it (TESTING.md sec.22).
 *
 * CHROME, FROM ITS SOURCE. Blink sends every WebUSB transfer with a timeout of
 * 0 (third_party/blink/renderer/modules/webusb/usb_device.cc), and 0 is "none"
 * on Chrome's macOS and Linux stacks: libusb arms no timer and hands IOKit
 * noDataTimeout = completionTimeout = 0; usbfs posts no timeout callback
 * (`UsbDeviceHandleUsbfs::SetUpTimeoutCallback`). A transfer the camera never
 * completes therefore stays on EP0, and the next control transfer waits behind
 * it (USB 2.0 sec.5.5.5). The only way out is close(), which cancels every
 * pending transfer of the handle (`UsbDeviceHandleImpl::Close`,
 * `UsbDeviceHandleUsbfs::Close`). `chromeDevice` below is exactly that, and no
 * more: one FIFO control pipe, no host timeout, close() cancels.
 * ==================================================================== */

import { describe, expect, it, vi } from 'vitest';

import { SeekError } from '../src/errors.js';
import { SeekDevice } from '../src/protocol/client.js';
import { OP, USB_TIMEOUT_MS } from '../src/protocol/ops.js';
import {
  WebUsbTransport,
  type WebUsbControlSetup,
  type WebUsbDevice,
  type WebUsbInTransferResult,
  type WebUsbOutTransferResult,
} from '../src/protocol/webusb.js';
import { readRunningFirmware } from '../src/workflows/capability.js';
import { EmulatedDeviceClock } from './emulator/device-clock.js';

const NS_PER_MS = 1_000_000;

/** What the camera does with one request: answer it, or never complete it. */
type Answer = { readonly data: Uint8Array } | 'never';

interface ChromeDevice extends WebUsbDevice {
  /** Requests that reached the camera, in order (a queued one only once it went out). */
  readonly reached: number[];
  readonly closes: number;
}

/**
 * A camera behind Chrome's WebUSB on macOS or Linux (see the file comment).
 * `answer(request, n)` is the camera: the n-th request (0-based) it receives.
 */
function chromeDevice(answer: (request: number, n: number) => Answer): ChromeDevice {
  const reached: number[] = [];
  let opened = false;
  let closes = 0;
  /* The control pipe: a transfer goes out only when the one before it has ended. */
  let pipe: Promise<unknown> = Promise.resolve();
  const pending = new Set<(error: Error) => void>();

  function submit<T>(setup: WebUsbControlSetup, done: (data: Uint8Array) => T): Promise<T> {
    const ahead = pipe;
    const transfer = new Promise<T>((resolve, reject) => {
      let cancelled = false;
      const cancel = (error: Error): void => {
        cancelled = true;
        pending.delete(cancel);
        reject(error);
      };
      pending.add(cancel);
      void ahead.then(() => {
        if (cancelled) return;
        const n = reached.length;
        reached.push(setup.request);
        const reply = answer(setup.request, n);
        if (reply === 'never') return; /* NAKed for ever; nothing times it out */
        pending.delete(cancel);
        resolve(done(reply.data));
      });
    });
    pipe = transfer.catch(() => undefined);
    return transfer;
  }

  return {
    reached,
    get closes(): number {
      return closes;
    },
    vendorId: 0x289d,
    productId: 0x0010,
    manufacturerName: 'Seek Thermal',
    productName: 'PIR206 Thermal Camera',
    serialNumber: null,
    configuration: { configurationValue: 1 },
    get opened(): boolean {
      return opened;
    },
    open: () => {
      opened = true;
      return Promise.resolve();
    },
    close: () => {
      closes++;
      opened = false;
      for (const cancel of [...pending]) {
        cancel(new DOMException('The transfer was cancelled.', 'AbortError'));
      }
      return Promise.resolve();
    },
    selectConfiguration: () => Promise.resolve(),
    claimInterface: () => Promise.resolve(),
    releaseInterface: () => Promise.resolve(),
    controlTransferIn: (setup) =>
      submit<WebUsbInTransferResult>(setup, (data) => ({
        status: 'ok',
        data: new DataView(data.buffer, data.byteOffset, data.byteLength),
      })),
    controlTransferOut: (setup, data) =>
      submit<WebUsbOutTransferResult>(setup, () => ({
        status: 'ok',
        bytesWritten: data.byteLength,
      })),
  };
}

/** GetFirmwareInfo's build block: four version bytes and the build string. */
function buildBlock(version: readonly number[], build: string): Uint8Array {
  const bytes = new Uint8Array(36);
  bytes.set(version, 0);
  bytes.set(new TextEncoder().encode(build), 4);
  return bytes;
}

describe('a transfer the camera never completes, behind Chrome (TESTING.md sec.22)', () => {
  it('is taken off the control pipe at the deadline, so the next transfer reaches the camera', async () => {
    vi.useFakeTimers();
    try {
      const camera = chromeDevice((_request, n) =>
        n === 0 ? 'never' : { data: new Uint8Array([1, 2, 3, 4]) },
      );
      const transport = new WebUsbTransport(camera);
      await transport.open();

      const first = transport.controlIn(OP.GET_ERROR_CODE, 4).catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(USB_TIMEOUT_MS);
      const error = await first;
      expect(error).toBeInstanceOf(SeekError);
      expect((error as SeekError).code).toBe('usb/timeout');
      /* The one thing WebUSB offers that ends a pending transfer, and the transport
       * is open again - the recipient it had decided kept. */
      expect(camera.closes).toBe(1);
      expect(transport.isOpen).toBe(true);
      expect(transport.info.recipient).toBe('interface');

      /* Before sec.22 this read queued behind the first on EP0 and timed out too. */
      const second = transport.controlIn(OP.GET_ERROR_CODE, 4);
      await vi.advanceTimersByTimeAsync(0);
      await expect(second).resolves.toEqual(new Uint8Array([1, 2, 3, 4]));
      expect(camera.reached).toEqual([OP.GET_ERROR_CODE, OP.GET_ERROR_CODE]);
      expect(camera.closes).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('identifies Compact 0.6.0.4, which never completes the first GetFirmwareInfo it is sent', async () => {
    /* FW-V1 Phase 29: 0.6.0.4's FW-init refusal returns "handled" without a data
     * stage, so that read is NAKed for ever; the ones after it are answered. On the
     * CLI nusb cancels it at 5 s and the version read's second read answers. */
    vi.useFakeTimers();
    try {
      const camera = chromeDevice((request, n) =>
        request === OP.GET_FIRMWARE_INFO && n === 0
          ? 'never'
          : { data: buildBlock([0, 6, 0, 4], 'Aug 11 2014 14:42:17') },
      );
      const transport = new WebUsbTransport(camera);
      await transport.open();
      const read = readRunningFirmware(new SeekDevice(transport));
      await vi.advanceTimersByTimeAsync(USB_TIMEOUT_MS);
      const firmware = await read;
      expect(firmware.version).toBe('0.6.0.4');
      expect(camera.reached).toEqual([
        OP.GET_FIRMWARE_INFO,
        OP.GET_FIRMWARE_INFO,
        OP.GET_FIRMWARE_INFO,
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('leaves the device alone when the camera answers in time', async () => {
    const camera = chromeDevice(() => ({ data: new Uint8Array([9]) }));
    const transport = new WebUsbTransport(camera);
    await transport.open();
    await transport.controlIn(OP.GET_ERROR_CODE, 1);
    await transport.controlOut(OP.SET_OPERATION_MODE, new Uint8Array(2));
    expect(camera.closes).toBe(0);
  });
});

describe("the emulated camera's clock after a late completion (TESTING.md sec.22)", () => {
  it('counts a timer started before the next record from the moment the toolkit gave up', () => {
    /* The `chrome` host model: nobody cancels, the camera answers at 7 s a transfer
     * whose deadline was 5 s. On a real host the toolkit reacted at 5 s, and what it
     * sent next waited on the pipe from then. */
    const clock = new EmulatedDeviceClock();
    const fired: string[] = [];
    clock.startTimer(5000, () => fired.push('first'));
    clock.advance(7000 * NS_PER_MS);
    expect(fired).toEqual(['first']);
    expect(clock.timeNs).toBe(7000 * NS_PER_MS);
    expect(clock.now()).toBe(5000);
    clock.startTimer(1500, () => fired.push('queued'));
    clock.advance(7000 * NS_PER_MS + 1);
    /* The next record: 6.5 s had passed at 7 s, so the queued deadline has too. */
    expect(fired).toEqual(['first', 'queued']);
    clock.advance(8000 * NS_PER_MS);
    expect(clock.now()).toBe(8000);
  });
});

import { describe, expect, it, vi } from 'vitest';

import { equalBytes, utf8 } from '../src/bytes.js';
import { CancelledError, SeekError } from '../src/errors.js';
import { collectingReporter } from '../src/events.js';
import { SeekDevice, u16Payload } from '../src/protocol/client.js';
import {
  assertOpSetsDisjoint,
  COMMIT_WORST_CASE_MS,
  FLASH_OPS,
  MIN_READ_CHUNK,
  OP,
  READ_ONLY_OPS,
  USB_COMMIT_TIMEOUT_MS,
  USB_TIMEOUT_MS,
  WINDOW_SIZE,
} from '../src/protocol/ops.js';
import type { WindowEntry } from '../src/profiles/types.js';
import type { UsbTransport } from '../src/protocol/transport.js';
import {
  WALL_CLOCK,
  WebUsbTransport,
  type WebUsbDevice,
  type WebUsbInTransferResult,
  type WebUsbOutTransferResult,
} from '../src/protocol/webusb.js';
import { EmulatedDeviceClock } from './emulator/device-clock.js';
import { fakeCamera, FAKE_ERR, type FakeCamera } from './fake-transport.js';

const TOKEN = new Uint8Array([
  0x53, 0x16, 0x10, 0x31, 0x80, 0xdd, 0x00, 0xb7, 0x4a, 0xf9, 0xe4, 0x17, 0xc5, 0x94, 0xbe, 0xd4,
]);

function entry(subcmd: number, address = 0x14000000 + subcmd * WINDOW_SIZE): WindowEntry {
  return { subcmd, address, note: 'test window' };
}

function authEntry(subcmd: number, token: Uint8Array): WindowEntry {
  const payload = new Uint8Array(2 + token.length);
  payload.set(u16Payload(subcmd), 0);
  payload.set(token, 2);
  return { ...entry(subcmd), auth: true, payload };
}

async function opened(camera: FakeCamera): Promise<SeekDevice> {
  await camera.open();
  return new SeekDevice(camera);
}

describe('ops', () => {
  it('keeps the read-only and flash command sets disjoint', () => {
    expect(() => {
      assertOpSetsDisjoint();
    }).not.toThrow();
    for (const op of FLASH_OPS) expect(READ_ONLY_OPS.has(op)).toBe(false);
    expect(READ_ONLY_OPS.has(OP.GET_FEATURED_FIRMWARE_DATA)).toBe(true);
    expect(FLASH_OPS.has(OP.SET_FEATURED_FIRMWARE_DATA)).toBe(true);
  });
});

describe('readWindow', () => {
  it('reads a whole 64 KiB window', async () => {
    const camera = fakeCamera();
    const dev = await opened(camera);

    const seen: number[] = [];
    const got = await dev.readWindow(entry(5), 64, (n) => seen.push(n));

    expect(got.data.length).toBe(WINDOW_SIZE);
    expect(got.stoppedAt).toBe(WINDOW_SIZE);
    expect(got.stopReason).toBeNull();
    expect(got.chunkUsed).toBe(64);
    expect(got.shrank).toBe(false);
    expect(equalBytes(got.data, camera.flash.subarray(5 * WINDOW_SIZE, 6 * WINDOW_SIZE))).toBe(
      true,
    );
    expect(seen.length).toBe(WINDOW_SIZE / 64);
  });

  it('rearms at offset 0, so two reads of the same window agree', async () => {
    const camera = fakeCamera();
    const dev = await opened(camera);

    const first = await dev.readWindow(entry(2), 256);
    const second = await dev.readWindow(entry(2), 256);
    expect(equalBytes(first.data, second.data)).toBe(true);
  });

  it('touches only read-only opcodes', async () => {
    const camera = fakeCamera();
    const dev = await opened(camera);
    await dev.readWindow(entry(3), 256);

    for (const call of camera.calls) expect(READ_ONLY_OPS.has(call.op as never)).toBe(true);
  });

  it('keeps a short window and reports why it stopped', async () => {
    const camera = fakeCamera({ stallAt: [{ subcmd: 5, offset: 0x8000 }] });
    const dev = await opened(camera);

    const got = await dev.readWindow(entry(5), 64);

    expect(got.data.length).toBe(0x8000);
    expect(got.stoppedAt).toBe(0x8000);
    expect(got.stopReason).toMatch(/GetFeaturedFirmwareData stopped at offset 0x8000/);
    expect(got.stopReason).toMatch(new RegExp(`even at ${String(MIN_READ_CHUNK)}-byte requests`));
    expect(got.chunkUsed).toBe(MIN_READ_CHUNK);
    expect(got.shrank).toBe(true);
    expect(
      equalBytes(got.data, camera.flash.subarray(5 * WINDOW_SIZE, 5 * WINDOW_SIZE + 0x8000)),
    ).toBe(true);
  });

  it('throws when the window yields nothing at all', async () => {
    const camera = fakeCamera({ stallAt: [{ subcmd: 5, offset: 0 }] });
    const dev = await opened(camera);

    const error = await dev.readWindow(entry(5), 64).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('device/window');
    expect((error as SeekError).message).toMatch(/returned nothing/);
  });

  it('stops on a short chunk rather than treating it as end-of-window', async () => {
    const camera = fakeCamera({ maxChunk: 48 });
    const dev = await opened(camera);
    await dev.ensureMode0();
    await dev.armWindow(entry(7));

    const got = await dev.readArmed(64, 256);

    expect(got.data.length).toBe(48);
    expect(got.stopReason).toMatch(/short chunk at offset 0x0030/);
    expect(got.shrank).toBe(false);
  });
});

describe('adaptive chunk shrinking', () => {
  it('shrinks past the stuck request and keeps the smaller size', async () => {
    const camera = fakeCamera({ stallAt: [{ subcmd: 6, offset: 0x8000, minSize: 128 }] });
    const dev = await opened(camera);

    const got = await dev.readWindow(entry(6), 256);

    expect(got.data.length).toBe(WINDOW_SIZE);
    expect(got.stopReason).toBeNull();
    expect(got.shrank).toBe(true);
    expect(got.chunkUsed).toBe(64);
    expect(equalBytes(got.data, camera.flash.subarray(6 * WINDOW_SIZE, 7 * WINDOW_SIZE))).toBe(
      true,
    );

    /* The size that worked is kept: nothing goes back up to 256 afterwards. */
    const reads = camera.calls.filter((c) => c.op === OP.GET_FEATURED_FIRMWARE_DATA);
    const afterStall = reads.slice(reads.findIndex((c) => c.length === 64));
    expect(afterStall.every((c) => c.length <= 64)).toBe(true);
  });
});

describe('ensureMode0', () => {
  it('leaves imaging mode and waits for mode 0 to read back', async () => {
    const camera = fakeCamera({ requireMode0: true, initialMode: 1, modeSettleMs: 60 });
    const dev = await opened(camera);

    const got = await dev.readWindow(entry(4), 256);

    expect(got.data.length).toBe(WINDOW_SIZE);
    expect(camera.operationMode).toBe(0);
    expect(camera.calls.some((c) => c.op === OP.SET_OPERATION_MODE)).toBe(true);
  });

  it('is the reason the window command works at all', async () => {
    const camera = fakeCamera({ requireMode0: true, initialMode: 1 });
    await camera.open();
    const dev = new SeekDevice(camera);

    /* Arming without the mode transition is exactly what a 4.9.x camera refuses. */
    await dev.rpcOut(OP.BEGIN_FIRMWARE_UPGRADE, u16Payload(4));
    expect(await dev.getErrorCode()).toBe(FAKE_ERR.MODE);

    await dev.armWindow(entry(4));
    expect(await dev.getErrorCode()).toBe(FAKE_ERR.NONE);
  });

  it('gives up with an explanatory error when the camera never gets there', async () => {
    const camera = fakeCamera({ requireMode0: true, initialMode: 1, modeSettleMs: 10_000 });
    const dev = await opened(camera);

    const error = await dev.ensureMode0().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('device/mode');
    expect((error as SeekError).message).toMatch(/did not enter operation mode 0/);
  }, 10_000);

  /* TESTING.md sec.20: the settle deadline on the transport's clock. */
  const NS_PER_MS = 1_000_000;

  /** A camera on an injected clock that, like the gated emulator, ages only while a
   *  request is outstanding: `msPerRequest` of its time per control transfer. */
  class OnClock implements UsbTransport {
    readonly clock = new EmulatedDeviceClock();
    private readonly inner: FakeCamera;
    private readonly msPerRequest: number;
    constructor(inner: FakeCamera, msPerRequest: number) {
      this.inner = inner;
      this.msPerRequest = msPerRequest;
    }
    get description(): UsbTransport['description'] {
      return this.inner.description;
    }
    get info(): UsbTransport['info'] {
      return this.inner.info;
    }
    get isOpen(): boolean {
      return this.inner.isOpen;
    }
    open(): Promise<void> {
      return this.inner.open();
    }
    close(): Promise<void> {
      return this.inner.close();
    }
    controlIn(request: number, length: number, timeoutMs: number): Promise<Uint8Array> {
      this.age();
      return this.inner.controlIn(request, length, timeoutMs);
    }
    controlOut(request: number, data: Uint8Array, timeoutMs: number): Promise<void> {
      this.age();
      return this.inner.controlOut(request, data, timeoutMs);
    }
    private age(): void {
      this.clock.advance(this.clock.timeNs + this.msPerRequest * NS_PER_MS);
    }
  }

  it("times the settle deadline on the transport's clock, so real time decides nothing", async () => {
    /* The camera never settles in real time (10 s), and ages 100 ms per request. */
    const camera = fakeCamera({ requireMode0: true, initialMode: 1, modeSettleMs: 10_000 });
    const transport = new OnClock(camera, 100);
    await transport.open();
    const dev = new SeekDevice(transport);
    expect(dev.clock).toBe(transport.clock);

    const error = await dev.ensureMode0().catch((e: unknown) => e);
    expect((error as SeekError).code).toBe('device/mode');
    /* The read, SetOperationMode (t = 200 ms, deadline 3,200 ms), then a poll per 100 ms
     * until the clock is past it: the 31st poll, at 3,300 ms. On the wall clock this was
     * however many polls fit in 3 real seconds (~150 at 20 ms apart). */
    const polls = camera.calls.filter((c) => c.op === OP.GET_OPERATION_MODE).length;
    expect(polls).toBe(1 + 31);
    expect(transport.clock.reads).toBe(1 + 31);
    expect(transport.clock.timeNs).toBe(3300 * NS_PER_MS);
  });

  it('takes the clock from the transport, and the wall clock without one', () => {
    const clock = new EmulatedDeviceClock();
    const webusb = new WebUsbTransport(stubDevice(), { clock });
    expect(new SeekDevice(webusb).clock).toBe(clock);
    expect(new SeekDevice(new WebUsbTransport(stubDevice())).clock).toBe(WALL_CLOCK);
    expect(new SeekDevice(fakeCamera()).clock).toBe(WALL_CLOCK);
    const before = Date.now();
    const read = WALL_CLOCK.now();
    expect(read).toBeGreaterThanOrEqual(before);
    expect(read).toBeLessThanOrEqual(Date.now());
  });
});

describe('authenticated banks', () => {
  it('refuses the plain 2-byte selector and accepts the 18-byte token', async () => {
    const camera = fakeCamera({ authBanks: [3], authToken: TOKEN });
    const dev = await opened(camera);

    const refused = await dev.readWindow(entry(3), 256).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(SeekError);
    expect((refused as SeekError).code).toBe('device/error-code');
    expect((refused as SeekError).deviceCode).toBe(FAKE_ERR.AUTH);

    const got = await dev.readWindow(authEntry(3, TOKEN), 256);
    expect(got.data.length).toBe(WINDOW_SIZE);
    expect(equalBytes(got.data, camera.flash.subarray(3 * WINDOW_SIZE, 4 * WINDOW_SIZE))).toBe(
      true,
    );
  });

  it('rejects a token that does not match this build', async () => {
    const camera = fakeCamera({ authBanks: [3], authToken: TOKEN });
    const dev = await opened(camera);

    const wrong = new Uint8Array(TOKEN);
    wrong[0] = (wrong[0] ?? 0) ^ 0xff;

    const error = await dev.readWindow(authEntry(3, wrong), 256).catch((e: unknown) => e);
    expect((error as SeekError).deviceCode).toBe(FAKE_ERR.AUTH);
  });
});

describe('cancellation', () => {
  it('throws CancelledError at the next loop boundary', async () => {
    const camera = fakeCamera();
    await camera.open();
    const controller = new AbortController();
    const dev = new SeekDevice(camera, { signal: controller.signal });

    let chunks = 0;
    const error = await dev
      .readWindow(entry(5), 64, () => {
        chunks += 1;
        if (chunks === 4) controller.abort();
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CancelledError);
    expect((error as SeekError).code).toBe('cancelled');
    expect(chunks).toBe(4);
  });

  it('reports the signal through `cancelled`', async () => {
    const camera = fakeCamera();
    await camera.open();
    const controller = new AbortController();
    const dev = new SeekDevice(camera, { signal: controller.signal });

    expect(dev.cancelled).toBe(false);
    controller.abort();
    expect(dev.cancelled).toBe(true);
    expect(() => {
      dev.assertNotCancelled();
    }).toThrow(CancelledError);
  });
});

describe('firmware info', () => {
  it('reads a selector and never throws for one the camera lacks', async () => {
    const payload = new Uint8Array(36).fill(0x41);
    const camera = fakeCamera({ fwInfo: new Map([[0, payload]]) });
    const reporter = collectingReporter();
    await camera.open();
    const dev = new SeekDevice(camera, { reporter });

    const build = await dev.readFwInfo(0, 36);
    expect(build.length).toBe(36);

    expect(await dev.tryFwInfo(99, 36, 'missing info')).toBeNull();
    expect(
      reporter.events.some((e) => e.type === 'log' && e.message.includes('missing info')),
    ).toBe(true);
  });

  it('reads the serial out of the RAM device-id block', async () => {
    const ram = new Uint8Array(248);
    ram.set(utf8('0E1CA0Z16D19'), 16);
    const camera = fakeCamera({ ramData: ram });
    const dev = await opened(camera);

    expect(await dev.readSerial()).toBe('0E1CA0Z16D19');
  });

  it('returns null rather than throwing when the serial is unavailable', async () => {
    const camera = fakeCamera();
    const dev = await opened(camera);
    expect(await dev.readSerial()).toBeNull();
  });
});

describe('write primitives', () => {
  it('stages and commits, and refuses a bad transfer checksum', async () => {
    const camera = fakeCamera({ flashSize: 2 * WINDOW_SIZE });
    const dev = await opened(camera);

    const payload = new Uint8Array(WINDOW_SIZE).fill(0xa5);
    let sum = 0;
    for (const b of payload) sum = (sum + b) & 0xffff;

    await dev.armWindow(entry(1));
    for (let off = 0; off < payload.length; off += 64) {
      await dev.setFeaturedFirmwareData(payload.subarray(off, off + 64));
    }
    await dev.completeMemoryUpgrade((sum + 1) & 0xffff);
    expect(await dev.getErrorCode()).toBe(FAKE_ERR.BAD_CHECKSUM);
    expect(camera.flash[WINDOW_SIZE]).not.toBe(0xa5);

    await dev.armWindow(entry(1));
    for (let off = 0; off < payload.length; off += 64) {
      await dev.setFeaturedFirmwareData(payload.subarray(off, off + 64));
    }
    await dev.completeMemoryUpgrade(sum);
    expect(await dev.getErrorCode()).toBe(FAKE_ERR.NONE);
    expect(camera.flash.subarray(WINDOW_SIZE, 2 * WINDOW_SIZE).every((b) => b === 0xa5)).toBe(true);
  });
});

/* ---- WebUsbTransport ------------------------------------------------- */

interface StubOptions {
  readonly inResult?: WebUsbInTransferResult;
  readonly outResult?: WebUsbOutTransferResult;
  /** Never settles, like a camera that has simply stopped answering. */
  readonly hang?: boolean;
  readonly claimFails?: boolean;
  /** What a failing claim rejects with. Default: a plain Error('Access denied'). */
  readonly claimError?: Error;
}

function stubDevice(options: StubOptions = {}): WebUsbDevice & { setups: unknown[] } {
  const setups: unknown[] = [];
  let isOpen = false;
  return {
    setups,
    vendorId: 0x289d,
    productId: 0x0011,
    manufacturerName: 'Seek Thermal',
    productName: 'Compact PRO',
    serialNumber: null,
    configuration: { configurationValue: 1 },
    get opened(): boolean {
      return isOpen;
    },
    open: () => {
      isOpen = true;
      return Promise.resolve();
    },
    close: () => {
      isOpen = false;
      return Promise.resolve();
    },
    selectConfiguration: () => Promise.resolve(),
    claimInterface: () =>
      options.claimFails === true
        ? Promise.reject(options.claimError ?? new Error('Access denied'))
        : Promise.resolve(),
    releaseInterface: () => Promise.resolve(),
    controlTransferIn: (setup) => {
      setups.push(setup);
      if (options.hang === true) return new Promise<WebUsbInTransferResult>(() => undefined);
      return Promise.resolve(
        options.inResult ?? { status: 'ok', data: new DataView(new ArrayBuffer(4)) },
      );
    },
    controlTransferOut: (setup) => {
      setups.push(setup);
      if (options.hang === true) return new Promise<WebUsbOutTransferResult>(() => undefined);
      return Promise.resolve(options.outResult ?? { status: 'ok', bytesWritten: 0 });
    },
  };
}

describe('WebUsbTransport', () => {
  it('reports a string the device named but could not produce as null, not "" (sec.21.1)', () => {
    /* Chrome on macOS and Windows keeps "" for a string whose read or parse failed
     * (services/device/usb ReadUsbStringDescriptors); on Linux it has none, null.
     * The 2014 Compacts' iSerialNumber 5 is such a string. */
    const chrome = { ...stubDevice(), serialNumber: '', productName: '', manufacturerName: '' };
    expect(new WebUsbTransport(chrome).description).toMatchObject({
      serialNumber: null,
      productName: null,
      manufacturerName: null,
    });
    const linux = { ...stubDevice(), serialNumber: null };
    expect(new WebUsbTransport(linux).description.serialNumber).toBeNull();
    const real = { ...stubDevice(), serialNumber: '1818B0Z3K6C8' };
    expect(new WebUsbTransport(real).description.serialNumber).toBe('1818B0Z3K6C8');
  });

  it('turns a stall into a thrown error instead of an empty read', async () => {
    const transport = new WebUsbTransport(stubDevice({ inResult: { status: 'stall' } }));
    await transport.open();

    const error = await transport.controlIn(OP.GET_ERROR_CODE, 4, 1000).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('usb/stalled');
  });

  it('times out instead of hanging forever', async () => {
    const transport = new WebUsbTransport(stubDevice({ hang: true }));
    await transport.open();

    const error = await transport.controlIn(OP.GET_ERROR_CODE, 4, 20).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('usb/timeout');
  });

  it('clears the timer on a transfer that did answer', async () => {
    vi.useFakeTimers();
    try {
      const transport = new WebUsbTransport(stubDevice());
      await transport.open();
      await transport.controlIn(OP.GET_ERROR_CODE, 4, 5000);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('addresses the interface, or the device when it could not be claimed', async () => {
    const claimed = stubDevice();
    const transport = new WebUsbTransport(claimed, { recipient: 'auto', interfaceNumber: 1 });
    await transport.open();
    await transport.controlIn(OP.GET_ERROR_CODE, 4, 1000);
    expect(transport.info.recipient).toBe('interface');
    expect(transport.info.claimedInterface).toBe(true);
    expect(claimed.setups[0]).toMatchObject({
      requestType: 'vendor',
      recipient: 'interface',
      index: 1,
    });

    /* The one claim failure 'auto' answers with device recipient: the platform
     * refusing it (WebUSB's NetworkError). Any other failure is an error now —
     * transport-session.test.ts. */
    const warnings: string[] = [];
    const busy = stubDevice({
      claimFails: true,
      claimError: new DOMException('Unable to claim interface.', 'NetworkError'),
    });
    const fallback = new WebUsbTransport(busy, {
      recipient: 'auto',
      interfaceNumber: 1,
      onWarning: (m) => warnings.push(m),
    });
    await fallback.open();
    await fallback.controlIn(OP.GET_ERROR_CODE, 4, 1000);
    expect(fallback.info.recipient).toBe('device');
    expect(fallback.info.claimedInterface).toBe(false);
    expect(warnings[0]).toMatch(/recipient=device/);
    expect(fallback.info.recipientFallback).toBe(warnings[0]);
    expect(busy.setups[0]).toMatchObject({ recipient: 'device', index: 0 });
  });

  it('explains who is holding the camera when the caller demanded the interface', async () => {
    const transport = new WebUsbTransport(stubDevice({ claimFails: true }), {
      recipient: 'interface',
    });

    const error = await transport.open().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('usb/not-open');
    expect((error as SeekError).message).toMatch(/another program or a system driver/);
  });

  it('gives the flash commit twice its worst case, worked out from the firmware and datasheet', () => {
    /* ops.ts shows the arithmetic: 3 x 2,000 ms block erases + 514 x 3 ms page
     * programs + 5 x 15 ms status writes + a 500 ms CPU allowance. */
    expect(COMMIT_WORST_CASE_MS).toBe(3 * 2000 + 514 * 3 + 5 * 15 + 500);
    expect(COMMIT_WORST_CASE_MS).toBe(8117);
    expect(USB_COMMIT_TIMEOUT_MS).toBeGreaterThanOrEqual(2 * COMMIT_WORST_CASE_MS);
  });

  it('in a browser, lets a worst-case commit finish, and times out only at its own deadline', async () => {
    /* WebUSB has no per-transfer timeout, so the transport's timer is the only
     * one: it must not fire before USB_COMMIT_TIMEOUT_MS, and a commit that
     * takes the worst case must complete. */
    vi.useFakeTimers();
    try {
      let commitMs = COMMIT_WORST_CASE_MS;
      const device: WebUsbDevice = {
        ...stubDevice(),
        controlTransferOut: (setup) =>
          setup.request === OP.COMPLETE_MEMORY_UPGRADE
            ? new Promise<WebUsbOutTransferResult>((resolve) => {
                setTimeout(() => {
                  resolve({ status: 'ok', bytesWritten: 2 });
                }, commitMs);
              })
            : Promise.resolve({ status: 'ok', bytesWritten: 0 }),
      };
      const transport = new WebUsbTransport(device);
      await transport.open();
      const dev = new SeekDevice(transport);

      const done = dev.completeMemoryUpgrade(0x1234).then(() => 'committed');
      await vi.advanceTimersByTimeAsync(COMMIT_WORST_CASE_MS);
      await expect(done).resolves.toBe('committed');

      commitMs = 10 * USB_COMMIT_TIMEOUT_MS;
      let settled: unknown = 'pending';
      const hung = dev.completeMemoryUpgrade(0x1234).then(
        () => 'committed',
        (e: unknown) => e,
      );
      void hung.then((value) => (settled = value));
      await vi.advanceTimersByTimeAsync(USB_COMMIT_TIMEOUT_MS - 1);
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBeInstanceOf(SeekError);
      expect((settled as SeekError).code).toBe('usb/timeout');
      expect((settled as SeekError).message).toContain(`${String(USB_COMMIT_TIMEOUT_MS)} ms`);
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses transfers before open()', async () => {
    const transport = new WebUsbTransport(stubDevice());
    const error = await transport.controlIn(OP.GET_ERROR_CODE, 4, 1000).catch((e: unknown) => e);
    expect((error as SeekError).code).toBe('usb/not-open');
  });
});

/* ---- the deadline's clock (TESTING.md sec.19) --------------------------- */

describe('WebUsbTransport deadlines on an injected clock', () => {
  const NS_PER_MS = 1_000_000;

  it('times its deadline on the given clock, and no real time can end it', async () => {
    vi.useFakeTimers();
    try {
      const clock = new EmulatedDeviceClock();
      const transport = new WebUsbTransport(stubDevice({ hang: true }), { clock });
      await transport.open();
      let settled: unknown = 'pending';
      void transport.controlIn(OP.GET_ERROR_CODE, 4).then(
        () => (settled = 'answered'),
        (e: unknown) => (settled = e),
      );
      /* A minute of real time: nothing. No real timer was even started. */
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(settled).toBe('pending');
      expect(clock.armed).toBe(1);
      /* The camera's clock: one nanosecond short of the deadline, then on it. */
      clock.advance(USB_TIMEOUT_MS * NS_PER_MS - 1);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBe('pending');
      clock.advance(USB_TIMEOUT_MS * NS_PER_MS);
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toBeInstanceOf(SeekError);
      expect((settled as SeekError).code).toBe('usb/timeout');
      expect((settled as SeekError).message).toContain(`${String(USB_TIMEOUT_MS)} ms`);
      expect(clock.armed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures each deadline from the clock at the transfer, in and out, and cancels it on an answer', async () => {
    const clock = new EmulatedDeviceClock();
    clock.advance(7 * 1000 * NS_PER_MS); /* the camera has been up 7 s */
    const transport = new WebUsbTransport(stubDevice(), { clock });
    await transport.open();
    await transport.controlIn(OP.GET_ERROR_CODE, 4, 1500);
    await transport.controlOut(OP.SET_OPERATION_MODE, new Uint8Array(2), 20_000);
    expect(clock.timersStarted).toBe(2);
    expect(clock.armed).toBe(0);
    expect(clock.timersFired).toBe(0);

    const hung = new WebUsbTransport(stubDevice({ hang: true }), { clock });
    await hung.open();
    const out = hung
      .controlOut(OP.SET_OPERATION_MODE, new Uint8Array(2), 1500)
      .catch((e: unknown) => e);
    clock.advance((7000 + 1499) * NS_PER_MS);
    expect(clock.timersFired).toBe(0);
    clock.advance((7000 + 1500) * NS_PER_MS);
    expect(((await out) as SeekError).code).toBe('usb/timeout');
  });

  it('fires the earliest deadline first, and time never runs backwards', () => {
    const clock = new EmulatedDeviceClock();
    const fired: string[] = [];
    clock.startTimer(20, () => fired.push('20 ms'));
    clock.startTimer(5, () => fired.push('5 ms'));
    const cancel = clock.startTimer(10, () => fired.push('10 ms, cancelled'));
    cancel();
    clock.advance(30 * NS_PER_MS);
    clock.advance(1 * NS_PER_MS);
    expect(clock.timeNs).toBe(30 * NS_PER_MS);
    expect(fired).toEqual(['5 ms', '20 ms']);
    cancel();
    expect(clock.armed).toBe(0);
  });

  it('defaults to the wall clock, which is setTimeout', async () => {
    vi.useFakeTimers();
    try {
      const transport = new WebUsbTransport(stubDevice({ hang: true }));
      await transport.open();
      let settled: unknown = 'pending';
      void transport.controlIn(OP.GET_ERROR_CODE, 4).catch((e: unknown) => (settled = e));
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(USB_TIMEOUT_MS - 1);
      expect(settled).toBe('pending');
      await vi.advanceTimersByTimeAsync(1);
      expect((settled as SeekError).code).toBe('usb/timeout');

      let expired = false;
      const cancel = WALL_CLOCK.startTimer(100, () => (expired = true));
      cancel();
      await vi.advanceTimersByTimeAsync(1000);
      expect(expired).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

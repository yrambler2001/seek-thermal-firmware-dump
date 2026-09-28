/**
 * The CLI's host stack, `usb` 3.1.0, as the transport really meets it.
 *
 * `usb` 3.x is node-usb-rs over nusb, not libusb, and its WebUSB shim differs
 * from a browser's `navigator.usb` in four ways that matter here (TESTING.md
 * sec.9.9 findings 4-6, and sec.11):
 *
 *   - every control transfer takes a TIMEOUT argument, defaulting to 1000 ms
 *     when it is left out (node_modules/usb/dist/index.js:8, :22, :32);
 *   - a STALL rejects, with nusb's "endpoint stalled", instead of resolving
 *     `status: 'stall'` (node-usb-rs src/webusb_device.rs, controlTransferIn);
 *   - the `configuration` getter THROWS "device is not configured" instead of
 *     returning null (webusb_device.rs `configuration`, nusb
 *     `ActiveConfigurationError`);
 *   - a claim the OS refuses because something else holds the interface
 *     rejects with a plain Error, not WebUSB's `NetworkError`.
 *
 * The device below carries the REAL shim functions `usb` installs on every
 * device, `UsbDevice.prototype.controlTransferIn/Out`, so a missing timeout
 * argument shows up here exactly as it would on a camera: as 1000 at the
 * native layer. Only the native layer is faked, and it behaves as
 * node-usb-rs does: bytes on success, a rejection carrying nusb's
 * `TransferError` text otherwise.
 */

import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import {
  OP,
  SeekDevice,
  SeekError,
  USB_COMMIT_TIMEOUT_MS,
  USB_PROBE_TIMEOUT_MS,
  USB_TIMEOUT_MS,
  WINDOW_SIZE,
  runDump,
  type UsbTransport,
  type WebUsbControlSetup,
} from '@seek-fw/core';
import { fakeCamera, type FakeCamera } from '../../core/test/fake-transport.js';
import { NodeUsbBackend, type NodeUsbDevice } from '../src/backend.js';
import { cameraWithFlash, buildSyntheticFlash } from './helpers.js';

type ShimIn = (
  this: unknown,
  setup: WebUsbControlSetup,
  length: number,
  timeout?: number,
) => Promise<{ status: string; data?: DataView }>;
type ShimOut = (
  this: unknown,
  setup: WebUsbControlSetup,
  data: ArrayBufferView,
  timeout?: number,
) => Promise<{ status: string; bytesWritten?: number }>;

/* `require('usb')` loads dist/index.js, which patches the native class's
 * prototype with the WebUSB shim; the class itself is the napi binding. */
const require = createRequire(import.meta.url);
require('usb');
const { UsbDevice } = require('usb/index.js') as {
  UsbDevice: { prototype: { controlTransferIn: ShimIn; controlTransferOut: ShimOut } };
};
const shimIn = UsbDevice.prototype.controlTransferIn;
const shimOut = UsbDevice.prototype.controlTransferOut;

interface NativeCall {
  readonly direction: 'in' | 'out';
  readonly request: number;
  readonly timeout: number;
}

interface NativeOptions {
  /** What the `configuration` getter does. Default: configuration 1. */
  readonly configuration?: () => { configurationValue: number } | null;
  readonly claim?: () => Promise<void>;
  /** Replaces the camera's answer with a native rejection, by request. */
  readonly nativeFailure?: (request: number) => string | null;
}

interface FakeNodeUsb extends NodeUsbDevice {
  readonly native: NativeCall[];
  readonly selected: number[];
}

/** nusb's `TransferError` for a firmware refusal, as node-usb-rs words it. */
function rejectionFor(error: unknown, direction: 'in' | 'out'): Error {
  const verb = direction === 'in' ? 'controlTransferIn' : 'controlTransferOut';
  if (error instanceof SeekError && error.code === 'usb/stalled') {
    return new Error(`${verb} error: endpoint stalled`);
  }
  return new Error(`${verb} error: transfer was cancelled`);
}

/**
 * A node-usb 3.1.0 `UsbDevice` whose firmware is `camera`: the real shim on
 * top, a faithful native layer underneath.
 */
function nodeUsbDevice(camera: FakeCamera, options: NativeOptions = {}): FakeNodeUsb {
  let opened = false;
  const native: NativeCall[] = [];
  const selected: number[] = [];
  const device = {
    native,
    selected,
    vendorId: 0x289d,
    productId: 0x0011,
    manufacturerName: 'Seek Thermal',
    productName: 'Seek Thermal Compact PRO',
    serialNumber: null,
    get configuration(): { configurationValue: number } | null {
      if (options.configuration) return options.configuration();
      return { configurationValue: 1 };
    },
    get opened(): boolean {
      return opened;
    },
    open: async (): Promise<void> => {
      opened = true;
      await camera.open();
    },
    close: async (): Promise<void> => {
      opened = false;
      await camera.close();
    },
    selectConfiguration: (value: number): Promise<void> => {
      selected.push(value);
      return Promise.resolve();
    },
    claimInterface: (): Promise<void> => options.claim?.() ?? Promise.resolve(),
    releaseInterface: (): Promise<void> => Promise.resolve(),
    controlTransferIn: shimIn,
    controlTransferOut: shimOut,
    nativeControlTransferIn: async (
      setup: WebUsbControlSetup,
      timeout: number,
      length: number,
    ): Promise<Uint8Array> => {
      native.push({ direction: 'in', request: setup.request, timeout });
      const forced = options.nativeFailure?.(setup.request) ?? null;
      if (forced !== null) throw new Error(`controlTransferIn error: ${forced}`);
      try {
        return await camera.controlIn(setup.request, length, timeout);
      } catch (error) {
        throw rejectionFor(error, 'in');
      }
    },
    nativeControlTransferOut: async (
      setup: WebUsbControlSetup,
      timeout: number,
      data: Uint8Array,
    ): Promise<number> => {
      native.push({ direction: 'out', request: setup.request, timeout });
      const forced = options.nativeFailure?.(setup.request) ?? null;
      if (forced !== null) throw new Error(`controlTransferOut error: ${forced}`);
      try {
        await camera.controlOut(setup.request, data, timeout);
        return data.length;
      } catch (error) {
        throw rejectionFor(error, 'out');
      }
    },
  };
  return device as unknown as FakeNodeUsb;
}

/** A 4.18.2.0 build block for GetFirmwareInfo selector 0. */
function buildBlock(): Uint8Array {
  const out = new Uint8Array(36);
  out.set([4, 18, 2, 0], 0);
  return out;
}

async function openThroughBackend(
  device: FakeNodeUsb,
  warnings: string[] = [],
): Promise<UsbTransport> {
  const backend = new NodeUsbBackend({
    enumerate: () => Promise.resolve([device]),
    onWarning: (m) => warnings.push(m),
  });
  const [transport] = await backend.listDevices();
  if (transport === undefined) throw new Error('the backend returned no transport');
  await transport.open();
  return transport;
}

describe('usb 3.1.0 itself', () => {
  it('gives a control transfer 1000 ms when the caller passes no timeout', async () => {
    /* The premise of the whole fix, pinned against the installed package. */
    const seen: number[] = [];
    const self = {
      nativeControlTransferIn: (_s: unknown, timeout: number): Promise<Uint8Array> => {
        seen.push(timeout);
        return Promise.resolve(new Uint8Array(4));
      },
    };
    const setup: WebUsbControlSetup = {
      requestType: 'vendor',
      recipient: 'interface',
      request: OP.GET_ERROR_CODE,
      value: 0,
      index: 0,
    };
    await shimIn.call(self, setup, 4);
    await shimIn.call(self, setup, 4, 4321);
    expect(seen).toEqual([1000, 4321]);
  });
});

describe('the CLI transport: timeouts', () => {
  it('hands the usb package the deadline the transport was asked for, on every transfer', async () => {
    /* A window whose tail only small requests get past, so the read uses the
     * first-attempt deadline, the shrink deadline and a commit deadline too. */
    const camera = fakeCamera({
      initialMode: 0,
      fwInfo: new Map([[0, buildBlock()]]),
      stallAt: [{ subcmd: 5, offset: 0x8000, minSize: 128 }],
    });
    const device = nodeUsbDevice(camera);
    const transport = await openThroughBackend(device);
    const asked: { request: number; timeoutMs: number }[] = [];
    const controlIn = transport.controlIn.bind(transport);
    const controlOut = transport.controlOut.bind(transport);
    vi.spyOn(transport, 'controlIn').mockImplementation((request, length, timeoutMs) => {
      asked.push({ request, timeoutMs });
      return controlIn(request, length, timeoutMs);
    });
    vi.spyOn(transport, 'controlOut').mockImplementation((request, data, timeoutMs) => {
      asked.push({ request, timeoutMs });
      return controlOut(request, data, timeoutMs);
    });
    const seek = new SeekDevice(transport);

    await seek.getErrorCode();
    await seek.readWindow({ subcmd: 5, address: 0x14050000, note: 'slot' }, 256);
    await seek.completeMemoryUpgrade(0x1234).catch(() => undefined);

    expect(device.native.map((c) => c.timeout)).toEqual(asked.map((a) => a.timeoutMs));
    expect(device.native.map((c) => c.request)).toEqual(asked.map((a) => a.request));
    const deadlines = new Set(device.native.map((c) => c.timeout));
    expect(deadlines).toEqual(
      new Set([USB_TIMEOUT_MS, USB_PROBE_TIMEOUT_MS, USB_COMMIT_TIMEOUT_MS]),
    );
    expect(device.native.find((c) => c.request === OP.COMPLETE_MEMORY_UPGRADE)?.timeout).toBe(
      USB_COMMIT_TIMEOUT_MS,
    );
    expect(device.native.some((c) => c.timeout === 1000)).toBe(false);
  });

  it('never lets a whole dump fall back to the 1 s default', async () => {
    const synthetic = buildSyntheticFlash();
    const device = nodeUsbDevice(cameraWithFlash(synthetic.flash));
    const transport = await openThroughBackend(device);
    const { modern4x } = await import('@seek-fw/core');
    const result = await runDump(
      {
        device: new SeekDevice(transport),
        profile: modern4x,
        detection: null,
        reporter: { log: () => undefined, progress: () => undefined, artifact: () => undefined },
      },
      { chunk: WINDOW_SIZE, decrypt: false },
    );
    expect(result.windowsRead).toBe(result.windowsExpected);
    expect(device.native.length).toBeGreaterThan(100);
    expect(device.native.every((c) => c.timeout === USB_TIMEOUT_MS)).toBe(true);
  }, 60_000);

  it('reports the host cancelling a transfer at its deadline as a timeout', async () => {
    const camera = fakeCamera({ initialMode: 0 });
    const device = nodeUsbDevice(camera, {
      nativeFailure: (request) => (request === OP.GET_ERROR_CODE ? 'transfer was cancelled' : null),
    });
    const transport = await openThroughBackend(device);
    const error = await transport.controlIn(OP.GET_ERROR_CODE, 4, 2500).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('usb/timeout');
    expect((error as SeekError).message).toContain('2500 ms');
  });
});

describe('the CLI transport: refusals', () => {
  it('reports a firmware stall as usb/stalled, as the browser does, in both directions', async () => {
    /* No GetFirmwareInfo payload, so the fake camera stalls it; 0x99 is no
     * command at all, so the OUT stalls too. */
    const device = nodeUsbDevice(fakeCamera({ initialMode: 0 }));
    const transport = await openThroughBackend(device);

    const inError = await transport
      .controlIn(OP.GET_FIRMWARE_INFO, 36, 5000)
      .catch((e: unknown) => e);
    expect(inError).toBeInstanceOf(SeekError);
    expect((inError as SeekError).code).toBe('usb/stalled');

    const outError = await transport
      .controlOut(0x99, new Uint8Array([1, 0]), 5000)
      .catch((e: unknown) => e);
    expect(outError).toBeInstanceOf(SeekError);
    expect((outError as SeekError).code).toBe('usb/stalled');
  });

  it('still reports a transfer that failed for another reason as a transfer failure', async () => {
    const device = nodeUsbDevice(fakeCamera({ initialMode: 0 }), {
      nativeFailure: () => 'device disconnected',
    });
    const transport = await openThroughBackend(device);
    const error = await transport.controlIn(OP.GET_ERROR_CODE, 4, 5000).catch((e: unknown) => e);
    expect((error as SeekError).code).toBe('usb/transfer-failed');
    expect((error as SeekError).message).toContain('device disconnected');
  });
});

describe('the CLI transport: an unconfigured device', () => {
  it('selects configuration 1 when the getter throws "device is not configured"', async () => {
    let configured = false;
    const device = nodeUsbDevice(fakeCamera({ initialMode: 0 }), {
      configuration: () => {
        if (!configured) throw new Error('configuration error: device is not configured');
        return { configurationValue: 1 };
      },
    });
    const original = device.selectConfiguration.bind(device);
    device.selectConfiguration = async (value: number): Promise<void> => {
      await original(value);
      configured = true;
    };

    const transport = await openThroughBackend(device);
    expect(device.selected).toEqual([1]);
    await expect(transport.controlIn(OP.GET_ERROR_CODE, 4, 5000)).resolves.toBeInstanceOf(
      Uint8Array,
    );
  });

  it('does not mistake any other configuration error for an unconfigured device', async () => {
    const device = nodeUsbDevice(fakeCamera({ initialMode: 0 }), {
      configuration: () => {
        throw new Error('configuration error: no descriptor found for active configuration 2');
      },
    });
    const backend = new NodeUsbBackend({ enumerate: () => Promise.resolve([device]) });
    const [transport] = await backend.listDevices();
    await expect(transport?.open()).rejects.toThrow(
      /no descriptor found for active configuration 2/,
    );
    expect(device.selected).toEqual([]);
  });
});

describe('the CLI transport: a claim the OS refused', () => {
  it('falls back, and says so, when another driver or program holds the interface', async () => {
    for (const message of [
      /* nusb 0.2.7, macOS (kIOReturnExclusiveAccess) and Linux (EBUSY) */
      'claimInterface error: could not open interface for exclusive access (error 0xe00002c5)',
      'claimInterface error: interface is busy (errno 16)',
    ]) {
      const warnings: string[] = [];
      const device = nodeUsbDevice(fakeCamera({ initialMode: 0 }), {
        claim: () => Promise.reject(new Error(message)),
      });
      const transport = await openThroughBackend(device, warnings);
      expect(transport.info.recipient, message).toBe('device');
      expect(transport.info.recipientFallback, message).toContain(message);
      expect(warnings, message).toHaveLength(1);
    }
  });

  it('does not fall back when the interface is simply not there', async () => {
    const device = nodeUsbDevice(fakeCamera({ initialMode: 0 }), {
      claim: () => Promise.reject(new Error('claimInterface error: interface not found')),
    });
    const backend = new NodeUsbBackend({ enumerate: () => Promise.resolve([device]) });
    const [transport] = await backend.listDevices();
    const error = await transport?.open().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('usb/not-open');
    expect(device.native).toHaveLength(0);
  });
});

describe('the CLI transport: a string the device cannot produce', () => {
  /* node-usb-rs v3.1.0's string getters: the OS's copy, else nusb's
   * get_string_descriptor, whose failure THROWS (TESTING.md sec.21.1). These are
   * its four messages: the bench Compact 1.3.0.0's, a stalled string, nusb's
   * 100 ms deadline, and the implicit open that precedes the read. */
  const FAILURES = [
    'getString error: invalid descriptor',
    'getString error: endpoint stalled',
    'getString error: transfer was cancelled',
    'open error: could not open device',
  ];

  function withThrowingString(
    name: 'serialNumber' | 'productName' | 'manufacturerName',
    message: string,
  ): { device: FakeNodeUsb; reads: () => number } {
    const device = nodeUsbDevice(fakeCamera({ initialMode: 0 }));
    let reads = 0;
    Object.defineProperty(device, name, {
      get(): never {
        reads++;
        throw new Error(message);
      },
    });
    return { device, reads: () => reads };
  }

  it('reads a serial string node-usb cannot produce as null, as WebUSB does', async () => {
    for (const message of FAILURES) {
      const { device, reads } = withThrowingString('serialNumber', message);
      const backend = new NodeUsbBackend({ enumerate: () => Promise.resolve([device]) });
      const [transport] = await backend.listDevices();
      expect(transport?.description, message).toMatchObject({
        serialNumber: null,
        productName: 'Seek Thermal Compact PRO',
        manufacturerName: 'Seek Thermal',
      });
      /* ...asked once, however often the description is read. */
      expect(transport?.description.serialNumber, message).toBeNull();
      expect(transport?.description.serialNumber, message).toBeNull();
      expect(reads(), message).toBe(1);
    }
  });

  it('does the same for the product and manufacturer strings', async () => {
    for (const name of ['productName', 'manufacturerName'] as const) {
      const { device } = withThrowingString(name, 'getString error: invalid descriptor');
      const backend = new NodeUsbBackend({ enumerate: () => Promise.resolve([device]) });
      const [transport] = await backend.listDevices();
      expect(transport?.description[name], name).toBeNull();
    }
  });

  it('still throws anything that is not one of those two failures', async () => {
    const { device } = withThrowingString('serialNumber', 'something else entirely');
    const backend = new NodeUsbBackend({ enumerate: () => Promise.resolve([device]) });
    const [transport] = await backend.listDevices();
    expect(() => transport?.description).toThrow('something else entirely');
  });

  it('lets `seek-fw devices` list the camera instead of exiting 1', async () => {
    const { run } = await import('../src/cli.js');
    const { testIo } = await import('./helpers.js');
    const { device } = withThrowingString('serialNumber', 'getString error: invalid descriptor');
    const { io, stdout, stderr } = testIo({
      backend: (options) =>
        new NodeUsbBackend({ ...options, enumerate: () => Promise.resolve([device]) }),
    });
    const code = await run(['devices', '--json'], io, new AbortController().signal);
    expect(code, stderr.text).toBe(0);
    expect(JSON.parse(stdout.text)).toMatchObject({
      ok: true,
      count: 1,
      devices: [{ serialNumber: null, productName: 'Seek Thermal Compact PRO' }],
    });
  });
});

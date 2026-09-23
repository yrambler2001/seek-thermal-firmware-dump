/* ==================================================================== *
 * One recipient per session, never switched silently, and a manifest that
 * records the transport the windows were really read over.
 *
 * `WebUsbTransport` with recipient 'auto' used to catch ANY claimInterface
 * rejection and quietly switch every vendor request to device recipient,
 * telling only an optional `onWarning`; and it decided again on every open(),
 * which `runDump` calls after a failed window, so one dump could change
 * recipient half way through. The dump manifest could not show either: the
 * transport was closed before the manifest was built, so `claimedInterface`
 * was always false (TESTING.md sec.9.9, findings 1-3).
 *
 * These run the REAL transport over a WebUSB-shaped device whose firmware is
 * core's fake camera, so what is asserted is what a front end would record.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';

import { SeekError } from '../src/errors.js';
import { collectingReporter, silentReporter, type Reporter } from '../src/events.js';
import { SeekDevice } from '../src/protocol/client.js';
import { OP } from '../src/protocol/ops.js';
import {
  WebUsbTransport,
  type WebUsbControlSetup,
  type WebUsbDevice,
  type WebUsbInTransferResult,
  type WebUsbOutTransferResult,
} from '../src/protocol/webusb.js';
import { FLASH_BASE, modern4x } from '../src/profiles/modern-4x.js';
import { runDump } from '../src/workflows/dump.js';
import { runSweep } from '../src/workflows/sweep.js';
import type { WorkflowContext } from '../src/workflows/types.js';
import { fakeCamera, type FakeCamera, type StallPoint } from './fake-transport.js';

/** `GetFirmwareInfo` selector 0 of a 4.18.2.0 build. */
function buildBlock(): Uint8Array {
  const out = new Uint8Array(36);
  out.set([4, 18, 2, 0], 0);
  out.set(new TextEncoder().encode('Feb 13 2020'), 4);
  return out;
}

/** A camera running the modern table and reporting 4.18.2.0. */
function modernCamera(stallAt: readonly StallPoint[] = []): FakeCamera {
  return fakeCamera({
    initialMode: 0,
    windows: modern4x
      .windowMap()
      .map((entry) => ({ subcmd: entry.subcmd, offset: entry.address - FLASH_BASE })),
    fwInfo: new Map([[0, buildBlock()]]),
    stallAt,
  });
}

/** The WebUSB spec's own name for "the platform would not give us the interface". */
function platformRefusal(): Error {
  return new DOMException(
    "Failed to execute 'claimInterface' on 'USBDevice': Unable to claim interface.",
    'NetworkError',
  );
}

interface WebUsbCamera extends WebUsbDevice {
  readonly setups: WebUsbControlSetup[];
  claims: number;
}

/**
 * A WebUSB device whose firmware is `camera`. A stall resolves `status:
 * 'stall'`, as a browser reports it; `claim` decides each claimInterface().
 */
function webUsbOver(
  camera: FakeCamera,
  claim: (attempt: number) => Promise<void> = () => Promise.resolve(),
): WebUsbCamera {
  let opened = false;
  const out: WebUsbCamera = {
    setups: [],
    claims: 0,
    vendorId: 0x289d,
    productId: 0x0011,
    manufacturerName: 'Seek Thermal',
    productName: 'Compact PRO',
    serialNumber: null,
    configuration: { configurationValue: 1 },
    get opened(): boolean {
      return opened;
    },
    open: async () => {
      opened = true;
      await camera.open();
    },
    close: async () => {
      opened = false;
      await camera.close();
    },
    selectConfiguration: () => Promise.resolve(),
    claimInterface: () => {
      out.claims += 1;
      return claim(out.claims);
    },
    releaseInterface: () => Promise.resolve(),
    controlTransferIn: async (setup, length): Promise<WebUsbInTransferResult> => {
      out.setups.push(setup);
      try {
        const data = await camera.controlIn(setup.request, length, 0);
        return { status: 'ok', data: new DataView(data.buffer, data.byteOffset, data.byteLength) };
      } catch (error) {
        if (error instanceof SeekError && error.code === 'usb/stalled') return { status: 'stall' };
        throw error;
      }
    },
    controlTransferOut: async (setup, data): Promise<WebUsbOutTransferResult> => {
      out.setups.push(setup);
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      try {
        await camera.controlOut(setup.request, bytes, 0);
        return { status: 'ok', bytesWritten: bytes.length };
      } catch (error) {
        if (error instanceof SeekError && error.code === 'usb/stalled') return { status: 'stall' };
        throw error;
      }
    },
  };
  return out;
}

function contextOver(
  transport: WebUsbTransport,
  reporter: Reporter = silentReporter,
): WorkflowContext {
  return {
    device: new SeekDevice(transport, { reporter }),
    profile: modern4x,
    detection: null,
    reporter,
  };
}

describe('recipient auto: which claim failure falls back', () => {
  it('falls back to device recipient only when the platform refused the claim', async () => {
    const warnings: string[] = [];
    const device = webUsbOver(modernCamera(), () => Promise.reject(platformRefusal()));
    const transport = new WebUsbTransport(device, { onWarning: (m) => warnings.push(m) });
    await transport.open();
    await transport.controlIn(OP.GET_ERROR_CODE, 4, 1000);

    expect(transport.info.recipient).toBe('device');
    expect(transport.info.claimedInterface).toBe(false);
    expect(transport.info.recipientFallback).toMatch(/Unable to claim interface/);
    expect(warnings).toHaveLength(1);
    expect(device.setups[0]).toMatchObject({ recipient: 'device', index: 0 });
  });

  it('does not fall back for a claim that failed for any other reason', async () => {
    /* A missing interface, an unconfigured or closed device, a disconnect: none
     * of those is "another driver holds it", and device recipient would only
     * hide them. Each is an error, and nothing is sent. */
    for (const cause of [
      new DOMException('no interface 0', 'NotFoundError'),
      new DOMException('the device is not configured', 'InvalidStateError'),
      new Error('Access denied'),
      new Error('claimInterface error: device disconnected'),
    ]) {
      const device = webUsbOver(modernCamera(), () => Promise.reject(cause));
      const transport = new WebUsbTransport(device, { recipient: 'auto' });
      const error = await transport.open().then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, cause.message).toBeInstanceOf(SeekError);
      expect((error as SeekError).code, cause.message).toBe('usb/not-open');
      expect((error as SeekError).message).toContain(cause.message);
      expect(transport.isOpen, cause.message).toBe(false);
      expect(device.setups, cause.message).toHaveLength(0);
    }
  });
});

describe('recipient auto: decided once per session', () => {
  it('does not switch to device recipient when a reopen cannot re-claim', async () => {
    const device = webUsbOver(modernCamera(), (attempt) =>
      attempt === 1 ? Promise.resolve() : Promise.reject(platformRefusal()),
    );
    const transport = new WebUsbTransport(device, { recipient: 'auto' });
    await transport.open();
    expect(transport.info.recipient).toBe('interface');
    await transport.close();

    const error = await transport.open().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('usb/not-open');
    expect((error as SeekError).message).toMatch(/does not switch recipient/);
    expect(transport.info.recipient).toBe('interface');
    expect(transport.info.recipientFallback).toBeNull();
  });

  it('stays on device recipient after a fallback, even when a later claim would work', async () => {
    const device = webUsbOver(modernCamera(), (attempt) =>
      attempt === 1 ? Promise.reject(platformRefusal()) : Promise.resolve(),
    );
    const transport = new WebUsbTransport(device, {
      recipient: 'auto',
      onWarning: () => undefined,
    });
    await transport.open();
    const reason = transport.info.recipientFallback;
    expect(transport.info.recipient).toBe('device');
    await transport.close();
    await transport.open();
    await transport.controlIn(OP.GET_ERROR_CODE, 4, 1000);

    expect(transport.info.recipient).toBe('device');
    expect(transport.info.recipientFallback).toBe(reason);
    expect(device.setups.every((s) => s.recipient === 'device')).toBe(true);
  });

  it('fails a dump whose retry could not re-claim, instead of finishing it on another recipient', async () => {
    /* A window that serves nothing makes runDump close and reopen between
     * attempts. The old transport re-decided there and carried on as device
     * recipient; the dump now stops with the claim failure. */
    const camera = modernCamera([{ subcmd: 5, offset: 0 }]);
    const device = webUsbOver(camera, (attempt) =>
      attempt === 1 ? Promise.resolve() : Promise.reject(platformRefusal()),
    );
    const transport = new WebUsbTransport(device, { recipient: 'auto' });
    await transport.open();

    const error = await runDump(contextOver(transport), {
      chunk: 4096,
      decrypt: false,
      retries: 1,
      retryDelayMs: 0,
    }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('usb/not-open');
    expect(device.setups.length).toBeGreaterThan(0);
    expect(device.setups.every((s) => s.recipient === 'interface')).toBe(true);
  }, 60_000);
});

describe('what a dump manifest says about its transport', () => {
  it('records that interface 0 was claimed, although the dump closes the transport first', async () => {
    const device = webUsbOver(modernCamera());
    const transport = new WebUsbTransport(device, { recipient: 'auto' });
    await transport.open();

    const result = await runDump(contextOver(transport), { chunk: 4096, decrypt: false });

    expect(transport.isOpen).toBe(false);
    expect(result.manifest.transport.recipient).toBe('interface');
    expect(result.manifest.transport.claimedInterface).toBe(true);
    expect(result.manifest.transport.recipientFallback).toBeNull();
  }, 60_000);

  it('records the same for a sweep', async () => {
    const device = webUsbOver(modernCamera());
    const transport = new WebUsbTransport(device, { recipient: 'auto' });
    await transport.open();
    const ctx = {
      ...contextOver(transport),
      profile: { ...modern4x, sweepRange: [1, 3] as const },
    };

    const result = await runSweep(ctx, { chunk: 4096, decrypt: false });

    expect(transport.isOpen).toBe(false);
    expect(result.manifest.transport.claimedInterface).toBe(true);
    expect(result.manifest.transport.recipientFallback).toBeNull();
  }, 60_000);

  it('records a fallback, and says so in the log, with no onWarning passed', async () => {
    const reporter = collectingReporter();
    const device = webUsbOver(modernCamera(), () => Promise.reject(platformRefusal()));
    const transport = new WebUsbTransport(device, { recipient: 'auto' });
    await transport.open();

    const result = await runDump(contextOver(transport, reporter), { chunk: 4096, decrypt: false });

    expect(result.manifest.transport.recipient).toBe('device');
    expect(result.manifest.transport.claimedInterface).toBe(false);
    expect(result.manifest.transport.recipientFallback).toMatch(/Unable to claim interface/);
    const warned = reporter.events.filter(
      (e) => e.type === 'log' && e.level === 'warn' && e.message.includes('recipient=device'),
    );
    expect(warned.length).toBeGreaterThan(0);
  }, 60_000);
});

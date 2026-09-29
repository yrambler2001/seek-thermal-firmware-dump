/* ==================================================================== *
 * The real hosts' give-up, on emulated cameras (TESTING.md sec.22).
 *
 * Every other emulator suite gives a transfer the firmware never completes up
 * after 200 ms of the camera's time (the `budget` host model, sec.19.3): a cost
 * decision, not a host. Here the emulated host gives up exactly as the two
 * real ones do, from their source (webusb-over-usbip.ts `HostModel`):
 *
 *  - `nusb`, the CLI: cancelled at exactly the deadline the transport passes;
 *  - `chrome`, the web app: never cancelled; the transport's own timer, on the
 *    camera's clock, is the only deadline.
 *
 * WHAT IS CHECKED.
 *  1. The two models on a request the firmware really answers late: Compact XR
 *     4.8.2.1's GetFirmwareInfo(6), a whole-image key probe (~1.9 s at the
 *     500 kHz idle clock, FW-V1 Phase 45), sent with the toolkit's shortest
 *     deadline, USB_PROBE_TIMEOUT_MS (1.5 s). No toolkit operation sends it;
 *     it is here because it is the one request in the corpus that outlasts a
 *     deadline and still completes, so it shows each model doing what its host
 *     does.
 *  2. The toolkit's operations that can take longest - `info`, and the flash
 *     path whose CompleteMemoryUpgrade erases, programs and verifies inside the
 *     transfer - under both real give-ups: the web app's (core workflows,
 *     `chrome`) and the CLI's (`run()` through node-usb, `nusb`), on the builds
 *     whose commit is longest on the emulator. Nothing may be given up and no
 *     deadline may fire.
 * ==================================================================== */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import {
  keyFilenameSuffix,
  OP,
  readDeviceInfo,
  SeekDevice,
  type SeekError,
  silentReporter,
  getProfile,
  u16Payload,
  USB_PROBE_TIMEOUT_MS,
  WebUsbTransport,
  bootedSlot,
  prepareImage,
  writeFirmware,
  type UsbBackend,
} from '@seek-fw/core';
import { liveEmulatorCount, RowEmulators } from '../../core/test/emulator/harness.js';
import {
  announceSkip,
  BOOT_TIMEOUT_MS,
  EMU_DIR,
  ENTRIES,
  URB_TIMEOUT_MS,
} from '../../core/test/emulator/suite.js';
import type {
  HostModel,
  TransferTrace,
  UsbIpWebUsbDevice,
} from '../../core/test/emulator/webusb-over-usbip.js';
import { NodeUsbBackend, type BackendOptions } from '../src/backend.js';
import { run } from '../src/cli.js';
import { EXIT_OK } from '../src/errors.js';
import { tempDir, testIo } from './helpers.js';
import { nodeUsbOverUsbIp } from './node-usb-over-usbip.js';

const XR = 'compact_xr/2020.02.26-11.23.26-4.8.2.1/1F1660P7U967/dump';
const COMPACT = 'compact/2020.02.26-11.23.26-4.8.2.1/2229A0YZ7E28/dump';
const COMPACT_4819 =
  'compact/2018.10.11-16.36.37-4.8.1.9/no-serial/32k_43x0_8hz_4.8.1.9_compact_oct_11_2018_16-36-37_99.28_yrambler2001_firmware';
const TIMEOUT_MS = Number(process.env.SEEK_EMU_GIVEUP_TIMEOUT_MS ?? '900000');
const NS_PER_MS = 1_000_000;

const available =
  EMU_DIR !== null && [XR, COMPACT, COMPACT_4819].every((id) => ENTRIES.some((e) => e.id === id));
if (!available) announceSkip("the real hosts' give-up (TESTING.md sec.22)");

function transportOver(device: UsbIpWebUsbDevice): WebUsbTransport {
  return new WebUsbTransport(device, {
    recipient: 'auto',
    api: 'usbip (emulator)',
    host: 'vitest',
    clock: device.deadlineClock,
  });
}

const ms = (t: TransferTrace): number => (t.endNs - t.startNs) / NS_PER_MS;

/** The slow key probe under one model: what the transport reported, and its transfer. */
async function slowProbe(model: HostModel): Promise<{
  error: unknown;
  probe: TransferTrace;
  after: Uint8Array;
  reopens: number;
  fired: number;
  gaveUp: number;
}> {
  const row = new RowEmulators(XR);
  const traces: TransferTrace[] = [];
  try {
    const emu = await row.start(EMU_DIR!, { entryId: XR, readyTimeoutMs: BOOT_TIMEOUT_MS });
    const out = await row.guard(emu, async () => {
      const device = await emu.attach({
        urbTimeoutMs: URB_TIMEOUT_MS,
        hostModel: model,
        onTransfer: (t) => traces.push(t),
      });
      const transport = transportOver(device);
      await transport.open();
      const seek = new SeekDevice(transport);
      await seek.rpcOut(OP.SET_FIRMWARE_INFO_FEATURES, u16Payload(6));
      const error = await seek
        .rpcIn(OP.GET_FIRMWARE_INFO, 64, USB_PROBE_TIMEOUT_MS)
        .then(() => null)
        .catch((e: unknown) => e);
      const probe = traces.findLast((t) => t.bRequest === OP.GET_FIRMWARE_INFO);
      /* ...and the camera is still there: the next request is answered. */
      const after = await seek.rpcIn(OP.GET_FIRMWARE_INFO, 36);
      await transport.close();
      return { error, probe: probe!, after, reopens: device.reopens };
    });
    await row.assertDelivery();
    const { clock } = row.totals();
    return { ...out, fired: clock.deadlinesFired, gaveUp: clock.hostGiveUps };
  } finally {
    await row.finish();
  }
}

describe.skipIf(!available)("the real hosts' give-up on emulated cameras (sec.22)", () => {
  afterAll(() => {
    expect(liveEmulatorCount(), 'every emulator this file started was stopped').toBe(0);
  });

  it(
    'gives a late answer up as each real host does: nusb cancels at the deadline, Chrome never does',
    { timeout: TIMEOUT_MS },
    async () => {
      const [nusb, chrome] = await Promise.all([slowProbe('nusb'), slowProbe('chrome')]);

      /* nusb: the emulated host cancelled at exactly 1.5 s of the camera's time (to
       * one microframe), and the transport reported its own timeout. */
      expect(nusb.probe.outcome).toBe('host-gave-up');
      expect(nusb.probe.hostDeadlineMs).toBe(USB_PROBE_TIMEOUT_MS);
      expect(ms(nusb.probe)).toBeGreaterThanOrEqual(USB_PROBE_TIMEOUT_MS);
      expect(ms(nusb.probe)).toBeLessThan(USB_PROBE_TIMEOUT_MS + 0.125);
      expect((nusb.error as SeekError).code).toBe('usb/timeout');
      expect(nusb.gaveUp).toBe(1);

      /* Chrome: nobody cancelled; the firmware finished the probe well past the
       * deadline, and the transport had given up at 1.5 s all the same. */
      expect(chrome.probe.outcome).toBe('ok');
      expect(ms(chrome.probe)).toBeGreaterThan(USB_PROBE_TIMEOUT_MS);
      expect((chrome.error as SeekError).code).toBe('usb/timeout');
      expect(chrome.gaveUp).toBe(0);

      /* Both: the transport's deadline fired once and it reopened the device. */
      for (const host of [nusb, chrome]) {
        expect(host.fired).toBe(1);
        expect(host.reopens).toBe(1);
      }
      /* WHAT THE NEXT REQUEST GETS. Under Chrome the probe's answer was taken off the
       * pipe with the probe, and the next read is the build block. Under nusb the
       * cancel came while the firmware was still inside its USB interrupt working on
       * the probe; when it finished it queued the probe's one-byte answer (02, FW-V1
       * `probe_pair_watchdog`), and the NEXT request's data stage took it. A real CLI
       * host would read exactly that. The toolkit sends no request that outlasts its
       * deadline (sec.22.3), so no toolkit read can meet this. */
      expect([...chrome.after.subarray(0, 4)]).toEqual([4, 8, 2, 1]);
      expect([...nusb.after]).toEqual([2]);
    },
  );

  it(
    "the web app's info and flash commit finish inside Chrome's give-up (Compact 4.8.2.1, 4.8.1.9)",
    { timeout: TIMEOUT_MS },
    async () => {
      await Promise.all(
        [COMPACT, COMPACT_4819].map(async (entryId) => {
          const row = new RowEmulators(entryId);
          const traces: TransferTrace[] = [];
          try {
            const emu = await row.start(EMU_DIR!, { entryId, readyTimeoutMs: BOOT_TIMEOUT_MS });
            await row.guard(emu, async () => {
              const device = await emu.attach({
                urbTimeoutMs: URB_TIMEOUT_MS,
                hostModel: 'chrome',
                onTransfer: (t) => traces.push(t),
              });
              const transport = transportOver(device);
              await transport.open();
              const ctx = {
                device: new SeekDevice(transport),
                profile: getProfile('modern-4x'),
                detection: null,
                reporter: silentReporter,
              };
              const state = await readDeviceInfo(ctx);
              expect(state.canFlash, state.flashBlockedBy.join('; ')).toBe(true);
              const running = bootedSlot(state);
              expect(running?.plain, 'the running image, decrypted').toBeTruthy();
              if (!running?.plain || !state.keyTable) return;
              const name = `same${keyFilenameSuffix(state.keyTable.keyA, state.keyTable.keyB)}.bin`;
              await writeFirmware(ctx, state, prepareImage(state, running.plain, name));
              await transport.close();
            });
            await row.assertDelivery();
            const { clock } = row.totals();
            expect(clock.hostGiveUps, entryId).toBe(0);
            expect(clock.deadlinesFired, entryId).toBe(0);
            const commit = traces.find((t) => t.bRequest === OP.COMPLETE_MEMORY_UPGRADE);
            expect(commit?.outcome).toBe('ok');
            expect(traces.every((t) => t.outcome === 'ok' || t.outcome === 'stall')).toBe(true);
          } finally {
            await row.finish();
          }
        }),
      );
    },
  );

  it(
    "the CLI's info and flash through node-usb finish inside nusb's give-up (Compact XR 4.8.2.1)",
    { timeout: TIMEOUT_MS },
    async () => {
      const row = new RowEmulators(XR);
      const out = await tempDir();
      const traces: TransferTrace[] = [];
      try {
        const emu = await row.start(EMU_DIR!, { entryId: XR, readyTimeoutMs: BOOT_TIMEOUT_MS });
        await row.guard(emu, async () => {
          const usbip = await emu.attach({
            urbTimeoutMs: URB_TIMEOUT_MS,
            hostModel: 'nusb',
            onTransfer: (t) => traces.push(t),
          });
          /* The image to write back: the camera's own running application. */
          const transport = transportOver(usbip);
          await transport.open();
          const state = await readDeviceInfo({
            device: new SeekDevice(transport),
            profile: getProfile('modern-4x'),
            detection: null,
            reporter: silentReporter,
          });
          await transport.close();
          const plain = bootedSlot(state)?.plain;
          if (!plain || !state.keyTable) throw new Error('no running image to write back');
          const image = path.join(
            out.path,
            `xr${keyFilenameSuffix(state.keyTable.keyA, state.keyTable.keyB)}.bin`,
          );
          writeFileSync(image, plain);

          const device = await nodeUsbOverUsbIp(usbip);
          const backend = (options: BackendOptions): UsbBackend =>
            new NodeUsbBackend({
              ...options,
              enumerate: () => Promise.resolve([device]),
              clock: usbip.deadlineClock,
            });
          for (const argv of [
            ['info', '--json'],
            ['flash', image, '--yes', '--no-rescue-dump', '--out', out.path, '--json'],
          ]) {
            const { io, stderr } = testIo({ backend });
            const code = await run(argv, io, new AbortController().signal);
            expect(code, `${argv[0] ?? ''}: ${stderr.text}`).toBe(EXIT_OK);
          }
        });
        await row.assertDelivery();
        const { clock } = row.totals();
        expect(clock.hostGiveUps).toBe(0);
        expect(clock.deadlinesFired).toBe(0);
        const commit = traces.find((t) => t.bRequest === OP.COMPLETE_MEMORY_UPGRADE);
        expect(commit?.outcome).toBe('ok');
        expect(commit?.hostDeadlineMs, 'nusb is handed the 20 s commit deadline').toBe(20_000);
      } finally {
        await row.finish();
        await out.cleanup();
      }
    },
  );
});

/* ==================================================================== *
 * The camera's restart, end to end, on real WebUSB — READ-ONLY —
 * `npm run e2e:camera:restart`.
 *
 * Step 02 reboots the camera only when its reader probe finds a dead reader,
 * and on stock firmware it never does, so `e2e:camera` never sees a restart.
 * This run makes the page SEE one: the write guard's test-only fault answers
 * the first 26 of step 02's reader-probe reads (28-byte IN 0x4F — the probe's
 * whole budget, `openProbedSession` in packages/core/src/preservation/
 * pipeline.ts) with `status: 'stall'`, unsent — exactly what a dead reader
 * answers on the wire (TESTING.md sec. 28.4). From there it is all the app's
 * own code: the probe gives up, reboots the camera by its own plain
 * ResetDevice (u16 0), the camera leaves the bus and comes back as a new
 * device, the page asks "Your turn", the test answers Electron's chooser, and
 * the step carries on with real reads. Every later read is real.
 *
 * The guards are those of `camera.e2e.ts`, unchanged, plus a budget: exactly
 * ONE reset may go out. Anything beyond "plain reset, re-enumerate, re-pick,
 * continue" fails the run — a second reset is refused unsent, and any ask but
 * the Connect pick stops it.
 *
 * It also measures what Electron does across a real re-enumeration: whether
 * the page gets a `disconnect` and a `connect`, what `getDevices()` answers
 * while the camera is gone and back, and whether the camera comes back under
 * a new device id.
 * ==================================================================== */

import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BOOT_CONFIG_BYTES } from '../packages/core/src/preservation/windows.js';
import { OP } from '../packages/core/src/protocol/ops.js';
import { say } from './lib/browser.js';
import {
  NEVER_ON_THE_WIRE,
  checkDumpArchive,
  checkStep02RunFile,
  checkStep03Offered,
} from './lib/camera-flow.js';
import { describeWire, wireSince } from './lib/checks.js';
import {
  checkGuardAndConnect,
  closeCameraSession,
  countsOf,
  guardOf,
  openCameraSession,
  setGuard,
  type CameraSession,
} from './lib/electron-camera.js';
import { electronBinary } from './lib/electron.js';
import { cameraBusyReason } from './lib/preflight.js';
import type { WriteGuardControl } from './lib/write-guard.js';

const SCRATCH =
  process.env.SEEK_E2E_SCRATCH ?? path.join(tmpdir(), `seek-e2e-restart-${String(process.pid)}`);
const KEEP = process.env.SEEK_E2E_KEEP === '1';
const HEADED = process.env.SEEK_E2E_HEADED === '1';

/** `openProbedSession`'s probe: 26 reads, 20 ms apart, before it reboots. */
const PROBE_READS = 26;

function unavailable(): string | null {
  if (electronBinary() === null) return 'the electron package is not installed';
  return cameraBusyReason();
}

const UNAVAILABLE = unavailable();
if (UNAVAILABLE !== null)
  process.stderr.write(`\n[skip] e2e restart on the camera: ${UNAVAILABLE}\n`);

describe.skipIf(UNAVAILABLE !== null)(
  'the camera restarts in step 02 on real WebUSB (Electron), read-only',
  () => {
    let session: CameraSession | null = null;

    const need = (): CameraSession => {
      if (session === null) throw new Error('Electron is not up (an earlier step failed)');
      return session;
    };

    beforeAll(async () => {
      session = await openCameraSession(SCRATCH, HEADED);
    });

    afterAll(async () => {
      await closeCameraSession(session, SCRATCH, KEEP);
    });

    it('connects, and Dump & decrypt reads the camera', async () => {
      const { app, wizard } = need();
      await checkGuardAndConnect(need());
      const dump = await wizard.dumpAndDecrypt(20 * 60_000);
      checkDumpArchive(dump);
      expect((await guardOf(app.page)).refusals).toEqual([]);
    });

    it('step 02 meets a dead reader: the app reboots the camera, asks for it, and finishes', async () => {
      const { app, wizard } = need();
      await wizard.openPreserve();
      const before = await guardOf(app.page);
      const startedAt = Date.now();
      await setGuard(app.page, {
        allowReset: true,
        resetBudget: 1,
        fault: {
          request: OP.GET_FEATURED_FIRMWARE_DATA,
          length: BOOT_CONFIG_BYTES,
          remaining: PROBE_READS,
        },
      });
      let after: WriteGuardControl;
      let run;
      try {
        run = await wizard.runPhase('read-build', { confirm: false, timeoutMs: 30 * 60_000 });
        after = await guardOf(app.page);
      } finally {
        await setGuard(app.page, { allowReset: false, resetBudget: null, fault: null });
      }

      /* The fault: exactly the probe's budget, all spent on the first probe. */
      expect(after.injected).toHaveLength(PROBE_READS);
      expect(after.fault?.remaining).toBe(0);
      /* Exactly one reset went out, the plain one, and the wire answered it. */
      expect(after.resets).toHaveLength(1);
      say(`the reset: ${after.resets.map((r) => r.outcome).join('; ')}`);
      const wire = wireSince(countsOf(before), countsOf(after));
      say(`step 02 wire: ${describeWire(wire)}`);
      expect(wire.get('out 0x59')).toBe(1);
      for (const op of NEVER_ON_THE_WIRE) expect(wire.has(op), op).toBe(false);
      expect(after.refusals).toEqual([]);

      /* The page's view of the restart: the calm blue ask, answered once. */
      expect(run.asks).toBe(1);
      expect(run.askViews[0]?.tone).toBe('info');
      expect(run.askViews[0]?.redAlerts).toEqual([]);

      /* WHAT ELECTRON DID, measured on the page across the re-enumeration. */
      const resetAt = after.resets[0]?.at ?? startedAt;
      const events = after.usbEvents.filter((e) => e.at >= startedAt);
      const calls = after.getDevicesCalls.filter((c) => c.at >= resetAt);
      say(
        `usb events: ${events.map((e) => `${e.type} +${String(e.at - resetAt)}ms`).join(', ') || 'none'}; ` +
          `getDevices() after the reset: ${calls.map((c) => `${String(c.devices)} +${String(c.at - resetAt)}ms`).join(', ')}`,
      );
      expect(events.map((e) => e.type)).toEqual(['disconnect']);
      const gone = events[0]?.at ?? resetAt;
      expect(calls.some((c) => c.at >= gone && c.devices === 0)).toBe(true);
      expect(calls.at(-1)?.devices).toBe(1);
      const ids = app.devicesSeen.filter((d) => d.vendorId === 0x289d).map((d) => d.deviceId);
      say(`the camera's device ids across the run: ${ids.join(' -> ')}`);
      expect(new Set(ids).size).toBeGreaterThanOrEqual(2);

      const log = await wizard.text('#preserve-phase-read-build-log');
      const around = log
        .split('\n')
        .filter((line) =>
          /reader probe|reboot command|restart|Your turn|back|re-adopted|did not open|disconnected/i.test(
            line,
          ),
        );
      say(`step 02 log around the reset:\n  ${around.join('\n  ')}`);

      const state = checkStep02RunFile(run);
      say(
        `run ${state.runId}: firmware ${state.expectedVersion ?? '?'}, next step ${state.nextStep}`,
      );
    });

    it('Dump & decrypt again: the reboot changed nothing on the camera', async () => {
      const { app, wizard } = need();
      const before = countsOf(await guardOf(app.page));
      const dump = await wizard.dumpAndDecrypt(20 * 60_000);
      const wire = wireSince(before, countsOf(await guardOf(app.page)));
      checkDumpArchive(dump);
      for (const op of [...NEVER_ON_THE_WIRE, 'out 0x59']) expect(wire.has(op), op).toBe(false);
    });

    it('step 03 is offered with no red alarm, and nothing was refused anywhere', async () => {
      const { app, wizard } = need();
      await wizard.openPreserve();
      await checkStep03Offered(wizard, app.page);
      const guard = await guardOf(app.page);
      expect(guard.refusals).toEqual([]);
      for (const op of ['out 0x50', 'out 0x51']) expect(guard.counts[op], op).toBeUndefined();
      expect(app.timeline.filter((line) => line.includes('REFUSED'))).toEqual([]);
    });
  },
);

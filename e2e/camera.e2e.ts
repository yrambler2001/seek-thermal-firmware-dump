/* ==================================================================== *
 * The web app on the REAL camera over REAL Chromium WebUSB, READ-ONLY —
 * `npm run e2e:camera`. (`npm run e2e:camera:bridge` is the same run through
 * the Node bridge and node-usb: `camera-bridge.e2e.ts`.)
 *
 * The app runs in Electron (`e2e/electron/main.mjs`): Chromium's own WebUSB on
 * the real macOS USB stack, no stand-in. Google Chrome's chooser cannot be
 * answered from a test; Electron's can — `select-usb-device` — so the main
 * process relays every chooser to this test and picks only what the test
 * picks, as a person would. Permissions are Electron's own, which for a camera
 * with no serial number are Chrome's (an ephemeral grant, dropped when the
 * camera leaves the bus); the test records the serial string Chromium read.
 *
 * WHAT IT DOES: Connect, Dump & decrypt, then Preserve step 02 "Read & build"
 * — reads, builds the patch in memory, and may reboot the camera by command if
 * its reader comes up spent (each restart's "Your turn" ask is answered through
 * the chooser). It checks the dump's image against this camera's flash, the
 * 02 run file, that the page offers step 03 with no red alarm, and STOPS.
 *
 * WHAT STOPS A WRITE, three times over, none of them depending on another:
 *   1. the UI guard (`READ_ONLY_CAMERA`): the test refuses to click step 03 /
 *      04, a write confirmation, the jump, or the Flash view;
 *   2. the page's write guard (`write-guard.ts`), loaded by Electron's preload
 *      before any app code: `USBDevice.prototype`'s transfer methods are
 *      replaced, locked, and pass only the read-only whitelist — 0x50, 0x51,
 *      0x55 and 0x5A never leave the page, nor does a reset outside step 02;
 *   3. the main process answers a chooser only for a Seek camera, only for the
 *      dev server's page, and only once it has checked that guard 2 is in place.
 * A camera that is absent, doubled, or held by another program skips the suite.
 * ==================================================================== */

import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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

const SCRATCH =
  process.env.SEEK_E2E_SCRATCH ?? path.join(tmpdir(), `seek-e2e-camera-${String(process.pid)}`);
const KEEP = process.env.SEEK_E2E_KEEP === '1';
const HEADED = process.env.SEEK_E2E_HEADED === '1';

function unavailable(): string | null {
  if (electronBinary() === null) return 'the electron package is not installed';
  return cameraBusyReason();
}

const UNAVAILABLE = unavailable();
if (UNAVAILABLE !== null) process.stderr.write(`\n[skip] e2e on the real camera: ${UNAVAILABLE}\n`);

describe.skipIf(UNAVAILABLE !== null)(
  'the web app on the real camera over real WebUSB (Electron), read-only',
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

    it('the write guard is in the page before the app; the camera is picked in code', async () => {
      const { app } = need();
      await checkGuardAndConnect(need());
      /* Within one enumeration the grant holds: a reload re-adopts without a pick. */
      await app.page.reload({ waitUntil: 'networkidle0' });
      await app.page.waitForFunction(
        () => (document.querySelector('#device-description')?.textContent ?? '').includes('VID'),
        { timeout: 30_000, polling: 250 },
      );
      expect(await app.page.evaluate(async () => (await navigator.usb.getDevices()).length)).toBe(
        1,
      );
      expect((await guardOf(app.page)).installed).toBe(true);
    });

    it('Dump & decrypt reads the camera — its image is the camera’s flash — without a write or a reset', async () => {
      const { app, wizard } = need();
      const before = countsOf(await guardOf(app.page));
      const dump = await wizard.dumpAndDecrypt(20 * 60_000);
      const after = await guardOf(app.page);
      const wire = wireSince(before, countsOf(after));
      say(`dump wire: ${describeWire(wire)}`);
      checkDumpArchive(dump);
      for (const op of [...NEVER_ON_THE_WIRE, 'out 0x59']) expect(wire.has(op), op).toBe(false);
      expect(after.version).toBe('1.3.0.0');
      expect(after.refusals).toEqual([]);
    });

    it('Preserve step 02 reads & builds, saves its run file, offers step 03 — and the run stops there', async () => {
      const { app, wizard } = need();
      await wizard.openPreserve();
      const before = countsOf(await guardOf(app.page));
      await setGuard(app.page, { allowReset: true });
      let run;
      try {
        run = await wizard.runPhase('read-build', { confirm: false, timeoutMs: 30 * 60_000 });
      } finally {
        await setGuard(app.page, { allowReset: false });
      }
      const wire = wireSince(before, countsOf(await guardOf(app.page)));
      say(`step 02 wire: ${describeWire(wire)}; ${String(run.asks)} restart ask(s) answered`);
      for (const op of NEVER_ON_THE_WIRE) expect(wire.has(op), op).toBe(false);
      const state = checkStep02RunFile(run);
      say(
        `run ${state.runId}: firmware ${state.expectedVersion ?? '?'}, next step ${state.nextStep}`,
      );
      await checkStep03Offered(wizard, app.page);
    });

    it('nothing was refused anywhere, and no flash write ever left the page', async () => {
      const { app } = need();
      const guard = await guardOf(app.page);
      expect(guard.refusals).toEqual([]);
      for (const op of ['out 0x50', 'out 0x51']) expect(guard.counts[op], op).toBeUndefined();
      expect(app.timeline.filter((line) => line.includes('REFUSED'))).toEqual([]);
    });
  },
);

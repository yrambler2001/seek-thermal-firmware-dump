/* ==================================================================== *
 * The web app on the REAL camera, READ-ONLY, through the BRIDGE —
 * `npm run e2e:camera:bridge`. (`npm run e2e:camera` is the same run on real
 * Chromium WebUSB, in Electron: `camera.e2e.ts`.)
 *
 * Here the page runs on the bridge's `navigator.usb` stand-in, as on the
 * emulator, and the camera is driven through the CLI's host stack (node-usb).
 * Google Chrome's own device chooser cannot be answered from a test — CDP's
 * `DeviceAccess.deviceRequestPrompted` fires for Web Bluetooth only, never for
 * `navigator.usb.requestDevice()` (`device-prompt.e2e.ts` measures that) — and
 * a policy that pre-grants the device would change the machine.
 *
 * WHAT IT DOES: Connect (the bridge's chooser), Dump & decrypt, then Preserve
 * step 02 "Read & build" — reads, builds the patch in memory, and may reboot
 * the camera by command if its reader comes up spent (each reboot's
 * "Your turn" ask is answered in the chooser). It checks the 02 run file and
 * that the page offers step 03 with no red alarm, and STOPS.
 *
 * WHAT IT WILL NOT DO, and what stops it: it never starts step 03 or 04, never
 * confirms a write, never opens the Flash view (`READ_ONLY_CAMERA`, the UI
 * guard); the page refuses the flash-write requests before they leave it; and
 * `CameraBus` forwards only a whitelist of reads, mode 0, the window arm (after
 * the version is known) and — during step 02 only — the plain reset. A
 * camera that is absent, doubled, or held by another program skips the suite.
 * ==================================================================== */

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { UsbBridge } from './lib/bridge.js';
import {
  CHROME_PATH,
  launchChrome,
  say,
  startDevServer,
  type DevServer,
  type LaunchedChrome,
} from './lib/browser.js';
import { CameraBus, PAGE_REFUSED_OUT } from './lib/camera-bus.js';
import {
  CAMERA_NAME,
  NEVER_ON_THE_WIRE,
  checkDumpArchive,
  checkStep02RunFile,
  checkStep03Offered,
} from './lib/camera-flow.js';
import { cameraBusyReason } from './lib/preflight.js';
import { describeWire, wireSince } from './lib/checks.js';
import { READ_ONLY_CAMERA, Wizard } from './lib/wizard.js';

const SCRATCH =
  process.env.SEEK_E2E_SCRATCH ?? path.join(tmpdir(), `seek-e2e-camera-${String(process.pid)}`);
const KEEP = process.env.SEEK_E2E_KEEP === '1';
const HEADED = process.env.SEEK_E2E_HEADED === '1';

function unavailable(): string | null {
  if (!existsSync(CHROME_PATH)) return `no Chrome at ${CHROME_PATH} (set SEEK_E2E_CHROME)`;
  return cameraBusyReason();
}

const UNAVAILABLE = unavailable();
if (UNAVAILABLE !== null) process.stderr.write(`\n[skip] e2e on the real camera: ${UNAVAILABLE}\n`);

describe.skipIf(UNAVAILABLE !== null)(
  'the web app on the real camera, read-only (bridge over node-usb)',
  () => {
    let bus: CameraBus | null = null;
    let server: DevServer | null = null;
    let chrome: LaunchedChrome | null = null;
    let bridge: UsbBridge | null = null;
    let page: Page | null = null;
    let wizard: Wizard | null = null;

    const need = <T>(value: T | null, what: string): T => {
      if (value === null) throw new Error(`${what} is not up (an earlier step failed)`);
      return value;
    };

    beforeAll(async () => {
      mkdirSync(SCRATCH, { recursive: true });
      say(`scratch: ${SCRATCH}`);
      bus = await CameraBus.open(say);
      server = await startDevServer();
      chrome = await launchChrome({ scratchDir: SCRATCH, headless: !HEADED });
      page = await chrome.browser.newPage();
      page.on('pageerror', (error) => {
        say(`page error: ${String(error)}`);
      });
      bridge = await UsbBridge.attach(page, bus, { log: say, refuseOutInPage: PAGE_REFUSED_OUT });
      await page.goto(`${server.url}#/`, { waitUntil: 'networkidle0' });
      wizard = new Wizard({
        page,
        prompter: bridge,
        downloads: chrome.downloads,
        guard: READ_ONLY_CAMERA,
        camera: CAMERA_NAME,
      });
    });

    afterAll(async () => {
      if (bridge !== null) {
        say(`bridge timeline:\n  ${bridge.timeline.join('\n  ')}`);
        say(`wire totals: ${describeWire(bridge.counts)}`);
        bridge.detach();
      }
      await chrome?.close();
      await server?.close();
      await bus?.close();
      if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true });
      else say(`kept: ${SCRATCH}`);
    });

    it('connects through the chooser, and Dump & decrypt reads the camera without a write or a reset', async () => {
      const w = need(wizard, 'the wizard');
      const b = need(bridge, 'the bridge');
      need(bus, 'the camera').allowReset = false;
      expect(await w.connect()).toMatch(/PIR206 Thermal Camera/);
      const before = new Map(b.counts);
      const dump = await w.dumpAndDecrypt(20 * 60_000);
      const wire = wireSince(before, b.counts);
      say(`dump wire: ${describeWire(wire)}`);
      checkDumpArchive(dump);
      for (const op of [...NEVER_ON_THE_WIRE, 'out 0x59']) expect(wire.has(op), op).toBe(false);
      expect(b.refusals).toEqual([]);
    });

    it('Preserve step 02 reads & builds, saves its run file, offers step 03 — and the run stops there', async () => {
      const w = need(wizard, 'the wizard');
      const b = need(bridge, 'the bridge');
      const camera = need(bus, 'the camera');
      await w.openPreserve();
      const before = new Map(b.counts);
      camera.allowReset = true;
      let run;
      try {
        run = await w.runPhase('read-build', { confirm: false, timeoutMs: 30 * 60_000 });
      } finally {
        camera.allowReset = false;
      }
      const wire = wireSince(before, b.counts);
      say(`step 02 wire: ${describeWire(wire)}; ${String(run.asks)} restart ask(s) answered`);
      for (const op of NEVER_ON_THE_WIRE) expect(wire.has(op), op).toBe(false);
      const state = checkStep02RunFile(run);
      say(
        `run ${state.runId}: firmware ${state.expectedVersion ?? '?'}, next step ${state.nextStep}`,
      );
      /* Step 03 is offered — and not taken. No red past-commit alarm anywhere. */
      await checkStep03Offered(w, need(page, 'the page'));
    });

    it('nothing was refused, and no flash write ever left the page', async () => {
      const b = need(bridge, 'the bridge');
      expect(b.refusals).toEqual([]);
      expect(await b.pageRefusals()).toEqual([]);
      expect(need(bus, 'the camera').innerRefusals).toEqual([]);
      for (const op of ['out 0x50', 'out 0x51']) expect(b.counts.has(op), op).toBe(false);
    });
  },
);

/**
 * The setup both real-WebUSB camera runs share (`camera.e2e.ts`,
 * `camera-restart.e2e.ts`): the dev server, Electron with the write guard as
 * its preload, the read-only wizard — and the guard's control object, read and
 * set from the test.
 */

import { mkdirSync, rmSync } from 'node:fs';

import type { Page } from 'puppeteer-core';
import { expect } from 'vitest';

import { say, startDevServer, type DevServer } from './browser.js';
import { CAMERA_NAME, WRITE_GUARD_GLOBAL, writeGuardScript } from './camera-flow.js';
import { describeWire } from './checks.js';
import { ElectronApp } from './electron.js';
import { READ_ONLY_CAMERA, Wizard } from './wizard.js';
import type { InjectedStall, WriteGuardControl } from './write-guard.js';

export interface CameraSession {
  readonly server: DevServer;
  readonly app: ElectronApp;
  readonly wizard: Wizard;
}

export async function openCameraSession(scratch: string, headed: boolean): Promise<CameraSession> {
  mkdirSync(scratch, { recursive: true });
  say(`scratch: ${scratch}`);
  const server = await startDevServer();
  try {
    const app = await ElectronApp.launch({
      scratchDir: scratch,
      url: `${server.url}#/`,
      preloadSource: writeGuardScript(),
      guardGlobal: WRITE_GUARD_GLOBAL,
      headed,
    });
    app.page.on('pageerror', (error) => {
      say(`page error: ${String(error)}`);
    });
    const wizard = new Wizard({
      page: app.page,
      prompter: app,
      downloads: app,
      guard: READ_ONLY_CAMERA,
      camera: CAMERA_NAME,
    });
    return { server, app, wizard };
  } catch (error) {
    await server.close();
    throw error;
  }
}

export async function closeCameraSession(
  session: CameraSession | null,
  scratch: string,
  keep: boolean,
): Promise<void> {
  if (session !== null) {
    say(`electron timeline:\n  ${session.app.timeline.join('\n  ')}`);
    const guard = await guardOf(session.app.page).catch(() => null);
    if (guard !== null) say(`wire (this page load): ${describeWire(countsOf(guard))}`);
    await session.app.close();
    await session.server.close();
  }
  if (!keep) rmSync(scratch, { recursive: true, force: true });
  else say(`kept: ${scratch}`);
}

/** The page's write guard, as plain data. */
export async function guardOf(page: Page): Promise<WriteGuardControl> {
  return page.evaluate((name: string) => {
    const guard = (globalThis as unknown as Record<string, unknown>)[name];
    return JSON.parse(JSON.stringify(guard ?? null)) as WriteGuardControl;
  }, WRITE_GUARD_GLOBAL);
}

/** Sets the guard's test-controlled fields (never its whitelist). */
export async function setGuard(
  page: Page,
  patch: {
    readonly allowReset?: boolean;
    readonly resetBudget?: number | null;
    readonly fault?: InjectedStall | null;
  },
): Promise<void> {
  await page.evaluate(
    (name: string, fields: Record<string, unknown>) => {
      const guard = (globalThis as unknown as Record<string, Record<string, unknown> | undefined>)[
        name
      ];
      if (guard === undefined) throw new Error('the write guard is not in the page');
      for (const [key, value] of Object.entries(fields)) guard[key] = value;
    },
    WRITE_GUARD_GLOBAL,
    patch,
  );
}

export function countsOf(guard: WriteGuardControl): Map<string, number> {
  return new Map(Object.entries(guard.counts));
}

/**
 * Guard 2 checks itself, then the first pick. The guard must be installed and
 * locked, and must refuse a flash write unsent before anything is granted (a
 * reload then gives the run a guard with a clean record). Nothing is granted
 * on a fresh profile until the chooser is answered; after the pick the page
 * sees exactly the camera. Returns the serial strings Chromium read — the
 * chooser's and the page's — which decide what kind of grant it is.
 */
export async function checkGuardAndConnect(
  session: CameraSession,
): Promise<{ readonly listedSerial: string | null; readonly pageSerial: string | null }> {
  const { app, wizard } = session;
  const guard = await guardOf(app.page);
  expect(guard.installed).toBe(true);
  expect(guard.wrapped).toEqual(
    expect.arrayContaining(['controlTransferOut', 'controlTransferIn', 'transferOut', 'reset']),
  );
  expect(guard.refusals).toEqual([]);
  expect(
    await app.page.evaluate(() => {
      const out = Object.getOwnPropertyDescriptor(USBDevice.prototype, 'controlTransferOut');
      return out !== undefined && !out.configurable && !out.writable;
    }),
  ).toBe(true);

  const probe = await app.page.evaluate(async () => {
    const out = Object.getOwnPropertyDescriptor(USBDevice.prototype, 'controlTransferOut')
      ?.value as (setup: USBControlTransferParameters, data: BufferSource) => Promise<unknown>;
    try {
      await out.call(
        {},
        { requestType: 'vendor', recipient: 'interface', request: 0x50, value: 0, index: 0 },
        new Uint8Array(2),
      );
      return 'sent';
    } catch (error) {
      return error instanceof DOMException ? `${error.name}: ${error.message}` : String(error);
    }
  });
  expect(probe).toMatch(/^SecurityError: e2e write guard: OUT 0x50/);
  expect((await guardOf(app.page)).refusals).toHaveLength(1);
  await app.page.reload({ waitUntil: 'networkidle0' });
  expect((await guardOf(app.page)).refusals).toEqual([]);

  expect(await app.page.evaluate(async () => (await navigator.usb.getDevices()).length)).toBe(0);
  expect(await wizard.connect()).toMatch(/PIR206 Thermal Camera/);
  const granted = await app.page.evaluate(async () =>
    (await navigator.usb.getDevices()).map((d) => d.serialNumber ?? null),
  );
  expect(granted).toHaveLength(1);
  const listedSerial = app.devicesSeen.find((d) => d.vendorId === 0x289d)?.serialNumber ?? null;
  const pageSerial = granted[0] ?? null;
  say(
    `Electron ${app.versions.electron} / Chromium ${app.versions.chrome}: the chooser listed the ` +
      `camera with serial ${JSON.stringify(listedSerial)}, the page sees ` +
      `${JSON.stringify(pageSerial)} — an empty serial makes the grant ephemeral (one ` +
      'enumeration), dropped when the camera leaves the bus',
  );
  return { listedSerial, pageSerial };
}

/* ==================================================================== *
 * Forget device — `npm run e2e:forget` (camera by default, real Chromium
 * revoke; `SEEK_E2E_TARGET=emu` runs the same through the bridge).
 *
 * After connecting: `getDevices()` sees the camera; "Forget device" revokes it
 * (on the camera target that is Electron's `usb-device-revoked`); `getDevices()`
 * is then empty; and Connect + pick grants it again.
 * ==================================================================== */

import { expect, it } from 'vitest';

import type { Page } from 'puppeteer-core';

import { say } from './lib/browser.js';
import { targetSpec } from './lib/spec.js';

const granted = (page: Page): Promise<number> =>
  page.evaluate(async () => (await navigator.usb.getDevices()).length);

targetSpec({ title: 'forget device', slug: 'forget', fallback: 'camera' }, (ctx) => {
  it('connect grants the camera, forget revokes it, and connect grants it again', async () => {
    const t = ctx.target();
    const w = t.wizard;

    await w.connect();
    expect(await granted(t.page)).toBe(1);

    await w.forget();
    expect(await granted(t.page), 'getDevices() is empty after forget').toBe(0);
    if (t.app !== null) {
      expect(
        t.app.timeline.some((line) => line.includes('usb-device-revoked')),
        'Electron reported usb-device-revoked',
      ).toBe(true);
    }
    say('forget revoked the grant');

    await w.connect();
    expect(await granted(t.page), 'the camera is granted again after a fresh pick').toBe(1);
  });
});

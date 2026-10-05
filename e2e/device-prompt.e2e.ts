/* ==================================================================== *
 * Can a test answer Chrome's WebUSB chooser? — `npm run e2e:prompt`.
 *
 * Puppeteer answers a device chooser through CDP's DeviceAccess domain
 * (`page.waitForDevicePrompt()`, `DeviceAccess.deviceRequestPrompted`), which
 * is documented for Web Bluetooth. This measures whether the installed Chrome
 * raises it for `navigator.usb.requestDevice()` too. HEADED, on a throwaway
 * profile, the chooser filtered to Seek's vendor id; nothing is ever selected
 * (a prompt that does fire is cancelled), so no device is touched.
 *
 * Measured on Chrome 154 (2026-10-05): it does NOT. `DeviceAccess.enable` is
 * accepted, the click opens the chooser (the page's `requestDevice()` stays
 * pending), and no event arrives — neither through Puppeteer nor on a raw CDP
 * session. That is why `camera.e2e.ts` runs the page on the bridge. If this
 * file starts failing, Chrome has begun exposing the WebUSB chooser to CDP and
 * the real-camera run can switch to Chrome's own WebUSB.
 * ==================================================================== */

import { createServer } from 'node:http';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CHROME_PATH, launchChrome, say } from './lib/browser.js';

const SCRATCH =
  process.env.SEEK_E2E_SCRATCH ?? path.join(tmpdir(), `seek-e2e-prompt-${String(process.pid)}`);

const PAGE = `<!doctype html><meta charset="utf-8"><title>chooser probe</title>
<button id="ask">ask</button><pre id="out">idle</pre>
<script>
document.getElementById('ask').onclick = async () => {
  const out = document.getElementById('out');
  out.textContent = 'pending';
  try {
    const d = await navigator.usb.requestDevice({ filters: [{ vendorId: 0x289d }] });
    out.textContent = 'picked ' + d.productName;
  } catch (e) {
    out.textContent = 'rejected ' + e.name;
  }
};
</script>`;

describe.skipIf(!existsSync(CHROME_PATH))('Chrome WebUSB chooser over CDP', () => {
  it('DeviceAccess.deviceRequestPrompted does not fire for navigator.usb.requestDevice()', async () => {
    mkdirSync(SCRATCH, { recursive: true });
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    const url = `http://127.0.0.1:${String(typeof address === 'object' && address !== null ? address.port : 0)}/`;
    const chrome = await launchChrome({ scratchDir: SCRATCH, headless: false });
    try {
      const page = await chrome.browser.newPage();
      await page.goto(url);
      expect(await page.evaluate(() => 'usb' in navigator && isSecureContext)).toBe(true);

      const cdp = await page.createCDPSession();
      const raw: unknown[] = [];
      cdp.on('DeviceAccess.deviceRequestPrompted', (event) => raw.push(event));
      await cdp.send('DeviceAccess.enable');

      const waited = page.waitForDevicePrompt({ timeout: 15_000 }).then(
        async (prompt) => {
          await prompt.cancel();
          return 'fired';
        },
        (error: unknown) => `not fired (${error instanceof Error ? error.message : String(error)})`,
      );
      await page.click('#ask');
      const verdict = await waited;
      const outcome = await page.$eval('#out', (el) => el.textContent);
      say(
        `Chrome ${await chrome.browser.version()}: puppeteer prompt ${verdict}; raw events ${String(raw.length)}; page: ${outcome}`,
      );
      /* The click did open the chooser: requestDevice() is still waiting on it. */
      expect(outcome).toBe('pending');
      expect(raw).toEqual([]);
      expect(verdict).toMatch(/^not fired/);
    } finally {
      await chrome.close();
      server.close();
      rmSync(SCRATCH, { recursive: true, force: true });
    }
  });
});

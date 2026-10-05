/* ==================================================================== *
 * Cancelling mid-read — `npm run e2e:cancel` (emu by default; camera with
 * SEEK_E2E_TARGET=camera, read-only).
 *
 * Cancel Dump & decrypt once it is under way, then run it again and get the
 * whole part back with the same sha. Also cancels step 02 mid-backup, when the
 * UI allows, and shows the camera still reads afterwards.
 * ==================================================================== */

import { expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { CAMERA_FLASH_SHA } from './lib/camera-flow.js';
import { sha256 } from './lib/checks.js';
import { phaseSection, Wizard } from './lib/wizard.js';
import { targetSpec } from './lib/spec.js';
import { waitForProgress } from './lib/target-tools.js';

const image = (entries: readonly { name: string; data: Uint8Array }[]): Uint8Array =>
  entries.find((e) => /^[^/]+\/flash_4m_usb[^/]*\.bin$/.test(e.name))?.data ?? new Uint8Array(0);

targetSpec({ title: 'cancel mid-read', slug: 'cancel' }, (ctx) => {
  it('connects', async () => {
    await ctx.target().wizard.connect();
  });

  it('cancels Dump & decrypt mid-read, then a clean re-run returns the whole part', async () => {
    const t = ctx.target();
    const w = t.wizard;
    await w.route('#/');
    await w.startDump('dump', 'Start dump');
    /* A few windows in (the bar past 10 %), so the cancel lands mid-sweep. */
    const at = await waitForProgress(t.page, 'dump', 10, 5 * 60_000);
    say(`dump at ${String(at)} %: ${await w.text('#dump-status')}`);
    const cancelled = await w.cancel('dump', 'section[aria-labelledby="dump-heading"]');
    say(`after cancel: ${cancelled}`);
    expect(cancelled).toMatch(/^Done — ([1-9]\d*)\/(\d+) windows read \(cancelled\)/);
    /* A cancelled dump still downloads its PARTIAL archive. Consume it so the
     * re-run's wait picks up the full one, not this one. */
    await t.downloads.waitFor((n) => /^seek_flash4m_.+\.zip$/.test(n), 60_000, 'partial dump');

    const again = await w.dumpAndDecrypt(20 * 60_000);
    expect(again.status).toMatch(/^Done — (\d+)\/\1 windows read\. /);
    if (CAMERA_FLASH_SHA !== '') {
      expect(sha256(image(again.entries)), 'the re-run image is the camera flash').toBe(
        CAMERA_FLASH_SHA,
      );
    }
  });

  it('cancels step 02 mid-backup; the camera still reads afterwards', async () => {
    const t = ctx.target();
    const w = t.wizard;
    await w.openPreserve();
    const section = phaseSection('read-build');
    await w.click(section, Wizard.startLabel('read-build'));
    /* Well into the backup sweep (its bar past 5 %), not just started — then stop. */
    const at = await waitForProgress(t.page, 'preserve-phase-read-build', 5, 5 * 60_000);
    say(`step 02 at ${String(at)} %: ${await t.wizard.text('#preserve-phase-read-build-status')}`);
    const stopped = await w.cancel('preserve-phase-read-build', section);
    say(`step 02 after cancel: ${stopped}`);
    expect(stopped).toMatch(/Cancelled|Done/i);
    /* A cancelled step is not a failure, so a plain re-read works — read-only. */
    const dump = await w.dumpAndDecrypt(20 * 60_000);
    expect(dump.status).toMatch(/^Done — /);
  });
});

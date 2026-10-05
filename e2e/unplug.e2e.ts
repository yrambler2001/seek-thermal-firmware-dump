/* ==================================================================== *
 * Unplug / replug mid-read — `npm run e2e:unplug`.
 *
 * On the emulator (the default, unattended): stopping the emulator IS the
 * cable being pulled. A dump in flight then fails cleanly — an error, not a
 * hang — and once a fresh emulator is booted from the same flash (the replug)
 * and re-picked, the camera reads again with the same sha.
 *
 * On the camera target the unplug is a human (the manual power switch) or the
 * rp2040 hardware switch — supervised, never unattended — so this spec runs its
 * unplug only on the emulator, and on the camera reports what would drive it.
 *
 * The "replug after an unfixed-patch drain" ask and the "power-cycle" ask are
 * NOT reachable on this emulator build: the shipped five-site patch resets the
 * reader cursor (no replug owed), and the emulator's reader never spends (no
 * power-cycle refusal). Both are covered on real hardware by
 * `camera-restart.e2e.ts`; see the report.
 * ==================================================================== */

import { expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { CAMERA_FLASH_SHA } from './lib/camera-flow.js';
import { sha256 } from './lib/checks.js';
import { ManualPowerSwitch, Rp2040PowerSwitch, switchInfo } from './lib/power-switch.js';
import { targetSpec } from './lib/spec.js';

const image = (entries: readonly { name: string; data: Uint8Array }[]): Uint8Array =>
  entries.find((e) => /^[^/]+\/flash_4m_usb[^/]*\.bin$/.test(e.name))?.data ?? new Uint8Array(0);

targetSpec({ title: 'unplug / replug mid-read', slug: 'unplug' }, (ctx) => {
  it('connects', async () => {
    await ctx.target().wizard.connect();
  });

  it('a mid-dump unplug fails cleanly, and a replug + re-pick reads again', async () => {
    const t = ctx.target();
    if (t.emu === null) {
      const info = await switchInfo();
      const hw = Rp2040PowerSwitch.fromEnv();
      say(
        'camera target: the unplug is supervised — ' +
          (hw === null
            ? 'set SEEK_E2E_SWITCH_CHANNEL for the rp2040 switch, or a human does it'
            : hw.describe()) +
          `; switch board: ${info.detail}`,
      );
      const manual = new ManualPowerSwitch({ present: () => Promise.resolve(true) });
      expect(manual.describe()).toMatch(/manual/);
      return; /* never auto-toggle the camera's power */
    }

    const w = t.wizard;
    await w.route('#/');
    await w.startDump('dump', 'Start dump');
    await w.dumpProgressed('dump', 3);
    say('pulling the cable (stopping the emulator) mid-dump');
    await t.emu.unplug();

    /* The dump must END — an error, not a hang. */
    await t.page.waitForFunction(
      () =>
        /^(Failed|Refused|Cancelled|Done)/.test(
          document.querySelector<HTMLElement>('#dump-status')?.innerText ?? '',
        ),
      { timeout: 90_000, polling: 500 },
    );
    const ended = await w.text('#dump-status');
    say(`after the unplug: ${ended}`);
    expect(ended).toMatch(/^(Failed|Refused|Cancelled)/);

    say('plugging back in (a fresh emulator from the same flash)');
    await t.emu.replug();
    await w.connect(); /* the replugged device is new — Chrome needs a pick */
    const again = await w.dumpAndDecrypt(20 * 60_000);
    expect(again.status).toMatch(/^Done — /);
    if (CAMERA_FLASH_SHA !== '') expect(sha256(image(again.entries))).toBe(CAMERA_FLASH_SHA);
  });
});

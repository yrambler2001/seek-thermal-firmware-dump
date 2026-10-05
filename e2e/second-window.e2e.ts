/* ==================================================================== *
 * A second window while the first holds the camera — `npm run e2e:second`
 * (emulator by default; `SEEK_E2E_TARGET=camera` runs the safe camera probe).
 *
 * KNOWN APP BUG (documented here, not fixed in this batch). When the OS refuses
 * `claimInterface` because another window already holds the interface, the
 * transport assumes a *system driver* holds it and talks to the device anyway,
 * on the device recipient (packages/core/src/protocol/webusb.ts,
 * `isPlatformClaimRefusal` / `open()`). So a second window does NOT get a clean
 * "camera in use" — it reads alongside the first, and the two interleaved read
 * sequences each come back as a WRONG, short image with no warning. A cross-tab
 * Web Locks lock would be one fix. This test pins the current behaviour: when
 * the app is fixed, it will fail, which is the signal to update it.
 *
 * On the emulator (the bridge now models one interface holder per browser, as
 * macOS does) the bug reproduces, so the emulator test demonstrates it. On the
 * REAL camera the test does NOT run two read sequences — it only confirms the
 * second window shares the grant and stays responsive — so two reads can never
 * interleave on real hardware.
 * ==================================================================== */

import { expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { describeWire, sha256 } from './lib/checks.js';
import { targetSpec } from './lib/spec.js';
import {
  expectedImageSha,
  grantedDevices,
  openSecondWindow,
  waitForProgress,
  type SecondWindow,
} from './lib/target-tools.js';
import type { DumpRun } from './lib/wizard.js';

const imageSha = (dump: DumpRun): string =>
  sha256(
    dump.entries.find((e) => /^[^/]+\/flash_4m_usb[^/]*\.bin$/.test(e.name))?.data ??
      new Uint8Array(0),
  );

targetSpec({ title: 'a second window contends for the camera', slug: 'second' }, (ctx) => {
  let second: SecondWindow | null = null;

  it('a second window shares the grant and stays responsive', async () => {
    const t = ctx.target();
    await t.wizard.connect();
    second = await openSecondWindow(t);
    const w2 = second;
    /* Both windows, same browser profile, see the same granted camera. */
    expect(await grantedDevices(t.page), 'window 1 holds the grant').toBeGreaterThanOrEqual(1);
    expect(await grantedDevices(w2.page), 'window 2 shares the grant').toBeGreaterThanOrEqual(1);
    say('the second window sees the same camera');
    expect(await w2.page.evaluate(() => document.title)).toContain('Seek');
  });

  it('demonstrates the claim-refusal read-through bug — EMULATOR only', async () => {
    const t = ctx.target();
    if (t.name !== 'emu' || second === null) {
      say('camera target: two read sequences are NOT run on real hardware (see the file header)');
      if (second !== null) {
        /* Window 2 only loaded the page and asked getDevices(): its own page
         * guard must have seen no transfer at all, and refused nothing. */
        const wire2 = await second.wire();
        say(`window 2 wire: ${describeWire(wire2) || 'nothing'}`);
        expect([...wire2.keys()], 'window 2 sent no transfer to the camera').toEqual([]);
        expect(await second.refusals()).toEqual([]);
      }
      return;
    }
    const w2 = second;
    /* Window 1 dumps; window 2 dumps at the same time. */
    const dump1 = t.wizard.dumpAndDecrypt(20 * 60_000);
    dump1.catch(() => undefined);
    await waitForProgress(t.page, 'dump', 5);
    const dump2 = w2.wizard.dumpAndDecrypt(20 * 60_000);
    dump2.catch(() => undefined);

    const results = await Promise.allSettled([dump1, dump2]);
    const outcomes = results.map((r, i) =>
      r.status === 'fulfilled'
        ? `window ${String(i + 1)}: ${r.value.status} sha ${imageSha(r.value).slice(0, 16)}`
        : `window ${String(i + 1)}: errored ${String(r.reason).slice(0, 60)}`,
    );
    say(`concurrent dumps:\n  ${outcomes.join('\n  ')}`);
    const reds = [...(await t.wizard.redAlerts()), ...(await w2.wizard.redAlerts())];

    const bothDone = results.every((r) => r.status === 'fulfilled');
    const trueSha = expectedImageSha(t);
    const anyWrong = results.some((r) => r.status === 'fulfilled' && imageSha(r.value) !== trueSha);
    /* THE BUG, pinned: two concurrent dumps both "complete", at least one with
     * a wrong image, and NOT ONE red warning. When the app grows a cross-tab
     * lock this expectation flips — update the test then. */
    expect(bothDone, 'both windows reported Done (no clean "in use" refusal)').toBe(true);
    expect(anyWrong, 'at least one dump returned a wrong image').toBe(true);
    expect(
      reds,
      `no red warning was shown for the contention (the bug): ${reds.join(' | ')}`,
    ).toEqual([]);
    say('KNOWN APP BUG reproduced: two tabs read the same camera and corrupt each other silently');
  });

  it('cleans up the second window', async () => {
    await second?.close();
    second = null;
  });
});

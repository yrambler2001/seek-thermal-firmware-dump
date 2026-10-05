/* ==================================================================== *
 * The Flash view — `npm run e2e:flash` (EMULATOR only).
 *
 * The Flash view writes, so it is never opened on the real camera (the
 * read-only guard refuses the route, and on the camera target both tests here
 * return before they touch the view).
 *
 * 1. Against a real emulated device it reads the running firmware (1.3.0.0),
 *    reports the slots, finds the build flashable, and offers the "Choose
 *    plaintext image…" write path with its red "this writes to the camera's
 *    flash" warning.
 * 2. A REAL flash and boot, on the emulator: the camera's own plaintext (the
 *    active slot as Dump & decrypt delivers it — the bench part is the 2014
 *    plaintext chain, so no key-named file is needed) is picked, written to
 *    the upgrade-target slot through the view's own "Write to camera" and its
 *    confirmation, the cable is pulled and put back (a fresh emulator booted
 *    from the flash the write left), and "Read device info" must then report
 *    the same firmware version running from the slot that was written.
 * ==================================================================== */

import { writeFileSync } from 'node:fs';
import path from 'node:path';

import type { Page } from 'puppeteer-core';
import { expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { sha256 } from './lib/checks.js';
import { targetSpec } from './lib/spec.js';
import { BENCH_PLAIN_SHA, refusalsOf } from './lib/target-tools.js';
import type { Wizard } from './lib/wizard.js';

const FW_SECTION = 'section[aria-labelledby="fw-heading"]';
const WRITE_SECTION = 'section[aria-labelledby="write-heading"]';

interface InfoView {
  readonly status: string;
  readonly version: string;
  readonly booted: string;
  readonly target: string;
}

/** Presses "Read device info" and waits for it to settle; returns the panel's key rows. */
async function readDeviceInfo(w: Wizard, page: Page): Promise<InfoView> {
  await w.click(FW_SECTION, 'Read device info');
  await page.waitForFunction(
    () => {
      const s = document.querySelector<HTMLElement>('#fwinfo-status')?.innerText ?? '';
      return (s.startsWith('Read') && !s.startsWith('Reading')) || /^(Refused|Failed)/.test(s);
    },
    { timeout: 5 * 60_000, polling: 500 },
  );
  const rows = await page.evaluate((sel: string) => {
    const out: Record<string, string> = {};
    for (const dt of document.querySelectorAll(`${sel} dt`)) {
      /* The first panel is the running firmware's; later ones (the slots) may reuse a label. */
      const key = (dt as HTMLElement).innerText.trim().toLowerCase();
      const dd = dt.nextElementSibling as HTMLElement | null;
      if (!(key in out)) out[key] = dd?.innerText.trim() ?? '';
    }
    return out;
  }, FW_SECTION);
  return {
    status: await w.text('#fwinfo-status'),
    version: rows.version ?? '',
    booted: rows['booted from'] ?? '',
    target: rows['upgrade target'] ?? '',
  };
}

targetSpec({ title: 'the Flash view', slug: 'flash-view' }, (ctx) => {
  it('reads the running firmware and offers the write path', async () => {
    const t = ctx.target();
    if (t.emu === null) {
      say('camera target: the Flash view writes and is never opened on the camera — skipping');
      return;
    }
    const w = t.wizard;
    await w.connect();
    await w.route('#/flash');
    const info = await readDeviceInfo(w, t.page);
    say(`Flash view device info: ${info.status}`);
    expect(info.status).toMatch(/^Read/);

    /* The view read the device and shows its version. */
    expect(await w.text(FW_SECTION)).toContain('1.3.0.0');

    /* This build is flashable here, so the write path is offered: the image
     * picker is live, and the view carries its own loud write warning. */
    const canChoose = await w.isEnabled(WRITE_SECTION, 'Choose plaintext image…');
    const warnings = await w.redAlerts();
    say(
      `Flash view: picker enabled=${String(canChoose)}; ${String(warnings.length)} warning alert(s)`,
    );
    expect(canChoose, 'the "Choose plaintext image…" picker is offered').toBe(true);
    expect(
      warnings.some((a) => /writes to the camera's flash/i.test(a)),
      'the Flash view warns that it writes',
    ).toBe(true);
  });

  it(
    "flashes the camera's own plaintext into the upgrade slot, and the emulator boots it",
    { timeout: 30 * 60_000 },
    async () => {
      const t = ctx.target();
      if (t.emu === null) {
        say('camera target: the Flash view is never opened on the camera — no write here');
        return;
      }
      const w = t.wizard;

      /* The image: the active slot's plaintext, as Dump & decrypt delivers it. */
      const dump = await w.dumpAndDecrypt(20 * 60_000);
      const plain = dump.entries.find(
        (e) => /\/decrypted\/[^/]+\.bin$/.test(e.name) && sha256(e.data) === BENCH_PLAIN_SHA,
      );
      expect(plain, "the dump's decrypted active slot").toBeDefined();
      if (plain === undefined) return;
      const imagePath = path.join(ctx.scratch, path.basename(plain.name));
      writeFileSync(imagePath, plain.data);
      say(`image: ${path.basename(plain.name)} (${String(plain.data.length)} B)`);

      /* Before: what runs, and where the write will land. */
      await w.route('#/flash');
      const before = await readDeviceInfo(w, t.page);
      say(`before: ${before.version}, booted from ${before.booted}, target ${before.target}`);
      expect(before.status).toMatch(/^Read\. /);
      expect(before.target).not.toBe('');
      const targetName = before.target.split(' at ')[0] ?? '';
      expect(targetName).not.toBe(before.booted);

      /* Pick the file; the view packages it and says it is ready. */
      const input = await t.page.$('input#filePickFw');
      if (input === null) throw new Error('the Flash view has no image input');
      await input.uploadFile(imagePath);
      await t.page.waitForFunction(
        () =>
          /^(Ready|Rejected)/.test(
            document.querySelector<HTMLElement>('#flash-status')?.innerText ?? '',
          ),
        { timeout: 60_000, polling: 250 },
      );
      const prepared = await w.text('#flash-status');
      expect(prepared, await w.logTail('flash')).toMatch(/^Ready — /);

      /* No rescue dump: the emulator's flash is a scratch file, and the dump
       * above already read the whole part. */
      await t.page.click('#optDumpFirst');
      expect(await t.page.$eval('#optDumpFirst', (el) => (el as HTMLInputElement).checked)).toBe(
        false,
      );

      /* The view's own write, through its confirmation dialog. */
      await w.click(WRITE_SECTION, 'Write to camera');
      await t.page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
      await w.click('[role="alertdialog"]', 'Yes — write to camera');
      const t0 = Date.now();
      await t.page.waitForFunction(
        () =>
          /^(Written|Failed|Cancelled)/.test(
            document.querySelector<HTMLElement>('#flash-status')?.innerText ?? '',
          ),
        { timeout: 20 * 60_000, polling: 500 },
      );
      const written = await w.text('#flash-status');
      say(`write: ${written} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
      expect(written, await w.logTail('flash')).toMatch(/^Written\./);

      /* The bank switch takes effect on a power cycle: pull the cable and put
       * it back — a fresh emulator booted from the flash the write left. */
      await t.emu.unplug();
      await t.emu.replug();
      await w.route('#/');
      await w.connect(); /* a re-enumerated camera with no serial needs a new pick */
      await w.route('#/flash');
      const after = await readDeviceInfo(w, t.page);
      say(`after: ${after.version}, booted from ${after.booted}, target ${after.target}`);
      expect(after.status).toMatch(/^Read/);
      expect(after.version, 'the written image runs and reports its version').toBe(before.version);
      expect(after.booted, 'the camera now runs from the slot that was written').toBe(targetName);
      expect(await refusalsOf(t)).toEqual([]);
    },
  );
});

/* ==================================================================== *
 * Reload mid-step — `npm run e2e:reload` (emu by default; camera read-only
 * with SEEK_E2E_TARGET=camera).
 *
 * Reloading the page in the middle of step 02 must not leave corrupted state:
 * step 02 writes its run file only when it finishes, so a mid-step reload just
 * starts clean, and running step 02 again works. Reloading AFTER step 02, with
 * the run file in hand, resumes at step 03.
 *
 * A page mid-run asks before it unloads (the runner's beforeunload). Chrome
 * shows "Leave site?" and Electron reports `will-prevent-unload`; the reload
 * here answers it as the person would ("Leave"), on either target.
 * ==================================================================== */

import { expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { checkStep02RunFile, checkStep03Offered } from './lib/camera-flow.js';
import { describeWire } from './lib/checks.js';
import { Wizard, phaseSection } from './lib/wizard.js';
import { targetSpec } from './lib/spec.js';
import { refusalsOf, reloadAnswering, waitForProgress, wireOf } from './lib/target-tools.js';

targetSpec({ title: 'reload mid-step', slug: 'reload' }, (ctx) => {
  let patchBuilt = '';

  it('connects', async () => {
    await ctx.target().wizard.connect();
  });

  it('a reload mid-step-02 leaves no corrupted state; a fresh step 02 then works', async () => {
    const t = ctx.target();
    await t.wizard.openPreserve();
    await t.wizard.click(phaseSection('read-build'), Wizard.startLabel('read-build'));
    /* Well into the backup sweep (its bar past 5 %), not just started. */
    const at = await waitForProgress(t.page, 'preserve-phase-read-build', 5, 5 * 60_000);
    say(`step 02 at ${String(at)} %: ${await t.wizard.text('#preserve-phase-read-build-status')}`);
    const { asked } = await reloadAnswering(t);
    say(`mid-step reload: the page ${asked ? 'asked before unloading' : 'did not ask'}`);
    /* After the reload the page is fresh: no run, nothing "Running", no red. */
    await t.wizard.openPreserve();
    const reds = await t.wizard.redAlerts();
    expect(reds, `a mid-step reload left a wall of red: ${reds.join(' | ')}`).toEqual([]);
    const running = await t.page.$$eval('[data-slot="badge"]', (bs) =>
      bs.some((b) => (b as HTMLElement).innerText.trim() === 'Running'),
    );
    expect(running, 'nothing is still marked Running after the reload').toBe(false);
    say('mid-step reload: the page came back clean');

    /* The device came back with the page (the grant survives a reload); make
     * sure, then run step 02 to completion. */
    if (!(await t.wizard.deviceDescription()).includes('VID')) await t.wizard.connect();
    const run = await t.wizard.runPhase('read-build', { confirm: false, timeoutMs: 30 * 60_000 });
    checkStep02RunFile(run);
    patchBuilt = run.runFile.path;
    say(`wire after the fresh step 02: ${describeWire(await wireOf(t))}`);
  });

  it('a reload after step 02 resumes from the run file at step 03', async () => {
    const t = ctx.target();
    expect(patchBuilt, 'the previous test recorded the run file').not.toBe('');
    await reloadAnswering(t);
    const status = await t.wizard.loadRunFile(patchBuilt);
    expect(status).toMatch(/^Resumed at commit/);
    await checkStep03Offered(t.wizard, t.page);
    expect(await refusalsOf(t), 'no guard refused anything').toEqual([]);
  });
});

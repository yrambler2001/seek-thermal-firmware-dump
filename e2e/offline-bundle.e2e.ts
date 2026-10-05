/* ==================================================================== *
 * The hosted build, run offline — `npm run e2e:offline` (emu by default;
 * camera with SEEK_E2E_TARGET=camera, read-only).
 *
 * Serves the committed `docs/` bundle (what GitHub Pages serves) over plain
 * HTTP — no dev server, no module graph — then, once the page has loaded, goes
 * offline (CDP) and runs Dump & decrypt and Preserve step 02. Both finish
 * offline, which is what the page's airplane-mode advice promises. Every
 * network request the page makes AFTER it has loaded is recorded and reported,
 * so a stray fetch (a font, an analytics ping) would show up.
 * ==================================================================== */

import { expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { checkDumpArchive, checkStep02RunFile } from './lib/camera-flow.js';
import { targetSpec } from './lib/spec.js';

interface Req {
  readonly url: string;
  readonly afterLoad: boolean;
}

targetSpec(
  { title: 'the hosted docs/ bundle, offline', slug: 'offline', source: 'docs' },
  (ctx) => {
    const requests: Req[] = [];
    let loaded = false;

    it('loads from the static bundle and connects', async () => {
      const t = ctx.target();
      t.page.on('request', (req) => {
        requests.push({ url: req.url(), afterLoad: loaded });
      });
      /* The whole page and its assets are in by now (networkidle on open). */
      loaded = true;
      await t.wizard.connect();
    });

    it('goes offline and still dumps and decrypts', async () => {
      const t = ctx.target();
      await t.setOffline(true);
      try {
        const dump = await t.wizard.dumpAndDecrypt(20 * 60_000);
        checkDumpArchive(dump);
      } finally {
        await t.setOffline(false);
      }
    });

    it('goes offline and still runs Preserve step 02', async () => {
      const t = ctx.target();
      await t.setOffline(true);
      try {
        const run = await t.wizard.runPhase('read-build', {
          confirm: false,
          timeoutMs: 30 * 60_000,
        });
        checkStep02RunFile(run);
      } finally {
        await t.setOffline(false);
      }
    });

    it('made no network request after it had loaded', () => {
      const after = requests.filter((r) => r.afterLoad);
      /* Blob downloads use blob: URLs, not the network; the dev server (emu) adds
       * its own client requests, so this bites hardest on the docs bundle. */
      const external = after.filter(
        (r) =>
          !r.url.startsWith('blob:') &&
          !r.url.startsWith('data:') &&
          !r.url.startsWith(ctx.target().serverUrl),
      );
      for (const r of after) say(`post-load request: ${r.url}`);
      expect(
        external,
        `the page fetched from the network after load: ${external.map((r) => r.url).join(', ')}`,
      ).toEqual([]);
    });
  },
);

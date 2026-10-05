/* ==================================================================== *
 * The rest of Dump & decrypt — `npm run e2e:dump` (target-agnostic, emu by
 * default; `SEEK_E2E_TARGET=camera` runs it read-only on the real camera).
 *
 *  - "Dump all selectors" (sweep mode): probes every selector and saves what
 *    each returns. Slow; only when SEEK_E2E_SWEEP=1.
 *  - the hand-picked firmware family: pick a profile, dump under it.
 *  - "Decrypt a dump you already have": an offline decrypt of a file named by
 *    SEEK_E2E_DUMP_FILE (skipped when unset). Its decrypted slots are checked
 *    against the camera's own dump (same input bytes -> same plaintext).
 * ==================================================================== */

import { existsSync } from 'node:fs';

import { expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { CAMERA_FLASH_SHA } from './lib/camera-flow.js';
import { names, sha256 } from './lib/checks.js';
import { targetSpec } from './lib/spec.js';

const DUMP_FILE = process.env.SEEK_E2E_DUMP_FILE ?? '';
const RUN_SWEEP = process.env.SEEK_E2E_SWEEP === '1';

/** The decrypted-slot files an archive carries, by flash address. */
function decryptedSlots(
  entries: readonly { name: string; data: Uint8Array }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entries) {
    const m = /decrypted_(1[0-9a-f]{7})\.bin$/.exec(e.name);
    if (m?.[1] !== undefined) out.set(m[1], sha256(e.data));
  }
  return out;
}

targetSpec({ title: 'Dump & decrypt — variants', slug: 'dump-variants' }, (ctx) => {
  it('connects to the camera', async () => {
    await ctx.target().wizard.connect();
  });

  it('the hand-picked legacy family dumps and decrypts', async () => {
    const w = ctx.target().wizard;
    await w.route('#/');
    await w.selectManualProfile('legacy-auth');
    const run = await w.runDump({
      panel: 'manual',
      button: 'Dump as this family',
      archive: /^seek_flash4m_legacy-auth_.+\.zip$/,
      timeoutMs: 20 * 60_000,
    });
    expect(run.status).toMatch(/^Done — /);
    const dir = names(run.entries)[0]?.split('/')[0] ?? '';
    expect(dir).toMatch(/^seek_flash4m_legacy-auth_/);
    expect(decryptedSlots(run.entries).size).toBeGreaterThanOrEqual(1);
  });

  it.skipIf(!RUN_SWEEP)('sweep mode probes every selector and saves what answers', async () => {
    const w = ctx.target().wizard;
    const run = await w.runDump({
      panel: 'dump',
      button: 'Dump all selectors (0x00–0xFF)',
      archive: /^seek_selectors_.+\.zip$/,
      timeoutMs: 40 * 60_000,
    });
    expect(run.status).toMatch(/selectors armed/);
    say(`sweep: ${run.status}`);
  });

  it.skipIf(DUMP_FILE === '')('offline-decrypts a dump file into the same plaintext', async () => {
    if (!existsSync(DUMP_FILE)) throw new Error(`SEEK_E2E_DUMP_FILE does not exist: ${DUMP_FILE}`);
    const w = ctx.target().wizard;
    const offline = await w.offlineDecrypt(DUMP_FILE);
    expect(offline.status).toMatch(/^Done —/);
    const slots = decryptedSlots(offline.entries);
    expect(slots.size).toBeGreaterThanOrEqual(1);
    say(`offline decrypt: ${String(slots.size)} slot(s) from ${DUMP_FILE}`);

    /* Cross-check against the camera's own dump: same bytes in, same plaintext
     * out. The input is this camera's flash, so a live dump decrypts to the
     * same per-slot plaintext. */
    const live = await w.dumpAndDecrypt(20 * 60_000);
    const liveImage = live.entries.find((e) => /^[^/]+\/flash_4m_usb[^/]*\.bin$/.test(e.name));
    if (CAMERA_FLASH_SHA !== '') {
      expect(sha256(liveImage?.data ?? new Uint8Array(0))).toBe(CAMERA_FLASH_SHA);
    }
    const liveSlots = decryptedSlots(live.entries);
    for (const [address, hash] of slots) {
      if (liveSlots.has(address)) expect(liveSlots.get(address), `slot ${address}`).toBe(hash);
    }
  });
});

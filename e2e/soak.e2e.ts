/* ==================================================================== *
 * Repeated dumps (soak) — `npm run e2e:soak` (emu by default; camera with
 * SEEK_E2E_TARGET=camera, read-only).
 *
 * N Dump & decrypt runs in a row (SEEK_E2E_SOAK_N, default 10). Every run's
 * whole-part image must have the same sha, and the timings are reported.
 * ==================================================================== */

import { expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { sha256 } from './lib/checks.js';
import { targetSpec } from './lib/spec.js';

const N = Math.max(1, Number(process.env.SEEK_E2E_SOAK_N ?? '10'));

const image = (entries: readonly { name: string; data: Uint8Array }[]): Uint8Array =>
  entries.find((e) => /^[^/]+\/flash_4m_usb[^/]*\.bin$/.test(e.name))?.data ?? new Uint8Array(0);

targetSpec({ title: `soak: ${String(N)} dumps`, slug: 'soak' }, (ctx) => {
  it('connects', async () => {
    await ctx.target().wizard.connect();
  });

  it(`reads the same sha on all ${String(N)} runs`, { timeout: N * 3 * 60_000 }, async () => {
    const w = ctx.target().wizard;
    const shas: string[] = [];
    const times: number[] = [];
    for (let i = 0; i < N; i++) {
      const run = await w.dumpAndDecrypt(20 * 60_000);
      shas.push(sha256(image(run.entries)));
      times.push(run.ms);
      say(
        `soak run ${String(i + 1)}/${String(N)}: ${(run.ms / 1000).toFixed(1)} s, sha ${(shas[i] ?? '').slice(0, 16)}`,
      );
    }
    const unique = [...new Set(shas)];
    expect(
      unique,
      `every run must read the same sha; got ${String(unique.length)} distinct`,
    ).toHaveLength(1);
    const min = Math.min(...times);
    const max = Math.max(...times);
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    say(
      `soak done: ${String(N)} runs, sha ${unique[0] ?? ''}; ` +
        `min ${(min / 1000).toFixed(1)}s, mean ${(mean / 1000).toFixed(1)}s, max ${(max / 1000).toFixed(1)}s, ` +
        `spread ${((max - min) / 1000).toFixed(1)}s`,
    );
  });
});

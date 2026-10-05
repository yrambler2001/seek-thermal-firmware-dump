/* ==================================================================== *
 * The supervised write flow — `npm run e2e:write`.
 *
 * Preserve 02 -> 03 -> 04. On the emulator (default) it is a normal write run.
 * On the camera it is gated by `approveWrite` (lib/supervised-write.ts): an
 * explicit env switch, a non-CI interactive TTY, and a typed-back confirmation
 * of the camera's own version and image sha. Under automation (vitest, no TTY)
 * the gate refuses, so NOTHING is ever written to the camera here.
 *
 * Proven this round:
 *   - the gate's decision on each target (emulator waves through; camera
 *     without the env refuses; camera with SEEK_E2E_WRITE=dry-run reaches the
 *     write boundary after step 02 and stops);
 *   - the write RPC sequence, on the emulator, via the full 02/03/04 run when
 *     SEEK_E2E_WRITE_FULL=1 (and always by `emulator.e2e.ts`).
 *
 * The camera's actual 03/04 execution (with the guard lifted) is wired but
 * reachable only by a human answering the confirmation at a terminal; it is
 * never run in this batch.
 * ==================================================================== */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { say } from './lib/browser.js';
import { NEVER_ON_THE_WIRE, writeGuardScript } from './lib/camera-flow.js';
import { describeWire, runState } from './lib/checks.js';
import { approveWrite, type WriteApproval } from './lib/supervised-write.js';
import { openTarget, targetUnavailable, wantedTarget } from './lib/target.js';
import { refusalsOf, wireOf } from './lib/target-tools.js';
import type { TargetHandle } from './lib/target.js';
import { EVERYTHING } from './lib/wizard.js';

const FULL = process.env.SEEK_E2E_WRITE_FULL === '1';
const KEEP = process.env.SEEK_E2E_KEEP === '1';
const HEADED = process.env.SEEK_E2E_HEADED === '1';
const SCRATCH =
  process.env.SEEK_E2E_SCRATCH ?? path.join(tmpdir(), `seek-e2e-write-${String(process.pid)}`);

const target = wantedTarget('emu');
const reason = targetUnavailable(target);
const title = `supervised write flow [${target}]`;
if (reason !== null) process.stderr.write(`\n[skip] ${title}: ${reason}\n`);

describe.skipIf(reason !== null)(title, () => {
  let handle: TargetHandle | null = null;
  const need = (): TargetHandle => {
    if (handle === null) throw new Error('the target is not open');
    return handle;
  };

  beforeAll(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    /* The target's own UI guard: everything on the emulator, read-only on the
     * camera. Only the confirmed camera write below reopens with EVERYTHING. */
    handle = await openTarget(target, { scratchDir: SCRATCH, headed: HEADED });
  });

  afterAll(async () => {
    await handle?.close().catch(() => undefined);
    handle = null;
    if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true });
  });

  it(
    'runs step 02, passes the write gate as the target allows, then writes only when safe',
    { timeout: 70 * 60_000 },
    async () => {
      const t = need();
      await t.wizard.connect();
      const step02 = await t.wizard.runPhase('read-build', {
        confirm: false,
        timeoutMs: 30 * 60_000,
      });
      const state = runState(step02.entries);
      expect(state.nextStep).toBe('commit');

      const approval: WriteApproval = await approveWrite(t.name, () =>
        Promise.resolve({
          token: `${state.expectedVersion ?? '?'}:${String(state.patch?.sites.length ?? 0)}sites`,
          describe:
            `camera firmware ${state.expectedVersion ?? '?'}, run ${state.runId}, ` +
            `about to COMMIT a patch to the active bank and later restore it`,
        }),
      );
      say(
        `write gate on ${t.name}: approved=${String(approval.approved)} dry=${String(approval.dry)} — ${approval.reason}`,
      );

      if (!approval.approved) {
        /* Camera default, or a camera dry run: nothing is written. We stopped
         * at the write boundary, step 02 done, next step commit. The page's
         * guard is the strict one, so its record is what went to the camera. */
        expect(t.name).toBe('camera');
        expect(t.writesSafe).toBe(false);
        const wire = await wireOf(t);
        say(`camera wire at the write boundary: ${describeWire(wire)}`);
        for (const op of NEVER_ON_THE_WIRE) expect(wire.has(op), op).toBe(false);
        expect(await refusalsOf(t), 'nothing was refused (no write was even tried)').toEqual([]);
        const text = await t.page.evaluate(() => document.body.innerText);
        expect(text).not.toContain('Patch & dump — done');
        return;
      }

      if (t.name === 'emu') {
        if (!FULL) {
          say(
            'emulator: gate allowed; the full 03/04 continuation is proven by emulator.e2e.ts (SEEK_E2E_WRITE_FULL=1 to run it here)',
          );
          return;
        }
        await t.wizard.runPhase('patch-dump', { confirm: true, timeoutMs: 60 * 60_000 });
        await t.wizard.runPhase('restore-verify', { confirm: true, timeoutMs: 60 * 60_000 });
        const text = await t.page.evaluate(() => document.body.innerText);
        expect(text).toContain('Verified — a perfect match.');
        return;
      }

      /* Camera, confirmed at a TTY: lift the page guard for this run only and
       * write. Reachable only by a human; never under automation. */
      say('camera write CONFIRMED — reopening with the lifted guard');
      await handle?.close();
      handle = await openTarget('camera', {
        scratchDir: SCRATCH,
        headed: HEADED,
        uiGuard: EVERYTHING,
        preloadSource: writeGuardScript({ lifted: true }),
      });
      const t2 = need();
      await t2.wizard.connect();
      await t2.wizard.loadRunFile(step02.runFile.path);
      await t2.wizard.runPhase('patch-dump', { confirm: true, timeoutMs: 60 * 60_000 });
      await t2.wizard.runPhase('restore-verify', { confirm: true, timeoutMs: 60 * 60_000 });
      const text = await t2.page.evaluate(() => document.body.innerText);
      expect(text).toContain('Verified — a perfect match.');
    },
  );
});

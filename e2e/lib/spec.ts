/**
 * The boilerplate every target-agnostic spec shares: pick the target, skip
 * cleanly when it is not available, open it before the tests and tear it down
 * after, and keep a scratch directory that is deleted unless `SEEK_E2E_KEEP=1`.
 *
 * A spec calls `targetSpec(...)` and gets a `ctx.target()` inside its tests.
 */

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe } from 'vitest';

import { say } from './browser.js';
import {
  openTarget,
  targetUnavailable,
  wantedTarget,
  type OpenTargetOptions,
  type TargetHandle,
  type TargetName,
} from './target.js';

export const KEEP = process.env.SEEK_E2E_KEEP === '1';
export const HEADED = process.env.SEEK_E2E_HEADED === '1';

export interface SpecContext {
  readonly name: TargetName;
  target(): TargetHandle;
  readonly scratch: string;
}

export function targetSpec(
  options: {
    readonly title: string;
    /** The default target when `SEEK_E2E_TARGET` is unset. */
    readonly fallback?: TargetName;
    readonly source?: OpenTargetOptions['source'];
    readonly uiGuard?: OpenTargetOptions['uiGuard'];
    /** A slug for the scratch directory. */
    readonly slug: string;
  },
  body: (ctx: SpecContext) => void,
): void {
  const target = wantedTarget(options.fallback);
  const reason = targetUnavailable(target);
  const title = `${options.title} [${target}]`;
  if (reason !== null) process.stderr.write(`\n[skip] ${title}: ${reason}\n`);

  const scratch =
    process.env.SEEK_E2E_SCRATCH ??
    path.join(tmpdir(), `seek-e2e-${options.slug}-${String(process.pid)}`);
  let handle: TargetHandle | null = null;

  describe.skipIf(reason !== null)(title, () => {
    beforeAll(async () => {
      mkdirSync(scratch, { recursive: true });
      say(`scratch: ${scratch}`);
      handle = await openTarget(target, {
        scratchDir: scratch,
        ...(options.source === undefined ? {} : { source: options.source }),
        headed: HEADED,
        ...(options.uiGuard === undefined ? {} : { uiGuard: options.uiGuard }),
      });
    });

    afterAll(async () => {
      await handle?.close().catch((error: unknown) => {
        say(`close failed: ${String(error)}`);
      });
      handle = null;
      if (!KEEP) rmSync(scratch, { recursive: true, force: true });
      else say(`kept: ${scratch}`);
    });

    body({
      name: target,
      scratch,
      target: () => {
        if (handle === null) throw new Error('the target is not open (an earlier step failed)');
        return handle;
      },
    });
  });
}

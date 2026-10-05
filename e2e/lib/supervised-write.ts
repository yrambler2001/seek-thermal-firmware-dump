/**
 * The gate every flash-writing flow on the REAL camera must pass. On the
 * emulator target there is nothing to gate — writing is the point — so it waves
 * through. On the camera target it is deliberately hard to pass, and impossible
 * to pass by accident or in CI:
 *
 *   1. the env switch `SEEK_E2E_WRITE=i-understand` must be set;
 *   2. the session must be interactive — a real TTY on stdin and stdout;
 *   3. `CI` must not be set;
 *   4. a human must type back the challenge shown (the camera's firmware
 *      version and the sha256 of the image read THIS run), within a timeout.
 *
 * `SEEK_E2E_WRITE=dry-run` is the third state: everything up to the first write
 * runs, and the gate then stops the flow (`approved: false, dry: true`) before
 * a single write RPC — the way the camera target's write flow is proven without
 * writing. Any other value, or none, is a hard refusal.
 *
 * This module decides ONLY whether a write may proceed. The other guards (the
 * vendor-id device pick, the page-side write guard, the expected RPC sequence)
 * live where they always do and are never relaxed here.
 */

import { createInterface } from 'node:readline';

import { say } from './browser.js';

export interface WriteApproval {
  readonly approved: boolean;
  /** True when the flow should run right up to, and stop before, the first write. */
  readonly dry: boolean;
  readonly reason: string;
}

export interface WriteChallenge {
  /** What the operator must type back, e.g. `1.3.0.0:40447c7e`. */
  readonly token: string;
  /** Shown to the operator in full. */
  readonly describe: string;
}

const APPROVED_SAFE: WriteApproval = { approved: true, dry: false, reason: 'emulator target' };

/**
 * The gate for a write flow on `target`. `challenge()` is called only once the
 * static checks pass, so it can read the camera first (version, image sha).
 */
export async function approveWrite(
  targetName: 'emu' | 'camera',
  challenge: () => Promise<WriteChallenge>,
  options: { readonly timeoutMs?: number } = {},
): Promise<WriteApproval> {
  if (targetName === 'emu') return APPROVED_SAFE;

  const mode = process.env.SEEK_E2E_WRITE ?? '';
  if (mode !== 'i-understand' && mode !== 'dry-run') {
    return {
      approved: false,
      dry: false,
      reason:
        'a camera write needs SEEK_E2E_WRITE=i-understand (or =dry-run to rehearse) — refusing',
    };
  }
  /* A dry run never writes, so it needs neither a TTY nor a non-CI session: it
   * is exactly the non-interactive rehearsal, and it runs the whole flow up to
   * the first write before stopping. */
  if (mode === 'dry-run') {
    const c = await challenge();
    return {
      approved: false,
      dry: true,
      reason: `dry run: everything up to the first write ran; ${c.describe}`,
    };
  }

  if (process.env.CI !== undefined && process.env.CI !== '') {
    return { approved: false, dry: false, reason: 'CI is set — a camera write never runs in CI' };
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return {
      approved: false,
      dry: false,
      reason: 'stdin/stdout is not a TTY — a camera write needs an interactive confirmation',
    };
  }

  const c = await challenge();
  say(`\nABOUT TO WRITE THE REAL CAMERA'S FLASH.\n${c.describe}`);
  const typed = await prompt(
    `Type exactly "${c.token}" to proceed (anything else cancels): `,
    options.timeoutMs ?? 120_000,
  );
  if (typed !== c.token) {
    return {
      approved: false,
      dry: false,
      reason: `confirmation did not match (${JSON.stringify(typed)})`,
    };
  }
  return { approved: true, dry: false, reason: 'confirmed at the terminal' };
}

function prompt(question: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const timer = setTimeout(() => {
      rl.close();
      resolve('');
    }, timeoutMs);
    rl.question(question, (answer) => {
      clearTimeout(timer);
      rl.close();
      resolve(answer.trim());
    });
  });
}

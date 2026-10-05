/* ==================================================================== *
 * The supervised write gate's refusals — `npm run e2e:gate`.
 *
 * No browser, no device: this pins the logic that keeps a camera write from
 * ever running by accident or in CI (`approveWrite`, lib/supervised-write.ts).
 * It is the proof the gate refuses; the proof it ALLOWS the right flow is the
 * write flows themselves running on the emulator target.
 * ==================================================================== */

import { afterEach, describe, expect, it } from 'vitest';

import { approveWrite, type WriteChallenge } from './lib/supervised-write.js';

const CHALLENGE: WriteChallenge = { token: '1.3.0.0:40447c7e', describe: 'test' };
const challenge = (): Promise<WriteChallenge> => Promise.resolve(CHALLENGE);

describe('the supervised write gate', () => {
  const saved = { write: process.env.SEEK_E2E_WRITE, ci: process.env.CI };
  afterEach(() => {
    if (saved.write === undefined) delete process.env.SEEK_E2E_WRITE;
    else process.env.SEEK_E2E_WRITE = saved.write;
    if (saved.ci === undefined) delete process.env.CI;
    else process.env.CI = saved.ci;
  });

  it('waves the emulator target through without any confirmation', async () => {
    const verdict = await approveWrite('emu', challenge);
    expect(verdict).toEqual({ approved: true, dry: false, reason: 'emulator target' });
  });

  it('refuses the camera target without SEEK_E2E_WRITE', async () => {
    delete process.env.SEEK_E2E_WRITE;
    const verdict = await approveWrite('camera', challenge);
    expect(verdict.approved).toBe(false);
    expect(verdict.dry).toBe(false);
    expect(verdict.reason).toMatch(/SEEK_E2E_WRITE=i-understand/);
  });

  it('refuses the camera target in CI even with the env set', async () => {
    process.env.SEEK_E2E_WRITE = 'i-understand';
    process.env.CI = 'true';
    const verdict = await approveWrite('camera', challenge);
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/CI is set/);
  });

  it('refuses the camera target when stdin is not a TTY (as under vitest)', async () => {
    process.env.SEEK_E2E_WRITE = 'i-understand';
    delete process.env.CI;
    /* vitest runs us without a TTY, which is exactly the non-interactive case. */
    expect(process.stdin.isTTY).toBeFalsy();
    const verdict = await approveWrite('camera', challenge);
    expect(verdict.approved).toBe(false);
    expect(verdict.reason).toMatch(/not a TTY/);
  });

  it('dry-run reaches the challenge and then stops before any write', async () => {
    process.env.SEEK_E2E_WRITE = 'dry-run';
    delete process.env.CI;
    let asked = false;
    const verdict = await approveWrite('camera', () => {
      asked = true;
      return Promise.resolve(CHALLENGE);
    });
    expect(asked).toBe(true);
    expect(verdict.approved).toBe(false);
    expect(verdict.dry).toBe(true);
    expect(verdict.reason).toContain('dry run');
  });
});

/**
 * Cutting and restoring power to the camera's USB port, for the unplug /
 * replug / power-cycle tests on the REAL camera.
 *
 * Two modes, one interface:
 *
 *   manual   a human does it. `off()` prints "unplug the camera now" and waits
 *            until the camera is actually gone from the bus; `on()` prints
 *            "plug it back in" and waits until it is back. Usable in a
 *            supervised, interactive run — never unattended.
 *
 *   rp2040   the user's software USB power switch at
 *            /Users/.../usb-port-switch-rp2040 (SEEK_E2E_SWITCH_DIR): an RP2040
 *            that cuts only the +5V line of a pass-through cable, driven over
 *            USB-CDC serial with line commands `on <1|2>`, `off <1|2>`,
 *            `cycle <1|2> [ms]`, `status`, `id` (vendor 2e8a, unit USBSW-1,
 *            GP2 = channel 1, GP3 = channel 2). This driver shells out to that
 *            project's own `switch.js` so its tested serial code and native
 *            binding are reused and nothing here is rebuilt or modified.
 *
 * THE CHANNEL IS NOT GUESSED. `off/on/cycle` refuse unless
 * `SEEK_E2E_SWITCH_CHANNEL` (1 or 2) says which channel the camera is on —
 * toggling the wrong one would cut power to whatever else is on the switch.
 * `info()` is read-only (`id`) and always safe.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

import { REPO_ROOT, say } from './browser.js';

/** The rp2040 switch project, overridable; the default is the sibling checkout. */
export function switchProjectDir(): string {
  return (
    process.env.SEEK_E2E_SWITCH_DIR ?? path.resolve(REPO_ROOT, '..', '..', 'usb-port-switch-rp2040')
  );
}

function run(dir: string, args: readonly string[], timeoutMs = 8000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(dir, 'switch.js'), ...args],
      { cwd: dir, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error)
          reject(new Error(`switch.js ${args.join(' ')}: ${stderr.trim() || error.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

/** The switch's `id` reply, or why it could not be reached — read-only. */
export async function switchInfo(): Promise<{ ok: boolean; detail: string }> {
  const dir = switchProjectDir();
  if (!existsSync(path.join(dir, 'switch.js'))) {
    return { ok: false, detail: `no switch.js under ${dir} (set SEEK_E2E_SWITCH_DIR)` };
  }
  try {
    const reply = await run(dir, ['id']);
    return { ok: reply.startsWith('OK'), detail: reply };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export interface PowerSwitch {
  readonly mode: 'manual' | 'rp2040';
  describe(): string;
  /** Cut power (unplug). */
  off(): Promise<void>;
  /** Restore power (replug). */
  on(): Promise<void>;
  /** off, wait, on. */
  cycle(ms?: number): Promise<void>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A human does the plugging; the driver waits for the bus to agree. */
export class ManualPowerSwitch implements PowerSwitch {
  readonly mode = 'manual' as const;
  private readonly present: () => Promise<boolean>;
  private readonly waitMs: number;

  constructor(options: { present: () => Promise<boolean>; waitMs?: number }) {
    this.present = options.present;
    this.waitMs = options.waitMs ?? 120_000;
  }

  describe(): string {
    return 'manual power switch — a human unplugs and replugs the camera';
  }

  private async until(want: boolean, what: string): Promise<void> {
    say(`ACTION NEEDED: ${what}`);
    const deadline = Date.now() + this.waitMs;
    for (;;) {
      if ((await this.present().catch(() => !want)) === want) {
        say(`the camera is ${want ? 'back' : 'gone'} — continuing`);
        return;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting: ${what}`);
      await sleep(500);
    }
  }

  off(): Promise<void> {
    return this.until(false, 'UNPLUG the camera now');
  }

  on(): Promise<void> {
    return this.until(true, 'PLUG the camera back in now');
  }

  async cycle(ms = 3000): Promise<void> {
    await this.off();
    await sleep(ms);
    await this.on();
  }
}

/**
 * The RP2040 switch, driving ONE channel. Never toggles until the channel is
 * known (`SEEK_E2E_SWITCH_CHANNEL`). Built this round; not exercised — the user
 * must first confirm which channel the camera is on.
 */
export class Rp2040PowerSwitch implements PowerSwitch {
  readonly mode = 'rp2040' as const;
  private readonly dir: string;
  private readonly channel: 1 | 2;

  constructor(channel: 1 | 2, dir: string = switchProjectDir()) {
    this.dir = dir;
    this.channel = channel;
  }

  /** Builds one from the environment, or null when the channel is not set. */
  static fromEnv(): Rp2040PowerSwitch | null {
    const raw = process.env.SEEK_E2E_SWITCH_CHANNEL;
    if (raw !== '1' && raw !== '2') return null;
    return new Rp2040PowerSwitch(raw === '1' ? 1 : 2);
  }

  describe(): string {
    return `rp2040 switch channel ${String(this.channel)} (${this.dir})`;
  }

  off(): Promise<void> {
    return this.command('off');
  }

  on(): Promise<void> {
    return this.command('on');
  }

  async cycle(ms = 3000): Promise<void> {
    await run(this.dir, ['cycle', String(this.channel), String(ms)]);
  }

  private async command(verb: 'on' | 'off'): Promise<void> {
    const reply = await run(this.dir, [verb, String(this.channel)]);
    if (!reply.startsWith('OK')) throw new Error(`switch ${verb}: ${reply}`);
  }
}

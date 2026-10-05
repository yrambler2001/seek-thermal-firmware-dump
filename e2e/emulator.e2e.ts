/* ==================================================================== *
 * The web app, end to end, on the EMULATED camera — `npm run e2e:emu`.
 *
 * Chrome (the installed one, headless unless SEEK_E2E_HEADED=1) loads the app
 * from its own Vite dev server. Its `navigator.usb` is the bridge's stand-in,
 * and every device call is served in Node by the FW-V1 emulator booted from
 * the bench camera's own dump (the corpus entry 101310HSNEA2, Compact 1.3.0.0
 * — the camera this toolkit is run against). Everything goes through the real
 * UI: the Connect pick in the chooser, Dump & decrypt, then the Preserve
 * wizard's steps 02, 03 and 04 with their confirmations, and every "Your turn:
 * press Connect device" ask the restarts raise answered in the chooser.
 *
 * A restart is modelled the way the camera does it in Chrome (`EmulatorBus`):
 * the reset drops the device, the emulator reboots from the flash it holds,
 * and the camera comes back as a NEW device Chrome has no grant for — no
 * connect event, an empty getDevices() — so the wizard must ask, and the run
 * only continues once the test picks the camera again.
 *
 * What it proves, beyond "the steps said done": each run file's name and
 * folders; the dump of the whole part equal to the emulated part byte for
 * byte (the raw dump to the post-commit part, the delivered image to the
 * as-booted one); the verify re-read equal to the backup; the camera's flash
 * after the restore identical to how it booted; and the summary's words.
 * ==================================================================== */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { Page } from 'puppeteer-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { EMU_DIR } from '../packages/core/test/emulator/suite.js';
import { UsbBridge } from './lib/bridge.js';
import {
  CHROME_PATH,
  launchChrome,
  say,
  startDevServer,
  type DevServer,
  type LaunchedChrome,
} from './lib/browser.js';
import { describeWire, entry, names, runState, sha256, wireSince } from './lib/checks.js';
import { EmulatorBus } from './lib/emulator-bus.js';
import { EVERYTHING, PHASE_FOLDER, Wizard, type PhaseRun } from './lib/wizard.js';

const CORPUS_ENTRY = '101310HSNEA2/dump';
const JEDEC = '010215';
/** The bench camera's part as it booted (the J-Link dump, TESTING.md sec. 34). */
const AS_BOOTED_SHA = '40447c7e6da5cbc84621f4694ffff5bda0f783e7807a45e80443383b19a8eb72';
/** The same part with the five-site patch committed (TESTING.md sec. 36.2). */
const POST_COMMIT_SHA = 'b22e9e20a9928241348c089f4e046c62f8a3f73db0ecb29dd2ce17eaa1cb6dcd';
const FLASH_BYTES = 4 * 1024 * 1024;

const SCRATCH =
  process.env.SEEK_E2E_SCRATCH ?? path.join(tmpdir(), `seek-e2e-emu-${String(process.pid)}`);
const KEEP = process.env.SEEK_E2E_KEEP === '1';
const HEADED = process.env.SEEK_E2E_HEADED === '1';

function unavailable(): string | null {
  if (EMU_DIR === null) return 'no FW-V1 emulator found (set SEEK_EMU_DIR)';
  if (!existsSync(CHROME_PATH)) return `no Chrome at ${CHROME_PATH} (set SEEK_E2E_CHROME)`;
  return null;
}

const UNAVAILABLE = unavailable();
if (UNAVAILABLE !== null) process.stderr.write(`\n[skip] e2e on the emulator: ${UNAVAILABLE}\n`);

describe.skipIf(UNAVAILABLE !== null)('the web app on the emulated camera (bridge)', () => {
  let bus: EmulatorBus | null = null;
  let server: DevServer | null = null;
  let chrome: LaunchedChrome | null = null;
  let bridge: UsbBridge | null = null;
  let page: Page | null = null;
  let wizard: Wizard | null = null;
  const runs: Partial<Record<string, PhaseRun>> = {};

  const need = <T>(value: T | null, what: string): T => {
    if (value === null) throw new Error(`${what} is not up (an earlier step failed)`);
    return value;
  };

  beforeAll(async () => {
    mkdirSync(SCRATCH, { recursive: true });
    say(`scratch: ${SCRATCH}`);
    bus = await EmulatorBus.start({
      emuDir: EMU_DIR ?? '',
      entryId: CORPUS_ENTRY,
      jedec: JEDEC,
      scratchDir: path.join(SCRATCH, 'flash'),
      log: say,
    });
    server = await startDevServer();
    chrome = await launchChrome({ scratchDir: SCRATCH, headless: !HEADED });
    page = await chrome.browser.newPage();
    page.on('pageerror', (error) => {
      say(`page error: ${String(error)}`);
    });
    bridge = await UsbBridge.attach(page, bus, { log: say });
    await page.goto(`${server.url}#/`, { waitUntil: 'networkidle0' });
    wizard = new Wizard({
      page,
      prompter: bridge,
      downloads: chrome.downloads,
      guard: EVERYTHING,
      camera: /PIR206|Seek|Thermal|289d/i,
    });
  });

  afterAll(async () => {
    if (bridge !== null) {
      say(`bridge timeline:\n  ${bridge.timeline.join('\n  ')}`);
      say(`wire totals: ${describeWire(bridge.counts)}`);
      bridge.detach();
    }
    await chrome?.close();
    await server?.close();
    await bus?.close();
    if (bus !== null) {
      for (const audit of bus.audits) {
        say(
          `emulator ${String(audit.boot)} (${audit.from}): delivered ` +
            `${String(audit.audit.server?.completions.delivered ?? '?')}, dropped ` +
            String(audit.audit.server?.completions.dropped ?? '?') +
            (audit.unexpected.length === 0 ? '' : `; NOTE: ${audit.unexpected.join(' | ')}`),
        );
      }
    }
    if (!KEEP) rmSync(SCRATCH, { recursive: true, force: true });
    else say(`kept: ${SCRATCH}`);
  });

  it('connects through the chooser, and Dump & decrypt reads the camera', async () => {
    const w = need(wizard, 'the wizard');
    const b = need(bridge, 'the bridge');
    const name = await w.connect();
    expect(name).toMatch(/PIR206 Thermal Camera/);

    const before = new Map(b.counts);
    const dump = await w.dumpAndDecrypt(30 * 60_000);
    const wire = wireSince(before, b.counts);
    say(`dump wire: ${describeWire(wire)}`);
    expect(dump.status).toMatch(/^Done — (\d+)\/\1 windows read/);
    /* The dump view's promise: no write, no commit, no reset on the wire. */
    for (const op of ['out 0x50', 'out 0x51', 'out 0x59']) expect(wire.has(op), op).toBe(false);

    const all = names(dump.entries);
    const dir = all[0]?.split('/')[0] ?? '';
    expect(dir).toMatch(/^seek_flash4m_/);
    expect(all).toContain(`${dir}/manifest.json`);
    expect(all).toContain(`${dir}/README.md`);
    /* The whole-image file at the archive's top: every window the dump read, at
     * its address, 0xFF where it read nothing — on this part, the part itself. */
    const combined = dump.entries.find((e) => /^[^/]+\/flash_4m_usb[^/]*\.bin$/.test(e.name));
    expect(combined?.data.length).toBe(FLASH_BYTES);
    expect(sha256(combined?.data ?? new Uint8Array(0)), 'the dump: the emulated part').toBe(
      AS_BOOTED_SHA,
    );
  });

  it('step 02 reads & builds: no restart on the emulator, the run file in 02-read-build/', async () => {
    const w = need(wizard, 'the wizard');
    const b = need(bridge, 'the bridge');
    await w.openPreserve();
    const before = new Map(b.counts);
    const run = await w.runPhase('read-build', { confirm: false, timeoutMs: 45 * 60_000 });
    runs['read-build'] = run;
    const wire = wireSince(before, b.counts);
    say(`step 02 wire: ${describeWire(wire)}`);
    for (const op of ['out 0x50', 'out 0x51']) expect(wire.has(op), op).toBe(false);
    /* The emulator's reader is never spent, so the probe never reboots it. */
    expect(run.asks).toBe(0);

    const all = names(run.entries);
    expect(all.slice(0, 2)).toEqual(['preserve_run.json', 'README.md']);
    for (const file of [
      'preserve_backup_windows.bin',
      'preserve_bank_capture.bin',
      'preserve_image_plain.bin',
      'preserve_patch_plain_patched.bin',
      'manifest.json',
      'README.md',
    ]) {
      expect(all).toContain(`${PHASE_FOLDER['read-build']}/${file}`);
    }
    expect(all.filter((n) => /^0[34]-/.test(n))).toEqual([]);
    const state = runState(run.entries);
    expect(state.expectedVersion).toBe('1.3.0.0');
    expect(state.steps.backup?.status).toBe('done');
    expect(state.steps.patch?.status).toBe('done');
    expect(state.nextStep).toBe('commit');
    expect(await w.redAlerts()).toEqual([]);
    expect(
      await w.isEnabled(
        'section[aria-labelledby="preserve-patch-dump-heading"]',
        Wizard.startLabel('patch-dump'),
      ),
    ).toBe(true);
  });

  it('step 03 patches & dumps: the restart asks for the camera, the whole part comes back', async () => {
    const w = need(wizard, 'the wizard');
    const run = await w.runPhase('patch-dump', { confirm: true, timeoutMs: 60 * 60_000 });
    runs['patch-dump'] = run;
    expect(run.asks).toBeGreaterThanOrEqual(1);

    const all = names(run.entries);
    const folder = PHASE_FOLDER['patch-dump'];
    expect(all).toContain(`${folder}/preserve_dump_postwrite.bin`);
    expect(all).toContain(`${folder}/preserve_dump_original.bin`);
    expect(all).toContain(`${PHASE_FOLDER['read-build']}/preserve_backup_windows.bin`);
    expect(all.filter((n) => n.startsWith('04-'))).toEqual([]);
    const raw = entry(run.entries, `${folder}/preserve_dump_postwrite.bin`);
    const delivered = entry(run.entries, `${folder}/preserve_dump_original.bin`);
    expect(raw.length).toBe(FLASH_BYTES);
    expect(sha256(raw), 'the raw dump: the post-commit part, byte for byte').toBe(POST_COMMIT_SHA);
    expect(sha256(delivered), 'the delivered image: the part as it booted').toBe(AS_BOOTED_SHA);
    const state = runState(run.entries);
    expect(state.steps.commit?.status).toBe('done');
    expect(state.steps.drain?.status).toBe('done');
    expect(state.nextStep).toBe('restore');
    expect(state.deliveredSha256).toBe(AS_BOOTED_SHA);
  });

  it('step 04 restores & verifies through a restart; the summary says it all matched', async () => {
    const w = need(wizard, 'the wizard');
    const p = need(page, 'the page');
    const run = await w.runPhase('restore-verify', { confirm: true, timeoutMs: 60 * 60_000 });
    runs['restore-verify'] = run;
    expect(run.asks).toBeGreaterThanOrEqual(1);

    const all = names(run.entries);
    const verifyFile = `${PHASE_FOLDER['restore-verify']}/preserve_verify_windows.bin`;
    expect(all).toContain(verifyFile);
    expect(all).toContain(`${PHASE_FOLDER['patch-dump']}/preserve_dump_original.bin`);
    const backup = entry(run.entries, `${PHASE_FOLDER['read-build']}/preserve_backup_windows.bin`);
    expect(sha256(entry(run.entries, verifyFile)), 'the verify re-read equals the backup').toBe(
      sha256(backup),
    );
    const state = runState(run.entries);
    expect(state.nextStep).toBe('done');
    expect(state.verify).toEqual({ diffBytes: 0, windowsRead: 31, badWindows: [] });

    const text = await p.evaluate(() => document.body.innerText);
    expect(text).toContain('Done — your firmware is preserved');
    expect(text).toContain('matches the backup on all 31 blocks');
    expect(text).toContain('Verified — a perfect match.');
    expect(await w.redAlerts()).toEqual([]);
  });

  it('the camera is back exactly as it booted, and the emulators stopped clean', async () => {
    const b = need(bus, 'the bus');
    const br = need(bridge, 'the bridge');
    expect(br.refusals).toEqual([]);
    expect(await br.pageRefusals()).toEqual([]);
    await b.settled();
    expect(b.rebootFailure).toBeNull();
    expect(b.deaths).toEqual([]);
    /* Two restarts: the drain's reset (step 03) and the restore's (step 04). */
    expect(b.reboots.map((r) => r.boot)).toEqual([1, 2]);
    say(
      `reboots: ${b.reboots.map((r) => `emulator ${String(r.boot)} from ${r.from} in ${String(r.ms)} ms`).join('; ')}`,
    );
    /* The last boot's as-booted image is the camera after the restore. */
    const last = b.bootImages().at(-1);
    expect(last?.index).toBe(2);
    expect(sha256(new Uint8Array(readFileSync(last?.flashOut ?? '')))).toBe(AS_BOOTED_SHA);

    await b.close();
    expect(EmulatorBus.liveCount()).toBe(0);
    for (const audit of b.audits) {
      expect(audit.audit.death, `emulator ${String(audit.boot)}`).toBeNull();
      expect(audit.audit.server?.completions.dropped, `emulator ${String(audit.boot)}`).toBe(0);
    }
    for (const run of Object.values(runs)) {
      if (run === undefined) continue;
      say(
        `${run.phase}: ${(run.ms / 1000).toFixed(1)} s, ${String(run.asks)} ask(s), ${run.runFile.name}`,
      );
    }
  });
});

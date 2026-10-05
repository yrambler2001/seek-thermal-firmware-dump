/**
 * What a target-agnostic spec needs beyond `TargetHandle`, each answered the
 * same way on both targets:
 *
 *  - the wire and the refusals: the bridge's counts on the emulator, the page's
 *    write guard on the camera;
 *  - Preserve step 02 with the plain reset allowed (the camera's guard lets one
 *    out only while step 02 runs; the emulator needs nothing);
 *  - the grants the page holds, and the revocations the browser reported;
 *  - a reload of a page that is mid-run — Chrome asks "Leave site?" (answered
 *    here as a person would, "Leave"), Electron reports `will-prevent-unload`;
 *  - a second window on the same app and the same browser profile;
 *  - the image a whole-part dump must come back as.
 */

import { TargetType, type Page } from 'puppeteer-core';

import { UsbBridge } from './bridge.js';
import { say } from './browser.js';
import { CAMERA_FLASH_SHA, CAMERA_NAME } from './camera-flow.js';
import { countsOf, guardOf, setGuard } from './electron-camera.js';
import type { TargetHandle } from './target.js';
import { EVERYTHING, READ_ONLY_CAMERA, Wizard } from './wizard.js';

/** The bench Compact 1.3.0.0's part as it booted: what the emulator boots, and the camera holds. */
export const BENCH_IMAGE_SHA = '40447c7e6da5cbc84621f4694ffff5bda0f783e7807a45e80443383b19a8eb72';
/** That part's active-slot firmware image, decrypted (the run state's `imageSha256`). */
export const BENCH_PLAIN_SHA = '862717a8a605021def7858ac0c04ad4aa1abe23d357d6c2417699939137f481c';

/** The whole-part image a Dump & decrypt must produce here, or '' to skip the check. */
export function expectedImageSha(t: TargetHandle): string {
  return t.name === 'emu' ? BENCH_IMAGE_SHA : CAMERA_FLASH_SHA;
}

/** The decrypted active slot's sha, when the target is the bench part; else null. */
export function expectedPlainSha(t: TargetHandle): string | null {
  return expectedImageSha(t) === BENCH_IMAGE_SHA ? BENCH_PLAIN_SHA : null;
}

/** The emulator target's bridge (its `prompter`), or null on the camera. */
export function bridgeOf(t: TargetHandle): UsbBridge | null {
  return t.prompter instanceof UsbBridge ? t.prompter : null;
}

/**
 * The requests that went out, by `in 0x4f`-style key: the bridge's counts (all
 * pages, all loads) on the emulator; this page load's write guard on the camera.
 */
export async function wireOf(t: TargetHandle, page: Page = t.page): Promise<Map<string, number>> {
  const bridge = bridgeOf(t);
  if (bridge !== null) return new Map(bridge.counts);
  return countsOf(await guardOf(page));
}

/** Every request a guard refused on this target (a passing run has none). */
export async function refusalsOf(t: TargetHandle, page: Page = t.page): Promise<string[]> {
  const bridge = bridgeOf(t);
  if (bridge !== null) return [...bridge.refusals, ...(await bridge.pageRefusals())];
  const guard = await guardOf(page);
  return [...guard.refusals, ...(t.app?.timeline.filter((line) => line.includes('REFUSED')) ?? [])];
}

/** Lets the camera's guard pass the plain reset step 02 may send, while `page` runs it. */
export async function allowStep02Reset(t: TargetHandle, on: boolean, page = t.page): Promise<void> {
  if (t.name === 'camera') await setGuard(page, { allowReset: on });
}

/** Runs `body` (Preserve step 02) with the plain reset allowed, and shut again after. */
export async function duringStep02<T>(
  t: TargetHandle,
  body: () => Promise<T>,
  page: Page = t.page,
): Promise<T> {
  await allowStep02Reset(t, true, page);
  try {
    return await body();
  } finally {
    await allowStep02Reset(t, false, page).catch(() => undefined);
  }
}

/** How many devices `navigator.usb.getDevices()` answers on `page`. */
export function grantedDevices(page: Page): Promise<number> {
  return page.evaluate(async () => (await navigator.usb.getDevices()).length);
}

/** The browser's own record of revoked grants: Electron's `usb-device-revoked`,
 *  or the bridge's `forget()` line on the emulator. */
export function revocationsOf(t: TargetHandle): string[] {
  const bridge = bridgeOf(t);
  if (bridge !== null) return bridge.timeline.filter((line) => line.includes('forget()'));
  return t.app?.revocations() ?? [];
}

/** Waits until run panel `panel`'s bar reads at least `percent`. */
export async function waitForProgress(
  page: Page,
  panel: string,
  percent: number,
  timeoutMs = 10 * 60_000,
): Promise<number> {
  const handle = await page.waitForFunction(
    (id: string, want: number) => {
      /* The bar sits beside the status line, in the same block of the RunPanel. */
      const bar = document
        .getElementById(`${id}-status`)
        ?.parentElement?.querySelector('[role="progressbar"]');
      const value = Number(bar?.getAttribute('aria-valuenow') ?? 'NaN');
      return Number.isFinite(value) && value >= want ? value : false;
    },
    { timeout: timeoutMs, polling: 250 },
    panel,
    percent,
  );
  return Number(await handle.jsonValue());
}

/** The app's shell is up again after a navigation: the Connect step is drawn. */
export async function waitForApp(page: Page): Promise<void> {
  await page.waitForSelector('#device-description', { timeout: 60_000 });
}

/**
 * Reloads `t.page`. A page mid-run asks before it unloads; the answer here is
 * the person's "Leave". Returns whether the page asked.
 */
export async function reloadAnswering(t: TargetHandle): Promise<{ readonly asked: boolean }> {
  let asked = false;
  const onDialog = (dialog: { type: () => string; accept: () => Promise<void> }): void => {
    if (dialog.type() === 'beforeunload') asked = true;
    say(`dialog: ${dialog.type()} — answered "Leave"`);
    /* On Electron the main process has already let the unload through
     * (`will-prevent-unload`), so by the time CDP's accept arrives there may be
     * no dialog left to answer — that is not a failure. */
    dialog.accept().catch((error: unknown) => {
      say(`dialog: already answered (${String(error).slice(0, 80)})`);
    });
  };
  const before = t.app?.unloadAsks ?? 0;
  t.page.on('dialog', onDialog);
  try {
    await t.page.reload({ waitUntil: 'networkidle0', timeout: 120_000 });
  } finally {
    t.page.off('dialog', onDialog);
  }
  await waitForApp(t.page);
  if (t.app !== null) asked = t.app.unloadAsks > before;
  return { asked };
}

export interface SecondWindow {
  readonly page: Page;
  readonly wizard: Wizard;
  /** The emulator's second bridge (null on the camera). */
  readonly bridge: UsbBridge | null;
  /** What THIS window sent: its own bridge's counts, or its own page's guard. */
  wire(): Promise<Map<string, number>>;
  /** What this window's guards refused. */
  refusals(): Promise<string[]>;
  close(): Promise<void>;
}

/**
 * A second window on the same app, in the same browser profile — so it holds
 * the same grants as the first. On the emulator that is a second tab whose
 * bridge shares the first one's `BrowserUsbState`; on the camera, a second
 * Electron window with the same preload write guard.
 */
export async function openSecondWindow(t: TargetHandle): Promise<SecondWindow> {
  const first = bridgeOf(t);
  if (first !== null) {
    if (t.emu === null) throw new Error('the emulator target has no bus');
    /* A new WINDOW, not a tab: a background tab is hidden (and throttled),
     * while two windows are both on screen, as the person's two windows are. */
    const browser = t.page.browser();
    const known = new Set(browser.targets());
    const session = await browser.target().createCDPSession();
    await session.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    await session.detach();
    const target = await browser.waitForTarget(
      (tg) => tg.type() === TargetType.PAGE && !known.has(tg),
      {
        timeout: 30_000,
      },
    );
    const page = await target.page();
    if (page === null) throw new Error('the second window has no page');
    page.on('pageerror', (error) => {
      say(`page error (window 2): ${String(error)}`);
    });
    const bridge = await UsbBridge.attach(page, t.emu, {
      log: (line) => {
        say(`[window 2] ${line}`);
      },
      shared: first.shared,
    });
    await page.goto(`${t.serverUrl}#/`, { waitUntil: 'networkidle0' });
    await waitForApp(page);
    const wizard = new Wizard({
      page,
      prompter: bridge,
      downloads: t.downloads,
      guard: EVERYTHING,
      camera: CAMERA_NAME,
    });
    return {
      page,
      wizard,
      bridge,
      wire: () => Promise.resolve(new Map(bridge.counts)),
      refusals: async () => [...bridge.refusals, ...(await bridge.pageRefusals())],
      close: async () => {
        bridge.detach();
        await page.close().catch(() => undefined);
      },
    };
  }
  if (t.app === null) throw new Error('the camera target has no Electron app');
  const page = await t.app.openWindow();
  page.on('pageerror', (error) => {
    say(`page error (window 2): ${String(error)}`);
  });
  await waitForApp(page);
  const wizard = new Wizard({
    page,
    prompter: t.app,
    downloads: t.app,
    guard: READ_ONLY_CAMERA,
    camera: CAMERA_NAME,
  });
  return {
    page,
    wizard,
    bridge: null,
    wire: async () => countsOf(await guardOf(page)),
    refusals: async () => (await guardOf(page)).refusals,
    close: async () => {
      await page.close().catch(() => undefined);
    },
  };
}

/** The camera's write guard is in the page and locked (camera target only). */
export async function guardInstalled(t: TargetHandle, page: Page = t.page): Promise<boolean> {
  if (t.name !== 'camera') return true;
  const guard = await guardOf(page);
  const locked = await page.evaluate(() => {
    const out = Object.getOwnPropertyDescriptor(USBDevice.prototype, 'controlTransferOut');
    return out !== undefined && !out.configurable && !out.writable;
  });
  return guard.installed && locked;
}

/** One phase section as the page shows it: badges, start button, status line. */
export interface PhaseView {
  readonly badges: string[];
  readonly start: { readonly label: string; readonly enabled: boolean } | null;
  readonly status: string;
  readonly text: string;
}

export function phaseView(page: Page, phase: string): Promise<PhaseView> {
  return page.evaluate((id: string) => {
    const root = document.querySelector(`section[aria-labelledby="preserve-${id}-heading"]`);
    const badges = [...(root?.querySelectorAll('[data-slot="badge"]') ?? [])].map((b) =>
      b.textContent.trim(),
    );
    const first = root?.querySelector<HTMLButtonElement>('[role="toolbar"] button') ?? null;
    return {
      badges,
      start: first === null ? null : { label: first.textContent.trim(), enabled: !first.disabled },
      status: document.querySelector<HTMLElement>(`#preserve-phase-${id}-status`)?.innerText ?? '',
      text: (root as HTMLElement | null)?.innerText ?? '',
    };
  }, phase);
}

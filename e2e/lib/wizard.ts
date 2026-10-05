/**
 * Driving the app through its own UI: the Connect pick, Dump & decrypt, and the
 * Preserve wizard's three phases — Start buttons, the write confirmations, and
 * the blue "Your turn" asks answered through the device chooser.
 *
 * Nothing here knows which device is behind the page. A `UiGuard` decides what
 * a run may click: the emulator run may click everything; the real-camera run
 * refuses every control that could start a write (and the Flash view), so a
 * mistake in a scenario fails the test instead of reaching the camera.
 */

import type { ElementHandle, Page } from 'puppeteer-core';

import type { DevicePrompter } from './bridge.js';
import { say, type Download, type DownloadWaiter } from './browser.js';
import { readZip, type ZipEntry } from './zip.js';

export type PhaseId = 'read-build' | 'patch-dump' | 'restore-verify';

export const PHASE_LABEL: Readonly<Record<PhaseId, string>> = {
  'read-build': 'Read & build',
  'patch-dump': 'Patch & dump',
  'restore-verify': 'Restore & verify',
};

/** The run file's name suffix after each phase (the last step it completed). */
export const PHASE_FILE_LABEL: Readonly<Record<PhaseId, string>> = {
  'read-build': 'patch-built',
  'patch-dump': 'full-dump',
  'restore-verify': 'verified',
};

export const PHASE_FOLDER: Readonly<Record<PhaseId, string>> = {
  'read-build': '02-read-build',
  'patch-dump': '03-patch-dump',
  'restore-verify': '04-restore-verify',
};

/** `preserve-<start>-<saved>-<label>.zip`, both stamps in the run id's shape. */
export function runFilePattern(label: string): RegExp {
  const stamp = String.raw`\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z`;
  return new RegExp(`^preserve-${stamp}-${stamp}-${label}\\.zip$`);
}

/** What a run may do in the UI. */
export interface UiGuard {
  readonly name: string;
  allowClick: (label: string) => boolean;
  allowRoute: (hash: string) => boolean;
  allowPhase: (phase: PhaseId) => boolean;
}

export const EVERYTHING: UiGuard = {
  name: 'everything (emulator)',
  allowClick: () => true,
  allowRoute: () => true,
  allowPhase: () => true,
};

/**
 * The real camera's guard: Dump & decrypt and Preserve step 02 only. Every
 * label that starts a write, confirms one, jumps past the commit or opens the
 * Flash view is refused, and so is the phase it would start.
 */
export const READ_ONLY_CAMERA: UiGuard = {
  name: 'read-only (real camera)',
  allowClick: (label) =>
    !/patch & dump|restore & verify|write to the camera|jump past|skip the commit|flash|i replugged it/i.test(
      label,
    ),
  allowRoute: (hash) => !/flash/i.test(hash),
  allowPhase: (phase) => phase === 'read-build',
};

export interface PhaseRun {
  readonly phase: PhaseId;
  /** How many "Your turn: press Connect device" asks were answered. */
  readonly asks: number;
  /** Each ask as it stood when it was answered: its tone, and any red alert beside it. */
  readonly askViews: readonly AskView[];
  readonly ms: number;
  readonly runFile: Download;
  readonly entries: readonly ZipEntry[];
  readonly status: string;
}

/** The calm blue ask is `info`; red would be `err`. */
export interface AskView {
  readonly tone: 'info' | 'ok' | 'warn' | 'err' | 'unknown';
  readonly text: string;
  readonly redAlerts: readonly string[];
}

export interface DumpRun {
  readonly ms: number;
  readonly archive: Download;
  readonly entries: readonly ZipEntry[];
  readonly status: string;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export function phaseSection(phase: PhaseId): string {
  return `section[aria-labelledby="preserve-${phase}-heading"]`;
}

export class Wizard {
  private readonly page: Page;
  private readonly prompter: DevicePrompter;
  private readonly downloads: DownloadWaiter;
  private readonly guard: UiGuard;
  /** Which chooser entry is the camera. */
  private readonly camera: RegExp;

  constructor(options: {
    readonly page: Page;
    readonly prompter: DevicePrompter;
    readonly downloads: DownloadWaiter;
    readonly guard: UiGuard;
    readonly camera: RegExp;
  }) {
    this.page = options.page;
    this.prompter = options.prompter;
    this.downloads = options.downloads;
    this.guard = options.guard;
    this.camera = options.camera;
  }

  /* ---- primitives -------------------------------------------------------- */

  async route(hash: string): Promise<void> {
    if (!this.guard.allowRoute(hash)) {
      throw new Error(`UI guard (${this.guard.name}) refuses the route ${hash}`);
    }
    await this.page.evaluate((h: string) => {
      location.hash = h;
    }, hash);
    await sleep(300);
  }

  /** The button labelled `label` inside `scope`, waited for until it is enabled. */
  private async button(
    scope: string | ElementHandle,
    label: string,
    timeoutMs = 30_000,
  ): Promise<ElementHandle<HTMLButtonElement>> {
    const deadline = Date.now() + timeoutMs;
    let seen = 'not found';
    for (;;) {
      const root = typeof scope === 'string' ? await this.page.$(scope) : scope;
      const buttons = root === null ? [] : await root.$$('button');
      for (const handle of buttons) {
        const [text, disabled] = await handle.evaluate((el) => [
          el.textContent.trim(),
          el.disabled,
        ]);
        if (text !== label) continue;
        if (!disabled) return handle;
        seen = 'disabled';
      }
      if (Date.now() > deadline) {
        throw new Error(
          `button "${label}" in ${String(scope)}: ${seen} after ${String(timeoutMs)} ms`,
        );
      }
      await sleep(250);
    }
  }

  async click(scope: string | ElementHandle, label: string, timeoutMs?: number): Promise<void> {
    if (!this.guard.allowClick(label)) {
      throw new Error(`UI guard (${this.guard.name}) refuses to click "${label}"`);
    }
    const handle = await this.button(scope, label, timeoutMs);
    await handle.click();
  }

  /** Whether the button exists and is enabled — without clicking it. */
  async isEnabled(scope: string, label: string): Promise<boolean> {
    return this.page.evaluate(
      (sel: string, text: string) => {
        const root = document.querySelector(sel);
        const match = [...(root?.querySelectorAll('button') ?? [])].find(
          (b) => b.textContent.trim() === text,
        );
        return match !== undefined && !match.disabled;
      },
      scope,
      label,
    );
  }

  async text(selector: string): Promise<string> {
    return this.page.evaluate(
      (sel: string) => document.querySelector<HTMLElement>(sel)?.innerText ?? '',
      selector,
    );
  }

  /** The last lines of a run panel's log, for a failure message. */
  async logTail(panelId: string, lines = 60): Promise<string> {
    const text = await this.text(`#${panelId}-log`);
    return text.split('\n').slice(-lines).join('\n');
  }

  /** Every red alert on the page, by its text. */
  async redAlerts(): Promise<string[]> {
    return this.page.$$eval('[data-slot="alert"]', (alerts) =>
      alerts
        .filter((alert) => alert.className.includes('border-l-destructive'))
        .map((alert) => (alert as HTMLElement).innerText),
    );
  }

  /** Clicks `label` in `scope`, answers the chooser it opens with the camera. */
  async pickCamera(
    scope: string | ElementHandle,
    label: string,
    deviceTimeoutMs: number,
  ): Promise<string> {
    const prompt = this.prompter.waitForDevicePrompt({ timeout: 30_000 });
    prompt.catch(() => undefined); /* awaited below; a failed click must not leave it unhandled */
    await this.click(scope, label);
    const chooser = await prompt;
    const device = await chooser.waitForDevice((d) => this.camera.test(d.name), {
      timeout: deviceTimeoutMs,
    });
    await chooser.select(device);
    return device.name;
  }

  /* ---- step 01: Connect --------------------------------------------------- */

  async connect(): Promise<string> {
    const name = await this.pickCamera(
      'section[aria-labelledby="connect-heading"]',
      'Connect device',
      60_000,
    );
    await this.page.waitForFunction(
      () => (document.querySelector('#device-description')?.textContent ?? '').includes('VID'),
      { timeout: 30_000, polling: 250 },
    );
    say(`connected: ${await this.text('#device-description')}`);
    return name;
  }

  /* ---- Dump & decrypt ------------------------------------------------------ */

  /** The "Dump" section's auto-family run, the common case. */
  async dumpAndDecrypt(timeoutMs: number): Promise<DumpRun> {
    return this.runDump({
      panel: 'dump',
      button: 'Start dump',
      archive: /^seek_flash4m_.+\.zip$/,
      timeoutMs,
    });
  }

  /** One dump-shaped run: start it, wait for its "Done" line, collect its zip. */
  async runDump(options: {
    readonly panel: string;
    readonly button: string;
    readonly archive: RegExp;
    readonly timeoutMs: number;
  }): Promise<DumpRun> {
    const t0 = Date.now();
    await this.route('#/');
    const statusSel = `#${options.panel}-status`;
    await this.startDump(options.panel, options.button);
    let lastReport = 0;
    for (;;) {
      const status = await this.text(statusSel);
      if (status.startsWith('Done — ')) break;
      if (/^(Failed|Refused|Cancelled)/.test(status)) {
        throw new Error(`${options.button} ended: ${status}\n${await this.logTail(options.panel)}`);
      }
      if (Date.now() - t0 > options.timeoutMs) {
        throw new Error(
          `${options.button} did not finish in ${String(options.timeoutMs)} ms: ${status}`,
        );
      }
      if (Date.now() - lastReport > 15_000) {
        lastReport = Date.now();
        say(`${options.panel}: ${status}`);
      }
      await sleep(500);
    }
    const status = await this.text(statusSel);
    const archive = await this.downloads.waitFor(
      (name) => options.archive.test(name),
      60_000,
      `${options.panel} archive`,
    );
    say(`${options.panel}: ${status} (${String(Date.now() - t0)} ms)`);
    return { ms: Date.now() - t0, archive, entries: readZip(archive.bytes), status };
  }

  /** Clicks a dump/sweep start button and waits past the previous "Done" line. */
  async startDump(panel: string, button: string): Promise<void> {
    const section = `section[aria-labelledby="${panel === 'manual' ? 'manual' : 'dump'}-heading"]`;
    await this.click(section, button);
    await this.page.waitForFunction(
      (sel: string) =>
        !(document.querySelector<HTMLElement>(sel)?.innerText ?? '').startsWith('Done'),
      { timeout: 15_000, polling: 100 },
      `#${panel}-status`,
    );
  }

  /** Waits until a dump has read at least `windows` windows (its progress text). */
  async dumpProgressed(panel: string, windows: number, timeoutMs = 60_000): Promise<void> {
    await this.page.waitForFunction(
      (sel: string, want: number) => {
        const bar = document.querySelector(`${sel} [role="progressbar"]`);
        const now = Number(bar?.getAttribute('aria-valuenow') ?? '0');
        const status = document.querySelector<HTMLElement>(`${sel}-status`)?.innerText ?? '';
        return now >= want || status.includes('read 0x');
      },
      { timeout: timeoutMs, polling: 200 },
      `#${panel}`,
      windows,
    );
  }

  /** Clicks a run panel's Cancel and waits for it to settle. Returns the status. */
  async cancel(panel: string, section: string, timeoutMs = 60_000): Promise<string> {
    await this.click(section, 'Cancel');
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.text(`#${panel}-status`);
      if (/Cancelled|Done —|Failed|Refused/.test(status)) return status;
      if (Date.now() > deadline) throw new Error(`cancel did not settle: ${status}`);
      await sleep(250);
    }
  }

  /** Picks a local file into the next `<input type=file>` the click opens. */
  private async pickFile(open: () => Promise<void>, filePath: string): Promise<void> {
    const chooser = this.page.waitForFileChooser({ timeout: 15_000 });
    chooser.catch(() => undefined);
    await open();
    const dialog = await chooser;
    await dialog.accept([filePath]);
  }

  /** Offline "Decrypt a dump you already have": pick `filePath`, wait, collect the zip. */
  async offlineDecrypt(filePath: string, timeoutMs = 5 * 60_000): Promise<DumpRun> {
    const t0 = Date.now();
    await this.route('#/');
    await this.pickFile(
      () => this.click('section[aria-labelledby="offline-heading"]', 'Choose dump file…'),
      filePath,
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.text('#offline-status');
      if (/^Done —|^No images|^Not a usable/.test(status)) break;
      if (/^Cancelled|^Failed|^ERROR/.test(status)) {
        throw new Error(`offline decrypt ended: ${status}\n${await this.logTail('offline')}`);
      }
      if (Date.now() > deadline) throw new Error(`offline decrypt stalled: ${status}`);
      await sleep(300);
    }
    const status = await this.text('#offline-status');
    const archive = await this.downloads.waitFor(() => true, 60_000, 'offline archive');
    say(`offline decrypt: ${status} (${String(Date.now() - t0)} ms)`);
    return { ms: Date.now() - t0, archive, entries: readZip(archive.bytes), status };
  }

  /** The manual "firmware family" select. `value` is a profile id. */
  async selectManualProfile(value: string): Promise<void> {
    await this.page.select('#manualProfile', value);
  }

  /** Loads a run file into the Preserve page and waits for the resume line. */
  async loadRunFile(filePath: string, timeoutMs = 60_000): Promise<string> {
    await this.route('#/preserve');
    await this.pickFile(
      () => this.click('section[aria-labelledby="preserve-runfile-heading"]', 'Load a run file…'),
      filePath,
    );
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const status = await this.text('#preserve-load-status');
      if (/^Resumed at|^Not resumed/.test(status)) {
        say(`load run file: ${status}`);
        return status;
      }
      if (Date.now() > deadline) throw new Error(`run-file load stalled: ${status}`);
      await sleep(250);
    }
  }

  /** The device description line (`#device-description`). */
  async deviceDescription(): Promise<string> {
    return this.text('#device-description');
  }

  /** Presses "Forget device" and waits for the seat to clear. */
  async forget(): Promise<void> {
    await this.click('section[aria-labelledby="connect-heading"]', 'Forget device');
    await this.page.waitForFunction(
      () => !(document.querySelector('#device-description')?.textContent ?? '').includes('VID'),
      { timeout: 15_000, polling: 200 },
    );
  }

  /* ---- the Preserve wizard ------------------------------------------------ */

  async openPreserve(): Promise<void> {
    await this.route('#/preserve');
    await this.page.waitForSelector(phaseSection('read-build'), { timeout: 30_000 });
  }

  /** The Start button's label for a phase that has not run yet. */
  static startLabel(phase: PhaseId): string {
    return `Start ${PHASE_LABEL[phase].toLowerCase()}`;
  }

  /**
   * Starts `phase`, confirms the write dialog when `confirm`, answers every
   * "press Connect device" ask through the chooser, and returns once the phase
   * reports done and its run file has downloaded.
   */
  async runPhase(
    phase: PhaseId,
    options: {
      readonly confirm: boolean;
      readonly timeoutMs: number;
      /** Called with each "Your turn" ask before it is answered (e.g. a screenshot). */
      readonly onAsk?: (ask: AskView) => Promise<void>;
    },
  ): Promise<PhaseRun> {
    if (!this.guard.allowPhase(phase)) {
      throw new Error(`UI guard (${this.guard.name}) refuses to start ${PHASE_LABEL[phase]}`);
    }
    /* Make sure the wizard is on screen — a caller may be anywhere. Idempotent. */
    await this.openPreserve();
    const section = phaseSection(phase);
    const panel = `preserve-phase-${phase}`;
    const t0 = Date.now();
    await this.click(section, Wizard.startLabel(phase));
    if (options.confirm) {
      await this.page.waitForSelector('[role="alertdialog"]', { timeout: 10_000 });
      await this.click('[role="alertdialog"]', 'Yes — write to the camera');
    }
    let asks = 0;
    const askViews: AskView[] = [];
    let lastReport = 0;
    let status: string;
    for (;;) {
      const view = await this.page.evaluate(
        (sel: string, statusSel: string) => {
          const root = document.querySelector(sel);
          const alerts = [...(root?.querySelectorAll('[data-slot="alert"]') ?? [])].map(
            (a) => (a as HTMLElement).innerText,
          );
          return {
            status: document.querySelector<HTMLElement>(statusSel)?.innerText ?? '',
            ask: alerts.find((t) => /Your turn|Before step 04/.test(t)) ?? null,
            running: [...(root?.querySelectorAll('[data-slot="badge"]') ?? [])].some(
              (b) => b.textContent.trim() === 'Running',
            ),
          };
        },
        section,
        `#${panel}-status`,
      );
      status = view.status;
      if (/ — done[.,]/.test(status) && !view.running) break;
      if (/^(Failed|Refused|Stopped|Cancelled|Not created|No run)/.test(status)) {
        throw new Error(`${PHASE_LABEL[phase]} ended: ${status}\n${await this.logTail(panel)}`);
      }
      if (Date.now() - t0 > options.timeoutMs) {
        throw new Error(
          `${PHASE_LABEL[phase]} did not finish in ${String(options.timeoutMs)} ms: ${status}\n` +
            (await this.logTail(panel)),
        );
      }
      if (view.ask !== null) {
        if (!view.ask.includes('press Connect device and pick the camera')) {
          throw new Error(`${PHASE_LABEL[phase]}: an ask this run does not answer: ${view.ask}`);
        }
        asks += 1;
        const asked = await this.yourTurn(section);
        const tone = await asked.evaluate((el) => {
          const classes = el.className;
          if (classes.includes('border-l-destructive')) return 'err' as const;
          if (classes.includes('border-l-warn')) return 'warn' as const;
          if (classes.includes('border-l-ok')) return 'ok' as const;
          if (classes.includes('border-l-primary')) return 'info' as const;
          return 'unknown' as const;
        });
        const askView: AskView = { tone, text: view.ask, redAlerts: await this.redAlerts() };
        askViews.push(askView);
        await options.onAsk?.(askView);
        say(`${PHASE_LABEL[phase]}: "Your turn" ask #${String(asks)} (${tone}) — answering it`);
        const picked = await this.pickCamera(asked, 'Connect device', 240_000);
        say(`${PHASE_LABEL[phase]}: picked ${picked} in the chooser`);
        await this.page.waitForFunction(
          (sel: string) =>
            ![...(document.querySelector(sel)?.querySelectorAll('[data-slot="alert"]') ?? [])].some(
              (a) => (a as HTMLElement).innerText.includes('Your turn'),
            ),
          { timeout: 120_000, polling: 250 },
          section,
        );
        continue;
      }
      if (Date.now() - lastReport > 15_000) {
        lastReport = Date.now();
        say(`${PHASE_LABEL[phase]}: ${status}`);
      }
      await sleep(400);
    }
    const label = PHASE_FILE_LABEL[phase];
    const runFile = await this.downloads.waitFor(
      (name) => runFilePattern(label).test(name),
      60_000,
      `${label} run file`,
    );
    const ms = Date.now() - t0;
    say(
      `${PHASE_LABEL[phase]}: done in ${(ms / 1000).toFixed(1)} s, ${String(asks)} ask(s) — ${runFile.name}`,
    );
    return { phase, asks, askViews, ms, runFile, entries: readZip(runFile.bytes), status };
  }

  private async yourTurn(section: string): Promise<ElementHandle> {
    const alerts = await this.page.$$(`${section} [data-slot="alert"]`);
    for (const alert of alerts) {
      const text = await alert.evaluate((el) => (el as HTMLElement).innerText);
      if (text.includes('Your turn')) return alert;
    }
    throw new Error('the "Your turn" box went away before it could be answered');
  }
}

/**
 * The Electron route: the app in a BrowserWindow with REAL Chromium WebUSB,
 * driven over CDP by the same Puppeteer scenario code as the bridge runs.
 *
 * `ElectronApp.launch` spawns `e2e/electron/main.mjs` with a free CDP port, a
 * throwaway profile directory (Electron's `userData`, deleted on close) and the
 * page-side write guard as the window's preload, then connects Puppeteer to it.
 * The app object is also the scenario's `DevicePrompter` — Electron's
 * `select-usb-device`, relayed by the main process, answered here with the
 * same `waitForDevice` / `select` / `cancel` calls Puppeteer's own prompt
 * offers — and its `DownloadWaiter` (Electron's `will-download`).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';

import puppeteer, { type Browser, type Page } from 'puppeteer-core';

import type { DevicePrompt, DevicePrompter, PromptDevice } from './bridge.js';
import { REPO_ROOT, freePort, say, type Download, type DownloadWaiter } from './browser.js';

/** The Electron binary the `electron` package installed (its main export is the path). */
export function electronBinary(): string | null {
  try {
    const found: unknown = createRequire(import.meta.url)('electron');
    return typeof found === 'string' ? found : null;
  } catch {
    return null;
  }
}

const MAIN = path.join(REPO_ROOT, 'e2e', 'electron', 'main.mjs');
const MARK = '@@seek-e2e ';

/** A USB device as Electron's `select-usb-device` lists it. */
export interface ElectronDevice {
  readonly deviceId: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string | null;
  readonly manufacturerName: string | null;
  readonly serialNumber: string | null;
}

type MainEvent =
  | { event: 'ready'; electron: string; chrome: string; node: string }
  | { event: 'prompt'; id: number; devices: ElectronDevice[] }
  | { event: 'prompt-devices'; id: number; devices: ElectronDevice[] }
  | { event: 'selected'; id: number; device: ElectronDevice }
  | { event: 'refused'; id: number; why: string }
  | { event: 'cancelled'; id: number }
  | { event: 'download-started'; name: string }
  | { event: 'download'; name: string; path: string; state: string; bytes: number }
  | {
      event: 'usb-device-added' | 'usb-device-removed' | 'usb-device-revoked';
      device: ElectronDevice;
    }
  | { event: 'error'; message: string };

function chooserName(device: ElectronDevice): string {
  const id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId
    .toString(16)
    .padStart(4, '0')}`;
  return `${device.productName ?? 'Unknown device'} (${id})`;
}

class ElectronPrompt implements DevicePrompt {
  readonly id: number;
  private readonly owner: ElectronApp;
  private list: readonly ElectronDevice[];

  constructor(owner: ElectronApp, id: number, devices: readonly ElectronDevice[]) {
    this.owner = owner;
    this.id = id;
    this.list = devices;
  }

  update(devices: readonly ElectronDevice[]): void {
    this.list = devices;
  }

  get devices(): readonly PromptDevice[] {
    return this.list.map((device) => ({ id: device.deviceId, name: chooserName(device) }));
  }

  waitForDevice(
    filter: (device: PromptDevice) => boolean,
    options: { timeout?: number } = {},
  ): Promise<PromptDevice> {
    const timeout = options.timeout ?? 30_000;
    return this.owner.until(
      () => this.devices.find(filter) ?? null,
      timeout,
      `no matching device appeared in Electron's chooser within ${String(timeout)} ms`,
    );
  }

  async select(device: PromptDevice): Promise<void> {
    this.owner.send({ cmd: 'select', id: this.id, deviceId: device.id });
    const outcome = await this.owner.until(
      () => this.owner.outcomeOf(this.id),
      30_000,
      `Electron's main process did not answer the pick of ${device.name}`,
    );
    if (outcome.event === 'refused') {
      throw new Error(`Electron's main process refused the pick: ${outcome.why}`);
    }
  }

  async cancel(): Promise<void> {
    this.owner.send({ cmd: 'cancel', id: this.id });
    await this.owner.until(() => this.owner.outcomeOf(this.id), 30_000, 'cancel not answered');
  }
}

export interface ElectronLaunch {
  readonly scratchDir: string;
  /** The page to open, on the e2e's own dev server. */
  readonly url: string;
  /** The preload's source: the page-side write guard. */
  readonly preloadSource: string;
  readonly guardGlobal: string;
  readonly headed: boolean;
}

export class ElectronApp implements DevicePrompter, DownloadWaiter {
  readonly browser: Browser;
  readonly page: Page;
  readonly versions: { readonly electron: string; readonly chrome: string; readonly node: string };
  /** The main process's events, timestamped, for the report. */
  readonly timeline: string[];
  private readonly child: ChildProcess;
  private readonly userData: string;
  private readonly state: AppState;

  /** Every device Electron's choosers listed, once per enumeration (deviceId), as listed. */
  get devicesSeen(): readonly ElectronDevice[] {
    return this.state.seen;
  }

  private constructor(parts: {
    browser: Browser;
    page: Page;
    child: ChildProcess;
    userData: string;
    state: AppState;
    versions: { electron: string; chrome: string; node: string };
  }) {
    this.browser = parts.browser;
    this.page = parts.page;
    this.child = parts.child;
    this.userData = parts.userData;
    this.state = parts.state;
    this.versions = parts.versions;
    this.timeline = parts.state.timeline;
  }

  static async launch(options: ElectronLaunch): Promise<ElectronApp> {
    const binary = electronBinary();
    if (binary === null) throw new Error('the electron package is not installed');
    mkdirSync(options.scratchDir, { recursive: true });
    const userData = mkdtempSync(path.join(options.scratchDir, 'electron-profile-'));
    const downloads = path.join(options.scratchDir, 'downloads');
    mkdirSync(downloads, { recursive: true });
    const preload = path.join(userData, 'write-guard-preload.js');
    writeFileSync(preload, options.preloadSource);
    const port = await freePort();
    const state = new AppState();
    const child = spawn(binary, [MAIN, `--remote-debugging-port=${String(port)}`], {
      env: {
        ...process.env,
        SEEK_E2E_URL: options.url,
        SEEK_E2E_USER_DATA: userData,
        SEEK_E2E_DOWNLOADS: downloads,
        SEEK_E2E_PRELOAD: preload,
        SEEK_E2E_GUARD_GLOBAL: options.guardGlobal,
        SEEK_E2E_HEADED: options.headed ? '1' : '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    createInterface({ input: child.stdout }).on('line', (line) => {
      if (line.startsWith(MARK)) state.receive(JSON.parse(line.slice(MARK.length)) as MainEvent);
      else if (line.trim() !== '') say(`[electron] ${line}`);
    });
    createInterface({ input: child.stderr }).on('line', (line) => {
      if (/DevTools listening|ERROR|FATAL/i.test(line)) say(`[electron] ${line}`);
    });
    child.once('exit', (code, signal) => {
      state.exited = `code ${String(code)}, signal ${String(signal)}`;
      state.wake();
    });
    try {
      const ready = await state.until(
        () => {
          if (state.exited !== null)
            throw new Error(`Electron exited before it was ready (${state.exited})`);
          return state.ready;
        },
        60_000,
        'Electron did not open the page within 60 s',
      );
      const browser = await puppeteer.connect({
        browserURL: `http://127.0.0.1:${String(port)}`,
        defaultViewport: null,
        protocolTimeout: 600_000,
      });
      const origin = new URL(options.url).origin;
      const page = (await browser.pages()).find((p) => p.url().startsWith(origin));
      if (page === undefined) throw new Error(`no Electron page on ${origin}`);
      say(
        `electron ${ready.electron} (Chromium ${ready.chrome}, Node ${ready.node}), CDP on ${String(port)}`,
      );
      return new ElectronApp({ browser, page, child, userData, state, versions: ready });
    } catch (error) {
      child.kill('SIGKILL');
      rmSync(userData, { recursive: true, force: true });
      throw error;
    }
  }

  send(command: Record<string, unknown>): void {
    this.child.stdin?.write(`${JSON.stringify(command)}\n`);
  }

  until<T>(look: () => T | null, timeoutMs: number, what: string): Promise<T> {
    return this.state.until(look, timeoutMs, what);
  }

  /** How the main process answered chooser `id`, once it has. */
  outcomeOf(
    id: number,
  ): Extract<MainEvent, { event: 'selected' | 'refused' | 'cancelled' }> | null {
    return this.state.outcomes.get(id) ?? null;
  }

  waitForDevicePrompt(options: { timeout?: number } = {}): Promise<DevicePrompt> {
    const timeout = options.timeout ?? 30_000;
    const from = this.state.promptsHandedOut;
    return this.state.until(
      () => {
        const next = this.state.prompts[from];
        if (next === undefined) return null;
        this.state.promptsHandedOut = from + 1;
        const prompt = new ElectronPrompt(this, next.id, next.devices);
        this.state.live.set(next.id, prompt);
        return prompt;
      },
      timeout,
      `no device chooser opened within ${String(timeout)} ms`,
    );
  }

  waitFor(test: (name: string) => boolean, timeoutMs: number, what: string): Promise<Download> {
    return this.state.until(
      () => {
        for (const item of this.state.downloads) {
          if (item.taken || !test(item.name)) continue;
          if (item.state !== 'completed')
            throw new Error(`the download of ${item.name} ${item.state}`);
          item.taken = true;
          return {
            name: item.name,
            path: item.path,
            bytes: new Uint8Array(readFileSync(item.path)),
          };
        }
        return null;
      },
      timeoutMs,
      `no ${what} download within ${String(timeoutMs)} ms (downloads so far: ${this.names().join(', ') || 'none'})`,
    );
  }

  names(): string[] {
    return this.state.downloads.filter((d) => d.state === 'completed').map((d) => d.name);
  }

  /** Quits Electron (killing it if it will not go) and deletes its profile. */
  async close(): Promise<void> {
    await this.browser.disconnect().catch(() => undefined);
    if (this.state.exited === null) {
      this.send({ cmd: 'quit' });
      this.child.stdin?.end();
      await this.state
        .until(() => this.state.exited, 15_000, 'Electron did not quit')
        .catch(() => {
          this.child.kill('SIGKILL');
        });
    }
    rmSync(this.userData, { recursive: true, force: true });
  }
}

/** What the main process has said so far, and the waits on it. */
class AppState {
  ready: { electron: string; chrome: string; node: string } | null = null;
  exited: string | null = null;
  readonly prompts: { id: number; devices: ElectronDevice[] }[] = [];
  promptsHandedOut = 0;
  readonly live = new Map<number, ElectronPrompt>();
  readonly outcomes = new Map<
    number,
    Extract<MainEvent, { event: 'selected' | 'refused' | 'cancelled' }>
  >();
  readonly downloads: { name: string; path: string; state: string; taken: boolean }[] = [];
  readonly timeline: string[] = [];
  readonly seen: ElectronDevice[] = [];
  private readonly started = Date.now();
  private readonly waiters = new Set<() => void>();

  private note(line: string): void {
    const stamped = `+${((Date.now() - this.started) / 1000).toFixed(1)}s ${line}`;
    this.timeline.push(stamped);
    say(`[electron] ${stamped}`);
  }

  receive(message: MainEvent): void {
    switch (message.event) {
      case 'ready':
        this.ready = { electron: message.electron, chrome: message.chrome, node: message.node };
        break;
      case 'prompt':
        this.prompts.push({ id: message.id, devices: message.devices });
        this.see(message.devices);
        this.note(
          `chooser #${String(message.id)} opened: ${message.devices.map(chooserName).join(', ') || 'empty'}`,
        );
        break;
      case 'prompt-devices':
        this.live.get(message.id)?.update(message.devices);
        this.see(message.devices);
        this.note(
          `chooser #${String(message.id)} now lists: ${message.devices.map(chooserName).join(', ') || 'nothing'}`,
        );
        break;
      case 'selected':
        this.outcomes.set(message.id, message);
        this.note(`chooser #${String(message.id)}: picked ${chooserName(message.device)}`);
        break;
      case 'refused':
        this.outcomes.set(message.id, message);
        this.note(`chooser #${String(message.id)}: REFUSED by the main process — ${message.why}`);
        break;
      case 'cancelled':
        this.outcomes.set(message.id, message);
        this.note(`chooser #${String(message.id)}: cancelled`);
        break;
      case 'download-started':
        say(`download started: ${message.name}`);
        break;
      case 'download':
        this.downloads.push({
          name: message.name,
          path: message.path,
          state: message.state,
          taken: false,
        });
        say(`download ${message.state}: ${message.name} (${String(message.bytes)} B)`);
        break;
      case 'usb-device-added':
      case 'usb-device-removed':
      case 'usb-device-revoked':
        this.note(`${message.event}: ${chooserName(message.device)} [${message.device.deviceId}]`);
        break;
      case 'error':
        this.note(`main process error: ${message.message}`);
        break;
    }
    this.wake();
  }

  private see(devices: readonly ElectronDevice[]): void {
    for (const device of devices) {
      if (!this.seen.some((d) => d.deviceId === device.deviceId)) this.seen.push(device);
    }
  }

  wake(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  until<T>(look: () => T | null, timeoutMs: number, what: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const check = (): void => {
        try {
          const found = look();
          if (found === null) return;
          done();
          resolve(found);
        } catch (error) {
          done();
          reject(error instanceof Error ? error : new Error(String(error)));
        }
      };
      const timer = setTimeout(() => {
        done();
        reject(new Error(what));
      }, timeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(check);
      };
      this.waiters.add(check);
      check();
    });
  }
}

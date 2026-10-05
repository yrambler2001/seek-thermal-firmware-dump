/**
 * The app, a browser, and the files it downloads.
 *
 *  - The app is served by its own Vite dev server, started here on a port of
 *    its own (never 5173/5174, which belong to `npm run dev` / `dev:phone`), with
 *    its own dependency cache, no file watcher and no HMR socket — an edit made
 *    while a run is in flight must not reload the page under it.
 *  - Chrome is the INSTALLED Google Chrome (`SEEK_E2E_CHROME` overrides the
 *    path), launched by puppeteer-core on a fresh throwaway profile under the
 *    scratch directory, which is deleted on close. The user's profile is never
 *    touched; the only preference written into the throwaway one lets the page
 *    download more than one file without asking.
 *  - Downloads go to a scratch directory through CDP
 *    (`Browser.setDownloadBehavior`), and each one is waited for by name.
 */

import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import puppeteer, { type Browser } from 'puppeteer-core';
import { createServer as createViteServer } from 'vite';

export const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const WEB_ROOT = path.join(REPO_ROOT, 'packages', 'web');
export const CHROME_PATH =
  process.env.SEEK_E2E_CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

export function say(line: string): void {
  process.stderr.write(`[e2e ${new Date().toISOString().slice(11, 19)}] ${line}\n`);
}

/** A port the OS has just confirmed free. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port === 0) reject(new Error('could not obtain a free port'));
        else resolve(port);
      });
    });
  });
}

export interface DevServer {
  readonly url: string;
  close(): Promise<void>;
}

/** `SEEK_E2E_PORT` pins the port; otherwise a free one. Never 5173/5174. */
export async function startDevServer(): Promise<DevServer> {
  const pinned = process.env.SEEK_E2E_PORT;
  const port = pinned === undefined || pinned === '' ? await freePort() : Number(pinned);
  if (port === 5173 || port === 5174) {
    throw new Error(`port ${String(port)} belongs to npm run dev / dev:phone — pick another`);
  }
  const server = await createViteServer({
    configFile: path.join(WEB_ROOT, 'vite.config.ts'),
    root: WEB_ROOT,
    cacheDir: path.join(REPO_ROOT, 'node_modules', '.vite-e2e'),
    clearScreen: false,
    logLevel: 'warn',
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, ws: false, watch: null },
  });
  await server.listen();
  const url = `http://127.0.0.1:${String(port)}/`;
  say(`dev server: ${url}`);
  return {
    url,
    close: () => server.close(),
  };
}

const MIME: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

/**
 * Serves a built directory (the hosted `docs/` bundle) over plain HTTP, exactly
 * as GitHub Pages would: static files, no dev server, no module graph, no
 * websocket. A request that resolves to nothing falls back to `index.html`
 * (the app routes on the hash, so any path is the one page). Every request's
 * path is recorded in `requests`, so a test can assert the page fetches nothing
 * from the network after it has loaded.
 */
export interface StaticServer extends DevServer {
  readonly requests: string[];
}

export async function startStaticServer(dir: string): Promise<StaticServer> {
  if (!existsSync(path.join(dir, 'index.html'))) {
    throw new Error(`no index.html under ${dir} — build the web app first (npm run build)`);
  }
  const requests: string[] = [];
  const server = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push(url.pathname);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    let file = path.join(dir, rel);
    if (!file.startsWith(dir)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    if (!existsSync(file) || statSync(file).isDirectory()) file = path.join(dir, 'index.html');
    try {
      const body = readFileSync(file);
      res.writeHead(200, {
        'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
      });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  const port = await freePort();
  await new Promise<void>((resolve) => {
    server.listen(port, '127.0.0.1', resolve);
  });
  const url = `http://127.0.0.1:${String(port)}/`;
  say(`static server (the hosted docs/ bundle): ${url}`);
  return {
    url,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

export interface Download {
  readonly name: string;
  readonly path: string;
  readonly bytes: Uint8Array;
}

/** Where the scenario waits for the files the page downloads (CDP, or Electron's own). */
export interface DownloadWaiter {
  /** The first completed download matching `test` that no earlier wait took. */
  waitFor: (test: (name: string) => boolean, timeoutMs: number, what: string) => Promise<Download>;
  /** Names of every completed download so far, in order. */
  names: () => string[];
}

/** Every download the browser makes, by the name the page gave it. */
export class Downloads implements DownloadWaiter {
  readonly dir: string;
  private readonly items = new Map<string, { name: string; state: string; path: string }>();
  private readonly taken = new Set<string>();
  private readonly waiters = new Set<() => void>();

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async capture(browser: Browser, dir: string): Promise<Downloads> {
    mkdirSync(dir, { recursive: true });
    const downloads = new Downloads(dir);
    const session = await browser.target().createCDPSession();
    session.on('Browser.downloadWillBegin', (event) => {
      downloads.items.set(event.guid, {
        name: event.suggestedFilename,
        state: 'inProgress',
        path: path.join(dir, event.guid),
      });
      say(`download started: ${event.suggestedFilename}`);
    });
    session.on('Browser.downloadProgress', (event) => {
      const item = downloads.items.get(event.guid);
      if (item === undefined || event.state === 'inProgress') return;
      item.state = event.state;
      say(`download ${event.state}: ${item.name} (${String(event.receivedBytes)} B)`);
      for (const wake of [...downloads.waiters]) wake();
    });
    await session.send('Browser.setDownloadBehavior', {
      behavior: 'allowAndName',
      downloadPath: dir,
      eventsEnabled: true,
    });
    return downloads;
  }

  /** Names of every completed download so far, in order. */
  names(): string[] {
    return [...this.items.values()].filter((i) => i.state === 'completed').map((i) => i.name);
  }

  /** The first completed download matching `test` that no earlier wait took. */
  waitFor(test: (name: string) => boolean, timeoutMs: number, what: string): Promise<Download> {
    return new Promise<Download>((resolve, reject) => {
      const look = (): boolean => {
        for (const [guid, item] of this.items) {
          if (this.taken.has(guid) || item.state !== 'completed' || !test(item.name)) continue;
          this.taken.add(guid);
          cleanup();
          resolve({
            name: item.name,
            path: item.path,
            bytes: new Uint8Array(readFileSync(item.path)),
          });
          return true;
        }
        for (const [, item] of this.items) {
          if (item.state === 'canceled' && test(item.name)) {
            cleanup();
            reject(new Error(`the download of ${item.name} was cancelled`));
            return true;
          }
        }
        return false;
      };
      const wake = (): void => {
        look();
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `no ${what} download within ${String(timeoutMs)} ms (downloads so far: ` +
              `${this.names().join(', ') || 'none'})`,
          ),
        );
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.waiters.delete(wake);
      };
      this.waiters.add(wake);
      look();
    });
  }
}

export interface LaunchedChrome {
  readonly browser: Browser;
  readonly downloads: Downloads;
  close(): Promise<void>;
}

/** The installed Chrome on a throwaway profile under `scratchDir`. */
export async function launchChrome(options: {
  readonly scratchDir: string;
  readonly headless: boolean;
}): Promise<LaunchedChrome> {
  mkdirSync(options.scratchDir, { recursive: true });
  const profileDir = mkdtempSync(path.join(options.scratchDir, 'chrome-profile-'));
  mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  writeFileSync(
    path.join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({
      profile: { default_content_setting_values: { automatic_downloads: 1 } },
      download: { prompt_for_download: false },
    }),
  );
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: options.headless,
    userDataDir: profileDir,
    defaultViewport: { width: 1280, height: 900 },
    args: ['--no-first-run', '--no-default-browser-check'],
  });
  say(`chrome: ${await browser.version()} (${options.headless ? 'headless' : 'headed'})`);
  const downloads = await Downloads.capture(browser, path.join(options.scratchDir, 'downloads'));
  return {
    browser,
    downloads,
    close: async () => {
      await browser.close().catch(() => undefined);
      rmSync(profileDir, { recursive: true, force: true });
    },
  };
}

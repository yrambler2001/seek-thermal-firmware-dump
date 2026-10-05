/* ==================================================================== *
 * The Electron main process for the real-camera e2e run (`camera.e2e.ts`).
 *
 * One BrowserWindow on the e2e's own Vite dev server, with REAL Chromium
 * WebUSB and the real macOS USB stack — no stand-in. The test drives the page
 * over CDP (`--remote-debugging-port`, puppeteer.connect) and drives THIS
 * process over stdin/stdout, one JSON object per line:
 *
 *   out  `@@seek-e2e {"event": ...}`  ready, prompt, prompt-devices, selected,
 *                                      refused, download, usb-device-*,
 *                                      window-opened, unload-asked, error
 *   in   `{"cmd": "select" | "cancel" | "open-window" | "quit", ...}`
 *
 * THE DEVICE PICKER, IN CODE. Chromium's chooser is replaced by Electron's
 * `select-usb-device`. Nothing is ever picked on its own: an open chooser is
 * reported to the test and waits, as a person's would, until the test answers
 * it — and the answer is checked here again (the third guard): only a Seek
 * camera (vendor 0x289d), only for a page on the dev server's origin, and only
 * once the page's write guard (`write-guard.ts`, the preload) is in place —
 * otherwise the chooser is cancelled and the refusal reported.
 *
 * PERMISSIONS are Electron's own: no permission handler is installed. Electron
 * 44 keeps a grant for a device with no serial number ephemerally, by the
 * enumeration's GUID, and drops it when the device leaves the bus — what Google
 * Chrome does for this camera (shell/browser/usb/usb_chooser_context.cc). The
 * test reports the serial string Chromium read, which decides it.
 *
 * Everything the profile writes goes under SEEK_E2E_USER_DATA, set before
 * `ready`, which the test deletes afterwards.
 * ==================================================================== */

import path from 'node:path';
import { createInterface } from 'node:readline';

import { app, BrowserWindow, session } from 'electron';

const SEEK_VENDOR_ID = 0x289d;

function required(name) {
  const value = process.env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

const PAGE_URL = required('SEEK_E2E_URL');
const USER_DATA = required('SEEK_E2E_USER_DATA');
const DOWNLOADS = required('SEEK_E2E_DOWNLOADS');
const PRELOAD = required('SEEK_E2E_PRELOAD');
const GUARD_GLOBAL = required('SEEK_E2E_GUARD_GLOBAL');
const HEADED = process.env.SEEK_E2E_HEADED === '1';
const PAGE_ORIGIN = new URL(PAGE_URL).origin;

process.env.ELECTRON_DISABLE_SECURITY_WARNINGS = 'true';
app.setPath('userData', USER_DATA);
app.setPath('sessionData', USER_DATA);
app.setPath('crashDumps', path.join(USER_DATA, 'crash-dumps'));
app.setAppLogsPath(path.join(USER_DATA, 'logs'));

function send(message) {
  process.stdout.write(`@@seek-e2e ${JSON.stringify(message)}\n`);
}

function describe(device) {
  return {
    deviceId: device.deviceId,
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName ?? null,
    manufacturerName: device.manufacturerName ?? null,
    serialNumber: device.serialNumber ?? null,
  };
}

/** The page's write guard, checked in the page's own world before a pick. */
const GUARD_CHECK = `(() => {
  const guard = globalThis[${JSON.stringify(GUARD_GLOBAL)}];
  const out = Object.getOwnPropertyDescriptor(USBDevice.prototype, 'controlTransferOut');
  return guard !== undefined && guard.installed === true && out !== undefined &&
    out.configurable === false && out.writable === false;
})()`;

/** id -> { callback, devices: Map<deviceId, device>, frame } */
const prompts = new Map();
let nextPrompt = 1;
let downloads = 0;

function listOf(prompt) {
  return [...prompt.devices.values()].map(describe);
}

async function answer(command) {
  const prompt = prompts.get(command.id);
  if (prompt === undefined) {
    send({ event: 'error', message: `no open chooser #${String(command.id)}` });
    return;
  }
  prompts.delete(command.id);
  if (command.cmd === 'cancel') {
    prompt.callback();
    send({ event: 'cancelled', id: command.id });
    return;
  }
  const device = prompt.devices.get(command.deviceId);
  const refuse = (why) => {
    prompt.callback();
    send({ event: 'refused', id: command.id, why });
  };
  if (device === undefined)
    return refuse(`device ${String(command.deviceId)} is not in the chooser`);
  if (device.vendorId !== SEEK_VENDOR_ID) {
    return refuse(
      `device ${device.vendorId.toString(16)}:${device.productId.toString(16)} is not a Seek camera`,
    );
  }
  let origin;
  try {
    origin = new URL(prompt.frame?.url ?? '').origin;
  } catch {
    origin = null;
  }
  if (origin !== PAGE_ORIGIN)
    return refuse(`the chooser was opened by ${String(origin)}, not ${PAGE_ORIGIN}`);
  let guarded;
  try {
    guarded = (await prompt.frame.executeJavaScript(GUARD_CHECK)) === true;
  } catch (error) {
    return refuse(`could not check the page's write guard: ${String(error)}`);
  }
  if (!guarded) return refuse("the page's write guard is not in place");
  prompt.callback(device.deviceId);
  send({ event: 'selected', id: command.id, device: describe(device) });
}

/** A window on the page, with the write guard as its preload. Every window the
 *  run opens (the first, and a second one on the test's ask) is built here. */
function openWindow() {
  const window = new BrowserWindow({
    show: HEADED,
    width: 1280,
    height: 900,
    webPreferences: {
      preload: PRELOAD,
      /* The guard must patch the page's own USBDevice before the app runs. */
      contextIsolation: false,
      nodeIntegration: false,
      sandbox: true,
      /* A hidden window must keep real-time timers: the app's waits are 20 ms. */
      backgroundThrottling: false,
    },
  });
  /* A page mid-run asks before it unloads (its beforeunload handler). Chrome
   * shows "Leave site?"; Electron shows nothing and silently keeps the page,
   * which would hang a reload. The test's reload stands for the user who
   * answers "Leave", so it is allowed through — and reported, so the test can
   * check that the page did ask. */
  window.webContents.on('will-prevent-unload', (event) => {
    send({ event: 'unload-asked', id: window.webContents.id });
    event.preventDefault();
  });
  return window;
}

app.whenReady().then(async () => {
  if (!HEADED) app.dock?.hide();
  const ses = session.defaultSession;

  ses.on('select-usb-device', (event, details, callback) => {
    event.preventDefault();
    const id = nextPrompt++;
    const prompt = {
      callback,
      frame: details.frame,
      devices: new Map(details.deviceList.map((device) => [device.deviceId, device])),
    };
    prompts.set(id, prompt);
    send({ event: 'prompt', id, devices: listOf(prompt) });
  });
  ses.on('usb-device-added', (_event, device) => {
    send({ event: 'usb-device-added', device: describe(device) });
    for (const [id, prompt] of prompts) {
      prompt.devices.set(device.deviceId, device);
      send({ event: 'prompt-devices', id, devices: listOf(prompt) });
    }
  });
  ses.on('usb-device-removed', (_event, device) => {
    send({ event: 'usb-device-removed', device: describe(device) });
    for (const [id, prompt] of prompts) {
      prompt.devices.delete(device.deviceId);
      send({ event: 'prompt-devices', id, devices: listOf(prompt) });
    }
  });
  ses.on('usb-device-revoked', (_event, details) => {
    send({ event: 'usb-device-revoked', device: describe(details.device) });
  });
  ses.on('will-download', (_event, item) => {
    downloads += 1;
    const name = item.getFilename();
    const file = path.join(DOWNLOADS, `${String(downloads)}-${name}`);
    item.setSavePath(file);
    send({ event: 'download-started', name });
    item.once('done', (_done, state) => {
      send({ event: 'download', name, path: file, state, bytes: item.getReceivedBytes() });
    });
  });

  createInterface({ input: process.stdin }).on('line', (line) => {
    let command;
    try {
      command = JSON.parse(line);
    } catch {
      send({ event: 'error', message: `not JSON: ${line}` });
      return;
    }
    if (command.cmd === 'quit') {
      app.quit();
      return;
    }
    if (command.cmd === 'open-window') {
      /* A second window on the same page and the same session (so the same
       * grants), with the same preload guard: what a second tab is in Chrome. */
      const second = openWindow();
      second
        .loadURL(PAGE_URL)
        .then(() => {
          send({ event: 'window-opened', id: second.webContents.id });
        })
        .catch((error) => {
          send({ event: 'error', message: `second window: ${String(error)}` });
        });
      return;
    }
    if (command.cmd === 'select' || command.cmd === 'cancel') {
      answer(command).catch((error) => {
        send({ event: 'error', message: String(error) });
      });
      return;
    }
    send({ event: 'error', message: `unknown command ${String(command.cmd)}` });
  });
  /* The test going away ends the app: nothing is left running. */
  process.stdin.on('end', () => {
    app.quit();
  });

  const window = openWindow();
  await window.loadURL(PAGE_URL);
  send({
    event: 'ready',
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

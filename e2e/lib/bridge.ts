/**
 * The Node half of the WebUSB bridge: a page whose `navigator.usb` is the
 * stand-in (`stand-in.ts`), served by whatever `UsbBus` the test hands it.
 *
 * THE BRIDGE IS TARGET-AGNOSTIC. It knows WebUSB and Chrome's chooser and
 * grants; the bus knows the device. `EmulatorBus` serves the FW-V1 emulator over
 * USB/IP and models a reboot; `CameraBus` serves the real camera through
 * node-usb and guards it. Every control transfer passes `UsbBus.check` first,
 * which can refuse it (a guard: the transfer never reaches the device, the page
 * sees a `SecurityError`, and `refusals` records it for the test to fail on) or
 * report that the device went away under it.
 *
 * CHROME'S GRANTS, AS THIS CAMERA MEETS THEM. Chrome keeps a WebUSB grant across
 * enumerations only for a device with a serial number; this camera has none, so
 * every reboot makes it a stranger (TESTING.md sec. 35.1, 35.5): the page sees
 * the `disconnect`, then NO `connect` event and an empty `getDevices()` until
 * the user picks it again in the chooser. The bridge models exactly that — a
 * device with a serial keeps its grant and comes back with a `connect` event.
 *
 * THE CHOOSER mirrors Puppeteer's `DeviceRequestPrompt` (`waitForDevicePrompt`,
 * `waitForDevice`, `select`, `cancel`), so a scenario written against
 * `DevicePrompter` runs unchanged against Chrome's own chooser, were CDP to
 * expose it for WebUSB (it does not, see `device-prompt.e2e.ts`).
 */

import type { Page } from 'puppeteer-core';
import type { WebUsbControlSetup, WebUsbDevice } from '../../packages/core/src/protocol/webusb.js';
import {
  BRIDGE_BINDING,
  BRIDGE_CONTROL,
  type BridgeReply,
  type BridgeRequest,
  type BusEvent,
  type ControlSetup,
  type DeviceInfo,
  type TransferValue,
  type UsbFilter,
} from './protocol.js';
import { installUsbStandIn, type StandInControl } from './stand-in.js';

/* ---- the bus ------------------------------------------------------------- */

/** One enumeration of a device. A reboot is a new `BusDevice` with a new key. */
export interface BusDevice {
  readonly key: string;
  readonly device: WebUsbDevice;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string | null;
  readonly manufacturerName: string | null;
  readonly serialNumber: string | null;
}

export interface BusChange {
  readonly kind: 'attach' | 'detach';
  readonly device: BusDevice;
}

/** What the bus decides about one control transfer before it reaches the device. */
export type Verdict =
  | { readonly kind: 'forward' }
  /** A guard: never sent. The page gets a SecurityError and the test fails. */
  | { readonly kind: 'refuse'; readonly why: string }
  /** The device went away under the transfer (the bus is modelling a reboot). */
  | { readonly kind: 'dropped'; readonly why: string };

export interface UsbBus {
  readonly name: string;
  /** The timeout handed to the host stack with each transfer. WebUSB has none;
   *  a host stack that needs one gets a ceiling above every toolkit deadline. */
  readonly hostTimeoutMs: number;
  present(): readonly BusDevice[];
  subscribe(listener: (change: BusChange) => void): () => void;
  check(
    device: BusDevice,
    direction: 'in' | 'out',
    setup: ControlSetup,
    data: Uint8Array | null,
  ): Verdict;
  close(): Promise<void>;
}

/* ---- the chooser, Puppeteer-shaped ----------------------------------------- */

export interface PromptDevice {
  readonly id: string;
  readonly name: string;
}

export interface DevicePrompt {
  readonly devices: readonly PromptDevice[];
  waitForDevice(
    filter: (device: PromptDevice) => boolean,
    options?: { timeout?: number },
  ): Promise<PromptDevice>;
  select(device: PromptDevice): Promise<void>;
  cancel(): Promise<void>;
}

export interface DevicePrompter {
  waitForDevicePrompt(options?: { timeout?: number }): Promise<DevicePrompt>;
}

function domError(name: string, message: string): DOMException {
  return new DOMException(message, name);
}

function matches(device: BusDevice, filters: readonly UsbFilter[]): boolean {
  if (filters.length === 0) return true;
  return filters.some(
    (filter) =>
      (filter.vendorId === undefined || filter.vendorId === device.vendorId) &&
      (filter.productId === undefined || filter.productId === device.productId),
  );
}

function chooserName(device: BusDevice): string {
  const id = `${device.vendorId.toString(16).padStart(4, '0')}:${device.productId
    .toString(16)
    .padStart(4, '0')}`;
  return device.productName === null ? `Unknown device (${id})` : `${device.productName} (${id})`;
}

class BridgePrompt implements DevicePrompt {
  readonly outcome: Promise<BusDevice>;
  private readonly bridge: UsbBridge;
  private readonly filters: readonly UsbFilter[];
  private settle: { resolve: (d: BusDevice) => void; reject: (e: Error) => void } | null = null;

  constructor(bridge: UsbBridge, filters: readonly UsbFilter[]) {
    this.bridge = bridge;
    this.filters = filters;
    this.outcome = new Promise<BusDevice>((resolve, reject) => {
      this.settle = { resolve, reject };
    });
  }

  get devices(): readonly PromptDevice[] {
    return this.bridge.bus
      .present()
      .filter((device) => matches(device, this.filters))
      .map((device) => ({ id: device.key, name: chooserName(device) }));
  }

  waitForDevice(
    filter: (device: PromptDevice) => boolean,
    options: { timeout?: number } = {},
  ): Promise<PromptDevice> {
    const timeout = options.timeout ?? 30_000;
    return new Promise<PromptDevice>((resolve, reject) => {
      const look = (): boolean => {
        const found = this.devices.find(filter);
        if (found === undefined) return false;
        cleanup();
        resolve(found);
        return true;
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(`no matching device appeared in the chooser within ${String(timeout)} ms`),
        );
      }, timeout);
      const unsubscribe = this.bridge.bus.subscribe(() => {
        look();
      });
      const cleanup = (): void => {
        clearTimeout(timer);
        unsubscribe();
      };
      look();
    });
  }

  select(device: PromptDevice): Promise<void> {
    const chosen = this.bridge.bus.present().find((candidate) => candidate.key === device.id);
    if (chosen === undefined) {
      return Promise.reject(new Error(`${device.name} is no longer on the bus`));
    }
    this.bridge.note(`chooser: picked ${device.name} [${device.id}]`);
    this.settle?.resolve(chosen);
    this.settle = null;
    return Promise.resolve();
  }

  cancel(): Promise<void> {
    this.bridge.note('chooser: cancelled');
    this.settle?.reject(domError('NotFoundError', 'No device selected.'));
    this.settle = null;
    return Promise.resolve();
  }
}

/* ---- the bridge ------------------------------------------------------------ */

export interface BridgeOptions {
  /** Vendor OUT request ids the PAGE refuses before they reach Node (a guard). */
  readonly refuseOutInPage?: readonly number[];
  readonly log?: (line: string) => void;
}

function infoOf(device: BusDevice): DeviceInfo {
  return {
    key: device.key,
    vendorId: device.vendorId,
    productId: device.productId,
    productName: device.productName,
    manufacturerName: device.manufacturerName,
    serialNumber: device.serialNumber,
    configurationValue: device.device.configuration?.configurationValue ?? null,
  };
}

function identityOf(device: BusDevice): string | null {
  const serial = device.serialNumber;
  if (serial === null || serial === '') return null;
  return `${String(device.vendorId)}:${String(device.productId)}:${serial}`;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');
}

function failureOf(error: unknown): BridgeReply {
  if (error instanceof DOMException) return { ok: false, name: error.name, message: error.message };
  if (error instanceof TypeError) return { ok: false, name: 'TypeError', message: error.message };
  /* Anything the host stack threw (a USB/IP error, a node-usb error) is what
   * Chrome reports as a NetworkError: "A transfer error has occurred." */
  const message = error instanceof Error ? error.message : String(error);
  return { ok: false, name: 'NetworkError', message };
}

export class UsbBridge implements DevicePrompter {
  readonly bus: UsbBus;
  /** Every transfer a guard refused. A passing run has none. */
  readonly refusals: string[] = [];
  /** `in 0x4f` -> how many went out, for the report. */
  readonly counts = new Map<string, number>();
  /** The bus and chooser events, timestamped, for the report. */
  readonly timeline: string[] = [];
  private readonly page: Page;
  private readonly log: (line: string) => void;
  private readonly granted = new Set<string>();
  private readonly persistentGrants = new Set<string>();
  private readonly known = new Map<string, BusDevice>();
  private readonly gone = new Set<string>();
  private readonly unclaimedPrompts: BridgePrompt[] = [];
  private readonly promptWaiters: ((prompt: BridgePrompt) => void)[] = [];
  private readonly started = Date.now();
  private readonly unsubscribe: () => void;

  private constructor(page: Page, bus: UsbBus, options: BridgeOptions) {
    this.page = page;
    this.bus = bus;
    this.log = options.log ?? ((): void => undefined);
    for (const device of bus.present()) this.known.set(device.key, device);
    this.unsubscribe = bus.subscribe((change) => {
      void this.onBusChange(change);
    });
  }

  /** Installs the stand-in on every new document of `page` and serves it. Call
   *  before the first navigation. */
  static async attach(page: Page, bus: UsbBus, options: BridgeOptions = {}): Promise<UsbBridge> {
    const bridge = new UsbBridge(page, bus, options);
    await page.exposeFunction(BRIDGE_BINDING, (request: BridgeRequest) => bridge.handle(request));
    await page.evaluateOnNewDocument(installUsbStandIn, {
      binding: BRIDGE_BINDING,
      control: BRIDGE_CONTROL,
      refuseOut: [...(options.refuseOutInPage ?? [])],
    });
    return bridge;
  }

  detach(): void {
    this.unsubscribe();
  }

  /** A line on the timeline, and in the log. */
  note(line: string): void {
    const stamped = `+${((Date.now() - this.started) / 1000).toFixed(1)}s ${line}`;
    this.timeline.push(stamped);
    this.log(`[usb] ${stamped}`);
  }

  /** The page-side guard's own refusals (the page records them itself). */
  async pageRefusals(): Promise<readonly string[]> {
    return this.page.evaluate((name: string) => {
      const control = (globalThis as unknown as Record<string, StandInControl | undefined>)[name];
      return control === undefined ? [] : [...control.refusals];
    }, BRIDGE_CONTROL);
  }

  waitForDevicePrompt(options: { timeout?: number } = {}): Promise<DevicePrompt> {
    const ready = this.unclaimedPrompts.shift();
    if (ready !== undefined) return Promise.resolve(ready);
    const timeout = options.timeout ?? 30_000;
    return new Promise<DevicePrompt>((resolve, reject) => {
      const waiter = (prompt: BridgePrompt): void => {
        clearTimeout(timer);
        resolve(prompt);
      };
      const timer = setTimeout(() => {
        const at = this.promptWaiters.indexOf(waiter);
        if (at >= 0) this.promptWaiters.splice(at, 1);
        reject(new Error(`no device chooser opened within ${String(timeout)} ms`));
      }, timeout);
      this.promptWaiters.push(waiter);
    });
  }

  /* ---- bus changes -> what the page is told ------------------------------ */

  private async onBusChange(change: BusChange): Promise<void> {
    const { device } = change;
    const label = `${chooserName(device)} [${device.key}]`;
    if (change.kind === 'attach') {
      this.known.set(device.key, device);
      this.gone.delete(device.key);
      const identity = identityOf(device);
      const keepsGrant = identity !== null && this.persistentGrants.has(identity);
      if (keepsGrant) this.granted.add(device.key);
      this.note(
        `bus: ${label} attached — ` +
          (keepsGrant
            ? 'Chrome still holds its grant (it has a serial number): connect event'
            : 'no grant (no serial number), so no connect event and getDevices() stays empty'),
      );
      if (keepsGrant) await this.tellPage({ type: 'connect', device: infoOf(device) });
      return;
    }
    this.gone.add(device.key);
    const wasGranted = this.granted.has(device.key);
    if (identityOf(device) === null) this.granted.delete(device.key);
    this.note(`bus: ${label} detached${wasGranted ? ' — disconnect event' : ''}`);
    if (wasGranted) await this.tellPage({ type: 'disconnect', device: infoOf(device) });
  }

  private async tellPage(event: BusEvent): Promise<void> {
    try {
      await this.page.evaluate(
        (name: string, payload: BusEvent) => {
          const control = (globalThis as unknown as Record<string, StandInControl | undefined>)[
            name
          ];
          control?.event(payload);
        },
        BRIDGE_CONTROL,
        event,
      );
    } catch (error) {
      this.note(`could not deliver ${event.type} to the page: ${String(error)}`);
    }
  }

  /* ---- page requests ----------------------------------------------------- */

  private async handle(request: BridgeRequest): Promise<BridgeReply> {
    try {
      switch (request.op) {
        case 'getDevices':
          return {
            ok: true,
            value: this.bus
              .present()
              .filter((device) => this.granted.has(device.key))
              .map(infoOf),
          };
        case 'requestDevice': {
          const chosen = await this.openPrompt(request.filters);
          return { ok: true, value: infoOf(chosen) };
        }
        case 'call':
          return await this.call(request);
      }
    } catch (error) {
      return failureOf(error);
    }
  }

  private async openPrompt(filters: readonly UsbFilter[]): Promise<BusDevice> {
    const prompt = new BridgePrompt(this, filters);
    this.note(`chooser: opened (${String(prompt.devices.length)} device(s) listed)`);
    const waiter = this.promptWaiters.shift();
    if (waiter !== undefined) waiter(prompt);
    else this.unclaimedPrompts.push(prompt);
    const chosen = await prompt.outcome;
    this.granted.add(chosen.key);
    const identity = identityOf(chosen);
    if (identity !== null) this.persistentGrants.add(identity);
    return chosen;
  }

  private count(direction: 'in' | 'out', request: number): void {
    const key = `${direction} 0x${request.toString(16).padStart(2, '0')}`;
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  private async call(request: BridgeRequest & { op: 'call' }): Promise<BridgeReply> {
    const entry = this.known.get(request.key);
    if (entry === undefined || this.gone.has(request.key)) {
      throw domError('NotFoundError', 'The device was disconnected.');
    }
    if (!this.granted.has(request.key)) {
      throw domError('NotFoundError', 'The device is not allowed (no grant).');
    }
    const device = entry.device;
    let value: unknown = undefined;
    switch (request.method) {
      case 'open':
        await device.open();
        break;
      case 'close':
        await device.close();
        break;
      case 'forget': {
        this.granted.delete(request.key);
        const identity = identityOf(entry);
        if (identity !== null) this.persistentGrants.delete(identity);
        this.note(`page: forget() ${chooserName(entry)}`);
        await device.close().catch(() => undefined);
        break;
      }
      case 'reset':
        throw domError('NotSupportedError', 'USBDevice.reset() is not modelled by the e2e bridge');
      case 'selectConfiguration':
        await device.selectConfiguration(request.n);
        break;
      case 'claimInterface':
        await device.claimInterface(request.n);
        break;
      case 'releaseInterface':
        await device.releaseInterface(request.n);
        break;
      case 'controlTransferIn': {
        const setup = this.vendorSetup(request.setup);
        this.count('in', setup.request);
        this.enforce(this.bus.check(entry, 'in', request.setup, null), 'in', setup.request);
        const result = await device.controlTransferIn(
          setup,
          request.length,
          this.bus.hostTimeoutMs,
        );
        const data = result.data;
        const transfer: TransferValue = {
          status: result.status,
          ...(data === undefined
            ? {}
            : {
                data: toBase64(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
              }),
        };
        value = transfer;
        break;
      }
      case 'controlTransferOut': {
        const setup = this.vendorSetup(request.setup);
        const bytes = new Uint8Array(Buffer.from(request.data, 'base64'));
        this.count('out', setup.request);
        this.enforce(this.bus.check(entry, 'out', request.setup, bytes), 'out', setup.request);
        const result = await device.controlTransferOut(setup, bytes, this.bus.hostTimeoutMs);
        const transfer: TransferValue = {
          status: result.status,
          bytesWritten: result.bytesWritten ?? bytes.length,
        };
        value = transfer;
        break;
      }
    }
    return {
      ok: true,
      value,
      state: {
        opened: device.opened,
        configurationValue: device.configuration?.configurationValue ?? null,
      },
    };
  }

  /** The app sends vendor requests only; anything else is refused unsent. */
  private vendorSetup(setup: ControlSetup): WebUsbControlSetup {
    if (
      setup.requestType !== 'vendor' ||
      (setup.recipient !== 'device' && setup.recipient !== 'interface')
    ) {
      throw domError(
        'NotSupportedError',
        `the e2e bridge forwards vendor requests to the device or an interface only ` +
          `(got ${setup.requestType} to ${setup.recipient})`,
      );
    }
    return {
      requestType: 'vendor',
      recipient: setup.recipient,
      request: setup.request,
      value: setup.value,
      index: setup.index,
    };
  }

  private enforce(verdict: Verdict, direction: 'in' | 'out', request: number): void {
    if (verdict.kind === 'forward') return;
    const what = `${direction.toUpperCase()} 0x${request.toString(16)}`;
    if (verdict.kind === 'refuse') {
      const line = `GUARD refused ${what}: ${verdict.why}`;
      this.refusals.push(line);
      this.note(line);
      throw domError('SecurityError', `e2e guard: ${verdict.why}`);
    }
    this.note(`${what} dropped: ${verdict.why}`);
    throw domError('NetworkError', verdict.why);
  }
}

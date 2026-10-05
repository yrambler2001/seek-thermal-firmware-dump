/**
 * The page's `navigator.usb`, replaced.
 *
 * `installUsbStandIn` runs IN THE PAGE (`page.evaluateOnNewDocument`), before
 * the app's first script, so it must be self-contained: Puppeteer sends its
 * source text, nothing it closes over comes along. Only type imports are used
 * here, and they are erased.
 *
 * It is a WebUSB-shaped object and nothing more: every device call goes to Node
 * through the exposed binding, where a real `WebUsbDevice` serves it (the
 * emulator's USB/IP adapter, or node-usb on a real camera). What it models of
 * Chrome itself, on purpose:
 *
 *  - `requestDevice` needs a user gesture (`SecurityError` without one) and is
 *    answered by the test through the bridge's chooser, as a person answers
 *    Chrome's;
 *  - `getDevices` and the connect/disconnect events see only devices the page
 *    holds a grant for, and the Node bridge decides the grants — a camera with
 *    no serial number loses its grant when it leaves the bus;
 *  - a device that left the bus stays a dead object: `opened` is false and
 *    every call rejects with `NotFoundError`, as Chrome's does.
 *
 * `refuseOut` is a guard, not a model: vendor OUT requests listed there are
 * refused in the page before anything reaches Node (the real-camera run lists
 * the flash writes). Each refusal is recorded for the test to assert on.
 */

import type {
  BridgeFailure,
  BridgeReply,
  BridgeRequest,
  BusEvent,
  ControlSetup,
  DeviceCall,
  DeviceInfo,
  DeviceState,
  TransferValue,
  UsbFilter,
} from './protocol.js';

export interface StandInConfig {
  /** The exposed function's name (`BRIDGE_BINDING`). */
  readonly binding: string;
  /** Where the page publishes its control object (`BRIDGE_CONTROL`). */
  readonly control: string;
  /** Vendor OUT request ids the page refuses outright. */
  readonly refuseOut: readonly number[];
}

/** What the page publishes at `config.control`, for the Node side. */
export interface StandInControl {
  readonly refusals: string[];
  event: (event: BusEvent) => void;
}

export function installUsbStandIn(config: StandInConfig): void {
  const scope = globalThis as unknown as Record<string, unknown>;

  const bridge = async (request: BridgeRequest): Promise<BridgeReply> => {
    const fn = scope[config.binding];
    if (typeof fn !== 'function') {
      return {
        ok: false,
        name: 'NotSupportedError',
        message: 'the e2e USB bridge is not attached',
      };
    }
    return await (fn as (r: BridgeRequest) => Promise<BridgeReply>)(request);
  };

  const failure = (reply: BridgeFailure): Error =>
    reply.name === 'TypeError'
      ? new TypeError(reply.message)
      : new DOMException(reply.message, reply.name);

  const toBase64 = (bytes: Uint8Array): string => {
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  };

  const fromBase64 = (text: string): Uint8Array => {
    const raw = atob(text);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  };

  const bytesOf = (data: BufferSource | undefined): Uint8Array => {
    if (data === undefined) return new Uint8Array(0);
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  };

  const plainSetup = (setup: USBControlTransferParameters): ControlSetup => ({
    requestType: setup.requestType,
    recipient: setup.recipient,
    request: setup.request,
    value: setup.value,
    index: setup.index,
  });

  const notModelled = (what: string): Promise<never> =>
    Promise.reject(
      new DOMException(`${what} is not modelled by the e2e USB bridge`, 'NotSupportedError'),
    );

  const control: StandInControl = {
    refusals: [],
    event: () => undefined,
  };

  class StandInDevice {
    readonly key: string;
    readonly vendorId: number;
    readonly productId: number;
    readonly productName: string | null;
    readonly manufacturerName: string | null;
    readonly serialNumber: string | null;
    readonly usbVersionMajor = 2;
    readonly usbVersionMinor = 0;
    readonly usbVersionSubminor = 0;
    readonly deviceClass = 0;
    readonly deviceSubclass = 0;
    readonly deviceProtocol = 0;
    readonly deviceVersionMajor = 0;
    readonly deviceVersionMinor = 0;
    readonly deviceVersionSubminor = 0;
    private state: DeviceState;

    constructor(info: DeviceInfo) {
      this.key = info.key;
      this.vendorId = info.vendorId;
      this.productId = info.productId;
      this.productName = info.productName;
      this.manufacturerName = info.manufacturerName;
      this.serialNumber = info.serialNumber;
      this.state = { opened: false, configurationValue: info.configurationValue };
    }

    get opened(): boolean {
      return this.state.opened;
    }

    get configuration(): USBConfiguration | null {
      const value = this.state.configurationValue;
      return value === null
        ? null
        : {
            configurationValue: value,
            configurationName: null,
            interfaces: [],
          };
    }

    get configurations(): USBConfiguration[] {
      return [
        {
          configurationValue: 1,
          configurationName: null,
          interfaces: [],
        },
      ];
    }

    /** The device left the bus: what Chrome's dead `USBDevice` reports. */
    markGone(): void {
      this.state = { opened: false, configurationValue: this.state.configurationValue };
    }

    private async call(body: DeviceCall): Promise<unknown> {
      const reply = await bridge({ op: 'call', key: this.key, ...body });
      if (!reply.ok) throw failure(reply);
      if (reply.state !== undefined) this.state = reply.state;
      return reply.value;
    }

    async open(): Promise<void> {
      await this.call({ method: 'open' });
    }

    async close(): Promise<void> {
      await this.call({ method: 'close' });
    }

    async forget(): Promise<void> {
      await this.call({ method: 'forget' });
    }

    async reset(): Promise<void> {
      await this.call({ method: 'reset' });
    }

    async selectConfiguration(n: number): Promise<void> {
      await this.call({ method: 'selectConfiguration', n });
    }

    async claimInterface(n: number): Promise<void> {
      await this.call({ method: 'claimInterface', n });
    }

    async releaseInterface(n: number): Promise<void> {
      await this.call({ method: 'releaseInterface', n });
    }

    selectAlternateInterface(): Promise<void> {
      return notModelled('selectAlternateInterface');
    }

    clearHalt(): Promise<void> {
      return notModelled('clearHalt');
    }

    transferIn(): Promise<USBInTransferResult> {
      return notModelled('transferIn');
    }

    transferOut(): Promise<USBOutTransferResult> {
      return notModelled('transferOut');
    }

    isochronousTransferIn(): Promise<USBIsochronousInTransferResult> {
      return notModelled('isochronousTransferIn');
    }

    isochronousTransferOut(): Promise<USBIsochronousOutTransferResult> {
      return notModelled('isochronousTransferOut');
    }

    async controlTransferIn(
      setup: USBControlTransferParameters,
      length: number,
    ): Promise<USBInTransferResult> {
      const value = (await this.call({
        method: 'controlTransferIn',
        setup: plainSetup(setup),
        length,
      })) as TransferValue;
      const data = value.data === undefined ? undefined : fromBase64(value.data);
      return {
        status: value.status,
        data: data === undefined ? undefined : new DataView(data.buffer, 0, data.byteLength),
      };
    }

    async controlTransferOut(
      setup: USBControlTransferParameters,
      data?: BufferSource,
    ): Promise<USBOutTransferResult> {
      if (setup.requestType === 'vendor' && config.refuseOut.includes(setup.request)) {
        const what = `vendor OUT 0x${setup.request.toString(16)} refused by the page-side e2e guard`;
        control.refusals.push(what);
        throw new DOMException(what, 'SecurityError');
      }
      const value = (await this.call({
        method: 'controlTransferOut',
        setup: plainSetup(setup),
        data: toBase64(bytesOf(data)),
      })) as TransferValue;
      return {
        status: value.status,
        bytesWritten: value.bytesWritten ?? 0,
      };
    }
  }

  const proxies = new Map<string, StandInDevice>();
  const proxyFor = (info: DeviceInfo): StandInDevice => {
    const known = proxies.get(info.key);
    if (known !== undefined) return known;
    const created = new StandInDevice(info);
    proxies.set(info.key, created);
    return created;
  };

  class StandInUsb extends EventTarget {
    onconnect: ((event: Event) => void) | null = null;
    ondisconnect: ((event: Event) => void) | null = null;

    async getDevices(): Promise<StandInDevice[]> {
      const reply = await bridge({ op: 'getDevices' });
      if (!reply.ok) throw failure(reply);
      return (reply.value as DeviceInfo[]).map(proxyFor);
    }

    async requestDevice(options?: { filters?: UsbFilter[] }): Promise<StandInDevice> {
      if (options === undefined || !Array.isArray(options.filters)) {
        throw new TypeError(
          "Failed to execute 'requestDevice' on 'USB': required member filters is undefined.",
        );
      }
      if (!navigator.userActivation.isActive) {
        throw new DOMException(
          'Must be handling a user gesture to show a permission request.',
          'SecurityError',
        );
      }
      const filters = options.filters.map((filter) => ({
        ...(filter.vendorId === undefined ? {} : { vendorId: filter.vendorId }),
        ...(filter.productId === undefined ? {} : { productId: filter.productId }),
      }));
      const reply = await bridge({ op: 'requestDevice', filters });
      if (!reply.ok) throw failure(reply);
      return proxyFor(reply.value as DeviceInfo);
    }
  }

  const usb = new StandInUsb();

  control.event = (event: BusEvent): void => {
    const device = proxyFor(event.device);
    if (event.type === 'disconnect') device.markGone();
    const dispatched = new Event(event.type);
    Object.defineProperty(dispatched, 'device', { value: device });
    usb.dispatchEvent(dispatched);
    const handler = event.type === 'connect' ? usb.onconnect : usb.ondisconnect;
    handler?.call(usb, dispatched);
  };
  scope[config.control] = control;

  Object.defineProperty(Navigator.prototype, 'usb', {
    configurable: true,
    enumerable: true,
    get: () => usb,
  });
}

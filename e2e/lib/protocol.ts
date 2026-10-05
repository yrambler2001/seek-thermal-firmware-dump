/**
 * The wire between the page's `navigator.usb` stand-in and the Node bridge.
 *
 * Everything crosses `page.exposeFunction`, which carries JSON, so binary
 * payloads travel as base64 and every reply is a plain object. The page never
 * sees a device object from Node: it holds a proxy per `key`, and the key names
 * ONE enumeration of the camera — a reboot is a new key, exactly as Chrome
 * hands the page a new `USBDevice` for a camera that re-enumerated.
 */

/** What a `USBDevice` reports about itself, for one enumeration. */
export interface DeviceInfo {
  readonly key: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string | null;
  readonly manufacturerName: string | null;
  readonly serialNumber: string | null;
  /** The active configuration when the page first sees this enumeration. */
  readonly configurationValue: number | null;
}

/** The mutable part of a `USBDevice`, sent back with every call. */
export interface DeviceState {
  readonly opened: boolean;
  readonly configurationValue: number | null;
}

export interface UsbFilter {
  readonly vendorId?: number;
  readonly productId?: number;
}

/** A WebUSB control setup, as the page passes it. */
export interface ControlSetup {
  readonly requestType: 'standard' | 'class' | 'vendor';
  readonly recipient: 'device' | 'interface' | 'endpoint' | 'other';
  readonly request: number;
  readonly value: number;
  readonly index: number;
}

export type DeviceCall =
  | { readonly method: 'open' | 'close' | 'forget' | 'reset' }
  | {
      readonly method: 'selectConfiguration' | 'claimInterface' | 'releaseInterface';
      readonly n: number;
    }
  | { readonly method: 'controlTransferIn'; readonly setup: ControlSetup; readonly length: number }
  | { readonly method: 'controlTransferOut'; readonly setup: ControlSetup; readonly data: string };

export type BridgeRequest = (
  | { readonly op: 'getDevices' }
  | { readonly op: 'requestDevice'; readonly filters: readonly UsbFilter[] }
  | ({ readonly op: 'call'; readonly key: string } & DeviceCall)
) & {
  /**
   * Which document sent it: a random id the stand-in draws once per page load.
   * A request from a new document means the old one unloaded, and Chrome closes
   * every device an unloaded document held — the bridge does the same.
   */
  readonly doc?: string;
};

/** A failure, as the DOMException the page rebuilds from it. */
export interface BridgeFailure {
  readonly ok: false;
  readonly name: string;
  readonly message: string;
}

export interface BridgeSuccess {
  readonly ok: true;
  /** `getDevices`: DeviceInfo[]; `requestDevice`: DeviceInfo; transfers: TransferValue. */
  readonly value: unknown;
  readonly state?: DeviceState;
}

export type BridgeReply = BridgeSuccess | BridgeFailure;

export interface TransferValue {
  readonly status: 'ok' | 'stall' | 'babble';
  /** IN: the data stage, base64. */
  readonly data?: string;
  /** OUT: how many bytes went out. */
  readonly bytesWritten?: number;
}

/** Node -> page: the bus changed under a device the page is allowed to see. */
export interface BusEvent {
  readonly type: 'connect' | 'disconnect';
  readonly device: DeviceInfo;
}

/** The names both sides agree on. */
export const BRIDGE_BINDING = '__seekE2eUsbBridge';
export const BRIDGE_CONTROL = '__seekE2eUsbControl';

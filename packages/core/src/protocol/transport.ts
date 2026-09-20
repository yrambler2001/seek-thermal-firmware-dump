/**
 * The transport boundary.
 *
 * Everything above this interface is pure logic and runs identically in a
 * browser and in Node. Below it sit exactly two implementations: `navigator.usb`
 * in the web app, and the `usb` package's WebUSB shim in the CLI. Both speak the
 * WebUSB shape, so `WebUsbTransport` in ./webusb.ts serves both and there is no
 * second protocol implementation to keep in sync.
 */

/** USB control-transfer recipient. Some hosts refuse to claim interface 0, in
 *  which case the camera still answers device-recipient requests. */
export type Recipient = 'device' | 'interface';

export interface DeviceDescription {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName: string | null;
  readonly manufacturerName: string | null;
  readonly serialNumber: string | null;
}

export interface TransportInfo {
  /** e.g. "WebUSB" or "node-usb 3.x (WebUSB shim)". */
  readonly api: string;
  readonly recipient: Recipient;
  readonly interfaceNumber: number;
  readonly claimedInterface: boolean;
  /** Free-form host identification recorded in dump manifests. */
  readonly host: string | null;
}

export interface UsbTransport {
  readonly description: DeviceDescription;
  readonly info: TransportInfo;
  readonly isOpen: boolean;

  /** Idempotent. Selects the configuration and claims the interface if it can. */
  open(): Promise<void>;
  /** Idempotent, and safe to call on a device that has already vanished. */
  close(): Promise<void>;

  /**
   * Vendor control IN. Resolves with the bytes actually returned, which may be
   * shorter than `length`. Must REJECT on a stall rather than resolving empty —
   * WebUSB resolves with status "stall", and a silent zero-length read would be
   * indistinguishable from an end-of-data.
   */
  controlIn(request: number, length: number, timeoutMs: number): Promise<Uint8Array>;

  /** Vendor control OUT. Must reject on a stall. */
  controlOut(request: number, data: Uint8Array, timeoutMs: number): Promise<void>;
}

/** Discovery is platform-specific; each platform package provides one of these. */
export interface UsbBackend {
  /** Devices the user has already authorized. */
  listDevices(): Promise<UsbTransport[]>;
  /** Prompts the user to pick a device. Rejects if they cancel. */
  requestDevice(): Promise<UsbTransport>;
}

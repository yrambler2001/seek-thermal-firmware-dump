/**
 * The REAL camera as a USB bus, through the CLI's host stack (the `usb`
 * package's WebUSB shim and `fromNodeUsb`'s corrections) — and guarded.
 *
 * WHAT IT WILL SEND. A whitelist, checked before every transfer
 * (`UsbBridge` turns a refusal into a SecurityError in the page and a line in
 * `refusals`, which fails the test), and checked AGAIN inside the device
 * wrapper, so a transfer that somehow skipped the first check still never
 * reaches the camera:
 *
 *   IN   0x35 GetErrorCode, 0x3D GetOperationMode, 0x4E GetFirmwareInfo,
 *        0x4F GetFeaturedFirmwareData (the window reader), 0x58 GetFeaturedData
 *        (the 0.7.x reader)
 *   OUT  0x3C SetOperationMode, payload u16 0 only;
 *        0x52 BeginFirmwareUpgrade (arms a read window) — only once the camera
 *        has reported its version on this bus (the toolkit's own rule: nothing
 *        but the identity reads before the build is known; on 0.3.0.1 wire 0x52
 *        is EnterBootloaderMode);
 *        0x59 ResetDevice, payload u16 0 only, and only while `allowReset` is
 *        set — the test sets it for Preserve step 02, whose probe may reboot a
 *        spent reader by command. Dump & decrypt promises no reset at all.
 *
 * Everything else — above all 0x50 SetFeaturedFirmwareData and 0x51
 * CompleteMemoryUpgrade, the only two requests that change flash, and the 0x55
 * / 0x5A selectors only the flash view uses — is refused unsent.
 *
 * A reboot is the camera's own: it leaves the bus and re-enumerates, node-usb
 * reports both, and the bridge turns them into what Chrome would show the
 * page.
 */

import { fromNodeUsb, type NodeUsbDevice } from '../../packages/cli/src/node-usb.js';
import { OP, SEEK_VENDOR_ID } from '../../packages/core/src/protocol/ops.js';
import { RESET_OP } from '../../packages/core/src/preservation/pipeline.js';
import type {
  WebUsbControlSetup,
  WebUsbDevice,
  WebUsbInTransferResult,
  WebUsbOutTransferResult,
} from '../../packages/core/src/protocol/webusb.js';
import type { BusChange, BusDevice, UsbBus, Verdict } from './bridge.js';
import type { ControlSetup } from './protocol.js';

const ALLOWED_IN: ReadonlySet<number> = new Set([
  OP.GET_ERROR_CODE,
  OP.GET_OPERATION_MODE,
  OP.GET_FIRMWARE_INFO,
  OP.GET_FEATURED_FIRMWARE_DATA,
  OP.GET_FEATURED_DATA,
]);

/** The two requests that change the camera's flash. Never, whatever else changes. */
export const FLASH_WRITE_OPS: readonly number[] = [
  OP.SET_FEATURED_FIRMWARE_DATA,
  OP.COMPLETE_MEMORY_UPGRADE,
];

/** What the page itself refuses on this target, before Node sees it. */
export const PAGE_REFUSED_OUT: readonly number[] = [
  OP.SET_FEATURED_FIRMWARE_DATA,
  OP.COMPLETE_MEMORY_UPGRADE,
  OP.SET_FIRMWARE_INFO_FEATURES,
  OP.SET_RAM_DATA_FEATURES,
];

const hexOp = (op: number): string => `0x${op.toString(16).padStart(2, '0')}`;

function isU16Zero(data: Uint8Array | null): boolean {
  return data !== null && data.length === 2 && data[0] === 0 && data[1] === 0;
}

export class CameraBus implements UsbBus {
  readonly name = 'real camera (node-usb)';
  /** nusb needs a timeout; this is above every deadline the read paths set (20 s). */
  readonly hostTimeoutMs = 25_000;
  /** Set by the test for Preserve step 02 only. */
  allowReset = false;
  /** The version the camera reported, once it has. */
  version: string | null = null;
  /** Every transfer the inner wrapper had to stop (a passing run has none). */
  readonly innerRefusals: string[] = [];
  private readonly log: (line: string) => void;
  private readonly listeners = new Set<(change: BusChange) => void>();
  private readonly webusb: EventTarget & { getDevices: () => Promise<NodeUsbDevice[]> };
  private current: { readonly bus: BusDevice; readonly raw: NodeUsbDevice } | null = null;
  private enumerations = 0;

  private constructor(
    webusb: EventTarget & { getDevices: () => Promise<NodeUsbDevice[]> },
    log: (line: string) => void,
  ) {
    this.webusb = webusb;
    this.log = log;
  }

  static async open(log: (line: string) => void): Promise<CameraBus> {
    const { WebUSB } = await import('usb');
    const webusb = new WebUSB({ allowAllDevices: true }) as unknown as EventTarget & {
      getDevices: () => Promise<NodeUsbDevice[]>;
    };
    const bus = new CameraBus(webusb, log);
    const cameras = (await webusb.getDevices()).filter((d) => d.vendorId === SEEK_VENDOR_ID);
    if (cameras.length !== 1) {
      throw new Error(`expected exactly one Seek camera, found ${String(cameras.length)}`);
    }
    const [camera] = cameras;
    if (camera !== undefined) bus.adopt(camera);
    webusb.addEventListener('connect', bus.onConnect);
    webusb.addEventListener('disconnect', bus.onDisconnect);
    return bus;
  }

  private readonly onConnect = (event: Event): void => {
    const device = (event as unknown as { device: NodeUsbDevice }).device;
    if (device.vendorId !== SEEK_VENDOR_ID || this.current !== null) return;
    this.log('[camera] a Seek camera arrived on the bus');
    this.adopt(device);
  };

  private readonly onDisconnect = (event: Event): void => {
    const device = (event as unknown as { device: NodeUsbDevice }).device;
    const held = this.current;
    if (held === null || device.vendorId !== SEEK_VENDOR_ID) return;
    this.current = null;
    this.log('[camera] the camera left the bus');
    this.emit({ kind: 'detach', device: held.bus });
  };

  present(): readonly BusDevice[] {
    return this.current === null ? [] : [this.current.bus];
  }

  subscribe(listener: (change: BusChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: BusChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  private adopt(raw: NodeUsbDevice): void {
    const device = this.guarded(fromNodeUsb(raw));
    const bus: BusDevice = {
      key: `cam-${String(this.enumerations++)}`,
      device,
      vendorId: device.vendorId,
      productId: device.productId,
      productName: device.productName,
      manufacturerName: device.manufacturerName,
      serialNumber: device.serialNumber,
    };
    this.current = { bus, raw };
    this.log(
      `[camera] ${bus.key}: ${bus.productName ?? '?'} ${hexOp(bus.vendorId)}:${hexOp(bus.productId)}, ` +
        `serial ${bus.serialNumber ?? 'none'}`,
    );
    this.emit({ kind: 'attach', device: bus });
  }

  /** The whitelist. Null when the transfer may go out. */
  private refusal(
    direction: 'in' | 'out',
    request: number,
    data: Uint8Array | null,
  ): string | null {
    if (direction === 'in') {
      return ALLOWED_IN.has(request) ? null : `IN ${hexOp(request)} is not a read this run allows`;
    }
    if (FLASH_WRITE_OPS.includes(request)) {
      return `OUT ${hexOp(request)} changes flash — never on the real camera`;
    }
    if (request === OP.SET_OPERATION_MODE) {
      return isU16Zero(data) ? null : 'SetOperationMode with a payload other than u16 0';
    }
    if (request === OP.BEGIN_FIRMWARE_UPGRADE) {
      return this.version === null
        ? 'BeginFirmwareUpgrade before the camera reported its version'
        : null;
    }
    if (request === RESET_OP) {
      if (!isU16Zero(data)) return 'ResetDevice with a non-zero payload (the TIMER1 arm route)';
      return this.allowReset ? null : 'ResetDevice outside Preserve step 02';
    }
    return `OUT ${hexOp(request)} is not on this run's whitelist`;
  }

  check(
    _device: BusDevice,
    direction: 'in' | 'out',
    setup: ControlSetup,
    data: Uint8Array | null,
  ): Verdict {
    const why = this.refusal(direction, setup.request, data);
    return why === null ? { kind: 'forward' } : { kind: 'refuse', why };
  }

  /** The second line: the same whitelist inside the device itself, and the version read noted. */
  private guarded(inner: WebUsbDevice): WebUsbDevice {
    const stop = (why: string): never => {
      this.innerRefusals.push(why);
      throw new DOMException(`e2e guard (inner): ${why}`, 'SecurityError');
    };
    return {
      get vendorId() {
        return inner.vendorId;
      },
      get productId() {
        return inner.productId;
      },
      get manufacturerName() {
        return inner.manufacturerName;
      },
      get productName() {
        return inner.productName;
      },
      get serialNumber() {
        return inner.serialNumber;
      },
      get configuration() {
        return inner.configuration;
      },
      get opened() {
        return inner.opened;
      },
      open: () => inner.open(),
      close: () => inner.close(),
      selectConfiguration: (value) => inner.selectConfiguration(value),
      claimInterface: (n) => inner.claimInterface(n),
      releaseInterface: (n) => inner.releaseInterface(n),
      controlTransferIn: async (
        setup: WebUsbControlSetup,
        length: number,
        timeoutMs: number,
      ): Promise<WebUsbInTransferResult> => {
        const why = this.refusal('in', setup.request, null);
        if (why !== null) stop(why);
        const result = await inner.controlTransferIn(setup, length, timeoutMs);
        const data = result.data;
        if (
          setup.request === OP.GET_FIRMWARE_INFO &&
          result.status === 'ok' &&
          data !== undefined &&
          data.byteLength >= 4
        ) {
          const v = `${String(data.getUint8(0))}.${String(data.getUint8(1))}.${String(
            data.getUint8(2),
          )}.${String(data.getUint8(3))}`;
          if (this.version !== v) this.log(`[camera] the camera reports firmware ${v}`);
          this.version = v;
        }
        return result;
      },
      controlTransferOut: (
        setup: WebUsbControlSetup,
        data: ArrayBufferView,
        timeoutMs: number,
      ): Promise<WebUsbOutTransferResult> => {
        const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        const why = this.refusal('out', setup.request, bytes);
        if (why !== null) stop(why);
        return inner.controlTransferOut(setup, data, timeoutMs);
      },
    };
  }

  /** Closes the handle (if the page left it open) and stops listening. */
  async close(): Promise<void> {
    this.webusb.removeEventListener('connect', this.onConnect);
    this.webusb.removeEventListener('disconnect', this.onDisconnect);
    const held = this.current;
    if (held?.bus.device.opened === true) {
      await held.bus.device.close().catch(() => undefined);
    }
    this.current = null;
  }
}

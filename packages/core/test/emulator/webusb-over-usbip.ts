/* ==================================================================== *
 * A `WebUsbDevice` backed by a USB/IP session.
 *
 * This is the one piece of test-only scaffolding the emulator suite needs, and
 * it is deliberately the thinnest possible: it implements exactly the structural
 * interface `WebUsbTransport` declares (`packages/core/src/protocol/webusb.ts`)
 * and forwards every control transfer onto the wire. No toolkit source is
 * changed to make any of this work.
 *
 * What it does NOT fake:
 *
 *  - the string descriptors are read off the device with real GET_DESCRIPTOR
 *    control transfers, so the manufacturer, product and serial a test asserts
 *    were produced by the firmware reading its own flash, not by a fixture;
 *  - `selectConfiguration` and `claimInterface` issue a real SET_CONFIGURATION
 *    and a real SET_INTERFACE;
 *  - a stall comes back as `status: 'stall'`, which is what a browser's WebUSB
 *    does and what the transport's error handling is written against. A
 *    transport-level timeout is left to `WebUsbTransport.withTimeout`, exactly
 *    as in the browser, but the URB itself also carries libusb's deadline so a
 *    hung emulator cannot leak a pending transfer.
 * ==================================================================== */

import type {
  WebUsbConfiguration,
  WebUsbControlSetup,
  WebUsbDevice,
  WebUsbInTransferResult,
  WebUsbOutTransferResult,
} from '../../src/protocol/webusb.js';
import { UsbIpSession, UsbIpStall } from './usbip-client.js';

const STANDARD_IN = 0x80;
const REQ_GET_DESCRIPTOR = 0x06;
const REQ_SET_CONFIGURATION = 0x09;
const REQ_SET_INTERFACE = 0x0b;
const DESC_DEVICE = 0x01;
const DESC_STRING = 0x03;

/** Per control transfer on the wire. Generous: the emulator is ~1000x slower
 *  than silicon, and a 2 s default is exactly what defeated an earlier tool. */
export const DEFAULT_URB_TIMEOUT_MS = 30_000;

/** How long `open()` keeps trying to re-import after a `close()`. */
export const REOPEN_TIMEOUT_MS = 20_000;

function requestType(setup: WebUsbControlSetup, dirIn: boolean): number {
  const dir = dirIn ? 0x80 : 0x00;
  const type = 0x40; /* vendor */
  const recipient = setup.recipient === 'interface' ? 0x01 : 0x00;
  return dir | type | recipient;
}

export interface UsbIpWebUsbOptions {
  /** Per-URB deadline in milliseconds. */
  readonly urbTimeoutMs?: number;
}

export class UsbIpWebUsbDevice implements WebUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  manufacturerName: string | null = null;
  productName: string | null = null;
  serialNumber: string | null = null;
  configuration: WebUsbConfiguration | null = null;
  opened = false;

  private session: UsbIpSession;
  private readonly timeoutMs: number;
  private readonly where: { host: string; port: number; busid: string };
  /** Raw 18-byte device descriptor, as the device returned it. */
  deviceDescriptor: Uint8Array = new Uint8Array(0);
  /** How many times `open()` had to re-import the device after a `close()`. */
  reopens = 0;

  private constructor(
    session: UsbIpSession,
    timeoutMs: number,
    where: { host: string; port: number; busid: string },
  ) {
    this.session = session;
    this.timeoutMs = timeoutMs;
    this.where = where;
    this.vendorId = session.device.idVendor;
    this.productId = session.device.idProduct;
  }

  /** Import the device and read its identity, as a host does on plug-in. */
  static async attach(
    host: string,
    port: number,
    busid: string,
    options: UsbIpWebUsbOptions = {},
  ): Promise<UsbIpWebUsbDevice> {
    const session = await UsbIpSession.attach(host, port, busid);
    const device = new UsbIpWebUsbDevice(session, options.urbTimeoutMs ?? DEFAULT_URB_TIMEOUT_MS, {
      host,
      port,
      busid,
    });
    device.opened = true;
    await device.readIdentity();
    return device;
  }

  private async standardIn(
    bRequest: number,
    wValue: number,
    wIndex: number,
    length: number,
  ): Promise<Uint8Array> {
    return this.session.controlTransfer(
      { bmRequestType: STANDARD_IN, bRequest, wValue, wIndex },
      null,
      length,
      this.timeoutMs,
    );
  }

  private async standardOut(bRequest: number, wValue: number, wIndex: number): Promise<void> {
    await this.session.controlTransfer(
      { bmRequestType: 0x00, bRequest, wValue, wIndex },
      null,
      0,
      this.timeoutMs,
    );
  }

  private async readString(index: number, langid: number): Promise<string | null> {
    if (index === 0) return null;
    try {
      const raw = await this.standardIn(
        REQ_GET_DESCRIPTOR,
        (DESC_STRING << 8) | index,
        langid,
        255,
      );
      if (raw.length < 2) return null;
      const body = raw.subarray(2, raw[0] ?? raw.length);
      return new TextDecoder('utf-16le').decode(body);
    } catch {
      return null;
    }
  }

  private async readIdentity(): Promise<void> {
    this.deviceDescriptor = await this.standardIn(REQ_GET_DESCRIPTOR, DESC_DEVICE << 8, 0, 18);
    const iManufacturer = this.deviceDescriptor[14] ?? 0;
    const iProduct = this.deviceDescriptor[15] ?? 0;
    const iSerial = this.deviceDescriptor[16] ?? 0;
    let langid = 0x0409;
    try {
      const langs = await this.standardIn(REQ_GET_DESCRIPTOR, DESC_STRING << 8, 0, 255);
      if (langs.length >= 4) langid = (langs[2] ?? 0) | ((langs[3] ?? 0) << 8);
    } catch {
      /* Some builds answer only the default language; 0x0409 is then correct. */
    }
    this.manufacturerName = await this.readString(iManufacturer, langid);
    this.productName = await this.readString(iProduct, langid);
    this.serialNumber = await this.readString(iSerial, langid);
  }

  /**
   * Re-import the device if it has been closed.
   *
   * THIS IS LOAD-BEARING, AND GETTING IT WRONG HID A REAL RESULT. The toolkit's
   * window-read retry does `transport.close()` / `transport.open()` between
   * attempts, because on a camera that has wedged its control endpoint that is
   * the only thing that clears it (`dump.ts` says so in as many words). An
   * adapter whose `open()` was a no-op therefore turned ONE unreadable window
   * into a dead session and every later window into a failure — which is exactly
   * what it did, and it read as "this firmware serves nothing" until the
   * difference between tier 1 and tier 2 on the same firmware exposed it.
   *
   * A real libusb reopen gets a fresh handle to the same device, so this gets a
   * fresh USB/IP import of the same busid. The count is exposed so a run can say
   * how many times it happened rather than hiding it.
   */
  async open(): Promise<void> {
    if (this.opened) return;
    /* RETRIED, BECAUSE THE IMPORT SLOT IS SINGULAR AND FREED ASYNCHRONOUSLY.
     *
     * The emulator serves ONE import at a time. `close()` drops the socket, and
     * the server's reader thread only detaches the session when it notices —
     * which, with a dozen emulators competing for ten cores, can be after the
     * next attach has already been refused with "already attached". A single
     * attempt therefore succeeded or failed by luck, and that luck propagated:
     * one refused re-import left the transport closed and turned every later
     * subcommand into a timeout, so the same firmware measured 25 of 63 windows
     * in one run and 1 of 63 in the next. Retrying until the slot frees is what
     * makes the measurement a property of the firmware instead of the load. */
    const deadline = Date.now() + REOPEN_TIMEOUT_MS;
    let last: unknown;
    for (;;) {
      try {
        this.session = await UsbIpSession.attach(
          this.where.host,
          this.where.port,
          this.where.busid,
        );
        this.reopens++;
        this.opened = true;
        return;
      } catch (error) {
        last = error;
        if (Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    throw last instanceof Error ? last : new Error(String(last));
  }

  close(): Promise<void> {
    if (!this.opened) return Promise.resolve();
    this.opened = false;
    this.session.close();
    return Promise.resolve();
  }

  async selectConfiguration(configurationValue: number): Promise<void> {
    await this.standardOut(REQ_SET_CONFIGURATION, configurationValue, 0);
    this.configuration = { configurationValue };
  }

  async claimInterface(interfaceNumber: number): Promise<void> {
    /* There is no kernel driver on this side to wrestle an interface from, so a
     * claim is the SET_INTERFACE the host would issue after claiming it. A
     * firmware that refuses that is refusing the interface, and the transport's
     * 'auto' recipient fallback should see the refusal rather than a silent no-op. */
    await this.standardOut(REQ_SET_INTERFACE, 0, interfaceNumber);
  }

  releaseInterface(_interfaceNumber: number): Promise<void> {
    return Promise.resolve();
  }

  async controlTransferIn(
    setup: WebUsbControlSetup,
    length: number,
  ): Promise<WebUsbInTransferResult> {
    try {
      const data = await this.session.controlTransfer(
        {
          bmRequestType: requestType(setup, true),
          bRequest: setup.request,
          wValue: setup.value,
          wIndex: setup.index,
        },
        null,
        length,
        this.timeoutMs,
      );
      return { status: 'ok', data: new DataView(data.buffer, data.byteOffset, data.byteLength) };
    } catch (error) {
      if (error instanceof UsbIpStall) return { status: 'stall' };
      throw error;
    }
  }

  async controlTransferOut(
    setup: WebUsbControlSetup,
    data: ArrayBufferView,
  ): Promise<WebUsbOutTransferResult> {
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    try {
      await this.session.controlTransfer(
        {
          bmRequestType: requestType(setup, false),
          bRequest: setup.request,
          wValue: setup.value,
          wIndex: setup.index,
        },
        bytes,
        0,
        this.timeoutMs,
      );
      return { status: 'ok', bytesWritten: bytes.length };
    } catch (error) {
      if (error instanceof UsbIpStall) return { status: 'stall' };
      throw error;
    }
  }
}

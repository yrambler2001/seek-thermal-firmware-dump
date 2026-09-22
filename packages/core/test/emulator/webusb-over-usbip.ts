/* ==================================================================== *
 * A `WebUsbDevice` backed by a USB/IP session.
 *
 * This is the one piece of test-only scaffolding the emulator suite needs, and
 * it is deliberately the thinnest possible: it implements exactly the structural
 * interface `WebUsbTransport` declares (`packages/core/src/protocol/webusb.ts`)
 * and forwards every control transfer onto the wire. No toolkit source is
 * changed to make any of this work.
 *
 * THE RULE: FOR EVERY CALL, PUT ON THE WIRE EXACTLY WHAT A REAL HOST STACK DOES
 * FOR THAT CALL — no more, no less. It is modelled on the WebUSB specification
 * (WICG, `index.bs`), which is also what the CLI's host stack follows: the `usb`
 * package 3.x (node-usb-rs over nusb 0.2) in the CLI, Chrome's `navigator.usb` in
 * the web app. Per call:
 *
 *  - `open()` / `close()`: no transfer. A close/open is a fresh USB/IP import,
 *    which is this host's "fresh handle to the same device" (see `open()`);
 *    close releases every claimed interface, as the spec's close() does.
 *  - `configuration`: the device's CURRENT configuration, which is what WebUSB
 *    reports (`[[configurationValue]]` is set from Get Configuration when the
 *    device is detected). The emulator has already enumerated and configured
 *    the part before it exports it, and says so in the import record.
 *  - `selectConfiguration(v)`: a real `SET_CONFIGURATION` (bmRequestType 0x00).
 *  - `claimInterface(n)` / `releaseInterface(n)`: NOTHING on the wire. The spec
 *    says "perform the necessary platform-specific steps to request exclusive
 *    control"; nusb does `USBInterfaceOpen` on macOS and the
 *    `USBDEVFS_CLAIMINTERFACE` ioctl on Linux, and neither sends a packet.
 *  - `selectAlternateInterface(n, alt)`: a real `SET_INTERFACE`, with
 *    bmRequestType 0x01 — interface recipient, as USB 2.0 sec.9.4.10 defines it
 *    and as Linux's `usb_set_interface()` and IOKit's `SetAlternateInterface`
 *    send it. The toolkit never calls it; it is here so the correct form exists.
 *  - vendor transfers: bmRequestType from the setup's own type and recipient,
 *    after the spec's "check the validity of the control transfer parameters"
 *    — so an interface-recipient transfer to an unclaimed interface is refused
 *    with the same `InvalidStateError` a browser raises, never sent.
 *
 * WHY THAT RULE IS WRITTEN DOWN (TESTING.md sec.9.9). Until 2026-09-22 this file's
 * `claimInterface` sent `SET_INTERFACE` as bmRequestType 0x00. That is not a
 * request USB 2.0 defines, every firmware stalled it, and `WebUsbTransport`'s
 * `'auto'` mode reads a rejected claim as "a driver is holding the interface"
 * and SILENTLY switches every vendor request to device recipient. So every
 * emulator row in both tiers measured 0x40/0xC0 requests, while a real host
 * claims interface 0 without a packet and sends 0x41/0xC1. `assertRealHostPath`
 * below now fails a row whose transport did not end up where a real host puts it.
 *
 * What it does NOT fake:
 *
 *  - the string descriptors are read off the device with real GET_DESCRIPTOR
 *    control transfers, so the manufacturer, product and serial a test asserts
 *    were produced by the firmware reading its own flash, not by a fixture;
 *  - a stall comes back as `status: 'stall'`, which is what a browser's WebUSB
 *    does and what the transport's error handling is written against. A
 *    transport-level timeout is left to `WebUsbTransport.withTimeout`, exactly
 *    as in the browser, but the URB itself also carries libusb's deadline so a
 *    hung emulator cannot leak a pending transfer.
 * ==================================================================== */

import type { TransportInfo } from '../../src/protocol/transport.js';
import type {
  WebUsbConfiguration,
  WebUsbControlSetup,
  WebUsbDevice,
  WebUsbInTransferResult,
  WebUsbOutTransferResult,
} from '../../src/protocol/webusb.js';
import { DeliveryLedger, UsbIpSession, UsbIpStall } from './usbip-client.js';

/* USB 2.0 sec.9.3.1, Table 9-2: bmRequestType is D7 direction, D6..5 type, D4..0
 * recipient. Table 9-3 lists every standard request with the ONE recipient it is
 * defined for: SET_CONFIGURATION 00000000B, SET_INTERFACE 00000001B. */
const STANDARD_IN_DEVICE = 0x80;
const STANDARD_OUT_DEVICE = 0x00;
const STANDARD_OUT_INTERFACE = 0x01;
const REQ_GET_DESCRIPTOR = 0x06;
const REQ_SET_CONFIGURATION = 0x09;
const REQ_SET_INTERFACE = 0x0b;
const DESC_DEVICE = 0x01;
const DESC_STRING = 0x03;

const TYPE_BITS: Readonly<Record<string, number>> = { standard: 0x00, class: 0x20, vendor: 0x40 };
const RECIPIENT_BITS: Readonly<Record<string, number>> = {
  device: 0x00,
  interface: 0x01,
  endpoint: 0x02,
  other: 0x03,
};

/** Per control transfer on the wire. Generous: the emulator is ~1000x slower
 *  than silicon, and a 2 s default is exactly what defeated an earlier tool. */
export const DEFAULT_URB_TIMEOUT_MS = 30_000;

/** How long `open()` keeps trying to re-import after a `close()`. */
export const REOPEN_TIMEOUT_MS = 20_000;

/** bmRequestType for a WebUSB setup, from ITS OWN type and recipient — nothing assumed. */
function requestType(setup: WebUsbControlSetup, dirIn: boolean): number {
  const type = TYPE_BITS[setup.requestType];
  const recipient = RECIPIENT_BITS[setup.recipient];
  if (type === undefined || recipient === undefined) {
    throw new TypeError(
      `unsupported control setup: requestType '${setup.requestType}', ` +
        `recipient '${setup.recipient}'`,
    );
  }
  return (dirIn ? 0x80 : 0x00) | type | recipient;
}

/**
 * A row whose transport did not take the path a real host takes.
 *
 * NOT A FINDING ABOUT FIRMWARE, AND NEVER RECORDED AS ONE. Every emulator row
 * used to run with `WebUsbTransport` fallen back to device-recipient requests
 * because this adapter refused the claim (TESTING.md sec.9.9); the transport does
 * that silently, so nothing noticed for a whole campaign. The suites rethrow
 * this instead of turning it into a gap.
 */
export class HarnessFidelityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HarnessFidelityError';
  }
}

/**
 * Throws `HarnessFidelityError` unless the transport ended up exactly where it
 * does on a real host: interface recipient for every vendor request, and no
 * claim ever refused along the way (the transport re-claims on every reopen, and
 * a refusal there would switch recipient mid-row without a word). With
 * `open: true` the interface must also be claimed right now — false only for a
 * transport the workflow has already closed, as `runDump` does when it finishes.
 */
export function assertRealHostPath(
  device: UsbIpWebUsbDevice,
  info: TransportInfo,
  where: string,
  open = true,
): void {
  if (
    info.recipient === 'interface' &&
    device.claimsRejected === 0 &&
    (info.claimedInterface || !open)
  ) {
    return;
  }
  throw new HarnessFidelityError(
    `${where}: the transport is not on the path a real host takes — recipient=` +
      `${info.recipient}, claimedInterface=${String(info.claimedInterface)}, ` +
      `${String(device.claimsRejected)} claimInterface() call(s) rejected by the adapter` +
      (device.lastClaimRejection === null ? '' : ` (last: ${device.lastClaimRejection})`) +
      '. On a real camera claiming interface 0 sends nothing and succeeds, so every vendor ' +
      'request goes out with interface recipient; a row measured any other way is ' +
      'measuring the harness.',
  );
}

export interface UsbIpWebUsbOptions {
  /** Per-URB deadline in milliseconds. */
  readonly urbTimeoutMs?: number;
  /**
   * Where every session this device opens — the first import and every re-import —
   * counts what it sent and received. `Emulator.attach` passes its own, so the
   * harness can compare the client's count against the emulator's delivery ledger.
   */
  readonly ledger?: DeliveryLedger;
}

export class UsbIpWebUsbDevice implements WebUsbDevice {
  readonly vendorId: number;
  readonly productId: number;
  manufacturerName: string | null = null;
  productName: string | null = null;
  serialNumber: string | null = null;
  configuration: WebUsbConfiguration | null;
  opened = false;

  private session: UsbIpSession;
  private readonly timeoutMs: number;
  private readonly where: { host: string; port: number; busid: string };
  private readonly ledger: DeliveryLedger;
  /** bNumInterfaces of the active configuration, from the import record. USB 2.0
   *  sec.9.6.5: bInterfaceNumber is the zero-based index into that array, so the
   *  interfaces that exist are exactly 0 .. interfaceCount-1. */
  private readonly interfaceCount: number;
  /** WebUSB's [[claimedInterface]]: host-side state only, never a packet. */
  private readonly claimed = new Set<number>();
  /** Raw 18-byte device descriptor, as the device returned it. */
  deviceDescriptor: Uint8Array = new Uint8Array(0);
  /** How many times `open()` had to re-import the device after a `close()`. */
  reopens = 0;
  /**
   * How many `claimInterface()` calls this adapter rejected. The transport turns
   * a rejected claim into a silent switch to device recipient, so the count is
   * exposed and `assertRealHostPath` requires it to be 0.
   */
  claimsRejected = 0;
  lastClaimRejection: string | null = null;

  private constructor(
    session: UsbIpSession,
    timeoutMs: number,
    where: { host: string; port: number; busid: string },
    ledger: DeliveryLedger,
  ) {
    this.session = session;
    this.timeoutMs = timeoutMs;
    this.where = where;
    this.ledger = ledger;
    this.vendorId = session.device.idVendor;
    this.productId = session.device.idProduct;
    this.interfaceCount = session.device.bNumInterfaces;
    /* WHAT THE DEVICE IS, NOT WHAT WOULD BE CONVENIENT. WebUSB sets
     * `[[configurationValue]]` from Get Configuration when it detects a device, and
     * both of the toolkit's host stacks read it from the OS rather than the wire
     * (nusb: sysfs on Linux, the IOKit interface nubs on macOS). The emulator
     * enumerates the part itself — ending in SET_CONFIGURATION(1) — before it
     * exports it, and the import record carries the value. Reporting `null` here,
     * as this adapter used to, made `WebUsbTransport.open()` send a second
     * SET_CONFIGURATION a real host never sends. */
    const active = session.device.bConfigurationValue;
    this.configuration = active === 0 ? null : { configurationValue: active };
  }

  /** Import the device and read its identity, as a host does on plug-in. */
  static async attach(
    host: string,
    port: number,
    busid: string,
    options: UsbIpWebUsbOptions = {},
  ): Promise<UsbIpWebUsbDevice> {
    const ledger = options.ledger ?? new DeliveryLedger();
    const session = await UsbIpSession.attach(host, port, busid, undefined, ledger);
    const device = new UsbIpWebUsbDevice(
      session,
      options.urbTimeoutMs ?? DEFAULT_URB_TIMEOUT_MS,
      { host, port, busid },
      ledger,
    );
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
      { bmRequestType: STANDARD_IN_DEVICE, bRequest, wValue, wIndex },
      null,
      length,
      this.timeoutMs,
    );
  }

  private async standardOut(
    bmRequestType: number,
    bRequest: number,
    wValue: number,
    wIndex: number,
  ): Promise<void> {
    await this.session.controlTransfer(
      { bmRequestType, bRequest, wValue, wIndex },
      null,
      0,
      this.timeoutMs,
    );
  }

  /** WebUSB "check if the device is configured": opened, and a configuration active. */
  private assertConfigured(what: string): void {
    if (!this.opened) {
      throw new DOMException(`${what}: the device must be opened first`, 'InvalidStateError');
    }
    if (this.configuration === null) {
      throw new DOMException(`${what}: the device is not configured`, 'InvalidStateError');
    }
  }

  /** WebUSB "finding the interface index": NotFoundError for an interface that does not exist. */
  private assertInterfaceExists(what: string, interfaceNumber: number): void {
    if (!Number.isInteger(interfaceNumber) || interfaceNumber < 0) {
      throw new DOMException(`${what}: no interface ${String(interfaceNumber)}`, 'NotFoundError');
    }
    if (interfaceNumber >= this.interfaceCount) {
      throw new DOMException(
        `${what}: the active configuration has ${String(this.interfaceCount)} interface(s); ` +
          `there is no interface ${String(interfaceNumber)}`,
        'NotFoundError',
      );
    }
  }

  /**
   * WebUSB "check the validity of the control transfer parameters", the part the
   * toolkit can reach: an interface-recipient transfer must name (low byte of
   * wIndex) an interface that exists and is claimed. A browser refuses it with no
   * packet sent; so does this. (nusb, under the CLI, routes such a transfer
   * through a claimed interface and refuses it when none is.)
   */
  private assertTransferAllowed(setup: WebUsbControlSetup, what: string): void {
    this.assertConfigured(what);
    if (setup.recipient !== 'interface') return;
    const interfaceNumber = setup.index & 0xff;
    this.assertInterfaceExists(what, interfaceNumber);
    if (!this.claimed.has(interfaceNumber)) {
      throw new DOMException(
        `${what}: interface ${String(interfaceNumber)} is not claimed`,
        'InvalidStateError',
      );
    }
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
     * makes the measurement a property of the firmware instead of the load.
     *
     * THE CHURN THIS CREATES IS REAL WORK FOR THE SERVER, and it found four
     * defects there on 2026-09-22 — a `quit` sentinel outliving its session and
     * silencing the next one, a detach eating its successor's completions, a listen
     * backlog of 4 dropping SYNs (1 re-import in 300 paid a second of TCP
     * retransmit), and — the one that cost 2,210 s a run — the next session's
     * writer taking the old writer's `quit`, which orphaned the old writer and let
     * it drop later sessions' replies. The last is fixed STRUCTURALLY (one reply
     * queue per session) in FW-V1's `emu/`, forced deterministically by its
     * self-test, and every row here now checks the emulator's delivery ledger
     * against what this adapter received (`Emulator.auditDelivery`). This retry
     * stays regardless: the single import slot is the protocol's, not a bug. */
    const deadline = Date.now() + REOPEN_TIMEOUT_MS;
    let last: unknown;
    for (;;) {
      try {
        this.session = await UsbIpSession.attach(
          this.where.host,
          this.where.port,
          this.where.busid,
          undefined,
          this.ledger,
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

  /** Ends the session. As WebUSB's close() does, every claimed interface is released
   *  with it — host-side state, no packet — and a reopen starts with none claimed. */
  close(): Promise<void> {
    if (!this.opened) return Promise.resolve();
    this.opened = false;
    this.claimed.clear();
    this.session.close();
    return Promise.resolve();
  }

  /** A real SET_CONFIGURATION (bmRequestType 0x00), as WebUSB and nusb both send. The
   *  device, not this adapter, decides whether the value is valid: a stall rejects. */
  async selectConfiguration(configurationValue: number): Promise<void> {
    if (!this.opened) {
      throw new DOMException(
        'selectConfiguration: the device must be opened first',
        'InvalidStateError',
      );
    }
    await this.standardOut(STANDARD_OUT_DEVICE, REQ_SET_CONFIGURATION, configurationValue, 0);
    this.configuration = { configurationValue };
    this.claimed.clear();
  }

  /**
   * NOTHING ON THE WIRE. That is the fix, and it is not a shortcut.
   *
   * WebUSB's claimInterface() is "perform the necessary platform-specific steps to
   * request exclusive control" and no control transfer; under the CLI, node-usb
   * 3.x calls nusb's `claim_interface`, which is `USBInterfaceOpen` on macOS and
   * the `USBDEVFS_CLAIMINTERFACE` ioctl on Linux — neither sends a packet, and
   * Linux's `claimintf()` in drivers/usb/core/devio.c only binds usbfs to the
   * interface. So a claim can be refused only by the HOST: the device not open
   * or not configured, or no such interface. Those are checked here exactly as
   * the spec checks them. It used to send SET_INTERFACE as bmRequestType 0x00,
   * which the firmware stalled every time, and which made the transport fall back
   * to device recipient on every row (TESTING.md sec.9.9).
   */
  claimInterface(interfaceNumber: number): Promise<void> {
    try {
      this.assertConfigured('claimInterface');
      this.assertInterfaceExists('claimInterface', interfaceNumber);
    } catch (error) {
      this.claimsRejected++;
      this.lastClaimRejection = error instanceof Error ? error.message : String(error);
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.claimed.add(interfaceNumber);
    return Promise.resolve();
  }

  /** Host-side state only, as a real release is. */
  releaseInterface(interfaceNumber: number): Promise<void> {
    try {
      this.assertConfigured('releaseInterface');
      this.assertInterfaceExists('releaseInterface', interfaceNumber);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    this.claimed.delete(interfaceNumber);
    return Promise.resolve();
  }

  /**
   * A real SET_INTERFACE, in the only form USB 2.0 sec.9.4.10 defines:
   * bmRequestType 00000001B (interface recipient), wValue = alternate setting,
   * wIndex = interface. That is what Linux's `usb_set_interface()` sends
   * (`USB_RECIP_INTERFACE`) and what IOKit's `SetAlternateInterface` sends, and
   * WebUSB requires the interface to be claimed first.
   *
   * The toolkit never calls this — `WebUsbTransport` has no alternate settings to
   * choose — so it is not part of the `WebUsbDevice` interface the transport
   * declares. A device that implements only the default setting "may" stall it
   * (sec.9.4.10); all eight Seek firmware builds measured accept it
   * (TESTING.md sec.9.9).
   */
  async selectAlternateInterface(interfaceNumber: number, alternateSetting: number): Promise<void> {
    this.assertConfigured('selectAlternateInterface');
    this.assertInterfaceExists('selectAlternateInterface', interfaceNumber);
    if (!this.claimed.has(interfaceNumber)) {
      throw new DOMException(
        `selectAlternateInterface: interface ${String(interfaceNumber)} is not claimed`,
        'InvalidStateError',
      );
    }
    await this.standardOut(
      STANDARD_OUT_INTERFACE,
      REQ_SET_INTERFACE,
      alternateSetting,
      interfaceNumber,
    );
  }

  async controlTransferIn(
    setup: WebUsbControlSetup,
    length: number,
  ): Promise<WebUsbInTransferResult> {
    this.assertTransferAllowed(setup, 'controlTransferIn');
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
    this.assertTransferAllowed(setup, 'controlTransferOut');
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

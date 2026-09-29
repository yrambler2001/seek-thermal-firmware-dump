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

import { USB_TIMEOUT_MS } from '../../src/protocol/ops.js';
import type { TransportInfo } from '../../src/protocol/transport.js';
import type {
  DeadlineClock,
  WebUsbConfiguration,
  WebUsbControlSetup,
  WebUsbDevice,
  WebUsbInTransferResult,
  WebUsbOutTransferResult,
} from '../../src/protocol/webusb.js';
import type { DeviceClockLink } from './device-clock.js';
import { DeliveryLedger, UsbIpError, UsbIpSession, UsbIpStall } from './usbip-client.js';

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

/** Per control transfer on the wire, on the WALL clock. Generous: the emulator is
 *  ~1000x slower than silicon, and a 2 s default is exactly what defeated an earlier
 *  tool. With a device-time side channel this is only the hung-emulator watchdog
 *  (device-clock.ts); the transfer's real deadline is on the camera's clock. */
export const DEFAULT_URB_TIMEOUT_MS = 30_000;

/**
 * The emulated host's deadline for the adapter's OWN standard requests (the
 * descriptor reads of `readIdentity`): Linux's `USB_CTRL_GET_TIMEOUT` and
 * `USB_CTRL_SET_TIMEOUT`, 5000 ms (include/linux/usb.h), which is also the
 * toolkit's `USB_TIMEOUT_MS`. Vendor transfers use the deadline the transport
 * passes with each one.
 */
const STANDARD_REQUEST_DEADLINE_MS = USB_TIMEOUT_MS;

/** The status the emulated host completes a transfer with when it gave it up
 *  (-ETIMEDOUT, FW-V1 `usb_host.py` THE HOST'S DEADLINE). */
const HOST_GAVE_UP = -110;

/**
 * How much of the camera's time the EMULATED host polls a transfer the firmware
 * never completes before it gives the transfer up (-110), when that is less than
 * the transport's own deadline. TESTING.md sec.19.3 has the measurement and the
 * choice; in short:
 *
 *  - A real host polls until the transport's deadline (5 s) and then cancels, so
 *    `Infinity` here - the emulated host giving up exactly at the transport's own
 *    deadline, which the transport then reports as its `usb/timeout` - is the
 *    faithful setting.
 *  - It is not affordable: on Compact 0.6.0.4 one never-answered request costs
 *    ~1.5 s of wall time at 200 ms, ~7 s at 1 s and more than ten minutes at 5 s
 *    (the firmware stops sleeping about a second in, and every instruction after
 *    that is emulated), and the row sends dozens of them.
 *  - So the default is 200 ms: the poll budget the emulator has always used
 *    (FW-V1 `UsbHost.wait_budget`, 20,000 polls of 10 us), now declared by the
 *    harness in the camera's time. Every transfer the firmware never completes then
 *    ends with the emulator's -110 after 200 ms of the camera's time, long before
 *    the transport's 5 s (or 1.5 s) on the same clock, and the transport reports
 *    `usb/transfer-failed` where a real host would report `usb/timeout` after 5 s.
 *
 * Either way the result is a function of the URB sequence alone, never of machine
 * load. `SEEK_EMU_HOST_GIVE_UP_MS` overrides it (`Infinity` for full fidelity).
 * That is the `budget` host model; `nusb` and `chrome` (below) are the two real
 * hosts, each given up exactly as its own source says.
 */
export const DEFAULT_HOST_GIVE_UP_MS = 200;

/**
 * WHICH REAL HOST THE EMULATED HOST GIVES A CONTROL TRANSFER UP LIKE (TESTING.md
 * sec.22). The switch is `SEEK_EMU_HOST` (harness.ts) or `attach({ hostModel })`.
 *
 *  - `budget` (the default): `min(the transport's deadline, hostGiveUpMs)`, 200 ms
 *    unless overridden - the cost decision of sec.19.3, not a real host.
 *  - `nusb`: the CLI. node-usb 3.1.0's shim passes the transport's own deadline to
 *    node-usb-rs (`nativeControlTransferIn(setup, timeout, length)`), which hands it
 *    to nusb 0.2.7 as `Duration::from_millis(timeout)`; nusb cancels the transfer at
 *    exactly that moment - on Linux its own timer and USBDEVFS_DISCARDURB
 *    (platform/linux_usbfs/device.rs `handle_timeouts`), on macOS IOKit's
 *    `DeviceRequestAsyncTO` with `noDataTimeout = completionTimeout = timeout`
 *    (platform/macos_iokit/device.rs), on Windows its own timer and CancelIoEx
 *    after it turns WinUSB's default control timeout off. No clear-halt, no reset:
 *    the next request is a new SETUP, which USB 2.0 sec.8.5.3 says aborts whatever
 *    the device was still doing for the old one. So: the emulated host gives the
 *    transfer up at exactly the transport's deadline, and moves on.
 *  - `chrome`: the web app. Blink passes a timeout of 0 for every WebUSB transfer
 *    (third_party/blink/renderer/modules/webusb/usb_device.cc,
 *    `ControlTransferIn(..., length, 0, ...)`), and 0 is "none" underneath: Linux
 *    usbfs (`UsbDeviceHandleUsbfs::SetUpTimeoutCallback` returns at once for 0, and
 *    an async URB has no kernel timeout) and macOS (libusb: no timer for 0, and
 *    `DeviceRequestAsyncTO` with both timeouts 0 - IOUSBHost: "If 0, the request
 *    will never timeout"). So the host NEVER gives up: the transport's own timer is
 *    the only deadline, the transfer stays on the pipe after it fires, and the next
 *    control transfer waits behind it (USB 2.0 sec.5.5.5: the host advances to the
 *    next control transfer only after the Status stage). The emulated host
 *    therefore polls until the device answers, bounded only by
 *    `CHROME_HOST_HORIZON_MS` of the camera's time so a transfer the firmware never
 *    completes cannot run for ever; reaching it fails the row
 *    (`HarnessFidelityError`), because what Chrome does then - hold EP0 until
 *    `close()` - is not something this harness measures. (Chrome on WINDOWS is
 *    different: WinUSB's own default timeout on the control pipe applies; not
 *    modelled.)
 */
export type HostModel = 'budget' | 'nusb' | 'chrome';

export const HOST_MODELS: readonly HostModel[] = ['budget', 'nusb', 'chrome'];

/**
 * The emulated host's cap on one transfer under the `chrome` model, in ms of the
 * camera's time: three times the longest deadline the toolkit ever sets (the
 * 20 s flash commit), so any transfer the device completes late is seen to
 * complete, and one it never completes ends the row instead of the machine.
 */
export const CHROME_HOST_HORIZON_MS = 60_000;

/** One control transfer as the adapter saw it, on the camera's clock (`onTransfer`). */
export interface TransferTrace {
  readonly bmRequestType: number;
  readonly bRequest: number;
  /** The transport's deadline for it (the adapter's own for a standard request). */
  readonly timeoutMs: number;
  /** What the emulated host was told (`hostModel`). */
  readonly hostDeadlineMs: number;
  /** The camera's time when it was submitted and when its completion was delivered. */
  readonly startNs: number;
  readonly endNs: number;
  readonly outcome: 'ok' | 'stall' | 'host-gave-up' | 'error';
}

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
  /**
   * Aborted when the device behind this adapter is gone for good: `Emulator` aborts
   * it the moment the emulator's run ends (the process exited, or it printed its
   * `stopped:` / `fault:` line without having been asked to stop).
   *
   * WHY THE ADAPTER HAS TO KNOW. Nothing on the socket says "for good". A closed
   * session looks like the single import slot being busy, so `open()` retries for
   * `REOPEN_TIMEOUT_MS`, and the probe reopens after every command that came back
   * with nothing — against a dead emulator that was 20 s per reopen, ~615 s per
   * Nano 300 row on 2026-09-23 (TESTING.md sec.14, sec.15). Once this is aborted,
   * the live session is closed (its pending transfers end at once), and every later
   * transfer and every reopen throws immediately with the reason.
   */
  readonly gone?: AbortSignal;
  /**
   * The emulator's device-time side channel (device-clock.ts). With it, every reply
   * is held until the camera's clock has reached its completion, every transfer's
   * deadline is handed to the emulator's host before the transfer goes out, and
   * `deadlineClock` is the clock the transport must time its deadlines on.
   */
  readonly clockLink?: DeviceClockLink;
  /** With `clockLink`: `DEFAULT_HOST_GIVE_UP_MS`'s value for this device (`budget`). */
  readonly hostGiveUpMs?: number;
  /** With `clockLink`: which real host the emulated host gives transfers up like. */
  readonly hostModel?: HostModel;
  /** Called once per control transfer, when it has ended (with `clockLink`). */
  readonly onTransfer?: (trace: TransferTrace) => void;
}

/** Throws at once when `gone` has been aborted, carrying its reason. */
function throwIfGone(gone: AbortSignal | undefined, what: string): void {
  if (gone?.aborted !== true) return;
  const reason: unknown = gone.reason;
  throw new UsbIpError(
    `${what}: the device is gone for good (${reason instanceof Error ? reason.message : String(reason)})`,
  );
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
  private readonly gone: AbortSignal | undefined;
  private readonly clockLink: DeviceClockLink | undefined;
  private readonly hostGiveUpMs: number;
  /** Which real host the emulated host gives transfers up like (`HostModel`). */
  readonly hostModel: HostModel;
  private readonly onTransfer: ((trace: TransferTrace) => void) | undefined;
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
    gone: AbortSignal | undefined,
    clockLink: DeviceClockLink | undefined,
    hostGiveUpMs: number,
    hostModel: HostModel,
    onTransfer: ((trace: TransferTrace) => void) | undefined,
  ) {
    this.session = session;
    this.timeoutMs = timeoutMs;
    this.where = where;
    this.ledger = ledger;
    this.gone = gone;
    this.clockLink = clockLink;
    this.hostGiveUpMs = hostGiveUpMs;
    this.hostModel = hostModel;
    this.onTransfer = onTransfer;
    gone?.addEventListener(
      'abort',
      () => {
        if (!this.opened) return;
        this.opened = false;
        this.claimed.clear();
        this.session.close();
      },
      { once: true },
    );
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
    throwIfGone(options.gone, 'attach');
    const session = await UsbIpSession.attach(
      host,
      port,
      busid,
      undefined,
      ledger,
      options.clockLink,
    );
    const device = new UsbIpWebUsbDevice(
      session,
      options.urbTimeoutMs ?? DEFAULT_URB_TIMEOUT_MS,
      { host, port, busid },
      ledger,
      options.gone,
      options.clockLink,
      options.hostGiveUpMs ?? DEFAULT_HOST_GIVE_UP_MS,
      options.hostModel ?? 'budget',
      options.onTransfer,
    );
    if (options.gone?.aborted === true) {
      session.close();
      throwIfGone(options.gone, 'attach');
    }
    device.opened = true;
    await device.readIdentity();
    return device;
  }

  /**
   * The clock a transport over this device must time its deadlines on: the
   * emulated camera's, when the emulator has a device-time side channel. Pass it
   * as `new WebUsbTransport(device, { clock: device.deadlineClock })`.
   */
  get deadlineClock(): DeadlineClock {
    if (!this.clockLink) {
      throw new HarnessFidelityError(
        "this device has no device-time side channel, so there is no emulated camera's " +
          'clock to time a deadline on (Emulator.attach always passes one)',
      );
    }
    return this.clockLink.clock;
  }

  private async standardIn(
    bRequest: number,
    wValue: number,
    wIndex: number,
    length: number,
  ): Promise<Uint8Array> {
    const setup = { bmRequestType: STANDARD_IN_DEVICE, bRequest, wValue, wIndex };
    const traced = await this.beginTransfer(STANDARD_REQUEST_DEADLINE_MS, setup, false);
    return traced(() => this.session.controlTransfer(setup, null, length, this.timeoutMs));
  }

  private async standardOut(
    bmRequestType: number,
    bRequest: number,
    wValue: number,
    wIndex: number,
  ): Promise<void> {
    const setup = { bmRequestType, bRequest, wValue, wIndex };
    const traced = await this.beginTransfer(STANDARD_REQUEST_DEADLINE_MS, setup, false);
    await traced(() => this.session.controlTransfer(setup, null, 0, this.timeoutMs));
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
      /* A REAL HOST DROPS A "STRING" THAT IS NOT A STRING DESCRIPTOR.
       *
       * Linux's usb_get_string() answers -ENODATA when byte 1 is not USB_DT_STRING
       * (drivers/usb/core/message.c), so the kernel caches no such string, and macOS
       * shows none either (FW-V1 Phase 53). The 2014 Compacts 0.6.0.4 .. 1.3.0.0
       * are why this matters: their device descriptor names iSerialNumber 5 and
       * their string table ends at index 4, so string 5 comes back as the head of
       * the configuration descriptor (09 02 40 00 02 01 00 80 32). Decoding that as
       * UTF-16 invented a serial number no real host would show.
       *
       * THIS IS THE OS'S VIEW, AND IT IS WHAT CHROME ON LINUX REPORTS - NOT WHAT
       * NODE-USB DOES. node-usb 3.1.0's getter, finding no OS copy, asks the device
       * again through nusb and THROWS "getString error: invalid descriptor"
       * (Chrome on macOS / Windows reports ""). That is what took the CLI down on
       * the bench and why no row here could see it: the CLI's own path over this
       * device is `packages/cli/test/node-usb-over-usbip.ts` (TESTING.md sec.21.1). */
      if (raw[1] !== DESC_STRING) return null;
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
      /* ...but never against a device known to be gone: see `UsbIpWebUsbOptions.gone`. */
      throwIfGone(this.gone, 'open');
      try {
        this.session = await UsbIpSession.attach(
          this.where.host,
          this.where.port,
          this.where.busid,
          undefined,
          this.ledger,
          this.clockLink,
        );
        if (this.gone?.aborted === true) {
          this.session.close();
          throwIfGone(this.gone, 'open');
        }
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
  async close(): Promise<void> {
    if (!this.opened) return;
    this.opened = false;
    this.claimed.clear();
    /* A reply the side channel has already reported is on the wire; it is read
     * before the session goes (UsbIpSession.closeAfterReported, TESTING.md sec.22). */
    await this.session.closeAfterReported();
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

  /** The emulated host's deadline for a transfer the transport gives `timeoutMs` (`HostModel`). */
  private hostDeadline(timeoutMs: number): number {
    switch (this.hostModel) {
      case 'nusb':
        return timeoutMs;
      case 'chrome':
        return Math.max(timeoutMs, CHROME_HOST_HORIZON_MS);
      case 'budget':
        return Math.min(timeoutMs, this.hostGiveUpMs);
    }
  }

  /**
   * Before a transfer: hand its deadline to the emulator's host and note the
   * clock's timer count (a vendor transfer's transport starts its deadline timer
   * right after this call's synchronous part). Returns the wrapper that runs the
   * transfer, traces it and checks the timer after.
   */
  private async beginTransfer(
    timeoutMs: number | undefined,
    setup: { readonly bmRequestType: number; readonly bRequest: number },
    vendor: boolean,
  ): Promise<<T>(run: () => Promise<T>) => Promise<T>> {
    const clock = this.clockLink?.clock;
    const before = clock?.timersStarted ?? 0;
    if (this.clockLink && timeoutMs === undefined) {
      throw new HarnessFidelityError(
        'a vendor transfer came without its deadline: WebUsbTransport passes one with every ' +
          'call, and the emulated host must give the transfer up where it does',
      );
    }
    const deadline = timeoutMs ?? 0;
    /* The adapter's own standard requests are the OS's (its descriptor reads at
     * enumeration, under the kernel's own 5 s), whatever the application is. */
    const hostDeadlineMs =
      vendor || this.hostModel === 'budget' ? this.hostDeadline(deadline) : deadline;
    await this.clockLink?.useDeadline(hostDeadlineMs);
    const startNs = clock?.timeNs ?? 0;
    return async <T>(run: () => Promise<T>): Promise<T> => {
      let outcome: TransferTrace['outcome'] = 'error';
      try {
        const value = await run();
        outcome = 'ok';
        return value;
      } catch (error) {
        if (error instanceof UsbIpStall) {
          outcome = 'stall';
        } else if (error instanceof UsbIpError && error.errno === HOST_GAVE_UP) {
          outcome = 'host-gave-up';
          /* Chrome never gives a transfer up; the horizon only keeps a transfer the
           * firmware never completes from running for ever (`HostModel`). */
          if (this.hostModel === 'chrome') {
            throw new HarnessFidelityError(
              `control ${String(setup.bRequest)} did not complete within ` +
                `${String(hostDeadlineMs)} ms of the camera's time. Chrome would still be ` +
                'polling it and would hold EP0 until close(); the chrome host model does not ' +
                'measure that (TESTING.md sec.22).',
            );
          }
        }
        throw error;
      } finally {
        if (clock) {
          this.onTransfer?.({
            bmRequestType: setup.bmRequestType,
            bRequest: setup.bRequest,
            timeoutMs: deadline,
            hostDeadlineMs,
            startNs,
            endNs: clock.timeNs,
            outcome,
          });
          /* A transport built without `clock: device.deadlineClock` started its timer
           * on the wall clock; the ledger counts it and the audit fails the row. */
          if (vendor && clock.timersStarted === before) this.ledger.wallClockTransfers++;
        }
      }
    };
  }

  async controlTransferIn(
    setup: WebUsbControlSetup,
    length: number,
    timeoutMs?: number,
  ): Promise<WebUsbInTransferResult> {
    throwIfGone(this.gone, 'controlTransferIn');
    this.assertTransferAllowed(setup, 'controlTransferIn');
    const wire = {
      bmRequestType: requestType(setup, true),
      bRequest: setup.request,
      wValue: setup.value,
      wIndex: setup.index,
    };
    const traced = await this.beginTransfer(timeoutMs, wire, true);
    try {
      const data = await traced(() =>
        this.session.controlTransfer(wire, null, length, this.timeoutMs),
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
    timeoutMs?: number,
  ): Promise<WebUsbOutTransferResult> {
    throwIfGone(this.gone, 'controlTransferOut');
    this.assertTransferAllowed(setup, 'controlTransferOut');
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    const wire = {
      bmRequestType: requestType(setup, false),
      bRequest: setup.request,
      wValue: setup.value,
      wIndex: setup.index,
    };
    const traced = await this.beginTransfer(timeoutMs, wire, true);
    try {
      await traced(() => this.session.controlTransfer(wire, bytes, 0, this.timeoutMs));
      return { status: 'ok', bytesWritten: bytes.length };
    } catch (error) {
      if (error instanceof UsbIpStall) return { status: 'stall' };
      throw error;
    }
  }
}

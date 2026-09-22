/* ==================================================================== *
 * A dependency-free USB/IP client, and nothing else.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT.
 *
 * The emulator in the sibling FW-V1 repository serves an emulated Seek camera
 * over USB/IP (`seek_emu.py --usbip`). On Linux, `usbip attach` hands that
 * socket to the kernel and real libusb talks to a real device node — but
 * `vhci-hcd` is a Linux kernel module, the import slots are few and contended,
 * and a process that exits without detaching wedges one. Neither is acceptable
 * for a suite that runs dozens of emulators concurrently on a developer laptop.
 *
 * So the *host controller* is substituted and nothing else: every transfer this
 * file issues leaves as a real `USBIP_CMD_SUBMIT` on a TCP socket and is
 * answered by the emulated firmware's own RPC dispatch. Everything above it —
 * `WebUsbTransport`, `SeekDevice`, `runDump`, the profile tables, the decrypt —
 * is the toolkit's real code, unmodified.
 *
 * LABEL THIS HONESTLY WHEN QUOTING A RESULT. A test that passes here has been
 * through the toolkit's whole protocol stack against real firmware executing
 * real instructions; it has NOT been through libusb, a kernel USB stack, or
 * silicon.
 *
 * Only control transfers are implemented, because that is all the dump and the
 * RPC surface use. A bulk transfer would need the same submit path with a
 * different endpoint; it is deliberately absent rather than stubbed.
 * ==================================================================== */

import { Buffer } from 'node:buffer';
import { connect, type Socket } from 'node:net';

const USBIP_VERSION = 0x0111;
const OP_REQ_DEVLIST = 0x8005;
const OP_REP_DEVLIST = 0x0005;
const OP_REQ_IMPORT = 0x8003;
const OP_REP_IMPORT = 0x0003;
const USBIP_CMD_SUBMIT = 1;
const USBIP_CMD_UNLINK = 2;
const USBIP_RET_SUBMIT = 3;
const USBIP_RET_UNLINK = 4;
const PDU = 48;
const DEVICE_RECORD = 312;

export class UsbIpError extends Error {
  readonly errno: number;
  constructor(message: string, errno = -1) {
    super(message);
    this.name = 'UsbIpError';
    this.errno = errno;
  }
}

/** Shaped like libusb's timeout so the transport's retry path sees what it expects. */
export class UsbIpTimeout extends UsbIpError {
  constructor(message: string) {
    super(message, -7 /* LIBUSB_ERROR_TIMEOUT */);
    this.name = 'LIBUSB_TRANSFER_TIMED_OUT';
  }
}

/** A stalled endpoint. The transport must see this as a stall, not as empty data. */
export class UsbIpStall extends UsbIpError {
  constructor(message: string) {
    super(message, -9 /* LIBUSB_ERROR_PIPE */);
    this.name = 'LIBUSB_TRANSFER_STALL';
  }
}

export interface UsbIpDevice {
  readonly path: string;
  readonly busid: string;
  readonly busnum: number;
  readonly devnum: number;
  readonly speed: number;
  readonly idVendor: number;
  readonly idProduct: number;
  readonly bcdDevice: number;
  readonly bConfigurationValue: number;
  readonly bNumConfigurations: number;
  readonly bNumInterfaces: number;
}

function opHeader(code: number, status = 0): Buffer {
  const b = Buffer.alloc(8);
  b.writeUInt16BE(USBIP_VERSION, 0);
  b.writeUInt16BE(code, 2);
  b.writeUInt32BE(status, 4);
  return b;
}

function parseDevice(blob: Buffer): UsbIpDevice {
  const cstr = (buf: Buffer): string => {
    const z = buf.indexOf(0);
    return buf.subarray(0, z < 0 ? buf.length : z).toString('ascii');
  };
  return {
    path: cstr(blob.subarray(0, 256)),
    busid: cstr(blob.subarray(256, 288)),
    busnum: blob.readUInt32BE(288),
    devnum: blob.readUInt32BE(292),
    speed: blob.readUInt32BE(296),
    idVendor: blob.readUInt16BE(300),
    idProduct: blob.readUInt16BE(302),
    bcdDevice: blob.readUInt16BE(304),
    bConfigurationValue: blob[309] ?? 0,
    bNumConfigurations: blob[310] ?? 0,
    bNumInterfaces: blob[311] ?? 0,
  };
}

/** A socket plus an exact-length reader. */
class Framed {
  private readonly socket: Socket;
  private chunks: Buffer = Buffer.alloc(0);
  private want: { n: number; resolve: (b: Buffer) => void } | null = null;
  private failure: Error | null = null;
  private closed = false;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (d: Buffer) => {
      this.chunks = Buffer.concat([this.chunks, d]);
      this.drain();
    });
    socket.on('error', (e: Error) => {
      this.fail(e);
    });
    socket.on('close', () => {
      this.fail(new UsbIpError('the USB/IP connection closed'));
    });
  }

  private fail(error: Error): void {
    this.closed = true;
    this.failure ??= error;
    const pending = this.want;
    this.want = null;
    /* A pending exact-length read can never be satisfied once the socket is
     * gone, so it is rejected rather than left hanging for the suite timeout. */
    if (pending) pending.resolve(Buffer.alloc(0));
  }

  private drain(): void {
    const pending = this.want;
    if (!pending || this.chunks.length < pending.n) return;
    const out = this.chunks.subarray(0, pending.n);
    this.chunks = this.chunks.subarray(pending.n);
    this.want = null;
    pending.resolve(out);
  }

  async read(n: number): Promise<Buffer> {
    if (n === 0) return Buffer.alloc(0);
    if (this.failure && this.chunks.length < n) throw this.failure;
    const out = await new Promise<Buffer>((resolve) => {
      this.want = { n, resolve };
      this.drain();
    });
    if (out.length !== n) throw this.failure ?? new UsbIpError('short read');
    return out;
  }

  write(b: Buffer): void {
    if (this.closed) throw this.failure ?? new UsbIpError('write to a closed socket');
    this.socket.write(b);
  }

  destroy(): void {
    this.closed = true;
    this.socket.destroy();
  }
}

function open(host: string, port: number, timeoutMs: number): Promise<Framed> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new UsbIpTimeout(`no USB/IP server on ${host}:${String(port)}`));
    }, timeoutMs);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(new Framed(socket));
    });
    socket.once('error', (e: Error) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

/** `usbip list -r host`. Used as the readiness probe before a device is imported. */
export async function devlist(
  host: string,
  port: number,
  timeoutMs = 5000,
): Promise<UsbIpDevice[]> {
  const f = await open(host, port, timeoutMs);
  try {
    f.write(opHeader(OP_REQ_DEVLIST));
    const head = await f.read(8);
    if (head.readUInt16BE(2) !== OP_REP_DEVLIST) throw new UsbIpError('bad OP_REP_DEVLIST');
    if (head.readUInt32BE(4) !== 0) throw new UsbIpError('devlist refused');
    const n = (await f.read(4)).readUInt32BE(0);
    const out: UsbIpDevice[] = [];
    for (let i = 0; i < n; i++) {
      const dev = parseDevice(await f.read(DEVICE_RECORD));
      for (let k = 0; k < dev.bNumInterfaces; k++) await f.read(4);
      out.push(dev);
    }
    return out;
  } finally {
    f.destroy();
  }
}

export interface ControlSetup {
  readonly bmRequestType: number;
  readonly bRequest: number;
  readonly wValue: number;
  readonly wIndex: number;
}

/** One imported device: the URB stream on one socket. */
export class UsbIpSession {
  readonly device: UsbIpDevice;
  private readonly f: Framed;
  private readonly devid: number;
  private readonly waiting = new Map<number, (r: { status: number; payload: Buffer }) => void>();
  private seq = 0;
  private stopped = false;

  private constructor(f: Framed, device: UsbIpDevice) {
    this.f = f;
    this.device = device;
    this.devid = (device.busnum << 16) | device.devnum;
    void this.pump().catch(() => {
      this.stopped = true;
    });
  }

  static async attach(
    host: string,
    port: number,
    busid: string,
    timeoutMs = 5000,
  ): Promise<UsbIpSession> {
    const f = await open(host, port, timeoutMs);
    const b = Buffer.alloc(32);
    b.write(busid, 0, 'ascii');
    f.write(Buffer.concat([opHeader(OP_REQ_IMPORT), b]));
    const head = await f.read(8);
    if (head.readUInt16BE(2) !== OP_REP_IMPORT || head.readUInt32BE(4) !== 0) {
      f.destroy();
      throw new UsbIpError(`OP_REQ_IMPORT ${busid} refused`);
    }
    return new UsbIpSession(f, parseDevice(await f.read(DEVICE_RECORD)));
  }

  private async pump(): Promise<void> {
    for (;;) {
      const head = await this.f.read(PDU);
      const command = head.readUInt32BE(0);
      const seqnum = head.readUInt32BE(4);
      let status: number;
      let payload: Buffer = Buffer.alloc(0);
      if (command === USBIP_RET_SUBMIT) {
        status = head.readInt32BE(20);
        const actual = head.readInt32BE(24);
        if (actual > 0) payload = await this.f.read(actual);
      } else if (command !== USBIP_RET_UNLINK) {
        throw new UsbIpError(`unexpected URB command ${String(command)}`);
      } else {
        status = head.readInt32BE(20);
      }
      const w = this.waiting.get(seqnum);
      if (w) {
        this.waiting.delete(seqnum);
        w({ status, payload });
      }
    }
  }

  private submit(ep: number, dirIn: boolean, setup: Buffer | null, data: Buffer, length: number) {
    const seq = ++this.seq;
    const head = Buffer.alloc(PDU);
    head.writeUInt32BE(USBIP_CMD_SUBMIT, 0);
    head.writeUInt32BE(seq, 4);
    head.writeUInt32BE(this.devid, 8);
    head.writeUInt32BE(dirIn ? 1 : 0, 12);
    head.writeUInt32BE(ep, 16);
    head.writeInt32BE(dirIn ? length : data.length, 24);
    if (setup) setup.copy(head, 40);
    this.f.write(dirIn ? head : Buffer.concat([head, data]));
    return seq;
  }

  private unlink(victim: number): number {
    const seq = ++this.seq;
    const head = Buffer.alloc(PDU);
    head.writeUInt32BE(USBIP_CMD_UNLINK, 0);
    head.writeUInt32BE(seq, 4);
    head.writeUInt32BE(this.devid, 8);
    head.writeUInt32BE(victim, 20);
    this.f.write(head);
    return seq;
  }

  private settle(seq: number, timeoutMs: number): Promise<{ status: number; payload: Buffer }> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      this.waiting.set(seq, (r) => {
        if (timer) clearTimeout(timer);
        resolve(r);
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          this.waiting.delete(seq);
          reject(new UsbIpTimeout(`URB ${String(seq)} timed out after ${String(timeoutMs)} ms`));
        }, timeoutMs);
      }
    });
  }

  /**
   * One control transfer.
   *
   * On a client-side deadline this does what libusb does: cancels the transfer
   * with `CMD_UNLINK` and reports a timeout. Nothing here waits longer than the
   * caller asked for, so a slow emulator shows up as a timeout and never as a
   * silently extended transfer.
   */
  async controlTransfer(
    setup: ControlSetup,
    data: Uint8Array | null,
    length: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    if (this.stopped) throw new UsbIpError('the USB/IP session has ended');
    const dirIn = (setup.bmRequestType & 0x80) !== 0;
    const pkt = Buffer.alloc(8);
    pkt.writeUInt8(setup.bmRequestType, 0);
    pkt.writeUInt8(setup.bRequest, 1);
    pkt.writeUInt16LE(setup.wValue, 2);
    pkt.writeUInt16LE(setup.wIndex, 4);
    pkt.writeUInt16LE(dirIn ? length : (data?.length ?? 0), 6);

    const body: Buffer = data ? Buffer.from(data.slice()) : Buffer.alloc(0);
    const seq = this.submit(0, dirIn, pkt, body, length);
    try {
      const { status, payload } = await this.settle(seq, timeoutMs);
      if (status !== 0) {
        /* -EPIPE is a stalled endpoint, which is how the firmware refuses a
         * command. The transport above distinguishes the two, so this must. */
        if (status === -32 || status === -9) {
          throw new UsbIpStall(
            `control ${String(setup.bRequest)} stalled (status ${String(status)})`,
          );
        }
        throw new UsbIpError(
          `control ${String(setup.bRequest)} failed, status ${String(status)}`,
          status,
        );
      }
      return new Uint8Array(payload);
    } catch (error) {
      if (error instanceof UsbIpTimeout) {
        const u = this.unlink(seq);
        void this.settle(u, 5000).catch(() => undefined);
      }
      throw error;
    }
  }

  close(): void {
    this.stopped = true;
    for (const [, resolve] of this.waiting) resolve({ status: -108, payload: Buffer.alloc(0) });
    this.waiting.clear();
    this.f.destroy();
  }
}

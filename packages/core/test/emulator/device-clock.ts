/* ==================================================================== *
 * The emulated camera's clock, for the transport's deadlines.
 *
 * WHY. `WebUsbTransport` gives up on a transfer after its deadline (5 s by
 * default). On a real camera that is real time, and the default clock is the
 * wall clock. The emulated camera has no real time: FW-V1's USB/IP server gates
 * its clock on host activity, so the camera's time is the work the emulator
 * has retired, and a loaded machine retires less of it per second. With a
 * wall-clock deadline the toolkit gave up after a load-dependent amount of the
 * CAMERA's time, and on Compact 0.6.0.4 - whose firmware never answers some
 * requests - that decided whether the emulator's own "timed out" (-110) or the
 * toolkit's deadline came first: 25 armed subcommands idle, 22 or 23 under load
 * (TESTING.md sec.19, FW-V1 campaign log open item 12).
 *
 * WHAT. `EmulatedDeviceClock` is a `DeadlineClock` whose time moves only with
 * the emulated camera's own time, which the emulator reports on its device-time
 * side channel (`seek_emu.py --usbip-clock`, FW-V1 seekemu/usbip.py THE
 * DEVICE-TIME SIDE CHANNEL): one record per RET_SUBMIT, written by the same
 * thread immediately before the RET_SUBMIT, carrying the camera's time when the
 * URB started and when it completed. `DeviceClockLink` is the client of that
 * channel. `UsbIpSession` holds every reply until its record has arrived, so the
 * clock has always reached the completion's time before the transport learns
 * of the completion; a deadline that the record shows has passed fires first,
 * as a real host's timer would have. Nothing depends on how long anything took
 * on the wall clock, so the same URB sequence gives the same result on an idle
 * machine and a loaded one.
 *
 * THE HOST'S DEADLINE. `DeviceClockLink.useDeadline` also tells the emulator
 * the transport's deadline for the transfers that follow, and its host gives an
 * unanswered control transfer up at exactly that much of the camera's time
 * (FW-V1 seekemu/usb_host.py THE HOST'S DEADLINE) - what a real host does:
 * polls the endpoint until its own timeout, then cancels.
 *
 * THE WALL CLOCK STILL WATCHES. A hung emulator never reports a time, so no
 * deadline on this clock would ever fire. The USB/IP client keeps a far longer
 * per-URB wall-clock deadline (`SEEK_EMU_URB_TIMEOUT_MS`) as a watchdog; when it
 * fires, the delivery audit fails the row as an `InfrastructureDefect` - never
 * as a measurement (harness.ts, "USB/IP deadline(s) expired on the client").
 * ==================================================================== */

import { Buffer } from 'node:buffer';
import { connect, type Socket } from 'node:net';

import type { DeadlineClock } from '../../src/protocol/webusb.js';

const NS_PER_MS = 1_000_000;

/** The side channel's protocol version this harness speaks (FW-V1 `CLOCK_PROTOCOL`). */
export const CLOCK_PROTOCOL = 1;

interface Timer {
  readonly dueNs: number;
  readonly onExpire: () => void;
  done: boolean;
}

/**
 * A `DeadlineClock` on the emulated camera's time, in ns of the emulator's
 * host clock (`Machine.now_ps() / 1000`).
 *
 * Time moves only in `advance()`, and `advance()` fires every timer that the
 * new time has reached, earliest first, synchronously. So a timer started at
 * `now` with `ms` fires exactly when a completion at or after `now + ms` is
 * reported, and never because the machine was busy.
 */
export class EmulatedDeviceClock implements DeadlineClock {
  private nowNs = 0;
  /**
   * WHEN THE TOOLKIT GAVE UP, until the next record: the due time of the latest
   * timer the last `advance()` fired, or null.
   *
   * A record can reach past a deadline: under the `chrome` host model the device
   * answers late and nobody cancelled the transfer (webusb-over-usbip.ts
   * `HostModel`). On a real host the toolkit reacted at its deadline, not at the
   * late completion, and what it sent next waited on the pipe from THEN. So a timer
   * started - or a time read - before the next record counts from here, and a
   * transfer queued behind a late one is timed as Chrome times it. Under `nusb`
   * the record ends at the deadline and this is the record's own time (to within
   * one microframe); under `budget` no timer fires and this stays null.
   */
  private firedAtNs: number | null = null;
  private readonly timers: Timer[] = [];
  /** Timers started, ever: the harness checks every vendor transfer started one. */
  timersStarted = 0;
  /** Timers that expired (a deadline passed on the camera's clock). */
  timersFired = 0;
  /** Reads of the time by a deadline checked between requests (`SeekDevice.ensureMode0`). */
  reads = 0;

  /** The camera's time, in ns of the emulator's host clock. */
  get timeNs(): number {
    return this.nowNs;
  }

  /** The camera's time in ms, for a deadline checked between requests. Between two
   *  URBs the gated clock does not move, so a host pause ages the camera by nothing. */
  now(): number {
    this.reads++;
    return this.baseNs / NS_PER_MS;
  }

  /** Where a timer started now counts from (`firedAtNs`). */
  private get baseNs(): number {
    return this.firedAtNs ?? this.nowNs;
  }

  /** Timers started and neither fired nor cancelled. */
  get armed(): number {
    return this.timers.length;
  }

  startTimer(ms: number, onExpire: () => void): () => void {
    const timer: Timer = { dueNs: this.baseNs + ms * NS_PER_MS, onExpire, done: false };
    this.timersStarted++;
    this.timers.push(timer);
    return () => {
      this.remove(timer);
    };
  }

  /**
   * The camera's time is now at least `ns`. Time never runs backwards: a smaller
   * value (a server-generated reply carries the last completion's time) is
   * ignored.
   */
  advance(ns: number): void {
    if (ns > this.nowNs) this.nowNs = ns;
    this.firedAtNs = null;
    for (;;) {
      let next: Timer | undefined;
      for (const t of this.timers) {
        if (t.dueNs <= this.nowNs && (next === undefined || t.dueNs < next.dueNs)) next = t;
      }
      if (next === undefined) return;
      this.remove(next);
      this.timersFired++;
      this.firedAtNs = Math.max(this.firedAtNs ?? 0, next.dueNs);
      next.onExpire();
    }
  }

  private remove(timer: Timer): void {
    if (timer.done) return;
    timer.done = true;
    const i = this.timers.indexOf(timer);
    if (i >= 0) this.timers.splice(i, 1);
  }
}

/** One record of the side channel: a RET_SUBMIT's times. */
export interface UrbTimes {
  readonly peerPort: number;
  readonly seqnum: number;
  readonly status: number;
  readonly t0Ns: number;
  readonly t1Ns: number;
}

/** What `DeviceClockLink` counted, for the delivery audit. */
export interface ClockLinkSnapshot {
  /** `urb` records read off the side channel. */
  readonly records: number;
  /** Replies that had to wait for their record (it was still in flight). */
  readonly repliesHeld: number;
  /** Records still unpaired with a reply. */
  readonly recordsUnpaired: number;
  /** Records for a session this client had already closed (its reply was never read). */
  readonly recordsAfterClose: number;
  /** Replies still waiting for a record. */
  readonly repliesWaiting: number;
  /** `deadline` requests the emulator acknowledged. */
  readonly deadlinesSet: number;
  /** Deadlines that passed on the camera's clock (the transport's timer fired). */
  readonly deadlinesFired: number;
  /** The camera's time at the last record, in ns. */
  readonly nowNs: number;
  /** Reads of the camera's time by a deadline checked between requests. */
  readonly clockReads: number;
  /** What went wrong on the channel itself, if anything. */
  readonly failure: string | null;
}

/**
 * The client of the emulator's device-time side channel: one TCP connection,
 * one JSON object per line.
 *
 * It feeds `clock`, pairs every RET_SUBMIT with its record (`onReply`), and sets
 * the emulator's host deadline (`useDeadline`). One link per emulator process;
 * every USB/IP session to that emulator - re-imports included - shares it.
 */
export class DeviceClockLink {
  readonly clock = new EmulatedDeviceClock();
  private readonly socket: Socket;
  private buffer = '';
  private readonly records = new Map<string, UrbTimes>();
  private readonly waiting = new Map<string, () => void>();
  /** The local ports of the live USB/IP sessions: seqnums restart with every import,
   *  and a port is only reused after its TIME_WAIT, so (port, seqnum) names one URB. */
  private readonly peers = new Set<number>();
  private afterClose = 0;
  private readonly acks = new Map<number, (reply: Record<string, unknown>) => void>();
  private hello: ((reply: Record<string, unknown>) => void) | null = null;
  private nextId = 1;
  private deadlineMs: number | null = null;
  private recordCount = 0;
  private held = 0;
  private deadlinesSet = 0;
  private failure: string | null = null;
  private closed = false;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      this.buffer += chunk;
      for (;;) {
        const nl = this.buffer.indexOf('\n');
        if (nl < 0) break;
        const line = this.buffer.slice(0, nl);
        this.buffer = this.buffer.slice(nl + 1);
        if (line.trim().length > 0) this.onLine(line);
      }
    });
    /* The channel closes whenever its emulator stops, so a close is only a failure
     * when something was still owed on it: a hello or a deadline acknowledgement. A
     * record that never came shows up as a reply still waiting for it
     * (`repliesWaiting`), and one the emulator could not write in its own summary. */
    const lost = (why: string): void => {
      this.closed = true;
      if (this.acks.size > 0 || this.hello !== null) this.failure ??= why;
      for (const [, resolve] of this.acks) resolve({ error: why });
      this.acks.clear();
      this.hello?.({ error: why });
      this.hello = null;
    };
    socket.on('error', (e: Error) => {
      lost(`the device-time side channel failed: ${e.message}`);
    });
    socket.on('close', () => {
      lost('the device-time side channel closed');
    });
  }

  /** Connect, say hello, and start the clock at the emulator's current time. */
  static async connect(host: string, port: number, timeoutMs = 10_000): Promise<DeviceClockLink> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect({ host, port });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Error(`no device-time side channel on ${host}:${String(port)}`));
      }, timeoutMs);
      s.once('connect', () => {
        clearTimeout(timer);
        s.setNoDelay(true);
        resolve(s);
      });
      s.once('error', (e: Error) => {
        clearTimeout(timer);
        reject(e);
      });
    });
    const link = new DeviceClockLink(socket);
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      link.hello = resolve;
      link.send({ op: 'hello' });
    });
    if (reply.hello !== CLOCK_PROTOCOL || typeof reply.now_ns !== 'number') {
      link.close();
      throw new Error(
        `the device-time side channel said ${JSON.stringify(reply)}; this harness speaks ` +
          `protocol ${String(CLOCK_PROTOCOL)}`,
      );
    }
    link.clock.advance(reply.now_ns);
    link.deadlineMs = typeof reply.deadline_ms === 'number' ? reply.deadline_ms : null;
    return link;
  }

  /**
   * The emulator's host gives the transfers that follow up after `ms` of the
   * camera's time. Sent only when it changes, and the next transfer waits for
   * the emulator's acknowledgement, which it writes after its bridge holds the
   * value - so that transfer runs under it.
   */
  async useDeadline(ms: number): Promise<void> {
    if (this.deadlineMs === ms) return;
    if (this.failure !== null) throw new Error(this.failure);
    if (this.closed) throw new Error('the device-time side channel has closed');
    const id = this.nextId++;
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      this.acks.set(id, resolve);
      this.send({ op: 'deadline', ms, id });
    });
    if (reply.ack !== id || reply.deadline_ms !== ms) {
      throw new Error(
        `the emulator did not take host deadline ${String(ms)} ms: ${JSON.stringify(reply)}`,
      );
    }
    this.deadlineMs = ms;
    this.deadlinesSet++;
  }

  /** A USB/IP session on this local port has been imported. */
  openPeer(port: number): void {
    this.peers.add(port);
  }

  /** That session has ended: nothing more of it is paired, and nothing of it is kept. */
  closePeer(port: number): void {
    this.peers.delete(port);
    const prefix = `${String(port)}:`;
    for (const key of [...this.records.keys()])
      if (key.startsWith(prefix)) this.records.delete(key);
    for (const key of [...this.waiting.keys()])
      if (key.startsWith(prefix)) this.waiting.delete(key);
  }

  /**
   * Deliver one RET_SUBMIT once its record has arrived - at once when it already
   * has (the usual case: the record is written first), or when it does. The
   * clock was advanced when the record arrived, so it is never behind the
   * completion the transport is about to learn of.
   */
  onReply(peerPort: number, seqnum: number, deliver: () => void): void {
    const key = `${String(peerPort)}:${String(seqnum)}`;
    if (this.records.delete(key)) {
      deliver();
      return;
    }
    this.held++;
    this.waiting.set(key, deliver);
  }

  /** Whether this URB's completion has been reported and its reply not yet delivered. */
  hasRecord(peerPort: number, seqnum: number): boolean {
    return this.records.has(`${String(peerPort)}:${String(seqnum)}`);
  }

  snapshot(): ClockLinkSnapshot {
    return {
      records: this.recordCount,
      repliesHeld: this.held,
      recordsUnpaired: this.records.size,
      recordsAfterClose: this.afterClose,
      repliesWaiting: this.waiting.size,
      deadlinesSet: this.deadlinesSet,
      deadlinesFired: this.clock.timersFired,
      nowNs: this.clock.timeNs,
      clockReads: this.clock.reads,
      failure: this.failure,
    };
  }

  close(): void {
    this.socket.destroy();
  }

  private send(message: Record<string, unknown>): void {
    this.socket.write(Buffer.from(`${JSON.stringify(message)}\n`, 'utf8'));
  }

  private onLine(line: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.failure ??= `the device-time side channel sent a line that is not JSON: ${line}`;
      return;
    }
    const urb = msg.urb;
    if (Array.isArray(urb)) {
      const [peerPort, seqnum, status, t0Ns, t1Ns] = urb as number[];
      if (
        peerPort === undefined ||
        seqnum === undefined ||
        status === undefined ||
        t0Ns === undefined ||
        t1Ns === undefined
      ) {
        this.failure ??= `a malformed urb record: ${line}`;
        return;
      }
      this.recordCount++;
      this.clock.advance(t1Ns);
      if (!this.peers.has(peerPort)) {
        this.afterClose++;
        return;
      }
      const key = `${String(peerPort)}:${String(seqnum)}`;
      const deliver = this.waiting.get(key);
      if (deliver) {
        this.waiting.delete(key);
        deliver();
      } else {
        this.records.set(key, { peerPort, seqnum, status, t0Ns, t1Ns });
      }
      return;
    }
    if ('hello' in msg || ('error' in msg && this.hello !== null && !('id' in msg))) {
      const resolve = this.hello;
      this.hello = null;
      resolve?.(msg);
      return;
    }
    const id = typeof msg.ack === 'number' ? msg.ack : typeof msg.id === 'number' ? msg.id : null;
    if (id !== null) {
      const resolve = this.acks.get(id);
      this.acks.delete(id);
      resolve?.(msg);
      return;
    }
    this.failure ??= `an unexpected line on the device-time side channel: ${line}`;
  }
}

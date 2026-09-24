/* ==================================================================== *
 * Starting and stopping emulated cameras, one per firmware, in parallel.
 *
 * THE LEAK RULE. An emulator is a Python process holding a TCP port. A suite
 * that starts fifty of them must not leave one behind on a failure, a timeout or
 * a Ctrl-C, or the next run finds its ports taken and its CPU gone. So every
 * child is registered the instant it is spawned, `stop()` is idempotent, and a
 * process-level handler kills whatever is still registered on exit — including
 * on SIGINT and SIGTERM, which vitest does not unwind through `afterEach`.
 *
 * THE READINESS RULE. Nothing here sleeps a fixed amount of time hoping the
 * device is up. `seek_emu.py --usbip` prints one `---USBIP-READY---` line
 * carrying the port, the busid, the sha256 of the image it is serving and the
 * fill report; the harness waits for that line and then for `OP_REQ_DEVLIST` to
 * answer. A firmware that never gets that far fails with the emulator's own
 * stderr attached, which is the diagnosis.
 *
 * THE DELIVERY RULE. A reply the emulator produced and then lost looks, from
 * this side of the socket, exactly like a camera that did not answer — and for a
 * whole suite run it was recorded as one (FW-V1 Phase 17: 172 replies dropped by
 * orphaned writer threads). So every emulator is stopped with SIGTERM, which makes
 * it print its delivery ledger (`---USBIP-SUMMARY---`), and `auditDelivery()`
 * compares that ledger with what the client side counted. Any dropped reply, any
 * mismatch, any ledger missing is an `InfrastructureDefect`: it fails the row,
 * gap or not, and is never written down as firmware behaviour.
 *
 * THE DEATH RULE (2026-09-23). An emulator whose run ends while a row is still
 * using it — the process exits, or it prints its `stopped:` / `fault:` line
 * without having been asked to stop — is a defect of the instrument too, and
 * the harness notices AT ONCE: `Emulator` watches the child's output and exit,
 * aborts every adapter attached to it (so nothing sits out a reopen timeout
 * against a corpse), and `RowEmulators.guard()` fails the row with an
 * `InfrastructureDefect` the moment it happens. It is never a gap: a camera
 * does not "fault at PC 0x1000436C", an emulator does (TESTING.md sec.15).
 * ==================================================================== */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import {
  DeliveryLedger,
  type DeliveryLedgerSnapshot,
  devlist,
  type WireCount,
} from './usbip-client.js';
import { UsbIpWebUsbDevice, type UsbIpWebUsbOptions } from './webusb-over-usbip.js';

/* ---- locating the emulator ----------------------------------------- */

/**
 * The emulator directory, or null when it is not available.
 *
 * `SEEK_EMU_DIR` wins and, when set, is the ONLY thing consulted: falling back
 * to a default when somebody's override points at nothing would run the suite
 * against an emulator they did not choose and report it as theirs — the same
 * rule `corpus.test.ts` applies to `SEEK_DUMPS_DIR`.
 */
export function emulatorDir(): string | null {
  const override = process.env.SEEK_EMU_DIR;
  const candidate =
    typeof override === 'string' && override.length > 0
      ? override
      : path.resolve(import.meta.dirname, '..', '..', '..', '..', '..', 'FW-V1', 'emu');
  return usable(candidate) ? path.resolve(candidate) : null;
}

function usable(dir: string): boolean {
  return existsSync(path.join(dir, 'seek_emu.py')) && existsSync(pythonFor(dir));
}

function pythonFor(dir: string): string {
  const venv = path.join(dir, '.venv', 'bin', 'python');
  return existsSync(venv) ? venv : (process.env.SEEK_EMU_PYTHON ?? 'python3');
}

/** The vendored corpus manifest, or null when the emulator is not available. */
export interface ManifestEntry {
  readonly id: string;
  readonly kind: 'full-dump' | 'image-only';
  readonly family: string;
  readonly product: string;
  readonly version: string;
  readonly serial: string | null;
  readonly sha256: string;
  readonly donor?: { readonly id: string } | null;
}

export function loadManifest(dir: string): readonly ManifestEntry[] {
  const file = path.join(dir, 'data', 'corpus', 'MANIFEST.json');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as { entries: ManifestEntry[] };
  return doc.entries;
}

/* ---- port allocation ------------------------------------------------ */

/**
 * A port the OS has just confirmed is free.
 *
 * There is an unavoidable race between releasing it and the emulator binding it;
 * `start()` therefore retries on a bind failure rather than assuming success.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        if (port === 0) reject(new Error('could not obtain a free port'));
        else resolve(port);
      });
    });
  });
}

/* ---- the process registry ------------------------------------------- */

const live = new Set<ChildProcess>();
let hooked = false;

function hookOnce(): void {
  if (hooked) return;
  hooked = true;
  const reap = (): void => {
    for (const child of live) {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
    live.clear();
  };
  process.on('exit', reap);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      reap();
      process.exit(1);
    });
  }
}

/** How many emulators are still running. A suite asserts this is 0 at the end. */
export function liveEmulatorCount(): number {
  return live.size;
}

/* ---- starting one --------------------------------------------------- */

export interface FillReport {
  readonly seed: number;
  readonly scope: string;
  readonly bytes_filled: number;
  readonly bytes_still_erased: number;
  readonly filled_sha256: string;
  readonly vendored_sha256: string;
}

export interface ReadyLine {
  readonly port: number;
  readonly busid: string;
  readonly bind: string;
  readonly flash_out: string | null;
  readonly flash_sha256: string;
  readonly source: string;
  readonly fill: FillReport | null;
}

/** The emulator's own delivery ledger: `seek_emu.py --usbip`'s `---USBIP-SUMMARY---`
 *  line, printed once every writer thread has been joined (FW-V1 seekemu/usbip.py,
 *  `Bridge.accounting()`). */
export interface DeliverySummary {
  readonly reason: string;
  readonly sessions: number;
  readonly balanced: boolean;
  readonly completions: {
    readonly produced: number;
    readonly delivered: number;
    readonly dropped: number;
    readonly unresolved: number;
  };
  readonly dropped_by_reason: Readonly<Record<string, number>>;
  readonly urbs: {
    readonly submitted: number;
    readonly answered: number;
    readonly unlinked: number;
    readonly dropped: number;
    readonly outstanding: number;
  };
  readonly writers_alive: number;
  readonly writers_stuck: number;
}

/** One emulator process's delivery, audited. `violations` empty means every reply
 *  the device produced reached the client and nothing was left unanswered. */
export interface DeliveryAudit {
  readonly entryId: string;
  readonly violations: readonly string[];
  readonly server: DeliverySummary | null;
  readonly client: DeliveryLedgerSnapshot;
  /** True when the emulator's run ended on its own before the harness stopped it.
   *  That is itself a violation (`death`); it only keeps the transfers it left
   *  unanswered from being listed as separate ones. */
  readonly diedOnItsOwn: boolean;
  /** How the emulator's run ended under the row, or null when the harness stopped it. */
  readonly death: string | null;
  /** What went on the wire, and the emulator's own count of SET_INTERFACE stalls. */
  readonly wire: WireTally;
}

/* ---- the wire log, summarised --------------------------------------- */

/**
 * What one row, or one tier, actually put on the wire — the numbers that say which
 * path a run measured.
 *
 * WHY THESE AND NOT OTHERS. For a whole campaign every emulator row sent its vendor
 * requests with DEVICE recipient (0x40/0xC0), because the adapter's `claimInterface`
 * sent a `SET_INTERFACE` a real host never sends, the firmware stalled it, and
 * `WebUsbTransport` fell back without a word (TESTING.md sec.9.9). On a real host the
 * claim is silent and the requests go out as 0x41/0xC1. `vendorDevice` must now be
 * 0 and `setInterfaceSent` must be 0; `setInterfaceStallsLogged` counts the
 * emulator's own `device stalled ... bRequest=11` lines, so the claim does not rest on
 * the client counting itself.
 */
export interface WireTally {
  /** Vendor requests with interface recipient: bmRequestType 0x41 / 0xC1. */
  readonly vendorInterface: number;
  /** Vendor requests with device recipient: bmRequestType 0x40 / 0xC0. */
  readonly vendorDevice: number;
  /** Vendor requests the device stalled — refusals, which are measurements. */
  readonly vendorStalled: number;
  readonly setConfigurationSent: number;
  readonly setInterfaceSent: number;
  readonly setInterfaceStalled: number;
  /** Standard requests the device stalled, by `bmRequestType/bRequest`. */
  readonly standardStalled: Readonly<Record<string, number>>;
  /** `device stalled ... bRequest=11` lines in the emulator's own log. */
  readonly setInterfaceStallsLogged: number;
}

export const NO_WIRE: WireTally = {
  vendorInterface: 0,
  vendorDevice: 0,
  vendorStalled: 0,
  setConfigurationSent: 0,
  setInterfaceSent: 0,
  setInterfaceStalled: 0,
  standardStalled: {},
  setInterfaceStallsLogged: 0,
};

function tallyWire(requests: Readonly<Record<string, WireCount>>, logged: number): WireTally {
  let vendorInterface = 0;
  let vendorDevice = 0;
  let vendorStalled = 0;
  let setConfigurationSent = 0;
  let setInterfaceSent = 0;
  let setInterfaceStalled = 0;
  const standardStalled: Record<string, number> = {};
  for (const [key, count] of Object.entries(requests)) {
    const [bmText = '', reqText = ''] = key.split('/');
    const bm = Number.parseInt(bmText, 16);
    const req = Number.parseInt(reqText, 16);
    const type = bm & 0x60;
    const recipient = bm & 0x1f;
    if (type === 0x40) {
      if (recipient === 0x01) vendorInterface += count.sent;
      else if (recipient === 0x00) vendorDevice += count.sent;
      vendorStalled += count.stalled;
    } else if (type === 0x00) {
      if (req === 0x09) setConfigurationSent += count.sent;
      if (req === 0x0b) {
        setInterfaceSent += count.sent;
        setInterfaceStalled += count.stalled;
      }
      if (count.stalled > 0) standardStalled[key] = count.stalled;
    }
  }
  return {
    vendorInterface,
    vendorDevice,
    vendorStalled,
    setConfigurationSent,
    setInterfaceSent,
    setInterfaceStalled,
    standardStalled,
    setInterfaceStallsLogged: logged,
  };
}

/** Two tallies, added. */
export function addWire(a: WireTally, b: WireTally): WireTally {
  const standardStalled: Record<string, number> = { ...a.standardStalled };
  for (const [key, n] of Object.entries(b.standardStalled)) {
    standardStalled[key] = (standardStalled[key] ?? 0) + n;
  }
  return {
    vendorInterface: a.vendorInterface + b.vendorInterface,
    vendorDevice: a.vendorDevice + b.vendorDevice,
    vendorStalled: a.vendorStalled + b.vendorStalled,
    setConfigurationSent: a.setConfigurationSent + b.setConfigurationSent,
    setInterfaceSent: a.setInterfaceSent + b.setInterfaceSent,
    setInterfaceStalled: a.setInterfaceStalled + b.setInterfaceStalled,
    standardStalled,
    setInterfaceStallsLogged: a.setInterfaceStallsLogged + b.setInterfaceStallsLogged,
  };
}

/**
 * A defect in the measuring instrument, not a property of the firmware.
 *
 * NEVER RECORDED, NEVER ABSORBED. It is thrown after the row's emulators have been
 * stopped and audited, it is not a `ProbeUnmeasurable` (so no re-measure hides it),
 * the regenerator does not turn it into a gap, and no row runs under `test.fails` —
 * so it fails the suite whichever row it happens on.
 */
export class InfrastructureDefect extends Error {
  readonly audits: readonly DeliveryAudit[];
  constructor(entryId: string, audits: readonly DeliveryAudit[], cause?: unknown) {
    const lines = audits.flatMap((a, i) =>
      a.violations.map((v) => `  emulator ${String(i + 1)} of ${String(audits.length)}: ${v}`),
    );
    super(
      `INFRASTRUCTURE DEFECT on ${entryId} — the emulator/USB-IP transport failed (a ` +
        `reply lost or mis-delivered, or the emulator's run ended under the row), so ` +
        `nothing this row measured is a statement about the firmware:\n${lines.join('\n')}`,
      cause === undefined ? undefined : { cause },
    );
    this.name = 'InfrastructureDefect';
    this.audits = audits;
  }
}

export interface StartOptions {
  /** The corpus entry to boot — or, when `flashOverride` is given, just the
   *  label this process is audited under. */
  readonly entryId: string;
  /** `--fill-erased SEED`; omit to serve the vendored bytes unchanged. */
  readonly fillSeed?: number;
  readonly fillScope?: 'safe' | 'all';
  /** Where the emulator writes the as-booted 4 MiB image (the ground truth). */
  readonly flashOut?: string;
  /** How long to wait for the READY line. Boots are ~1-20 s; be generous. */
  readonly readyTimeoutMs?: number;
  readonly urbTimeoutMs?: number;
  /* ---- preservation-pipeline additions (2026-09-24, additive) ----
   * The four phases need boots this suite's own rows never make: an image-only
   * corpus entry spliced onto a DONOR dump (the v1 chimeras), the donor's JEDEC
   * id, a longer per-transfer wait budget so a wire-81 commit's erase+program+
   * verify URB outlives the flash work, and a `--flash` override that boots a
   * SPECIFIC part image (the post-commit state) instead of the vendored one. */
  /** `--donor ID` — the corpus entry an image-only boot is spliced onto. */
  readonly donor?: string;
  /** `--jedec <id>` — the emulated NOR's JEDEC identity. */
  readonly jedec?: string;
  /** `--host-wait-budget <steps>` — per-transfer guest-step budget. */
  readonly hostWaitBudget?: number;
  /** `--flash <path>` — boot this 4 MiB part image instead of the vendored one.
   *  Mutually exclusive with `entryId` by the emulator's own rules. */
  readonly flashOverride?: string;
}

/** How long a SIGTERM'd emulator gets to join its threads and print its ledger. A
 *  backstop, not a wait: a healthy one exits in well under a second. */
const STOP_GRACE_MS = 30_000;

/** How long an emulator whose run has ended on its own gets to finish printing before
 *  `stop()` sends SIGTERM. Its summary and its `fault:` line come AFTER the `stopped:`
 *  line the death is noticed on, and by then `seek_emu.py` has put SIGTERM back to the
 *  default action, so a prompt SIGTERM cuts the diagnosis off. A backstop, not a wait:
 *  it exits by itself within milliseconds. */
const DEATH_GRACE_MS = 3_000;

/** What `startOnce` wires to the child's output and exit before the `Emulator`
 *  object exists; the constructor fills the two hooks in. */
interface ChildWatch {
  onLine: ((line: string) => void) | null;
  onExit: ((code: number | null, signal: NodeJS.Signals | null) => void) | null;
}

export class Emulator {
  readonly entryId: string;
  readonly ready: ReadyLine;
  /** Everything the client side sent and received, over every session to this emulator. */
  readonly ledger = new DeliveryLedger();
  private readonly child: ChildProcess;
  private readonly logLines: string[];
  private readonly closed: Promise<void>;
  private stopped = false;
  private killed = false;
  private diedOnItsOwn = false;
  /** The emulator printed `stopping (...)`: a stop somebody ASKED for is under way. */
  private stopAnnounced = false;
  private deathReason: string | null = null;
  private readonly deathController = new AbortController();
  private readonly deathNotice: Promise<string>;
  private announceDeath: (reason: string) => void = () => undefined;

  private constructor(
    entryId: string,
    child: ChildProcess,
    ready: ReadyLine,
    log: string[],
    closed: Promise<void>,
    watch: ChildWatch,
  ) {
    this.entryId = entryId;
    this.child = child;
    this.ready = ready;
    this.logLines = log;
    this.closed = closed;
    this.deathNotice = new Promise<string>((resolve) => {
      this.announceDeath = resolve;
    });
    /* Anything that happened between the READY line and now counts too. */
    for (const line of log) this.onOutputLine(line);
    watch.onLine = (line) => {
      this.onOutputLine(line);
    };
    watch.onExit = (code, signal) => {
      this.onChildExit(code, signal);
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      this.onChildExit(child.exitCode, child.signalCode);
    }
  }

  /**
   * The emulator's own words about its run ending.
   *
   * `seek_emu.py --usbip` prints `stopping (SIGTERM) - ...` when it is ASKED to stop,
   * and `stopped: <reason>` when `Machine.run()` returns, then the summary, then
   * `fault: ...` if the part faulted (FW-V1 seekemu/cli.py, seekemu/report.py). So a
   * `stopped:` line with no `stopping (` before it is a run that ended by itself - a
   * Unicorn fault, a stall, anything - and a `fault:` line always is. Seen here, it
   * is noticed while the process is still printing, before the socket has even
   * finished closing.
   */
  private onOutputLine(line: string): void {
    if (line.startsWith('stopping (')) {
      this.stopAnnounced = true;
    } else if (line.startsWith('fault: ')) {
      this.markDead(`it reported "${line.trim()}"`, true);
    } else if (line.startsWith('stopped: ') && !this.stopAnnounced) {
      this.markDead(`it reported "${line.trim()}" without having been asked to stop`, true);
    }
  }

  /** The process exited. Only a death if nobody here asked it to stop. */
  private onChildExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.markDead(
      `the process exited (code ${String(code)}, signal ${String(signal)})` +
        (this.stopAnnounced ? ' after a stop this harness did not ask for' : ''),
      false,
    );
  }

  /** `selfDescribing`: the emulator said so itself, so it counts even if the harness
   *  had begun stopping it in the same instant. */
  private markDead(how: string, selfDescribing: boolean): void {
    if (this.deathReason !== null) return;
    if (this.stopped && !selfDescribing) return;
    this.deathReason = `the emulator's run ended while the harness was still using it: ${how}`;
    this.diedOnItsOwn = true;
    this.deathController.abort(new Error(this.deathReason));
    this.announceDeath(this.deathReason);
  }

  /** How the emulator's run ended under the harness, or null while it has not. */
  get death(): string | null {
    return this.deathReason;
  }

  /** Settles, with `death`, the moment the emulator's run ends on its own; never
   *  settles for a stop the harness asked for. */
  whenDead(): Promise<string> {
    return this.deathNotice;
  }

  /** The Python process's pid - for a test that has to kill one from outside. */
  get pid(): number | undefined {
    return this.child.pid;
  }

  /** The emulator's own output. Attached to every failure, because the reason a
   *  firmware did not get somewhere is always in here. */
  log(tail = 40): string {
    return this.logLines.slice(-tail).join('\n');
  }

  /**
   * Is the Python process still running?
   *
   * A DEAD EMULATOR IS NOT A FIRMWARE RESULT, and telling the two apart matters:
   * several corpus firmwares reach an instruction this emulator cannot execute
   * — a bit-band write, for instance, which it does not model — and Unicorn
   * stops the whole run with `UC_ERR_WRITE_UNMAPPED`. Every transfer after that
   * fails with ECONNREFUSED, which a probe that only watches the wire records as
   * "the camera answered nothing". It answered nothing because there was no
   * longer a camera.
   */
  get alive(): boolean {
    return this.child.exitCode === null && this.child.signalCode === null;
  }

  /** The emulator's own stop reason, when it has one. Unicorn prints
   *  `stopped: ...` and `fault: ...` lines just before the run summary. */
  stopReason(): string | null {
    for (let i = this.logLines.length - 1; i >= 0; i--) {
      const line = this.logLines[i] ?? '';
      if (line.startsWith('stopped: ') || line.startsWith('fault: ')) return line.trim();
    }
    return null;
  }

  /**
   * The stop reason, once the child's stdout has been read to the end.
   *
   * THE RACE IS REAL AND IT COSTS FIVE MINUTES A ROW WHEN IT IS LOST. Node sets
   * `exitCode` on the `exit` event, but the final stdout chunks — which is
   * where `stopped:` and `fault:` live — can still be in flight. A caller that
   * reads `stopReason()` the instant it notices the process is gone gets null,
   * concludes the death was a random session loss, and re-measures a
   * deterministic Unicorn fault from scratch.
   *
   * It used to wait a fixed 750 ms for the pipe to drain, which is a guess about
   * host load. It now waits for the child's `close` event — every stdio stream at
   * end-of-file — which is the actual condition, bounded only as a backstop.
   */
  async settledStopReason(backstopMs = 15_000): Promise<string | null> {
    const reason = this.stopReason();
    if (reason !== null || this.alive) return reason;
    await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, backstopMs))]);
    return this.stopReason();
  }

  /** The emulator's own `urb N ep0: device stalled ... bRequest=11` notes: SET_INTERFACE
   *  refused, counted by the SERVER. (Vendor wire ids start at 53, so 11 is never one.) */
  setInterfaceStallsLogged(): number {
    return this.logLines.filter((line) => /device stalled .*\bbRequest=11\b/.test(line)).length;
  }

  /** The emulator's `---USBIP-SUMMARY---` delivery ledger, once it has exited. */
  deliverySummary(): DeliverySummary | null {
    for (let i = this.logLines.length - 1; i >= 0; i--) {
      const line = this.logLines[i] ?? '';
      if (line.startsWith('---USBIP-SUMMARY--- ')) {
        try {
          return JSON.parse(line.slice('---USBIP-SUMMARY--- '.length)) as DeliverySummary;
        } catch {
          return null;
        }
      }
    }
    return null;
  }

  /**
   * Did every reply the emulator produced reach this client? Call after `stop()`.
   *
   * The rules, and why each is a defect of the instrument rather than a finding:
   *
   *  - the ledger must exist: an emulator that did not print it was killed or
   *    crashed, and nothing can be said about what it delivered;
   *  - `dropped` must be 0 and the ledger must balance: a reply the device
   *    produced and the client never got is what Phase 17 recorded as `no-answer`;
   *  - no writer thread may outlive its session;
   *  - what the server says it delivered must equal what the client read, and
   *    nothing may arrive after the client stopped waiting for it;
   *  - and, unless the emulator died on its own (a Unicorn fault, which the probe
   *    records as such), nothing may be left unanswered: no URB outstanding at
   *    exit, no transfer abandoned by the client, no client deadline expired. The
   *    device answers every request in under 100 ms (Phase 17: slowest of 892,004
   *    was 68 ms), so a deadline that expired on a live emulator means the answer
   *    was not waited for, and whatever was recorded instead is not the firmware's.
   */
  auditDelivery(): DeliveryAudit {
    const server = this.deliverySummary();
    const client = this.ledger.snapshot();
    const v: string[] = [];
    if (this.deathReason !== null) {
      const said = this.stopReason();
      v.push(
        this.deathReason +
          (said === null || this.deathReason.includes(said) ? '' : ` [${said}]`) +
          ' - an emulator that stops is a defect of the instrument, never a firmware result',
      );
    }
    if (server === null) {
      v.push(
        'the emulator exited without printing its ---USBIP-SUMMARY--- delivery ledger' +
          (this.killed ? ' (it did not stop on SIGTERM and had to be killed)' : ''),
      );
    } else {
      const c = server.completions;
      if (c.dropped > 0) {
        v.push(
          `the emulator DROPPED ${String(c.dropped)} of ${String(c.produced)} repl(ies) it ` +
            `produced: ${JSON.stringify(server.dropped_by_reason)}`,
        );
      }
      if (!server.balanced || c.unresolved !== 0) {
        v.push(
          `the emulator's ledger does not balance: ${String(c.unresolved)} repl(ies) ` +
            'neither delivered nor counted as dropped',
        );
      }
      if (server.writers_alive > 0 || server.writers_stuck > 0) {
        v.push(
          `${String(server.writers_alive)} writer thread(s) outlived their session ` +
            `(${String(server.writers_stuck)} stuck at teardown)`,
        );
      }
      if (client.repliesReceived !== c.delivered) {
        v.push(
          `the emulator delivered ${String(c.delivered)} repl(ies) and the client read ` +
            String(client.repliesReceived),
        );
      }
      if (client.sessions !== server.sessions) {
        v.push(
          `the emulator opened ${String(server.sessions)} session(s) and the client saw ` +
            String(client.sessions),
        );
      }
      if (!this.diedOnItsOwn && server.urbs.outstanding > 0) {
        v.push(
          `${String(server.urbs.outstanding)} URB(s) were still unanswered when the harness ` +
            'stopped a live emulator',
        );
      }
    }
    if (client.repliesUnmatched > 0) {
      v.push(
        `${String(client.repliesUnmatched)} repl(ies) arrived after the client had stopped ` +
          'waiting for them',
      );
    }
    if (!this.diedOnItsOwn) {
      if (client.urbsAbandoned > 0) {
        v.push(
          `the client closed a session with ${String(client.urbsAbandoned)} transfer(s) ` +
            'still unanswered by a live emulator',
        );
      }
      if (client.deadlinesExpired > 0) {
        v.push(
          `${String(client.deadlinesExpired)} USB/IP deadline(s) expired on the client ` +
            'against a live emulator',
        );
      }
    }
    return {
      entryId: this.entryId,
      violations: v,
      server,
      client,
      diedOnItsOwn: this.diedOnItsOwn,
      death: this.deathReason,
      wire: tallyWire(client.requests, this.setInterfaceStallsLogged()),
    };
  }

  static async start(dir: string, options: StartOptions): Promise<Emulator> {
    hookOnce();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await Emulator.startOnce(dir, options);
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private static async startOnce(dir: string, options: StartOptions): Promise<Emulator> {
    const port = await freePort();
    const argv = [
      'seek_emu.py',
      '--usbip',
      '--usbip-port',
      String(port),
      '--usbip-bind',
      '127.0.0.1',
      ...(options.flashOverride !== undefined
        ? (['--flash', options.flashOverride] as const)
        : (['--corpus-entry', options.entryId] as const)),
      /* NO SENSOR.
       *
       * `--usbip` normally attaches the SGPIO sensor feed, because a client may
       * ask for frames. This suite never does — it wants the RPC surface and the
       * flash — and two corpus firmwares FAULT inside their frame path
       * (4.9.1.15 writes past the top of SRAM bank A at 0x10089AC0; 1.0.3.2
       * takes an unhandled CPU exception at 0x4000C154) and take the USB/IP
       * server down with them, which reads as "this firmware answers nothing".
       * Without a sensor all four of those entries enumerate and answer RPC.
       *
       * This is a REMOVED INPUT, not a workaround: a camera whose sensor is
       * producing nothing is still a camera as far as its flash is concerned,
       * and the emulator's own frame-path limits are recorded in FW-V1's
       * docs/EMULATOR_CORPUS.md rather than papered over here. */
      '--no-sensor',
    ];
    if (options.fillSeed !== undefined) {
      argv.push('--fill-erased', String(options.fillSeed));
      argv.push('--fill-erased-scope', options.fillScope ?? 'safe');
    }
    if (options.flashOut !== undefined) argv.push('--flash-out', options.flashOut);
    /* The preservation pipeline's boots. Each flag exists on the FW-V1 emulator
     * (seekemu/cli.py); when the pointed-at emulator predates one, the spawn
     * fails on the unknown argument and the error says so — there is no silent
     * fallback onto a boot the caller did not describe. */
    if (options.donor !== undefined) argv.push('--donor', options.donor);
    if (options.jedec !== undefined) argv.push('--jedec', options.jedec);
    if (options.hostWaitBudget !== undefined) {
      argv.push('--host-wait-budget', String(options.hostWaitBudget));
    }

    const child = spawn(pythonFor(dir), argv, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    live.add(child);
    const closed = new Promise<void>((resolve) => {
      child.once('close', () => {
        resolve();
      });
    });

    const lines: string[] = [];
    const watch: ChildWatch = { onLine: null, onExit: null };
    child.once('exit', (code, signal) => {
      watch.onExit?.(code, signal);
    });
    const ready = await new Promise<ReadyLine>((resolve, reject) => {
      const deadline = setTimeout(() => {
        reject(
          new Error(
            `emulator for ${options.entryId} produced no ---USBIP-READY--- line within ` +
              `${String(options.readyTimeoutMs ?? 120_000)} ms\n${lines.slice(-30).join('\n')}`,
          ),
        );
      }, options.readyTimeoutMs ?? 120_000);

      let pending = '';
      const onChunk = (chunk: Buffer): void => {
        pending += chunk.toString('utf8');
        const parts = pending.split('\n');
        pending = parts.pop() ?? '';
        for (const line of parts) {
          lines.push(line);
          watch.onLine?.(line);
          if (line.startsWith('---USBIP-READY--- ')) {
            clearTimeout(deadline);
            try {
              resolve(JSON.parse(line.slice('---USBIP-READY--- '.length)) as ReadyLine);
            } catch (error) {
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          }
        }
      };
      child.stdout.on('data', onChunk);
      child.stderr.on('data', onChunk);
      child.once('error', (error) => {
        clearTimeout(deadline);
        reject(error);
      });
      child.once('exit', (code) => {
        clearTimeout(deadline);
        reject(
          new Error(
            `emulator for ${options.entryId} exited with code ${String(code)} before it was ` +
              `ready\n${lines.slice(-30).join('\n')}`,
          ),
        );
      });
    }).catch((error: unknown) => {
      live.delete(child);
      child.kill('SIGKILL');
      throw error instanceof Error ? error : new Error(String(error));
    });

    /* The READY line says the socket is bound; this says the DEVICE answers.
     *
     * STILL POLLED, THOUGH THE REASON IT HAD TO BE IS GONE. The emulator's server
     * used to refuse `OP_REQ_DEVLIST` when its own enumeration had not finished
     * within ten seconds of HOST time (`usbip.py`, `ready.wait(10.0)`). A 2014
     * Compact takes 9-11 s to get there on an idle machine, so under the
     * contention of several exported cameras nine firmwares came back "devlist
     * refused" with nothing wrong with them, and only asking again — the ten
     * seconds were per request — got past it. As of 2026-09-22 that wall clock is
     * gone: the server waits on its own liveness, so one call now blocks until
     * the device is published or the emulator run has ended. The retry is kept
     * because it costs nothing, covers a server that is still binding its port,
     * and keeps this working against an older emulator.
     *
     * A failure must not leak the child: it is already registered, and `start()`
     * retries, so an un-killed one would sit there burning a core until the
     * process-exit reaper ran. */
    const deadline = Date.now() + (options.readyTimeoutMs ?? 120_000);
    let lastError: unknown;
    for (;;) {
      try {
        await devlist('127.0.0.1', ready.port, 15_000);
        return new Emulator(options.entryId, child, ready, lines, closed, watch);
      } catch (error) {
        if (Date.now() >= deadline || child.exitCode !== null) {
          lastError = error;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    live.delete(child);
    child.kill('SIGKILL');
    throw new Error(
      `emulator for ${options.entryId} never answered OP_REQ_DEVLIST: ` +
        `${lastError instanceof Error ? lastError.message : String(lastError)}\n` +
        lines.slice(-20).join('\n'),
    );
  }

  /** A `WebUsbDevice` over this emulator, for `new WebUsbTransport(...)`. */
  attach(options: UsbIpWebUsbOptions = {}): Promise<UsbIpWebUsbDevice> {
    return UsbIpWebUsbDevice.attach('127.0.0.1', this.ready.port, this.ready.busid, {
      ...options,
      ledger: this.ledger,
      gone: this.deathController.signal,
    });
  }

  /**
   * Idempotent. Safe on a process that has already died.
   *
   * SIGTERM, and then WAIT for the process to finish its own shutdown: the emulator
   * stops its server, joins every writer thread and only then prints its delivery
   * ledger, which `auditDelivery()` needs. SIGKILL is the backstop, and an emulator
   * that needs it fails the audit — it did not stop, so nobody knows what it
   * delivered.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    live.delete(this.child);
    if (this.deathReason !== null && this.alive) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        this.closed,
        new Promise((resolve) => (timer = setTimeout(resolve, DEATH_GRACE_MS))),
      ]);
      clearTimeout(timer);
    }
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      this.diedOnItsOwn = true;
      this.markDead(
        `the process had exited (code ${String(this.child.exitCode)}, signal ` +
          `${String(this.child.signalCode)}) before the harness stopped it`,
        true,
      );
      await Promise.race([this.closed, new Promise((resolve) => setTimeout(resolve, 15_000))]);
      return;
    }
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      this.killed = true;
      this.child.kill('SIGKILL');
    }, STOP_GRACE_MS);
    await this.closed;
    clearTimeout(timer);
  }
}

/**
 * Every emulator process one test row starts, stopped and audited together.
 *
 * A row may start several — `ProbeUnmeasurable` re-measures from a fresh process —
 * and every one of them is audited, the discarded attempts included: an attempt
 * thrown away because replies went missing is exactly the defect that must not
 * be re-measured into silence.
 */
export class RowEmulators {
  readonly entryId: string;
  private readonly started: Emulator[] = [];
  private audits: DeliveryAudit[] | null = null;

  constructor(entryId: string) {
    this.entryId = entryId;
  }

  async start(dir: string, options: StartOptions): Promise<Emulator> {
    const emu = await Emulator.start(dir, options);
    this.started.push(emu);
    return emu;
  }

  /** The last emulator's log, for a failure message. */
  lastLog(tail = 25): string {
    return this.started.at(-1)?.log(tail) ?? '(no emulator was started)';
  }

  /** Stop every emulator this row started and audit each. Idempotent. */
  async finish(): Promise<readonly DeliveryAudit[]> {
    if (this.audits !== null) return this.audits;
    const audits: DeliveryAudit[] = [];
    for (const emu of this.started) {
      await emu.stop();
      audits.push(emu.auditDelivery());
    }
    this.audits = audits;
    return audits;
  }

  /**
   * Run `work` against `emu`, and fail the row THE MOMENT the emulator's run ends.
   *
   * `work` is raced against `Emulator.whenDead()`. If the emulator dies first, every
   * emulator of the row is stopped and audited and an `InfrastructureDefect` is
   * thrown at once, carrying the death; `work` is left to unwind on its own, which
   * it does in milliseconds because the death also aborted every adapter attached
   * to that emulator. If `work` fails and the emulator turns out to be dead, that is
   * the same defect (the socket can close a moment before the `stopped:` line is
   * read). Nothing is retried and nothing is recorded.
   */
  async guard<T>(emu: Emulator, work: () => Promise<T>): Promise<T> {
    const running = work();
    const outcome = await Promise.race([
      running.then(
        (value) => ({ kind: 'done' as const, value }),
        (error: unknown) => ({ kind: 'threw' as const, error }),
      ),
      emu.whenDead().then((reason) => ({ kind: 'died' as const, reason })),
    ]);
    if (outcome.kind === 'done') return outcome.value;
    /* A failure while the emulator is (still) running is the work's own; if the
     * emulator was in fact dying, the audit after the row says so. */
    if (outcome.kind === 'threw' && emu.death === null) throw outcome.error;
    const cause = outcome.kind === 'threw' ? outcome.error : new Error(outcome.reason);
    await this.assertDelivery(cause);
    /* Unreachable in practice: a dead emulator is always a violation. Kept so a
     * change to the audit can never turn a death into a pass. */
    throw new InfrastructureDefect(this.entryId, await this.finish(), cause);
  }

  /** Throws `InfrastructureDefect` if any audited emulator lost or mis-delivered a reply. */
  async assertDelivery(cause?: unknown): Promise<void> {
    const audits = await this.finish();
    if (audits.some((a) => a.violations.length > 0)) {
      throw new InfrastructureDefect(this.entryId, audits, cause);
    }
  }

  /** Totals for the summary matrix. */
  totals(): {
    emulators: number;
    delivered: number;
    received: number;
    dropped: number;
    wire: WireTally;
  } {
    const audits = this.audits ?? [];
    return {
      emulators: audits.length,
      delivered: audits.reduce((n, a) => n + (a.server?.completions.delivered ?? 0), 0),
      received: audits.reduce((n, a) => n + a.client.repliesReceived, 0),
      dropped: audits.reduce((n, a) => n + (a.server?.completions.dropped ?? 0), 0),
      wire: audits.reduce((w, a) => addWire(w, a.wire), NO_WIRE),
    };
  }
}

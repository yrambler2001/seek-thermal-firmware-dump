/* ==================================================================== *
 * A dead emulator fails its row AT ONCE, as an `InfrastructureDefect`.
 *
 * WHY THIS FILE EXISTS (TESTING.md sec.15). On 2026-09-23 the Nano 300 rows
 * met an emulator that had faulted on the first vendor request, and the probe
 * went on asking a corpse: every reopen sat out its 20 s, the row took ~615 s,
 * and the fault was then pinned as the row's "known gap". Both were wrong. An
 * emulator that stops is a defect of the instrument, never a firmware result,
 * and the harness has to notice it the moment it happens.
 *
 * WHAT IS PROVED HERE, and how:
 *
 *  1. A FAULT LINE. A stand-in emulator (a few lines of Python, written below,
 *     that speaks just enough USB/IP to pass the harness's readiness check)
 *     prints `stopped:` / `fault:` exactly as `seek_emu.py --usbip` does and
 *     then stays alive. The row must fail on the LINE, while the process is
 *     still running, with the fault in the message.
 *  2. A STOP THE HARNESS ASKED FOR IS NOT A DEATH. The same stand-in, stopped by
 *     `RowEmulators` with SIGTERM, prints `stopping (SIGTERM)` first, as the
 *     real one does; the audit must pass.
 *  3. A KILL FROM OUTSIDE (another process's `pkill`): the stand-in stops in
 *     order and exits 0 without the harness having asked. The row must fail.
 *  4. THE REAL THING. A real emulator is SIGKILLed in the middle of a tier-1
 *     probe. The row must fail within half of one reopen timeout, and the probe
 *     it abandoned must itself unwind that fast (no reopen waits on a corpse).
 *     Skipped, loudly, when no emulator is available.
 * ==================================================================== */

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { SeekDevice } from '../src/protocol/client.js';
import { withTimeout } from '../src/protocol/webusb.js';
import { InfrastructureDefect, liveEmulatorCount, RowEmulators } from './emulator/harness.js';
import { probeTier1 } from './emulator/probe.js';
import { announceSkip, BOOT_TIMEOUT_MS, EMU_DIR, ENTRIES, scratchFile } from './emulator/suite.js';
import { REOPEN_TIMEOUT_MS } from './emulator/webusb-over-usbip.js';
import { fakeCamera } from './fake-transport.js';

/** Half of one reopen timeout: a row that noticed the death only by sitting out a
 *  reopen could not fail inside it. The old path took ~615 s. */
const FAST_MS = REOPEN_TIMEOUT_MS / 2;

/* ---- the stand-in emulator ------------------------------------------- */

/**
 * `seek_emu.py` for the harness, and nothing else: parse `--usbip-port`, answer
 * `OP_REQ_DEVLIST` with no devices, print the READY line, then behave as the mode
 * in `--corpus-entry fake/<mode>` says. Its output lines are the real emulator's
 * (FW-V1 seekemu/cli.py `run_usbip`, seekemu/report.py `report`).
 */
const FAKE_EMULATOR = String.raw`
import json, signal, socket, struct, sys, threading, time

argv = sys.argv
port = int(argv[argv.index('--usbip-port') + 1])
mode = argv[argv.index('--corpus-entry') + 1].split('/')[-1]

SUMMARY = {'reason': 'host script complete', 'sessions': 0, 'balanced': True,
           'completions': {'produced': 0, 'delivered': 0, 'dropped': 0, 'unresolved': 0},
           'dropped_by_reason': {},
           'urbs': {'submitted': 0, 'answered': 0, 'unlinked': 0, 'dropped': 0,
                    'outstanding': 0},
           'writers_alive': 0, 'writers_stuck': 0,
           'clock': {'records': 0, 'unheard': 0, 'failed': 0, 'hellos': 0,
                     'deadlines_set': 0, 'deadline_ms': None, 'deadline_expiries': 0}}

srv = socket.socket()
srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
srv.bind(('127.0.0.1', port))
srv.listen(8)

DEVICE = (b'/sys/devices/fake'.ljust(256, b'\0') + b'1-1'.ljust(32, b'\0')
          + struct.pack('>IIIHHHBBBBBB', 1, 2, 3, 0x289D, 0x0011, 0x0100, 0, 0, 0, 1, 1, 1))

def hang(conn):
    # 'hang': an import is accepted and every URB after it is read and never answered -
    # an emulator that is alive and stuck, which only the wall-clock watchdog can catch.
    SUMMARY['sessions'] += 1
    conn.sendall(struct.pack('>HHI', 0x0111, 0x0003, 0) + DEVICE)
    while conn.recv(4096):
        pass

def serve():
    while True:
        conn, _ = srv.accept()
        try:
            code = struct.unpack('>HHI', conn.recv(8))[1]
            if code == 0x8003 and mode == 'hang':
                conn.recv(32)
                threading.Thread(target=hang, args=(conn,), daemon=True).start()
                continue
            conn.sendall(struct.pack('>HHI', 0x0111, 0x0005, 0) + struct.pack('>I', 0))
            conn.close()
        except OSError:
            conn.close()

threading.Thread(target=serve, daemon=True).start()

# The device-time side channel (seekemu/usbip.py DeviceClockChannel): hello only - this
# device answers no URB, so it never has a record to write.
clk = socket.socket()
clk.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
clk.bind(('127.0.0.1', 0))
clk.listen(8)

def clock_serve():
    while True:
        conn, _ = clk.accept()
        def one(conn=conn):
            buf = b''
            while True:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                buf += chunk
                while b'\n' in buf:
                    line, buf = buf.split(b'\n', 1)
                    msg = json.loads(line)
                    if msg.get('op') == 'hello':
                        SUMMARY['clock']['hellos'] += 1
                        conn.sendall(b'{"hello":1,"now_ns":0,"deadline_ms":null}\n')
                    elif msg.get('op') == 'deadline':
                        SUMMARY['clock']['deadlines_set'] += 1
                        conn.sendall((json.dumps({'ack': msg['id'], 'deadline_ms': msg['ms']})
                                      + '\n').encode())
        threading.Thread(target=one, daemon=True).start()

threading.Thread(target=clock_serve, daemon=True).start()

def orderly_stop(sig, frame):
    print('\nstopping (SIGTERM) - the host script will finish its current URB', flush=True)
    print('\nstopped: host script complete', flush=True)
    print('---USBIP-SUMMARY--- ' + json.dumps(SUMMARY, sort_keys=True), flush=True)
    sys.exit(0)

signal.signal(signal.SIGTERM, orderly_stop)
print('---USBIP-READY--- ' + json.dumps({'port': port, 'busid': '1-1', 'bind': '127.0.0.1',
      'flash_out': None, 'flash_sha256': '0' * 64, 'source': 'stand-in', 'fill': None,
      'clock_port': clk.getsockname()[1], 'clock_protocol': 1}),
      flush=True)

if mode == 'fault':
    time.sleep(1.0)
    SUMMARY['reason'] = 'unmapped'
    print('\nstopped: unmapped', flush=True)
    print('---USBIP-SUMMARY--- ' + json.dumps(SUMMARY, sort_keys=True), flush=True)
    print('stopped: unmapped  PC=0x1000436C', flush=True)
    print('fault: unmapped addr=0x8808F3A2 at PC=0x1000436C', flush=True)
    signal.signal(signal.SIGTERM, signal.SIG_DFL)
    time.sleep(60)      # still alive: the harness must act on the LINE, not the exit
else:
    while True:
        time.sleep(0.2)
`;

function fakeEmulatorDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'seek-fake-emu-'));
  writeFileSync(path.join(dir, 'seek_emu.py'), FAKE_EMULATOR);
  return dir;
}

/** A piece of work that never settles by itself, like a probe waiting on a device. */
const forever = (): Promise<never> => new Promise<never>(() => undefined);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the guarded work to fail, and it succeeded');
}

describe('the harness fails a row the moment its emulator dies', () => {
  afterAll(() => {
    expect(liveEmulatorCount(), 'emulator processes still running at the end').toBe(0);
  });

  it('a fault line fails the row while the process is still alive', async () => {
    const row = new RowEmulators('fake/fault');
    try {
      const emu = await row.start(fakeEmulatorDir(), {
        entryId: 'fake/fault',
        readyTimeoutMs: 30_000,
      });
      let aliveWhenNoticed: boolean | null = null;
      void emu.whenDead().then(() => {
        aliveWhenNoticed = emu.alive;
      });
      const started = Date.now();
      const error = await rejection(row.guard(emu, forever));
      const elapsed = Date.now() - started;

      expect(error).toBeInstanceOf(InfrastructureDefect);
      const message = (error as Error).message;
      expect(message).toContain('INFRASTRUCTURE DEFECT on fake/fault');
      expect(message).toContain('fault: unmapped addr=0x8808F3A2 at PC=0x1000436C');
      expect(message).toContain('never a firmware result');
      expect(aliveWhenNoticed, 'noticed on the line, before the process exited').toBe(true);
      expect(elapsed, 'ms from the start of the work to the failed row').toBeLessThan(FAST_MS);
      const [audit] = await row.finish();
      expect(audit?.death).toContain('"stopped: unmapped" without having been asked to stop');
      expect(audit?.violations.join('\n')).toContain('fault: unmapped addr=0x8808F3A2');
    } finally {
      await row.finish();
    }
  }, 60_000);

  it('a stop the harness asked for is not a death', async () => {
    const row = new RowEmulators('fake/serve');
    try {
      const emu = await row.start(fakeEmulatorDir(), {
        entryId: 'fake/serve',
        readyTimeoutMs: 30_000,
      });
      const value = await row.guard(emu, async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        return 'measured';
      });
      expect(value).toBe('measured');
      await row.assertDelivery();
      const [audit] = await row.finish();
      expect(audit?.death).toBeNull();
      expect(audit?.violations).toEqual([]);
    } finally {
      await row.finish();
    }
  }, 60_000);

  it('a hung emulator is caught by the wall-clock watchdog, as an infrastructure defect', async () => {
    /* THE SAFETY NET (TESTING.md sec.19.4). Every deadline a transport sets runs on
     * the emulated camera's clock, and a stuck emulator reports no time, so none of
     * them can fire. The USB/IP client's per-URB wall-clock deadline still does -
     * and what it yields is a failed audit, never a measurement. */
    const row = new RowEmulators('fake/hang');
    try {
      const emu = await row.start(fakeEmulatorDir(), {
        entryId: 'fake/hang',
        readyTimeoutMs: 30_000,
      });
      const started = Date.now();
      const error = await rejection(row.guard(emu, () => emu.attach({ urbTimeoutMs: 2000 })));
      expect(Date.now() - started, 'ms until the watchdog ended the stuck transfer').toBeLessThan(
        FAST_MS,
      );
      expect(String(error)).toContain('timed out after 2000 ms');
      expect(emu.deviceClock.timeNs, "the camera's clock never moved").toBe(0);
      expect(emu.deviceClock.timersFired).toBe(0);
      const defect = await rejection(row.assertDelivery());
      expect(defect).toBeInstanceOf(InfrastructureDefect);
      expect((defect as Error).message).toContain(
        'USB/IP deadline(s) expired on the client against a live emulator',
      );
    } finally {
      await row.finish();
    }
  }, 60_000);

  it('a wait timed on the wall clock fails the row, as an infrastructure defect', async () => {
    /* THE WALL CLOCK'S TRIPWIRE (TESTING.md sec.20). A SeekDevice over a transport
     * with no clock falls back to WALL_CLOCK - its settle deadline on real time -
     * and so does a transport deadline raced without one. Either, while an
     * emulator runs, is a decision load could have moved. */
    const row = new RowEmulators('fake/serve');
    try {
      const emu = await row.start(fakeEmulatorDir(), {
        entryId: 'fake/serve',
        readyTimeoutMs: 30_000,
      });
      await row.guard(emu, async () => {
        const camera = fakeCamera({ requireMode0: true, initialMode: 1, modeSettleMs: 30 });
        await camera.open();
        await new SeekDevice(camera).ensureMode0();
        await withTimeout(Promise.resolve('answered'), 1000, 'a transfer');
      });
      const defect = await rejection(row.assertDelivery());
      expect(defect).toBeInstanceOf(InfrastructureDefect);
      const message = (defect as Error).message;
      expect(message).toContain('the toolkit timed a wait on the WALL clock');
      expect(message).toMatch(/[1-9]\d* read\(s\) of its time, 1 timer\(s\) on it/);
    } finally {
      await row.finish();
    }
  }, 60_000);

  it('a kill from outside fails the row even though the emulator stopped in order', async () => {
    const row = new RowEmulators('fake/serve');
    try {
      const emu = await row.start(fakeEmulatorDir(), {
        entryId: 'fake/serve',
        readyTimeoutMs: 30_000,
      });
      const guarded = rejection(row.guard(emu, forever));
      const killedAt = Date.now();
      process.kill(emu.pid!, 'SIGTERM');
      const error = await guarded;
      const elapsed = Date.now() - killedAt;

      expect(error).toBeInstanceOf(InfrastructureDefect);
      expect((error as Error).message).toContain('after a stop this harness did not ask for');
      expect(elapsed, 'ms from the kill to the failed row').toBeLessThan(FAST_MS);
    } finally {
      await row.finish();
    }
  }, 60_000);

  /* ---- a real emulator, killed in the middle of a tier-1 probe ---- */

  const REAL = 'compact_pro/2020.02.13-15.26.28-4.18.2.0-FF/090BB12PR939/dump';
  const entry = ENTRIES.find((e) => e.id === REAL) ?? ENTRIES.find((e) => e.kind === 'full-dump');
  if (EMU_DIR === null || entry === undefined) {
    announceSkip('fail-fast on a real emulator killed mid-probe');
  }

  it.skipIf(EMU_DIR === null || entry === undefined)(
    'a real emulator SIGKILLed mid-probe fails the row within half a reopen timeout',
    async () => {
      const id = entry!.id;
      const row = new RowEmulators(id);
      try {
        const truth = scratchFile(`failfast_${id}.bin`);
        const emu = await row.start(EMU_DIR!, {
          entryId: id,
          flashOut: truth,
          readyTimeoutMs: BOOT_TIMEOUT_MS,
        });
        let probe: Promise<unknown> | null = null;
        const guarded = rejection(
          row.guard(emu, () => {
            const p = probeTier1(emu, { groundTruthPath: truth });
            probe = p;
            return p;
          }),
        );

        /* Mid-row: the probe has had real answers, and has plenty left to ask. */
        const deadline = Date.now() + 120_000;
        while (emu.ledger.snapshot().repliesReceived < 20) {
          if (Date.now() > deadline) throw new Error('the probe never got 20 replies');
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        const killedAt = Date.now();
        process.kill(emu.pid!, 'SIGKILL');
        const error = await guarded;
        const elapsed = Date.now() - killedAt;

        expect(error).toBeInstanceOf(InfrastructureDefect);
        const message = (error as Error).message;
        expect(message).toContain(`INFRASTRUCTURE DEFECT on ${id}`);
        expect(message).toContain('signal SIGKILL');
        expect(elapsed, 'ms from the kill to the failed row').toBeLessThan(FAST_MS);

        /* ...and the probe it abandoned does not go on waiting out reopens: the
         * death aborted its adapter, so every transfer and reopen fails at once. */
        let settled = false;
        const abandoned = (probe as Promise<unknown> | null)?.then(
          () => (settled = true),
          () => (settled = true),
        );
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          abandoned,
          new Promise((resolve) => (timer = setTimeout(resolve, FAST_MS))),
        ]);
        clearTimeout(timer);
        expect(settled, `the abandoned probe settled within ${String(FAST_MS)} ms`).toBe(true);
      } finally {
        await row.finish();
      }
    },
    BOOT_TIMEOUT_MS + 180_000,
  );
});

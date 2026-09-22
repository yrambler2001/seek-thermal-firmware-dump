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
 * ==================================================================== */

import { type ChildProcess, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';

import { devlist } from './usbip-client.js';
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

export interface StartOptions {
  readonly entryId: string;
  /** `--fill-erased SEED`; omit to serve the vendored bytes unchanged. */
  readonly fillSeed?: number;
  readonly fillScope?: 'safe' | 'all';
  /** Where the emulator writes the as-booted 4 MiB image (the ground truth). */
  readonly flashOut?: string;
  /** How long to wait for the READY line. Boots are ~1-20 s; be generous. */
  readonly readyTimeoutMs?: number;
  readonly urbTimeoutMs?: number;
}

export class Emulator {
  readonly entryId: string;
  readonly ready: ReadyLine;
  private readonly child: ChildProcess;
  private readonly logLines: string[];
  private stopped = false;

  private constructor(entryId: string, child: ChildProcess, ready: ReadyLine, log: string[]) {
    this.entryId = entryId;
    this.child = child;
    this.ready = ready;
    this.logLines = log;
  }

  /** The emulator's own output. Attached to every failure, because the reason a
   *  firmware did not get somewhere is always in here. */
  log(tail = 40): string {
    return this.logLines.slice(-tail).join('\n');
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
      '--corpus-entry',
      options.entryId,
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

    const child = spawn(pythonFor(dir), argv, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    live.add(child);

    const lines: string[] = [];
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
        return new Emulator(options.entryId, child, ready, lines);
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
    return UsbIpWebUsbDevice.attach('127.0.0.1', this.ready.port, this.ready.busid, options);
  }

  /** Idempotent. Safe on a process that has already died. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    live.delete(this.child);
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    const gone = new Promise<void>((resolve) => {
      this.child.once('exit', () => {
        resolve();
      });
    });
    this.child.kill('SIGTERM');
    const timer = setTimeout(() => {
      this.child.kill('SIGKILL');
    }, 5000);
    await gone;
    clearTimeout(timer);
  }
}

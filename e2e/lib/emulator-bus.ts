/**
 * The FW-V1 emulator as a USB bus: one emulated camera at a time, served over
 * USB/IP by `seek_emu.py --usbip` through the core suites' own harness
 * (`Emulator`, `UsbIpWebUsbDevice` with the `chrome` host model — Chrome never
 * gives a WebUSB transfer up; the page's transport timer is the only deadline).
 *
 * THE REBOOT. On a real camera the wizard's wire-89 `ResetDevice` (payload
 * u16 0) reboots the part: it drops off the bus, boots from flash for about ten
 * seconds and re-enumerates as a new device, and Chrome — the camera has no
 * serial number — no longer knows it. The bus models that, and nothing else:
 * the reset transfer is NOT sent to the emulator; the current emulator is
 * stopped (the session closed first, so it stops politely and writes its
 * `.final` — every byte the firmware programmed), and a fresh one is booted
 * from that flash. The bridge sees a detach, then an attach of a NEW device.
 * Two things this avoids are properties of the emulator, not of the camera: a
 * wire-89 sent INTO the emulator orphans its own URB (a gated-clock emulator
 * never retires it), and the same server's post-reset window can wedge
 * (TESTING.md sec. 23.4) — the core suites boot a fresh server from the
 * committed part for exactly that reason.
 *
 * Every emulator the bus started is stopped and audited at `close()`.
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  Emulator,
  liveEmulatorCount,
  type DeliveryAudit,
} from '../../packages/core/test/emulator/harness.js';
import type { UsbIpWebUsbDevice } from '../../packages/core/test/emulator/webusb-over-usbip.js';
import { RESET_OP } from '../../packages/core/src/preservation/pipeline.js';
import { USB_TIMEOUT_MS } from '../../packages/core/src/protocol/ops.js';
import type { BusChange, BusDevice, UsbBus, Verdict } from './bridge.js';
import type { ControlSetup } from './protocol.js';

export interface EmulatorBusOptions {
  readonly emuDir: string;
  /** The corpus entry the first boot serves (`--corpus-entry`). */
  readonly entryId: string;
  /** The NOR's JEDEC id for every later boot (`--flash <file> --jedec`). */
  readonly jedec: string;
  /** Where every boot's `--flash-out` (and `.final`) lands. */
  readonly scratchDir: string;
  readonly log: (line: string) => void;
  readonly readyTimeoutMs?: number;
}

interface Boot {
  readonly index: number;
  readonly emu: Emulator;
  readonly flashOut: string;
  readonly from: string;
}

/** One emulator's delivery audit, split into what a browser host explains and what it does not. */
export interface BootAudit {
  readonly boot: number;
  readonly from: string;
  readonly audit: DeliveryAudit;
  /** Violations a browser host causes by design: Chrome times its transfers on
   *  real time, never on the emulated camera's clock. Reported, not failed. */
  readonly expected: readonly string[];
  readonly unexpected: readonly string[];
}

const BROWSER_HOST_VIOLATIONS = [
  /were not timed on the emulated camera's clock/,
  /timed a wait on the WALL clock/,
];

export class EmulatorBus implements UsbBus {
  readonly name = 'FW-V1 emulator (USB/IP)';
  /** Handed to the adapter per transfer; under the `chrome` host model the emulated
   *  host polls until the device answers (up to 60 s of the camera's time), and
   *  the page's own transport timer is the deadline, as in Chrome. */
  readonly hostTimeoutMs = USB_TIMEOUT_MS;
  readonly audits: BootAudit[] = [];
  readonly deaths: string[] = [];
  readonly reboots: { readonly boot: number; readonly ms: number; readonly from: string }[] = [];
  private readonly options: EmulatorBusOptions;
  private readonly listeners = new Set<(change: BusChange) => void>();
  private readonly boots: Boot[] = [];
  private current: BusDevice | null = null;
  private rebooting: Promise<void> | null = null;
  private stopping = false;
  /** The last reboot's failure, if one failed: the test checks it. */
  rebootFailure: unknown = null;

  private constructor(options: EmulatorBusOptions) {
    this.options = options;
    mkdirSync(options.scratchDir, { recursive: true });
  }

  static async start(options: EmulatorBusOptions): Promise<EmulatorBus> {
    const bus = new EmulatorBus(options);
    await bus.boot({ corpus: options.entryId });
    return bus;
  }

  present(): readonly BusDevice[] {
    return this.current === null ? [] : [this.current];
  }

  subscribe(listener: (change: BusChange) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Every boot so far: where it booted from and where its flash landed. */
  bootImages(): readonly {
    readonly index: number;
    readonly from: string;
    readonly flashOut: string;
  }[] {
    return this.boots.map(({ index, from, flashOut }) => ({ index, from, flashOut }));
  }

  /** The last boot's emulator log, for a failure message. */
  lastLog(tail = 60): string {
    return this.boots.at(-1)?.emu.log(tail) ?? '(no emulator was started)';
  }

  /** Resolves once a reboot in progress has finished (or failed). */
  async settled(): Promise<void> {
    await this.rebooting;
  }

  /**
   * The cable pulled: stop the current emulator and drop the device off the
   * bus, WITHOUT a wire reset — an external unplug, not the app's own reboot.
   * Any transfer in flight fails as the socket closes. `replug()` brings the
   * same flash back as a NEW device (a new key, so no grant carries over).
   */
  async unplug(): Promise<void> {
    await this.rebooting;
    const device = this.current;
    if (device === null) return;
    this.current = null;
    await (device.device as UsbIpWebUsbDevice).close().catch(() => undefined);
    const boot = this.boots.at(-1);
    this.emit({ kind: 'detach', device });
    if (boot !== undefined) await this.stopBoot(boot);
  }

  /** The cable plugged back in: boot a fresh emulator from the flash the last
   *  one held (its post-write `.final` when it wrote, else the as-booted image). */
  async replug(): Promise<void> {
    const boot = this.boots.at(-1);
    if (boot === undefined) throw new Error('nothing to replug — no emulator has booted');
    const final = `${boot.flashOut}.final`;
    await this.boot({ flash: existsSync(final) ? final : boot.flashOut });
  }

  check(
    device: BusDevice,
    direction: 'in' | 'out',
    setup: ControlSetup,
    data: Uint8Array | null,
  ): Verdict {
    if (direction !== 'out' || setup.request !== RESET_OP) return { kind: 'forward' };
    if (!(data?.length === 2 && data[0] === 0 && data[1] === 0)) {
      return {
        kind: 'refuse',
        why: 'ResetDevice with a non-zero payload arms the TIMER1 route, which the toolkit never sends',
      };
    }
    if (this.current?.key !== device.key) {
      return { kind: 'dropped', why: 'The device was disconnected.' };
    }
    this.beginReboot(device);
    return { kind: 'dropped', why: 'A transfer error has occurred. (the camera rebooted)' };
  }

  private emit(change: BusChange): void {
    for (const listener of [...this.listeners]) listener(change);
  }

  private async boot(
    source: { readonly corpus: string } | { readonly flash: string },
  ): Promise<void> {
    const index = this.boots.length;
    const flashOut = path.join(this.options.scratchDir, `boot-${String(index)}.bin`);
    const from = 'corpus' in source ? `corpus entry ${source.corpus}` : path.basename(source.flash);
    const t0 = Date.now();
    const emu = await Emulator.start(this.options.emuDir, {
      entryId: 'corpus' in source ? source.corpus : `flash:boot-${String(index)}`,
      readyTimeoutMs: this.options.readyTimeoutMs ?? 180_000,
      flashOut,
      ...('flash' in source ? { flashOverride: source.flash, jedec: this.options.jedec } : {}),
    });
    const boot: Boot = { index, emu, flashOut, from };
    this.boots.push(boot);
    void emu.whenDead().then((reason) => {
      if (this.stopping) return;
      this.deaths.push(`emulator ${String(index)}: ${reason}`);
      this.options.log(`[emu] emulator ${String(index)} DIED: ${reason}\n${emu.log(30)}`);
      if (this.current !== null && this.current.key === `emu-${String(index)}`) {
        const gone = this.current;
        this.current = null;
        this.emit({ kind: 'detach', device: gone });
      }
    });
    const device: UsbIpWebUsbDevice = await emu.attach({
      urbTimeoutMs: 30_000,
      hostModel: 'chrome',
    });
    /* A device the host has just enumerated is not open: the page opens it. */
    await device.close();
    this.options.log(
      `[emu] emulator ${String(index)} up in ${String(Date.now() - t0)} ms from ${from} ` +
        `(flash sha256 ${emu.ready.flash_sha256.slice(0, 16)}…): ` +
        `${device.productName ?? '?'} ${device.vendorId.toString(16)}:${device.productId.toString(16)}, ` +
        `serial ${device.serialNumber ?? 'none'}`,
    );
    const busDevice: BusDevice = {
      key: `emu-${String(index)}`,
      device,
      vendorId: device.vendorId,
      productId: device.productId,
      productName: device.productName,
      manufacturerName: device.manufacturerName,
      serialNumber: device.serialNumber,
    };
    this.current = busDevice;
    this.emit({ kind: 'attach', device: busDevice });
  }

  private async stopBoot(boot: Boot): Promise<void> {
    this.stopping = true;
    try {
      await boot.emu.stop();
    } finally {
      this.stopping = false;
    }
    const audit = boot.emu.auditDelivery();
    const expected = audit.violations.filter((v) =>
      BROWSER_HOST_VIOLATIONS.some((re) => re.test(v)),
    );
    const unexpected = audit.violations.filter((v) => !expected.includes(v));
    this.audits.push({ boot: boot.index, from: boot.from, audit, expected, unexpected });
  }

  private beginReboot(device: BusDevice): void {
    this.current = null;
    this.emit({ kind: 'detach', device });
    const boot = this.boots.at(-1);
    if (boot === undefined) return;
    const t0 = Date.now();
    this.rebooting = (async () => {
      await (device.device as UsbIpWebUsbDevice).close().catch(() => undefined);
      await this.stopBoot(boot);
      const final = `${boot.flashOut}.final`;
      const wrote = existsSync(final);
      const next = wrote ? final : boot.flashOut;
      this.options.log(
        `[emu] reboot: emulator ${String(boot.index)} stopped (${
          wrote ? 'the firmware wrote flash — booting from its .final' : 'flash unchanged'
        }); booting emulator ${String(boot.index + 1)}`,
      );
      await this.boot({ flash: next });
      this.reboots.push({ boot: boot.index + 1, ms: Date.now() - t0, from: path.basename(next) });
    })().catch((error: unknown) => {
      this.rebootFailure = error;
      this.options.log(
        `[emu] reboot FAILED: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  }

  /** Stops every emulator still running and audits it. Idempotent. */
  async close(): Promise<void> {
    await this.rebooting;
    const device = this.current;
    this.current = null;
    if (device !== null) {
      await (device.device as UsbIpWebUsbDevice).close().catch(() => undefined);
    }
    const audited = new Set(this.audits.map((a) => a.boot));
    for (const boot of this.boots) {
      if (!audited.has(boot.index)) await this.stopBoot(boot);
    }
  }

  /** The harness's own leak count: 0 once `close()` has run. */
  static liveCount(): number {
    return liveEmulatorCount();
  }
}

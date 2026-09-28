/* ==================================================================== *
 * Before the camera has said which firmware it runs, send only what every
 * firmware reads the same way.
 *
 * A wire id is an index into each build's OWN RPC method table, and the
 * tables differ: on Compact 0.3.0.1 wire id 0x52 — the id a dump, a sweep and
 * the capability probe all arm windows with — is `EnterBootloaderMode`, and
 * the selector-arm requests arm that build's firmware-upgrade stage instead of a
 * read window (FW-V1 Phase 47: it stays in the application). So until
 * `GetFirmwareInfo` has come back with a version, the toolkit may send ONLY
 * the commands that sit at the same wire id with the same name on EVERY image
 * in `test/firmware/facts.json`, and that are read handlers (getter column,
 * nothing in the setter column) on every one of them.
 *
 * This file derives that list from the facts, pins it, holds the toolkit's
 * `SAFE_BEFORE_IDENTITY` to it, and then checks every entry point that talks
 * to a camera — probe, dump, sweep, device info — against a camera whose
 * version does not come back. On the emulator, Compact 0.5.1.0 and 0.5.1.3
 * stall every request for a while after connecting (TESTING.md sec.10.4), so
 * this is a path the toolkit really takes.
 * ==================================================================== */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { hex } from '../src/bytes.js';
import { SeekError } from '../src/errors.js';
import { collectingReporter, silentReporter } from '../src/events.js';
import { SeekDevice } from '../src/protocol/client.js';
import { OP, OP_DIRECTION, SAFE_BEFORE_IDENTITY, type Opcode } from '../src/protocol/ops.js';
import type { DeviceDescription, TransportInfo, UsbTransport } from '../src/protocol/transport.js';
import { compact2016 } from '../src/profiles/compact-2016.js';
import { generic } from '../src/profiles/generic.js';
import { legacyAuth } from '../src/profiles/legacy-auth.js';
import { modern4x } from '../src/profiles/modern-4x.js';
import { detectProfile } from '../src/profiles/registry.js';
import type { FirmwareProfile } from '../src/profiles/types.js';
import {
  evidenceFromChannelProbe,
  identifyCamera,
  probeSelectorChannel,
  readRunningFirmware,
  VERSION_READ_ATTEMPTS,
  VERSION_READ_STARTUP_READS,
  VERSION_READ_STARTUP_SPACING_MS,
  VERSION_READ_STARTUP_WINDOW_MS,
} from '../src/workflows/capability.js';
import { readDeviceInfo } from '../src/workflows/device-info.js';
import { runDump } from '../src/workflows/dump.js';
import { runSweep } from '../src/workflows/sweep.js';
import type { WorkflowContext } from '../src/workflows/types.js';
import { planForDevice } from '../src/workflows/window-plan.js';
import { fakeCamera } from './fake-transport.js';
import facts from './firmware/facts.json' with { type: 'json' };

interface MethodColumns {
  readonly name: string;
  readonly getter: string | null;
  readonly setter: string | null;
}

interface ImageFact {
  readonly version: string;
  readonly rpcHandlers: readonly MethodColumns[] | null;
}

const IMAGES = Object.entries(facts.images as Record<string, ImageFact>);
const WIRE_ID_BASE = facts.wireIdBase;

/**
 * Every wire id that means the same READ on every image: the same name at the
 * same index of every build's method table, a getter, and no setter.
 *
 * Computed from the facts rather than written down, and then compared with the
 * pinned list below, so a regeneration of `facts.json` that adds an image with
 * a different table turns this red instead of quietly shrinking the list.
 */
function agreedReads(): ReadonlyMap<number, string> {
  const tables = IMAGES.map(([id, f]) => {
    if (f.rpcHandlers === null) throw new Error(`${id} has no recovered RPC table`);
    return f.rpcHandlers;
  });
  const longest = Math.max(...tables.map((t) => t.length));
  const out = new Map<number, string>();
  for (let index = 0; index < longest; index++) {
    const rows = tables.map((t) => t[index]);
    const first = rows[0];
    if (first === undefined) continue;
    const agreed = rows.every(
      (row) => row?.name === first.name && row.getter !== null && row.setter === null,
    );
    if (agreed) out.set(index + WIRE_ID_BASE, first.name);
  }
  return out;
}

/** The facts-derived list, pinned. A change here is a change in real firmware. */
const PINNED_AGREED_READS: readonly (readonly [number, string])[] = [
  [0x35, 'GetErrorCode'],
  [0x36, 'GetChipID'],
  [0x39, 'GetShutterPolarity'],
  [0x3d, 'GetOperationMode'],
  [0x3f, 'GetIPMode'],
  [0x41, 'GetDataPage'],
  [0x44, 'GetCurrentCmd'],
  [0x47, 'GetDefaultCmd'],
  [0x4d, 'GetRDAC'],
  [0x4e, 'GetFirmwareInfo'],
];

describe('the commands safe before identity, from facts.json', () => {
  it('walks all 36 images and finds exactly ten reads every one of them agrees on', () => {
    expect(IMAGES).toHaveLength(36);
    expect([...agreedReads()]).toEqual(PINNED_AGREED_READS);
  });

  it('holds SAFE_BEFORE_IDENTITY to that list, as control IN only', () => {
    const agreed = agreedReads();
    expect([...SAFE_BEFORE_IDENTITY].sort((a, b) => a - b)).toEqual([
      OP.GET_ERROR_CODE,
      OP.GET_OPERATION_MODE,
      OP.GET_FIRMWARE_INFO,
    ]);
    for (const op of SAFE_BEFORE_IDENTITY) {
      expect(agreed.has(op), `${hex(op)} is agreed on by every image`).toBe(true);
      expect(OP_DIRECTION[op], `${hex(op)} is sent as a control IN`).toBe('in');
    }
  });

  it('leaves out every id whose meaning or column changes between builds', () => {
    const agreed = agreedReads();
    /* 0x52 is EnterBootloaderMode on 0.3.0.1; 0x4F is UploadFirmwareRowSize
     * (setter) before 0.7 and a setter-only GetFeaturedFirmwareData on 0.7.0.x;
     * 0x3C and 0x55 are the same name everywhere but setters. */
    for (const op of [
      OP.BEGIN_FIRMWARE_UPGRADE,
      OP.GET_FEATURED_FIRMWARE_DATA,
      OP.SET_OPERATION_MODE,
      OP.SET_FIRMWARE_INFO_FEATURES,
      OP.SET_FEATURED_FIRMWARE_DATA,
      OP.COMPLETE_MEMORY_UPGRADE,
      OP.SET_RAM_DATA_FEATURES,
    ]) {
      expect(agreed.has(op), hex(op)).toBe(false);
    }
  });
});

/* ---- cameras that do not say what they are --------------------------- */

/** Every request stalls — what 0.5.1.0 and 0.5.1.3 do on the emulator after connecting. */
class RefusesEverything implements UsbTransport {
  readonly calls: { direction: 'in' | 'out'; op: number }[] = [];
  private opened = false;
  get description(): DeviceDescription {
    return {
      vendorId: 0x289d,
      productId: 0x0010,
      productName: 'PIR206 Thermal Camera',
      manufacturerName: 'Seek Thermal',
      serialNumber: null,
    };
  }
  get info(): TransportInfo {
    return {
      api: 'test',
      recipient: 'interface',
      interfaceNumber: 0,
      claimedInterface: this.opened,
      host: null,
      recipientFallback: null,
    };
  }
  get isOpen(): boolean {
    return this.opened;
  }
  open(): Promise<void> {
    this.opened = true;
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.opened = false;
    return Promise.resolve();
  }
  controlIn(request: number): Promise<Uint8Array> {
    this.calls.push({ direction: 'in', op: request });
    return Promise.reject(new SeekError('usb/stalled', `control IN ${hex(request)} -> stall`));
  }
  controlOut(request: number): Promise<void> {
    this.calls.push({ direction: 'out', op: request });
    return Promise.reject(new SeekError('usb/stalled', `control OUT ${hex(request)} -> stall`));
  }
}

/** A camera that answers everything but GetFirmwareInfo, which stalls. */
function versionless(): ReturnType<typeof fakeCamera> {
  return fakeCamera({ initialMode: 0, fwInfo: new Map() });
}

interface Recorded {
  readonly calls: readonly { direction: 'in' | 'out'; op: number }[];
}

/** Every request went out as a control IN of an id every image reads the same way. */
function expectOnlyAgreedReads(camera: Recorded, what: string): void {
  const agreed = agreedReads();
  expect(camera.calls.length, `${what}: something was asked`).toBeGreaterThan(0);
  for (const call of camera.calls) {
    const label = `${what}: ${call.direction.toUpperCase()} ${hex(call.op)}`;
    expect(call.direction, label).toBe('in');
    expect(agreed.has(call.op), label).toBe(true);
    expect(SAFE_BEFORE_IDENTITY.has(call.op as Opcode), label).toBe(true);
  }
  expect(
    camera.calls.some((c) => c.op === OP.BEGIN_FIRMWARE_UPGRADE),
    `${what}: an arm (0x52) was sent`,
  ).toBe(false);
}

async function contextFor(
  profile: FirmwareProfile,
  camera: UsbTransport,
): Promise<WorkflowContext> {
  await camera.open();
  return {
    device: new SeekDevice(camera, { reporter: silentReporter }),
    profile,
    detection: null,
    reporter: silentReporter,
  };
}

async function refusal(run: () => Promise<unknown>): Promise<SeekError> {
  const error = await run().then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SeekError);
  return error as SeekError;
}

function expectVersionRefusal(error: SeekError, operation: string): void {
  expect(error.code).toBe('device/version-unknown');
  expect(error.message).toContain(`refusing to ${operation}`);
  expect(error.message).toContain('did not report its firmware version');
  expect(error.message).toContain('EnterBootloaderMode');
}

/* Each camera here STALLs every GetFirmwareInfo, so each version read waits out
 * the whole start-up window on the real clock (VERSION_READ_STARTUP_WINDOW_MS,
 * 500 ms), and a test that tries four profiles waits four times. */
describe('a camera whose firmware version cannot be read', { timeout: 20_000 }, () => {
  it('is probed with GetFirmwareInfo only: no arm, no mode change', async () => {
    const camera = versionless();
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));

    expect(probe.firmwareVersion).toBeNull();
    expect(probe.skippedForSafety).toBe(true);
    expect(probe.plainAccepted).toBe(false);
    expect(probe.notes.join(' ')).toContain('did not report its firmware version');
    /* Every read STALLs, which is what a camera still starting up answers, so
     * the version read uses its whole start-up window: exactly
     * VERSION_READ_STARTUP_READS reads of GetFirmwareInfo, and nothing else. */
    expect(camera.calls.map((c) => c.op)).toEqual(
      Array.from({ length: VERSION_READ_STARTUP_READS }, () => OP.GET_FIRMWARE_INFO),
    );
  });

  it('cannot hand legacy-auth a "refused plain arm" it never observed', async () => {
    /* The 0.5.1.x shape: every request stalls. The old probe sent the plain arm
     * anyway, read the stall as "the legacy lock refused it", and legacy-auth
     * won detection on that alone. */
    const camera = new RefusesEverything();
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));
    const evidence = evidenceFromChannelProbe(probe);

    expect(evidence.plainSelectorRefused).toBeUndefined();
    expect(evidence.authSelectorWorks).toBeUndefined();
    expect(detectProfile(evidence).best.profile.id).not.toBe('legacy-auth');
    expectOnlyAgreedReads(camera, 'probe');
  });

  it('is refused by runDump under every profile that dumps, before anything is armed', async () => {
    for (const profile of [modern4x, legacyAuth, compact2016, generic]) {
      const camera = versionless();
      const error = await refusal(async () =>
        runDump(await contextFor(profile, camera), { chunk: 4096, decrypt: false }),
      );
      expectVersionRefusal(error, 'dump');
      expectOnlyAgreedReads(camera, `dump under ${profile.id}`);
    }
  });

  it('is refused by runSweep, before anything is armed', async () => {
    for (const profile of [modern4x, legacyAuth, generic]) {
      const camera = versionless();
      const error = await refusal(async () =>
        runSweep(await contextFor(profile, camera), { chunk: 4096, decrypt: false }),
      );
      expectVersionRefusal(error, 'sweep');
      expectOnlyAgreedReads(camera, `sweep under ${profile.id}`);
    }
  });

  it('is refused by readDeviceInfo, which used to send SetFirmwareInfoFeatures and arm', async () => {
    for (const profile of [modern4x, legacyAuth, generic]) {
      const camera = versionless();
      const error = await refusal(async () =>
        readDeviceInfo(await contextFor(profile, camera), { chunk: 4096 }),
      );
      expectVersionRefusal(error, 'read the device info');
      expectOnlyAgreedReads(camera, `device info under ${profile.id}`);
    }
  });

  it('is refused on the 0.5.1.x shape too, where every request stalls', async () => {
    const dump = new RefusesEverything();
    expectVersionRefusal(
      await refusal(async () => runDump(await contextFor(legacyAuth, dump), { decrypt: false })),
      'dump',
    );
    expectOnlyAgreedReads(dump, 'dump');

    const info = new RefusesEverything();
    expectVersionRefusal(
      await refusal(async () => readDeviceInfo(await contextFor(modern4x, info))),
      'read the device info',
    );
    expectOnlyAgreedReads(info, 'device info');
  });

  it('counts a version answer shorter than four bytes as no version', async () => {
    const camera = fakeCamera({ initialMode: 0, fwInfo: new Map([[0, Uint8Array.of(4, 18)]]) });
    const error = await refusal(async () =>
      runDump(await contextFor(modern4x, camera), { chunk: 4096, decrypt: false }),
    );
    expectVersionRefusal(error, 'dump');
    expectOnlyAgreedReads(camera, 'dump');
  });
});

describe('a camera whose version says the ids mean something else', () => {
  it('is refused by readDeviceInfo under a forced profile, as a dump already was', async () => {
    /* readDeviceInfo arms the boot config, the bootloader block and the slots
     * with 0x52, which on 0.3.0.1 is EnterBootloaderMode. It never looked at
     * the version before; now it goes through the same gate as a dump. */
    const block = new Uint8Array(36);
    block.set([0, 3, 0, 1], 0);
    const camera = fakeCamera({ initialMode: 0, fwInfo: new Map([[0, block]]) });
    const error = await refusal(async () => readDeviceInfo(await contextFor(modern4x, camera)));
    expect(error.code).toBe('profile/unsupported');
    expect(error.message).toContain('refusing to read the device info: firmware 0.3.0.1 predates');
    expect(camera.calls.map((c) => c.op)).toEqual([OP.GET_FIRMWARE_INFO, OP.GET_FIRMWARE_INFO]);
  });
});

/* ---- a camera an earlier program left with the info selector set ------ */

/** GetFirmwareInfo record: four version bytes, then a date string. */
function infoRecord(version: readonly [number, number, number, number], date: string): Uint8Array {
  const out = new Uint8Array(36);
  out.set(version, 0);
  out.set(new TextEncoder().encode(date), 4);
  return out;
}

/**
 * Compact 4.8.1.7 as the emulator runs it: record 0 is the application's build
 * block, record 1 the bootloader's (`2.0.2.3`, which is what a single unarmed
 * read returned on the emulator after the probe's SetFirmwareInfoFeatures(1),
 * TESTING.md sec.11.8).
 */
function compact4817(): ReturnType<typeof fakeCamera> {
  return fakeCamera({
    initialMode: 0,
    fwInfo: new Map([
      [0, infoRecord([4, 8, 1, 7], 'Sep  4 2018 15:36:50')],
      [1, infoRecord([2, 0, 2, 3], 'Feb 26 2020 11:23:26')],
    ]),
  });
}

/**
 * What another program — or an interrupted run of this one — leaves behind:
 * `SetFirmwareInfoFeatures(n)` with no read after it. The selector is one u16
 * in the camera's RAM; closing the device does not clear it (the fake keeps it
 * across close/open, as the firmware keeps it across a USB re-open).
 */
async function leaveSelectorAt(camera: ReturnType<typeof fakeCamera>, sel: number): Promise<void> {
  await camera.open();
  await new SeekDevice(camera).rpcOut(OP.SET_FIRMWARE_INFO_FEATURES, Uint8Array.of(sel, 0));
  await camera.close();
  camera.calls.length = 0;
}

/** Drops the first `count` GetFirmwareInfo requests before the camera sees them: a lost SETUP. */
class LosesFirstVersionReads implements UsbTransport {
  private readonly inner: UsbTransport;
  private remaining: number;
  constructor(inner: UsbTransport, count: number) {
    this.inner = inner;
    this.remaining = count;
  }
  get description(): DeviceDescription {
    return this.inner.description;
  }
  get info(): TransportInfo {
    return this.inner.info;
  }
  get isOpen(): boolean {
    return this.inner.isOpen;
  }
  open(): Promise<void> {
    return this.inner.open();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  controlIn(request: number, length: number, timeoutMs: number): Promise<Uint8Array> {
    if (request === OP.GET_FIRMWARE_INFO && this.remaining > 0) {
      this.remaining -= 1;
      return Promise.reject(new SeekError('usb/timeout', 'control IN 0x4e: no answer in 5000 ms'));
    }
    return this.inner.controlIn(request, length, timeoutMs);
  }
  controlOut(request: number, data: Uint8Array, timeoutMs: number): Promise<void> {
    return this.inner.controlOut(request, data, timeoutMs);
  }
}

describe('a camera an earlier command left with the firmware-info selector set', () => {
  it("reads the application's version, not the record the selector was left on", async () => {
    const camera = compact4817();
    await leaveSelectorAt(camera, 1);
    await camera.open();
    const running = await readRunningFirmware(new SeekDevice(camera));

    expect(running.version).toBe('4.8.1.7');
    expect(running.buildString).toBe('Sep  4 2018 15:36:50');
    expect(running.note).toContain('the first read answered a different record (2.0.2.3)');
    /* Two unarmed reads, nothing else: both inside SAFE_BEFORE_IDENTITY. */
    expect(camera.calls).toEqual([
      { direction: 'in', op: OP.GET_FIRMWARE_INFO, length: 36 },
      { direction: 'in', op: OP.GET_FIRMWARE_INFO, length: 36 },
    ]);
  });

  it('hands the probe and the planner that version too', async () => {
    const probeCamera = compact4817();
    await leaveSelectorAt(probeCamera, 1);
    await probeCamera.open();
    const probe = await probeSelectorChannel(new SeekDevice(probeCamera));
    expect(probe.firmwareVersion).toBe('4.8.1.7');

    const planCamera = compact4817();
    await leaveSelectorAt(planCamera, 1);
    const { firmware, plan } = await planForDevice(await contextFor(modern4x, planCamera), 'dump');
    expect(firmware.version).toBe('4.8.1.7');
    expect(plan.firmwareVersion).toBe('4.8.1.7');
  });

  it('cannot open the gate on 0.3.0.1 with a record that happens to parse as a later version', async () => {
    /* The safety case. On 0.3.0.1 wire id 0x52 is EnterBootloaderMode. If the
     * version read believed a stale record — here the bootloader's 2.0.2.3 —
     * identityGate would permit arming and the probe would send 0x52. */
    const camera = fakeCamera({
      initialMode: 0,
      fwInfo: new Map([
        [0, infoRecord([0, 3, 0, 1], 'May  3 2014 10:42:49')],
        [1, infoRecord([2, 0, 2, 3], 'Feb 26 2020 11:23:26')],
      ]),
    });
    await leaveSelectorAt(camera, 1);
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));

    expect(
      camera.calls.filter((c) => c.op === OP.BEGIN_FIRMWARE_UPGRADE).length,
      'arms (0x52, EnterBootloaderMode on 0.3.0.1) sent by the probe',
    ).toBe(0);
    expect(probe.firmwareVersion).toBe('0.3.0.1');
    expect(probe.skippedForSafety).toBe(true);
    expectOnlyAgreedReads(camera, 'probe of 0.3.0.1 with a stale selector');

    await leaveSelectorAt(camera, 1);
    const error = await refusal(async () =>
      runDump(await contextFor(modern4x, camera), { chunk: 4096, decrypt: false }),
    );
    expect(error.code).toBe('profile/unsupported');
    expect(error.message).toContain('firmware 0.3.0.1 predates');
    expectOnlyAgreedReads(camera, 'dump of 0.3.0.1 with a stale selector');
  });

  it('counts only an ANSWERED read as clearing the selector', async () => {
    /* A lost first read proves nothing: the camera may never have taken the
     * SETUP, so the next answer can still be the stale record. */
    const camera = compact4817();
    await leaveSelectorAt(camera, 1);
    await camera.open();
    const running = await readRunningFirmware(
      new SeekDevice(new LosesFirstVersionReads(camera, 1)),
    );
    expect(running.version).toBe('4.8.1.7');
    expect(running.note).toContain('(2.0.2.3)');
    /* The camera saw two reads: the stale answer, then the build block. */
    expect(camera.calls.map((c) => c.op)).toEqual([OP.GET_FIRMWARE_INFO, OP.GET_FIRMWARE_INFO]);
  });

  it('gives up after two failures in a row, and after the attempt budget', async () => {
    const lost = compact4817();
    await lost.open();
    const twice = await readRunningFirmware(new SeekDevice(new LosesFirstVersionReads(lost, 2)));
    expect(twice.version).toBeNull();
    expect(twice.note).toContain('did not answer');
    expect(lost.calls).toHaveLength(0);

    /* answered, lost, answered, lost: never two answers in a row. */
    class Alternating extends LosesFirstVersionReads {
      private n = 0;
      override controlIn(request: number, length: number, timeoutMs: number): Promise<Uint8Array> {
        this.n += 1;
        return this.n % 2 === 0
          ? Promise.reject(new SeekError('usb/timeout', 'control IN 0x4e: no answer in 5000 ms'))
          : super.controlIn(request, length, timeoutMs);
      }
    }
    const flaky = compact4817();
    await flaky.open();
    const alternating = await readRunningFirmware(new SeekDevice(new Alternating(flaky, 0)));
    expect(alternating.version).toBeNull();
    expect(alternating.note).toContain('never two in a row');
    expect(flaky.calls).toHaveLength(VERSION_READ_ATTEMPTS / 2);
  });
});

/* ---- a camera that is still starting up ------------------------------- */

/** One request as the starting camera saw it, and whether it was refused. */
interface StartupCall {
  readonly direction: 'in' | 'out';
  readonly op: number;
  readonly refused: boolean;
  /** `Date.now()` when the request arrived: the fake clock in these tests. */
  readonly at: number;
}

/**
 * A camera whose firmware is still in its init states: the dispatcher STALLs
 * every request, whatever it is ("Request sent during FW init"), and then
 * serves them all. Two clocks, as in TESTING.md sec.18:
 *
 * - `refusedRequests: n`: the emulator's gated clock. The device moves on only
 *   while a request is outstanding, so its start-up ends after n requests,
 *   however long the host sleeps between them. Compact 1.3.0.8 on the
 *   emulator refuses at +1..+9 ms and answers at +10 ms, one interrupt
 *   threshold (~1 ms) a request: nine refused requests.
 * - `startsAfterMs: t`: a real camera's own clock. Its start-up ends t ms after
 *   it was plugged in, whatever the host sends.
 */
class StartingCamera implements UsbTransport {
  readonly calls: StartupCall[] = [];
  private readonly inner: UsbTransport;
  private readonly startsAt: number;
  private refusalsLeft: number;
  constructor(
    inner: UsbTransport,
    start: { readonly refusedRequests: number } | { readonly startsAfterMs: number },
  ) {
    this.inner = inner;
    this.startsAt = 'startsAfterMs' in start ? Date.now() + start.startsAfterMs : -Infinity;
    this.refusalsLeft = 'refusedRequests' in start ? start.refusedRequests : 0;
  }
  get description(): DeviceDescription {
    return this.inner.description;
  }
  get info(): TransportInfo {
    return this.inner.info;
  }
  get isOpen(): boolean {
    return this.inner.isOpen;
  }
  open(): Promise<void> {
    return this.inner.open();
  }
  close(): Promise<void> {
    return this.inner.close();
  }
  controlIn(request: number, length: number, timeoutMs: number): Promise<Uint8Array> {
    if (this.starting('in', request)) {
      return Promise.reject(new SeekError('usb/stalled', `control IN ${hex(request)} -> stall`));
    }
    return this.inner.controlIn(request, length, timeoutMs);
  }
  controlOut(request: number, data: Uint8Array, timeoutMs: number): Promise<void> {
    if (this.starting('out', request)) {
      return Promise.reject(new SeekError('usb/stalled', `control OUT ${hex(request)} -> stall`));
    }
    return this.inner.controlOut(request, data, timeoutMs);
  }
  /** The requests sent before the first one the camera served. */
  get sentWhileStarting(): readonly StartupCall[] {
    const served = this.calls.findIndex((call) => !call.refused);
    return served === -1 ? this.calls : this.calls.slice(0, served);
  }
  private starting(direction: 'in' | 'out', op: number): boolean {
    const at = Date.now();
    const refused = this.refusalsLeft > 0 || at < this.startsAt;
    if (this.refusalsLeft > 0) this.refusalsLeft -= 1;
    this.calls.push({ direction, op, refused, at });
    return refused;
  }
}

/** The warnings the version read logged, one per retry of its start-up window. */
function startupWarnings(reporter: ReturnType<typeof collectingReporter>): string[] {
  return reporter.events.flatMap((event) =>
    event.type === 'log' && event.level === 'warn' && event.message.includes('starting up')
      ? [event.message]
      : [],
  );
}

/** Runs `run` to completion on the fake clock, whatever it waits for. */
async function onFakeClock<T>(run: () => Promise<T>): Promise<T> {
  const settled = run().then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  await vi.runAllTimersAsync();
  const outcome = await settled;
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

describe('a camera still starting up, which refuses every request for a while', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('is identified when it answers inside the window on the gated clock (Compact 1.3.0.8 on the emulator)', async () => {
    const camera = new StartingCamera(compact4817(), { refusedRequests: 9 });
    await camera.open();
    const reporter = collectingReporter();
    const identification = await onFakeClock(() =>
      identifyCamera(new SeekDevice(camera, { reporter })),
    );

    expect(identification.gate).toEqual({ permitsArming: true, version: '4.8.1.7' });
    expect(identification.probe.notes[0]).toContain(
      'it answered after refusing 9 read(s) while starting up',
    );
    /* Nine refused GetFirmwareInfo, then the two answered ones, then the probe's arms. */
    expect(camera.sentWhileStarting.map((c) => c.op)).toEqual(
      Array.from({ length: 9 }, () => OP.GET_FIRMWARE_INFO),
    );
    expect(camera.calls.slice(9, 11).map((c) => [c.op, c.refused])).toEqual([
      [OP.GET_FIRMWARE_INFO, false],
      [OP.GET_FIRMWARE_INFO, false],
    ]);
    /* Every retry was reported, and the first answer ended the waiting at once. */
    expect(startupWarnings(reporter)).toHaveLength(9);
    expect(startupWarnings(reporter)[0]).toContain(
      `read 1 of up to ${String(VERSION_READ_STARTUP_READS)}`,
    );
    expect(camera.calls[10]?.at).toBe(camera.calls[9]?.at);
  });

  it('is identified when it answers inside the window on its own clock', async () => {
    const camera = new StartingCamera(compact4817(), { startsAfterMs: 300 });
    await camera.open();
    const reporter = collectingReporter();
    const identification = await onFakeClock(() =>
      identifyCamera(new SeekDevice(camera, { reporter })),
    );

    expect(identification.gate).toEqual({ permitsArming: true, version: '4.8.1.7' });
    /* Refused at 0, 20, ..., 280 ms; answered at 300 ms. */
    expect(camera.sentWhileStarting.map((c) => c.at - (camera.calls[0]?.at ?? 0))).toEqual(
      Array.from({ length: 15 }, (_, i) => i * VERSION_READ_STARTUP_SPACING_MS),
    );
    expect(startupWarnings(reporter)).toHaveLength(15);
  });

  it('is refused after the window when it never answers, having waited it out', async () => {
    const camera = new StartingCamera(compact4817(), { refusedRequests: Infinity });
    await camera.open();
    const reporter = collectingReporter();
    const identification = await onFakeClock(() =>
      identifyCamera(new SeekDevice(camera, { reporter })),
    );

    expect(identification.gate.permitsArming).toBe(false);
    if (identification.gate.permitsArming) return;
    expect(identification.gate.code).toBe('device/version-unknown');
    expect(identification.gate.reason).toContain(
      `on any of ${String(VERSION_READ_STARTUP_READS)} reads`,
    );
    expect(camera.calls).toHaveLength(VERSION_READ_STARTUP_READS);
    /* 500 ms on the camera's clock from the first read to the last. */
    expect(VERSION_READ_STARTUP_WINDOW_MS).toBe(500);
    expect((camera.calls.at(-1)?.at ?? 0) - (camera.calls[0]?.at ?? 0)).toBe(
      VERSION_READ_STARTUP_WINDOW_MS,
    );
    expect(startupWarnings(reporter)).toHaveLength(VERSION_READ_STARTUP_READS - 1);
  });

  it('sends nothing but GetFirmwareInfo during the window, from every entry point', async () => {
    const window = Array.from({ length: VERSION_READ_STARTUP_READS }, () => ({
      direction: 'in',
      op: OP.GET_FIRMWARE_INFO,
    }));
    const sent = (camera: StartingCamera): { direction: string; op: number }[] =>
      camera.calls.map(({ direction, op }) => ({ direction, op }));

    const probe = new StartingCamera(compact4817(), { refusedRequests: Infinity });
    await probe.open();
    await onFakeClock(() => probeSelectorChannel(new SeekDevice(probe)));
    expect(sent(probe), 'probe').toEqual(window);

    const entryPoints: readonly (readonly [string, (ctx: WorkflowContext) => Promise<unknown>])[] =
      [
        ['dump', (ctx) => runDump(ctx, { chunk: 4096, decrypt: false })],
        ['sweep', (ctx) => runSweep(ctx, { chunk: 4096, decrypt: false })],
        ['read the device info', (ctx) => readDeviceInfo(ctx, { chunk: 4096 })],
      ];
    for (const [what, run] of entryPoints) {
      const camera = new StartingCamera(compact4817(), { refusedRequests: Infinity });
      const ctx = await contextFor(modern4x, camera);
      const error = await refusal(() => onFakeClock(() => run(ctx)));
      expectVersionRefusal(error, what);
      expect(sent(camera), what).toEqual(window);
    }
  });

  it('reads through the window even when the run was cancelled before it began', async () => {
    /* The emulator's first-contact instrument runs the dump with its signal
     * already aborted, so that a dump that plans stops before its first arm
     * (TESTING.md sec.11.1). The version read must still give its own answer
     * there: the wait is bounded and does not consult the signal. */
    const camera = new StartingCamera(compact4817(), { refusedRequests: Infinity });
    await camera.open();
    const abort = new AbortController();
    abort.abort();
    const ctx: WorkflowContext = {
      device: new SeekDevice(camera, { reporter: silentReporter, signal: abort.signal }),
      profile: modern4x,
      detection: null,
      reporter: silentReporter,
    };
    const error = await refusal(() =>
      onFakeClock(() => runDump(ctx, { chunk: 4096, decrypt: false })),
    );
    expectVersionRefusal(error, 'dump');
    expect(camera.calls).toHaveLength(VERSION_READ_STARTUP_READS);
  });
});

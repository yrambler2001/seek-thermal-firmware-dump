/* ==================================================================== *
 * Before the camera has said which firmware it runs, send only what every
 * firmware reads the same way.
 *
 * A wire id is an index into each build's OWN RPC method table, and the
 * tables differ: on Compact 0.3.0.1 wire id 0x52 — the id a dump, a sweep and
 * the capability probe all arm windows with — is `EnterBootloaderMode`, and
 * the selector-arm requests mean "leave the application". So until
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

import { describe, expect, it } from 'vitest';

import { hex } from '../src/bytes.js';
import { SeekError } from '../src/errors.js';
import { silentReporter } from '../src/events.js';
import { SeekDevice } from '../src/protocol/client.js';
import { OP, OP_DIRECTION, SAFE_BEFORE_IDENTITY, type Opcode } from '../src/protocol/ops.js';
import type { DeviceDescription, TransportInfo, UsbTransport } from '../src/protocol/transport.js';
import { compact2016 } from '../src/profiles/compact-2016.js';
import { generic } from '../src/profiles/generic.js';
import { legacyAuth } from '../src/profiles/legacy-auth.js';
import { modern4x } from '../src/profiles/modern-4x.js';
import { detectProfile } from '../src/profiles/registry.js';
import type { FirmwareProfile } from '../src/profiles/types.js';
import { evidenceFromChannelProbe, probeSelectorChannel } from '../src/workflows/capability.js';
import { readDeviceInfo } from '../src/workflows/device-info.js';
import { runDump } from '../src/workflows/dump.js';
import { runSweep } from '../src/workflows/sweep.js';
import type { WorkflowContext } from '../src/workflows/types.js';
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

describe('a camera whose firmware version cannot be read', () => {
  it('is probed with GetFirmwareInfo only: no arm, no mode change', async () => {
    const camera = versionless();
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));

    expect(probe.firmwareVersion).toBeNull();
    expect(probe.skippedForSafety).toBe(true);
    expect(probe.plainAccepted).toBe(false);
    expect(probe.notes.join(' ')).toContain('did not report its firmware version');
    expect(camera.calls.map((c) => c.op)).toEqual([OP.GET_FIRMWARE_INFO]);
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
    expect(camera.calls.map((c) => c.op)).toEqual([OP.GET_FIRMWARE_INFO]);
  });
});

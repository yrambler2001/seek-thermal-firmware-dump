/* ==================================================================== *
 * The capability probe: what it asks, what it refuses to ask, and what
 * the answers are allowed to decide.
 *
 * The probe is the one place in this toolkit that sends something to a camera
 * in order to find out what the camera is, so its two obligations are opposite
 * and both need testing: it has to ask enough to tell the families apart, and
 * it has to send NOTHING at all to a build where the opcode it would use means
 * something else.
 * ==================================================================== */

import { describe, expect, it } from 'vitest';

import { SeekDevice } from '../src/protocol/client.js';
import { OP, READ_ONLY_OPS } from '../src/protocol/ops.js';
import { detectProfile } from '../src/profiles/registry.js';
import { OLD_FW_UNLOCK_TOKEN } from '../src/profiles/legacy-auth.js';
import {
  evidenceFromChannelProbe,
  predatesDumpProtocol,
  PROBE_OPEN_SUBCMD,
  PROBE_PROTECTED_SUBCMD,
  probeSelectorChannel,
} from '../src/workflows/capability.js';
import { fakeCamera, type FakeCameraOptions } from './fake-transport.js';

/** `GetFirmwareInfo` selector 0: four version bytes then the build string. */
function buildBlock(
  version: readonly [number, number, number, number],
  date = 'Jan  1 2020',
): Uint8Array {
  const out = new Uint8Array(36);
  out.set(version, 0);
  out.set(new TextEncoder().encode(date), 4);
  return out;
}

function cameraFor(
  version: readonly [number, number, number, number],
  extra: FakeCameraOptions = {},
): ReturnType<typeof fakeCamera> {
  return fakeCamera({
    initialMode: 0,
    fwInfo: new Map([[0, buildBlock(version)]]),
    ...extra,
  });
}

describe('probeSelectorChannel', () => {
  it('reads the version and separates the plain channel from the authenticated one', async () => {
    /* A modern camera: every bank opens on the plain 2-byte selector, and the
     * 18-byte form arms it too because that handler has no token check. */
    const camera = cameraFor([4, 18, 2, 0]);
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));

    expect(probe.firmwareVersion).toBe('4.18.2.0');
    expect(probe.buildString).toBe('Jan  1 2020');
    expect(probe.plainAccepted).toBe(true);
    expect(probe.authAccepted).toBe(true);
    expect(probe.openWindowReadable).toBe(true);
    expect(probe.skippedForSafety).toBe(false);
  });

  it('sees a locked bank refuse the plain arm and open to the token', async () => {
    const camera = cameraFor([1, 0, 3, 0], {
      authBanks: [PROBE_PROTECTED_SUBCMD],
      authToken: OLD_FW_UNLOCK_TOKEN,
    });
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));

    expect(probe.plainAccepted).toBe(false);
    expect(probe.authAccepted).toBe(true);
    /* The open bank is outside the locked set, which is the whole reason it is
     * the one used to ask "can this build serve a window at all". */
    expect(probe.openWindowReadable).toBe(true);
  });

  it('reports a wrong token as a refusal, so the token is really compared', async () => {
    const wrong = Uint8Array.from(OLD_FW_UNLOCK_TOKEN);
    wrong[0] = (wrong[0] ?? 0) ^ 0xff;
    const camera = cameraFor([1, 0, 3, 0], {
      authBanks: [PROBE_PROTECTED_SUBCMD],
      authToken: wrong,
    });
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));

    expect(probe.plainAccepted).toBe(false);
    expect(probe.authAccepted).toBe(false);
  });

  it('sends only read-only opcodes, on every path', async () => {
    const camera = cameraFor([1, 0, 3, 0], {
      authBanks: [PROBE_PROTECTED_SUBCMD],
      authToken: OLD_FW_UNLOCK_TOKEN,
    });
    await camera.open();
    await probeSelectorChannel(new SeekDevice(camera));
    expect(camera.calls.length).toBeGreaterThan(0);
    for (const call of camera.calls) {
      expect(READ_ONLY_OPS.has(call.op as never), `opcode ${String(call.op)}`).toBe(true);
    }
  });

  it('stops after the version read on a build that predates the dump protocol', async () => {
    /* THE SAFETY PROPERTY. On 0.3.0.1 wire id 0x52 is EnterBootloaderMode, so
     * the probe must not reach the arm at all — and "must not" has to be
     * checked by what went on the wire, not by what the result says. */
    const camera = cameraFor([0, 3, 0, 1], { fwInfo: new Map([[0, buildBlock([0, 3, 0, 1])]]) });
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));

    expect(probe.firmwareVersion).toBe('0.3.0.1');
    expect(probe.skippedForSafety).toBe(true);
    expect(camera.calls.map((c) => c.op)).toEqual([OP.GET_FIRMWARE_INFO]);
    expect(camera.calls.some((c) => c.op === OP.BEGIN_FIRMWARE_UPGRADE)).toBe(false);
  });

  it('stops after the version read on 0.7.0.x, whose read has no getter', async () => {
    /* 0.7.0.7's 0x52 IS BeginFirmwareUpgrade, so arming would be harmless — and
     * useless: its GetFeaturedFirmwareData is registered as a setter only, so
     * no window it arms can be read. The version is enough to know, so the
     * probe sends nothing more, and the evidence it hands on names the builds'
     * own profile, which refuses to dump. */
    const camera = cameraFor([0, 7, 0, 7]);
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));

    expect(probe.firmwareVersion).toBe('0.7.0.7');
    expect(probe.skippedForSafety).toBe(true);
    expect(camera.calls.map((c) => c.op)).toEqual([OP.GET_FIRMWARE_INFO]);
    expect(probe.notes.join(' ')).toContain('setter only');
    const detection = detectProfile(evidenceFromChannelProbe(probe));
    expect(detection.best.profile.id).toBe('compact-2014');
    expect(detection.best.profile.capabilities.dump.supported).toBe(false);
  });

  it('sends nothing but the version read when the caller disables the arms', async () => {
    const camera = cameraFor([4, 18, 2, 0]);
    await camera.open();
    await probeSelectorChannel(new SeekDevice(camera), { armProbes: false });
    expect(camera.calls.map((c) => c.op)).toEqual([OP.GET_FIRMWARE_INFO]);
  });

  it('survives a camera that will not answer GetFirmwareInfo', async () => {
    /* 0.6.0.4 does exactly this over the emulator. An unknown version must not
     * stop the probe, because the arms are what will actually settle it. */
    const camera = fakeCamera({ initialMode: 0 });
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));
    expect(probe.firmwareVersion).toBeNull();
    expect(probe.plainAccepted).toBe(true);
    expect(probe.notes.some((n) => n.includes('GetFirmwareInfo did not answer'))).toBe(true);
  });

  it('records a window that arms but serves nothing', async () => {
    const camera = cameraFor([4, 18, 2, 0], {
      stallAt: [{ subcmd: PROBE_OPEN_SUBCMD, offset: 0 }],
    });
    await camera.open();
    const probe = await probeSelectorChannel(new SeekDevice(camera));
    expect(probe.openWindowReadable).toBe(false);
  });
});

describe('predatesDumpProtocol', () => {
  it('is the 0.8 boundary the corpus measured, and nothing else', () => {
    /* 0.8.0.0 is the first build with a GETTER for GetFeaturedFirmwareData at
     * 0x4F. 0.7.0.7 and 0.7.0.8 have the name there and the handler in the
     * setter column, which is why this boundary was 0.7 until 2026-09-23: the
     * facts it was drawn from recorded names only. */
    for (const v of [
      '0.3.0.1',
      '0.5.0.2',
      '0.5.1.0',
      '0.5.1.3',
      '0.6.0.4',
      '0.6.99.99',
      '0.7.0.7',
      '0.7.0.8',
      '0.7.99.99',
    ]) {
      expect(predatesDumpProtocol(v), v).toBe(true);
    }
    for (const v of ['0.8.0.0', '0.9.1.0', '1.0.0.0', '1.3.0.8', '4.18.2.0', '42.32.3.10']) {
      expect(predatesDumpProtocol(v), v).toBe(false);
    }
  });

  it('says no when there is no version to judge', () => {
    /* An unknown version must not be treated as old: refusing to read a camera
     * because it did not answer one optional command would be a worse failure
     * than the one this guard prevents. */
    expect(predatesDumpProtocol(null)).toBe(false);
    expect(predatesDumpProtocol('PIR206 Thermal Camera')).toBe(false);
  });
});

describe('evidenceFromChannelProbe', () => {
  it('turns a refused plain arm into the evidence that names legacy-auth', async () => {
    const camera = cameraFor([1, 0, 3, 0], {
      authBanks: [PROBE_PROTECTED_SUBCMD],
      authToken: OLD_FW_UNLOCK_TOKEN,
    });
    await camera.open();
    const evidence = evidenceFromChannelProbe(await probeSelectorChannel(new SeekDevice(camera)));

    expect(evidence.plainSelectorRefused).toBe(true);
    expect(evidence.authSelectorWorks).toBe(true);
    const detection = detectProfile(evidence);
    expect(detection.best.profile.id).toBe('legacy-auth');
    expect(detection.ambiguous).toBe(false);
  });

  it('turns an accepted plain arm into the evidence that names modern-4x', async () => {
    const camera = cameraFor([10, 9, 1, 31]);
    await camera.open();
    const evidence = evidenceFromChannelProbe(await probeSelectorChannel(new SeekDevice(camera)));

    expect(evidence.plainSelectorRefused).toBe(false);
    const detection = detectProfile(evidence);
    /* A Mosaic. Its version is 10.x and it used to score ZERO on modern-4x for
     * that reason alone, landing on `generic` — which refuses to flash a camera
     * whose entire selector map it reads correctly. */
    expect(detection.best.profile.id).toBe('modern-4x');
  });

  it('claims nothing about the channel when the probe never touched it', async () => {
    const camera = cameraFor([0, 5, 0, 2]);
    await camera.open();
    const evidence = evidenceFromChannelProbe(await probeSelectorChannel(new SeekDevice(camera)));

    /* The probe stopped at the version, so it observed no refusal and must not
     * report one — a false `plainSelectorRefused` would name `legacy-auth` for
     * a camera nothing was asked. */
    expect(evidence.plainSelectorRefused).toBeUndefined();
    expect(evidence.plainSelectorWorks).toBeUndefined();
    expect(detectProfile(evidence).best.profile.id).toBe('compact-2014');
  });
});

import { describe, expect, it } from 'vitest';

import { addrTag, bytesToHex, equalBytes, hex, viewOf } from '../src/bytes.js';
import { SeekError } from '../src/errors.js';
import { collectingReporter, silentReporter, type Artifact, type Reporter } from '../src/events.js';
import { cryptBytes } from '../src/crypto/cipher.js';
import { keyFilenameSuffix, stateFromKey } from '../src/crypto/keys.js';
import {
  assertBankPayload,
  setAcceptSum,
  transferSum16,
  type BankPayload,
} from '../src/image/bank.js';
import {
  FOOTER_SIZE,
  FOOTER_TAG,
  HEADER_OFFSET,
  IMAGE_MAGIC,
  TRY_KEYS_MAX_LEN,
  parseImageHeader,
  type ImageFooter,
  type ImageHeader,
} from '../src/image/header.js';
import { SeekDevice } from '../src/protocol/client.js';
import { OP, OP_DIRECTION, READ_ONLY_OPS, WINDOW_SIZE, type Opcode } from '../src/protocol/ops.js';
import { compact2014 } from '../src/profiles/compact-2014.js';
import { compact2016 } from '../src/profiles/compact-2016.js';
import { generic } from '../src/profiles/generic.js';
import {
  buildLegacyWindowMap,
  legacyAuth,
  legacySelectorRows,
  legacyWindowPlan,
  OLD_FW_UNLOCK_TOKEN,
} from '../src/profiles/legacy-auth.js';
import {
  FLASH_BASE,
  FLASH_SIZE,
  GAP_ADDRESS,
  modern4x,
  modernWindowPlan,
} from '../src/profiles/modern-4x.js';
import { detectProfile } from '../src/profiles/registry.js';
import type { FirmwareProfile, SlotKey } from '../src/profiles/types.js';
import { decryptDump, detectProfileForDump, evidenceFromDump } from '../src/workflows/decrypt.js';
import { readDeviceInfo } from '../src/workflows/device-info.js';
import { runDump } from '../src/workflows/dump.js';
import { prepareImage, writeFirmware } from '../src/workflows/flash.js';
import { runSweep } from '../src/workflows/sweep.js';
import type {
  DeviceState,
  PreparedFlash,
  SlotState,
  WorkflowContext,
} from '../src/workflows/types.js';
import {
  fakeCamera,
  patternFlash,
  type FakeCamera,
  type FakeWindowSpec,
} from './fake-transport.js';

/* ==================================================================== *
 * Fixtures
 * ==================================================================== */

/**
 * The version a `cameraFor(profile)` camera reports, chosen so that the plan
 * the profile makes for it IS `profile.windowMap()`, the map the camera serves.
 *
 * These cameras used to report nothing, and the dump then planned for an
 * unknown version. It refuses that now (`identity-gate.test.ts`), so each one
 * names a build: the modern line's 4.18.2.0, and on the legacy line 1.1.0.0 —
 * a build whose table has NOT been decoded, so the plan is the rows every
 * decoded build agrees on, which is exactly `buildLegacyWindowMap()`.
 */
function versionServedBy(profile: FirmwareProfile): string {
  return profile.id === 'legacy-auth' || profile.id === 'compact-2016' ? '1.1.0.0' : '4.18.2.0';
}

/** A fake camera whose selector map is exactly `profile`'s. */
function cameraFor(
  profile: FirmwareProfile,
  options: { flash?: Uint8Array; stallAt?: readonly { subcmd: number; offset: number }[] } = {},
): FakeCamera {
  const windows: FakeWindowSpec[] = profile
    .windowMap()
    .map((entry) => ({ subcmd: entry.subcmd, offset: entry.address - profile.memory.flashBase }));
  const authBanks = profile
    .windowMap()
    .filter((entry) => entry.auth === true)
    .map((entry) => entry.subcmd);
  return fakeCamera({
    windows,
    fwInfo: new Map([[0, buildBlock(versionServedBy(profile))]]),
    ...(options.flash ? { flash: options.flash } : {}),
    ...(options.stallAt ? { stallAt: options.stallAt } : {}),
    ...(authBanks.length > 0 ? { authBanks, authToken: OLD_FW_UNLOCK_TOKEN } : {}),
  });
}

/** `GetFirmwareInfo` selector 0: four version bytes, then the build string. */
function buildBlock(version: string): Uint8Array {
  const out = new Uint8Array(36);
  out.set(
    version.split('.').map((n) => Number.parseInt(n, 10)),
    0,
  );
  out.set(new TextEncoder().encode('Oct 21 2014'), 4);
  return out;
}

/**
 * A fake camera running one legacy build's OWN window table, as decoded from
 * its image: every row with a constant address serves that block, a row the
 * build computes at run time serves nothing, and it reports `version` through
 * GetFirmwareInfo. On a 2014 build that means subcommands 0x0D AND 0x0E both
 * serve 0x140B0000, and nothing serves 0x140C0000 — exactly the firmware the
 * shared map used to mis-file.
 */
function legacyBuildCamera(version: string, flash?: Uint8Array): FakeCamera {
  const rows = legacySelectorRows(version) ?? [];
  const live = rows.filter((r) => r.address !== null && r.channel !== 'refused');
  return fakeCamera({
    windows: live.map((r) => ({ subcmd: r.subcmd, offset: (r.address ?? 0) - FLASH_BASE })),
    authBanks: live.filter((r) => r.channel === 'auth').map((r) => r.subcmd),
    authToken: OLD_FW_UNLOCK_TOKEN,
    fwInfo: new Map([[0, buildBlock(version)]]),
    ...(flash ? { flash } : {}),
  });
}

async function contextFor(
  profile: FirmwareProfile,
  camera: FakeCamera,
  reporter: Reporter = silentReporter,
  signal?: AbortSignal,
): Promise<WorkflowContext> {
  await camera.open();
  const device = new SeekDevice(camera, { reporter, ...(signal ? { signal } : {}) });
  return { device, profile, detection: null, reporter, ...(signal ? { signal } : {}) };
}

function namesOf(artifacts: readonly Artifact[]): string[] {
  return artifacts.map((a) => a.name);
}

/** Deterministic, non-degenerate 16-byte key material. */
function makeKey(seed: number): Uint8Array {
  const key = new Uint8Array(16);
  let state = (seed * 2654435761) >>> 0;
  for (let i = 0; i < 16; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    key[i] = (state >>> 24) & 0xff;
  }
  /* findKeyCandidates skips a hit whose following word looks like another flash
   * pointer, so keep byte 3 away from the 0x14 region prefix. */
  if (key[3] === 0x14) key[3] = 0x15;
  return key;
}

const IMAGE_SIZE = 0x4000;
const KEY_A_AT = 0x1000;
const KEY_B_AT = 0x1010;

/**
 * A plaintext firmware image that satisfies every structural check: a sane
 * Cortex-M vector table with the reserved words the GF(2) solve needs, a header
 * at 0x200, the adjust word tuned to the profile's acceptance sum, and its own
 * g_keyA/g_keyB embedded outside the cleartext header window.
 */
/**
 * A version word that agrees with the profile being built.
 *
 * THE FIXTURE USED TO SAY 4.18.2.0 WHATEVER IT WAS BUILDING, and that is the
 * synthetic-fixture drift `TESTING.md` warns about, caught: the `compact-2016`
 * dump carried a zero acceptance sum — a 2016 part — and a header claiming the
 * build from 2020. Nothing noticed, because no `detect()` read the header
 * version. Now that they do, a fixture has to be consistent to be evidence of
 * anything, so the version comes off the profile.
 *
 * `0x00021204` is 4.18.2.0 and `0x00030001` is 1.0.3.0, both low byte first
 * (`versionString`): the Compact PRO FF build the modern map was decoded from,
 * and the 2016 Compact PRO build the legacy handler was decoded from.
 */
function versionWordFor(profile: FirmwareProfile): number {
  if (profile.id === 'compact-2016' || profile.id === 'legacy-auth')
    return 0x00030001; /* 1.0.3.0 */
  if (profile.id === 'compact-2014') return 0x00000500; /* 0.5.0.0 */
  return 0x00021204; /* 4.18.2.0 */
}

function makePlainImage(keyA: Uint8Array, keyB: Uint8Array, profile: FirmwareProfile): Uint8Array {
  const image = new Uint8Array(IMAGE_SIZE);
  const dv = viewOf(image);
  dv.setUint32(0, 0x10004000, true); /* SP: LPC43xx SRAM, word-aligned */
  dv.setUint32(4, 0x14030201, true); /* reset vector, Thumb */
  /* words 7..10 (solve input) and word 13 (self-check) stay zero */
  dv.setUint32(HEADER_OFFSET + 0, IMAGE_MAGIC, true);
  dv.setUint32(HEADER_OFFSET + 4, IMAGE_SIZE, true);
  dv.setUint32(HEADER_OFFSET + 8, 0x00001234, true);
  dv.setUint32(HEADER_OFFSET + 12, versionWordFor(profile), true);
  dv.setUint32(HEADER_OFFSET + 16, 0x14030201, true);
  image.set(keyA, KEY_A_AT);
  image.set(keyB, KEY_B_AT);
  return setAcceptSum(image, profile.cipher).image;
}

/**
 * A 4 MiB dump holding the bootloader key table near the base and one
 * Key-A-encrypted image at 0x14030000 — the minimum a real decrypt run needs.
 */
function makeDumpWithImage(
  keyA: Uint8Array,
  keyB: Uint8Array,
  profile: FirmwareProfile,
): { dump: Uint8Array; plain: Uint8Array; slotOffset: number } {
  const dump = new Uint8Array(FLASH_SIZE);
  const tableAt = 0x1000;
  viewOf(dump).setUint32(tableAt, profile.memory.bootConfigBase, true);
  dump.set(keyA, tableAt + 4);
  dump.set(keyB, tableAt + 20);

  const plain = makePlainImage(keyA, keyB, profile);
  const cipher = cryptBytes(plain, stateFromKey(keyA, profile.cipher.whiteningK), profile.cipher);
  const slotOffset = 0x30000;
  dump.set(cipher, slotOffset);
  return { dump, plain, slotOffset };
}

function footerTemplate(length: number): ImageFooter {
  const raw = new Uint8Array(FOOTER_SIZE).fill(0xff);
  const dv = viewOf(raw);
  dv.setUint32(0, FOOTER_TAG, true);
  dv.setUint32(4, length, true);
  dv.setUint32(8, 0x00001234, true);
  dv.setUint32(12, 0x00021204, true);
  raw.set(new TextEncoder().encode('PIR324'), 16);
  return {
    offset: 0,
    tag: FOOTER_TAG,
    length,
    imageId: 0x1234,
    version: 0x00021204,
    model: 'PIR324',
    raw,
  };
}

const RUNNING_HEADER: ImageHeader = {
  sp: 0x10004000,
  reset: 0x14030201,
  magic: IMAGE_MAGIC,
  length: IMAGE_SIZE,
  imageId: 0x00001234,
  version: 0x00021204,
  entry: 0x14030201,
  adjust: 0,
  versionStr: '4.18.2.0',
};

function slot(
  key: SlotKey,
  name: string,
  address: number,
  extra: Partial<SlotState> = {},
): SlotState {
  return {
    key,
    name,
    subcmd: 0,
    address,
    present: true,
    reason: null,
    unread: false,
    header: RUNNING_HEADER,
    raw: null,
    footer: footerTemplate(IMAGE_SIZE),
    recovered: null,
    plain: null,
    plainHeader: RUNNING_HEADER,
    accepts: true,
    footerOk: true,
    sha256: null,
    keyName: 'Key A',
    bootable: true,
    ...extra,
  };
}

/**
 * A DeviceState as `readDeviceInfo` would have produced it for a flashable
 * camera. Built by hand so the flash guards can be exercised without a camera
 * that would have to be talked through a whole analysis first.
 */
function makeDeviceState(keyA: Uint8Array, keyB: Uint8Array): DeviceState {
  const slotA = slot('a', 'Slot A', 0x14030000);
  const slotB = slot('b', 'Slot B', 0x14050000);
  const slots = [slotA, slotB];
  return {
    readAt: '2026-09-20T00:00:00.000Z',
    profile: modern4x,
    detection: {
      best: { profile: modern4x, score: 0.97, reasons: [] },
      ranked: [],
      ambiguous: false,
    },
    evidence: {},
    description: {
      vendorId: 0x289d,
      productId: 0x0011,
      productName: 'Seek Thermal Compact PRO',
      manufacturerName: 'Seek Thermal',
      serialNumber: null,
    },
    version: '4.18.2.0',
    buildString: null,
    bootloaderVersion: null,
    bootloaderString: null,
    platform: null,
    usbSpeed: null,
    activeSlotWord: null,
    serial: null,
    cfg0: 0,
    cfgSlots: null,
    deviceKeySlot: null,
    keyTableCandidates: 1,
    keyTable: { offset: 0x1000, keyA, keyB, matchA: true, matchB: false },
    keyWhiteningK: modern4x.cipher.whiteningK,
    storeKey: { name: 'Key B', key: keyB, programmed: false },
    slots,
    byKey: new Map([
      ['a', slotA],
      ['b', slotB],
    ]),
    boot: { booted: 'a', target: 'b' },
    updateTargetSubcmd: 0,
    targetConfirmed: null,
    familyOk: true,
    plainChain: false,
    canFlash: true,
    flashBlockedBy: [],
  };
}

/* ==================================================================== *
 * runDump
 * ==================================================================== */

describe('runDump', () => {
  it('reads the whole selector map into a 4 MiB image and reports every window ok', async () => {
    const camera = cameraFor(modern4x);
    const reporter = collectingReporter();
    const ctx = await contextFor(modern4x, camera, reporter);
    const expected = modern4x.windowMap().length;

    const result = await runDump(ctx, { chunk: 4096, decrypt: false });

    expect(result.combined.length).toBe(FLASH_SIZE);
    expect(result.windowsExpected).toBe(expected);
    expect(result.windowsRead).toBe(expected);
    expect(result.cancelled).toBe(false);
    expect(result.manifest.windows).toHaveLength(expected);
    expect(result.manifest.windows.every((w) => w.ok)).toBe(true);

    /* the bytes really came off the emulated flash */
    const at = 0x14030000 - FLASH_BASE;
    expect(
      equalBytes(result.combined.subarray(at, at + 64), camera.flash.subarray(at, at + 64)),
    ).toBe(true);

    /* the one block no selector reaches stays gap-filled and is declared */
    const gapAt = GAP_ADDRESS - FLASH_BASE;
    expect(result.combined.subarray(gapAt, gapAt + WINDOW_SIZE).every((b) => b === 0xff)).toBe(
      true,
    );
    expect(result.manifest.gaps).toHaveLength(1);
    expect(result.manifest.gaps[0]?.address).toBe(hex(GAP_ADDRESS, 8));

    const names = namesOf(result.artifacts);
    expect(names).toContain('manifest.json');
    expect(names).toContain('README.md');
    expect(names).toContain(result.manifest.combinedFile);
    expect(names.filter((n) => n.startsWith('windows/'))).toHaveLength(expected);

    /* every byte of the log went through the Reporter, never console */
    expect(reporter.events.some((e) => e.type === 'log')).toBe(true);
  }, 60_000);

  it('keeps a short window, gap-fills exactly the missing range and records why', async () => {
    const stallOffset = 0x8000;
    const camera = cameraFor(modern4x, { stallAt: [{ subcmd: 5, offset: stallOffset }] });
    const ctx = await contextFor(modern4x, camera);
    const expected = modern4x.windowMap().length;

    const result = await runDump(ctx, {
      chunk: 4096,
      decrypt: false,
      retries: 0,
      retryDelayMs: 0,
    });

    /* the run still succeeds; only that one window is short */
    expect(result.windowsRead).toBe(expected - 1);
    expect(result.manifest.windows).toHaveLength(expected);

    const record = result.manifest.windows.find((w) => w.subcmd === hex(5));
    expect(record).toBeDefined();
    expect(record?.ok).toBe(false);
    if (record === undefined || 'error' in record)
      throw new Error('expected a short read, not a failure');
    expect(record.lengthRead).toBe(stallOffset);
    expect(record.shortBy).toBe(WINDOW_SIZE - stallOffset);
    expect(record.shortfallFilled).not.toBeNull();
    expect(record.shortfallFilled?.from).toBe(hex(0x14030000 + stallOffset, 8));
    expect(record.shortfallFilled?.to).toBe(hex(0x14030000 + WINDOW_SIZE - 1, 8));
    expect(record.shortfallFilled?.length).toBe(WINDOW_SIZE - stallOffset);
    expect(record.shortfallFilled?.fill).toBe(hex(0xff, 2));
    expect(record.shortfallFilled?.reason).toMatch(
      /GetFeaturedFirmwareData|no more data|short chunk/,
    );

    /* the bytes that DID arrive are kept, and exactly the rest is filled */
    const base = 0x14030000 - FLASH_BASE;
    expect(
      equalBytes(
        result.combined.subarray(base, base + stallOffset),
        camera.flash.subarray(base, base + stallOffset),
      ),
    ).toBe(true);
    expect(
      result.combined.subarray(base + stallOffset, base + WINDOW_SIZE).every((b) => b === 0xff),
    ).toBe(true);
  }, 60_000);

  it('keeps what it read when the caller cancels, and says the run was partial', async () => {
    /* A dump takes minutes, so cancelling one must not throw the bytes away —
     * the original page saved what it had, and so does this. The guarantee that
     * matters is that a partial image can never be mistaken for a complete one:
     * the manifest says cancelled, the unread windows stay gap-filled, and the
     * readable-window count is short. */
    const controller = new AbortController();
    const seen: Artifact[] = [];
    const reporter: Reporter = {
      log: () => undefined,
      progress: () => undefined,
      artifact: (artifact) => {
        seen.push(artifact);
        if (artifact.name.startsWith('windows/')) controller.abort();
      },
    };
    const camera = cameraFor(modern4x);
    const ctx = await contextFor(modern4x, camera, reporter, controller.signal);
    const entries = modern4x.windowMap();

    const result = await runDump(ctx, { chunk: 4096, decrypt: false });

    expect(result.cancelled).toBe(true);
    expect(result.windowsRead).toBeGreaterThan(0);
    expect(result.windowsRead).toBeLessThan(entries.length);
    expect(result.windowsExpected).toBe(entries.length);

    /* the run is still fully described — that is what makes it safe to keep */
    expect(namesOf(result.artifacts)).toContain('manifest.json');
    expect(namesOf(result.artifacts)).toContain('README.md');
    expect(result.manifest.cancelled).toBe(true);
    expect(result.manifest.usbReadableWindows).toBe(result.windowsRead);

    /* every window that never ran is gap-filled, and recorded as unread */
    expect(result.manifest.windows.filter((w) => w.ok)).toHaveLength(result.windowsRead);

    /* decryption is skipped: the image is incomplete and stopping was the point */
    expect(result.manifest.decryption.attempted).toBe(false);

    expect(seen.length).toBeGreaterThan(0);
    expect(camera.isOpen).toBe(false);
  }, 60_000);

  it('covers the legacy authenticated map with the same function, and says so', async () => {
    /* The unification under test: one runDump, two algorithms. Nothing branches
     * on the profile id — the authenticated payloads in the map itself are what
     * select the legacy manifest, its unlock-token bookkeeping and its README.
     * This camera reports 1.1.0.0, a legacy build whose table has not been
     * decoded, so the plan is only the rows every decoded build agrees on.
     * (It used to report nothing and get the same plan; a camera that reports
     * nothing is now refused — identity-gate.test.ts.) */
    const camera = cameraFor(legacyAuth);
    const ctx = await contextFor(legacyAuth, camera);
    const entries = buildLegacyWindowMap();

    const result = await runDump(ctx, { chunk: 4096, decrypt: false });

    expect(result.windowsRead).toBe(entries.length);
    const manifest = result.manifest;
    if (!('algorithm' in manifest)) throw new Error('expected the legacy manifest shape');
    expect(manifest.algorithm).toBe('legacy-locked-firmware');
    expect(manifest.unlockToken).toBe(bytesToHex(OLD_FW_UNLOCK_TOKEN));
    expect(manifest.authChannelBanks).toEqual(
      entries.filter((e) => e.auth === true).map((e) => hex(e.address, 8)),
    );
    expect(manifest.combinedFile).toContain('legacy');
    expect(manifest.safety.join(' ')).toContain('channel-0x12 unlock token');

    /* the blocks THIS plan does not reach — for an undecoded build, the ones
     * the builds disagree about as well as the ones none of them reaches */
    expect(manifest.gaps.map((g) => g.address)).toEqual(
      legacyWindowPlan('1.1.0.0').unreachable.map((u) => hex(u.address, 8)),
    );
    expect(manifest.gaps.map((g) => g.address)).toContain(hex(FLASH_BASE, 8));
    expect(manifest.selectorTable?.firmwareVersion).toBe('1.1.0.0');
    expect(manifest.selectorTable?.table).toMatch(
      /version unknown: .*firmware 1\.1\.0\.0 is not a build whose table has been decoded/,
    );

    const readme = result.artifacts.find((a) => a.name === 'README.md');
    expect(new TextDecoder().decode(readme?.data ?? new Uint8Array())).toContain(
      'legacy (locked-firmware) algorithm',
    );
  }, 60_000);

  it('dumps a 2014 Compact with its own table and never files 0x140B0000 under 0x140C0000', async () => {
    /* THE BUG, reproduced and closed. On 0.8.0.0 .. 1.3.0.0 the firmware's own
     * table gives subcommand 0x0E the address 0x140B0000, the same as 0x0D. The
     * shared map claimed 0x0E was 0x140C0000, so a dump stored 0x140B0000's
     * bytes at 0x140C0000 and never read 0x140C0000 at all. The camera here runs
     * that table: had the dump armed 0x0E "for 0x140C0000", the bytes at
     * 0x140C0000 in the image would equal the flash at 0x140B0000. */
    const flash = patternFlash(FLASH_SIZE, 0x2014);
    const camera = legacyBuildCamera('1.3.0.0', flash);
    const ctx = await contextFor(legacyAuth, camera);

    const result = await runDump(ctx, { chunk: 4096, decrypt: false });

    const at = (address: number): Uint8Array =>
      result.combined.subarray(address - FLASH_BASE, address - FLASH_BASE + WINDOW_SIZE);
    const flashAt = (address: number): Uint8Array =>
      flash.subarray(address - FLASH_BASE, address - FLASH_BASE + WINDOW_SIZE);

    expect(equalBytes(at(0x140b0000), flashAt(0x140b0000))).toBe(true);
    expect(equalBytes(at(0x140c0000), flashAt(0x140b0000))).toBe(false);
    expect(at(0x140c0000).every((b) => b === 0xff)).toBe(true);
    expect(result.manifest.windows.some((w) => w.address === hex(0x140c0000, 8))).toBe(false);
    const gap = result.manifest.gaps.find((g) => g.address === hex(0x140c0000, 8));
    expect(gap?.reason).toMatch(/gives subcommand 0x0E the address 0x140B0000/);

    /* ...and the build's own table is used for the rest: 31 windows, the
     * bootloader block read through subcommand 2 and the token. */
    expect(result.windowsExpected).toBe(31);
    expect(result.windowsRead).toBe(31);
    expect(equalBytes(at(FLASH_BASE), flashAt(FLASH_BASE))).toBe(true);
    expect(result.manifest.selectorTable).toEqual({
      firmwareVersion: '1.3.0.0',
      table: "legacy 1.3.0.0: this build's own BeginFirmwareUpgrade table",
    });
    /* every block read came from the address it is filed under */
    for (const w of result.manifest.windows) {
      const address = Number(w.address);
      expect(equalBytes(at(address), flashAt(address)), w.address).toBe(true);
    }
  }, 60_000);

  it('dumps the 2016 Compact PRO 1.0.3.0 with its own table: 31 blocks, 0x14010000 up', async () => {
    const flash = patternFlash(FLASH_SIZE, 0x2016);
    const camera = legacyBuildCamera('1.0.3.0', flash);
    const ctx = await contextFor(compact2016, camera);

    const result = await runDump(ctx, { chunk: 4096, decrypt: false });

    expect(result.windowsRead).toBe(31);
    expect(result.manifest.windows.map((w) => w.address)).toEqual(
      legacyWindowPlan('1.0.3.0').windows.map((w) => hex(w.address, 8)),
    );
    expect(result.manifest.gaps.map((g) => g.address)).toEqual([
      hex(FLASH_BASE, 8),
      hex(0x14200000, 8),
    ]);
    const c = 0x140c0000 - FLASH_BASE;
    expect(
      equalBytes(result.combined.subarray(c, c + WINDOW_SIZE), flash.subarray(c, c + WINDOW_SIZE)),
    ).toBe(true);
  }, 60_000);

  it('refuses a 0.7.0.x camera before arming anything, even under a forced profile', async () => {
    /* 0.7.0.7 and 0.7.0.8 have GetFeaturedFirmwareData at 0x4F with the handler
     * in the SETTER column: every read would stall. The refusal is the
     * firmware's, so it holds whichever profile the caller forced. */
    for (const version of ['0.7.0.7', '0.7.0.8']) {
      const camera = fakeCamera({ fwInfo: new Map([[0, buildBlock(version)]]) });
      const ctx = await contextFor(legacyAuth, camera);
      const error = await runDump(ctx, { chunk: 4096, decrypt: false }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(error, version).toBeInstanceOf(SeekError);
      expect((error as SeekError).code).toBe('profile/unsupported');
      expect((error as SeekError).message).toContain(`firmware ${version} predates the dump`);
      expect((error as SeekError).message).toContain('setter only');
      /* The version read (two unarmed reads), and nothing after it. */
      expect(
        camera.calls.map((c) => c.op),
        version,
      ).toEqual([OP.GET_FIRMWARE_INFO, OP.GET_FIRMWARE_INFO]);
    }
  }, 60_000);

  it('sends every request of a dump in the direction OP_DIRECTION records', async () => {
    /* `firmware-facts.test.ts` checks each image's handler COLUMNS against
     * OP_DIRECTION; this checks the client against OP_DIRECTION. Together they
     * say: every request a dump sends reaches a handler the firmware has. */
    for (const [profile, camera] of [
      [modern4x, cameraFor(modern4x)],
      [legacyAuth, legacyBuildCamera('1.3.0.0')],
    ] as const) {
      const ctx = await contextFor(profile, camera);
      await runDump(ctx, { chunk: 4096, decrypt: false });
      expect(camera.calls.length).toBeGreaterThan(0);
      for (const call of camera.calls) {
        expect(READ_ONLY_OPS.has(call.op as Opcode), `${profile.id} op ${hex(call.op)}`).toBe(true);
        expect(call.direction, `${profile.id} op ${hex(call.op)}`).toBe(
          OP_DIRECTION[call.op as Opcode],
        );
      }
    }
  }, 60_000);

  it('rejects out-of-range options before touching the camera', async () => {
    const camera = cameraFor(modern4x);
    const ctx = await contextFor(modern4x, camera);
    const before = camera.calls.length;

    for (const bad of [
      { chunk: 0 },
      { chunk: WINDOW_SIZE + 1 },
      { gapFill: 256 },
      { retries: -1 },
      { retryDelayMs: -1 },
    ]) {
      await expect(runDump(ctx, bad)).rejects.toBeInstanceOf(SeekError);
      /* The code and `detail.option` are the contract a front end branches on,
       * so that it can highlight the offending input rather than parse prose. */
      const error: SeekError = await runDump(ctx, bad).then(
        () => {
          throw new Error('expected a rejection');
        },
        (e: unknown) => e as SeekError,
      );
      expect(error.code).toBe('options/invalid');
      expect(error.detail?.option).toBe(Object.keys(bad)[0]);
    }
    expect(camera.calls.length).toBe(before);
  });
});

/* ==================================================================== *
 * runSweep
 * ==================================================================== */

describe('runSweep', () => {
  it('probes every selector in the range and places the mapped ones', async () => {
    /* A narrowed sweep range: the behaviour under test is the probe loop, not
     * how long 66 selectors take. */
    const profile: FirmwareProfile = { ...modern4x, sweepRange: [1, 3] };
    const camera = cameraFor(profile);
    const ctx = await contextFor(profile, camera);

    const result = await runSweep(ctx, { chunk: 4096, decrypt: false });

    expect(result.manifest.selectors).toHaveLength(3);
    expect(result.selectorsArmed).toBe(3);
    expect(result.selectorsWithData).toBe(3);
    expect(result.placedInImage).toBe(3);
    expect(result.manifest.mode).toBe('selector-sweep');
    expect(namesOf(result.artifacts)).toContain('blocks/subcmd_03_14010000.bin');

    const base = 0x14010000 - FLASH_BASE;
    expect(
      equalBytes(result.combined.subarray(base, base + 32), camera.flash.subarray(base, base + 32)),
    ).toBe(true);
  }, 60_000);

  it('places a 2014 Compact subcommand where its own table says, not where 4.x would', async () => {
    /* The sweep had the dump's bug too: it placed each selector's block at the
     * address the PROFILE's map claimed. On a 2014 build subcommand 0x0E serves
     * 0x140B0000, and the old map put those bytes at 0x140C0000. */
    const flash = patternFlash(FLASH_SIZE, 0x5eed);
    const camera = legacyBuildCamera('1.3.0.0', flash);
    const profile: FirmwareProfile = { ...legacyAuth, sweepRange: [0x0d, 0x0f] };
    const ctx = await contextFor(profile, camera);

    const result = await runSweep(ctx, { chunk: 4096, decrypt: false });

    expect(result.manifest.selectors.map((r) => r.mappedAddress)).toEqual([
      hex(0x140b0000, 8),
      hex(0x140b0000, 8),
      hex(0x140d0000, 8),
    ]);
    const c = 0x140c0000 - FLASH_BASE;
    expect(result.combined.subarray(c, c + WINDOW_SIZE).every((b) => b === 0xff)).toBe(true);
    expect(namesOf(result.artifacts)).toContain('blocks/subcmd_0e_140b0000.bin');
  }, 60_000);

  it('refuses to sweep a build whose 0x52 may be EnterBootloaderMode', async () => {
    const camera = fakeCamera({ fwInfo: new Map([[0, buildBlock('0.3.0.1')]]) });
    const ctx = await contextFor(modern4x, camera);
    await expect(runSweep(ctx, { chunk: 4096, decrypt: false })).rejects.toThrow(
      /refusing to sweep: firmware 0\.3\.0\.1 predates the dump protocol/,
    );
    expect(camera.calls.some((c) => c.op === OP.BEGIN_FIRMWARE_UPGRADE)).toBe(false);
  }, 60_000);
});

/* ==================================================================== *
 * decryptDump
 * ==================================================================== */

describe('decryptDump', () => {
  it('recovers an encrypted slot with no device attached and emits the full artifact set', async () => {
    const keyA = makeKey(1);
    const keyB = makeKey(2);
    const { dump, plain, slotOffset } = makeDumpWithImage(keyA, keyB, modern4x);

    const result = await decryptDump(
      dump,
      'test_dump',
      { profile: modern4x, dumpPath: 'test_dump.bin' },
      silentReporter,
    );

    expect(result.slots).toHaveLength(1);
    const recovered = result.slots[0];
    if (recovered === undefined) throw new Error('no slot decrypted');
    expect(recovered.flash).toBe(FLASH_BASE + slotOffset);
    expect(recovered.length).toBe(IMAGE_SIZE);
    expect(equalBytes(recovered.plain, plain)).toBe(true);
    expect(recovered.recovered.confidence).toBe('VERIFIED(profile)');
    expect(recovered.recovered.matchesProfile).toBe(true);

    /* the key is named from the image's OWN plaintext, not from the TARGET */
    expect(recovered.whitening.evidence).toBe('plaintext');
    expect(recovered.whitening.keyHex).toBe(bytesToHex(keyA));
    expect(recovered.whitening.whiteningK).toBe(modern4x.cipher.whiteningK);

    /* the dump's bootloader table was identified, so the name carries the keys */
    expect(result.bootloaderKeys).not.toBeNull();
    expect(equalBytes(result.bootloaderKeys?.keyA ?? new Uint8Array(), keyA)).toBe(true);
    expect(recovered.embedded).not.toBeNull();
    expect(recovered.embedded?.offsetA).toBe(KEY_A_AT);
    expect(recovered.embedded?.adjacent).toBe(true);

    const stem = 'test_dump';
    const tag = addrTag(FLASH_BASE + slotOffset);
    const suffix = keyFilenameSuffix(keyA, keyB);
    const names = namesOf(result.artifacts);
    expect(names).toContain(`decrypted/${stem}_decrypted_${tag}${suffix}.bin`);
    expect(names).toContain(`decrypted/${stem}_decrypted_${tag}.txt`);
    expect(names).toContain(`decrypted/${stem}_${tag}.key`);
    expect(names).toContain('decrypted/decryption_report.txt');
    expect(names).toContain(`decrypted/${stem}_keys.log`);

    /* the per-slot report says which evidence decided the key form */
    const report = result.artifacts.find((a) => a.name.endsWith(`${tag}.txt`));
    const text = new TextDecoder().decode(report?.data ?? new Uint8Array());
    expect(text).toContain('key evidence   :');
    expect(text).toContain("this exact key is in the image's own plaintext");
    expect(text).toContain('Embedded key table : yes');

    if (result.summary.attempted) {
      expect(result.summary.images).toHaveLength(1);
      expect(result.summary.keys).toHaveLength(1);
      expect(result.summary.images[0]?.key).toBe(bytesToHex(keyA));
    } else {
      throw new Error('expected an attempted decryption summary');
    }
  });

  it('detects a duplicated slot and leaves the filename unstamped with no key table', async () => {
    const keyA = makeKey(3);
    const keyB = makeKey(4);
    const { dump, slotOffset } = makeDumpWithImage(keyA, keyB, modern4x);
    /* a second, identical copy one slot along — real cameras ship two */
    dump.set(dump.subarray(slotOffset, slotOffset + IMAGE_SIZE), slotOffset + 0x20000);

    const result = await decryptDump(
      dump,
      'dup',
      { profile: modern4x, dumpPath: 'dup.bin' },
      silentReporter,
    );

    expect(result.slots).toHaveLength(2);
    expect(result.slots[0]?.duplicateOf).toBeNull();
    expect(result.slots[1]?.duplicateOf).toBe(FLASH_BASE + slotOffset);
  });

  it('says so, and emits nothing per-slot, when a buffer holds no image', async () => {
    const result = await decryptDump(
      patternFlash(0x40000),
      'noise',
      { profile: modern4x, dumpPath: 'noise.bin' },
      silentReporter,
    );
    expect(result.slots).toHaveLength(0);
    expect(result.artifacts).toHaveLength(0);
    if (!result.summary.attempted) throw new Error('expected attempted');
    expect(result.summary.note).toBe('no image slots found');
  });
});

/* ==================================================================== *
 * prepareImage — the refusals
 * ==================================================================== */

describe('prepareImage', () => {
  const myKeyA = makeKey(10);
  const myKeyB = makeKey(11);
  const srcKeyA = makeKey(20);
  const srcKeyB = makeKey(21);

  function expectRefusal(fn: () => unknown, code: string): void {
    let thrown: unknown;
    try {
      fn();
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SeekError);
    expect((thrown as SeekError).code).toBe(code);
  }

  it('refuses an image whose filename does not carry its key pair', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = makePlainImage(srcKeyA, srcKeyB, modern4x);
    expectRefusal(() => prepareImage(state, image, 'firmware.bin'), 'flash/refused');
  });

  it('explains differently when the unnamed image does hold this camera keys', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = makePlainImage(myKeyA, myKeyB, modern4x);
    let message = '';
    try {
      prepareImage(state, image, 'firmware.bin');
    } catch (error) {
      message = (error as SeekError).message;
    }
    expect(message).toContain("The image does contain this camera's keys");
    expect(message).toContain(keyFilenameSuffix(myKeyA, myKeyB));
  });

  it('refuses when the named key pair is not actually in the image', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = makePlainImage(srcKeyA, srcKeyB, modern4x);
    const wrong = keyFilenameSuffix(makeKey(30), makeKey(31));
    expectRefusal(() => prepareImage(state, image, `firmware${wrong}.bin`), 'image/key-table');
  });

  it('refuses a size that is not a multiple of 4', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = new Uint8Array(0x4001);
    expectRefusal(() => prepareImage(state, image, 'firmware.bin'), 'image/malformed');
  });

  it('refuses an image with no header magic', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = makePlainImage(srcKeyA, srcKeyB, modern4x);
    viewOf(image).setUint32(HEADER_OFFSET, 0xdeadbeef, true);
    expectRefusal(() => prepareImage(state, image, 'firmware.bin'), 'image/malformed');
  });

  it('refuses an image the bootloader could never boot (>= TRY_KEYS_MAX_LEN)', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = new Uint8Array(TRY_KEYS_MAX_LEN);
    expectRefusal(() => prepareImage(state, image, 'firmware.bin'), 'image/unsupported');
  });

  it('refuses to patch a key that lives inside the cleartext header window', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = makePlainImage(srcKeyA, srcKeyB, modern4x);
    /* move Key A into 0x200..0x23F, where the bootloader reads length in clear */
    image.fill(0, KEY_A_AT, KEY_A_AT + 16);
    image.set(srcKeyA, HEADER_OFFSET + 0x20);
    const suffix = keyFilenameSuffix(srcKeyA, srcKeyB);
    expectRefusal(() => prepareImage(state, image, `fw${suffix}.bin`), 'flash/refused');
  });

  it('refuses when the analysis says this camera cannot be flashed', () => {
    const state: DeviceState = {
      ...makeDeviceState(myKeyA, myKeyB),
      canFlash: false,
      flashBlockedBy: ['no slot decrypts to the acceptance sum'],
    };
    const image = makePlainImage(srcKeyA, srcKeyB, modern4x);
    const suffix = keyFilenameSuffix(srcKeyA, srcKeyB);
    expectRefusal(() => prepareImage(state, image, `fw${suffix}.bin`), 'flash/refused');
  });

  it('refuses outright on a profile that does not support flashing', () => {
    /* legacy-auth now declares flash — the gate, not the capability, scopes it
     * to the plain chain — so the capability refusal left is generic's. */
    const state: DeviceState = { ...makeDeviceState(myKeyA, myKeyB), profile: generic };
    const image = makePlainImage(srcKeyA, srcKeyB, modern4x);
    const suffix = keyFilenameSuffix(srcKeyA, srcKeyB);
    expectRefusal(() => prepareImage(state, image, `fw${suffix}.bin`), 'profile/unsupported');
  });

  /* ---- and the accept path ---------------------------------------- */

  it('retargets a well-formed image and produces a payload the bank guard accepts', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = makePlainImage(srcKeyA, srcKeyB, modern4x);
    const suffix = keyFilenameSuffix(srcKeyA, srcKeyB);

    const prep = prepareImage(state, image, `fw_decrypted_14030000${suffix}.bin`);

    /* the guard that stands between a mistake and a brick passes on this blob */
    expect(() => {
      assertBankPayload(prep.payload);
    }).not.toThrow();
    expect(prep.sum16).toBe(transferSum16(prep.payload));
    expect(prep.payload.length).toBe(0x8000);
    expect(prep.footerOffset).toBe(0x8000 - FOOTER_SIZE);
    expect(prep.footer?.tag).toBe(FOOTER_TAG);
    expect(prep.footer?.length).toBe(IMAGE_SIZE);
    expect(prep.footerFrom).toBe('Slot B');

    /* the image's own key table was rewritten to THIS camera's pair */
    expect(prep.keyPatch.changed).toBe(true);
    expect(prep.keyPatch.offsetA).toBe(KEY_A_AT);
    expect(prep.keyPatch.fromA).toBe(bytesToHex(srcKeyA));
    expect(prep.keyPatch.toA).toBe(bytesToHex(myKeyA));
    expect(prep.carriesMine).toBe(true);

    /* and the caller's buffer was not modified in place */
    expect(equalBytes(image.subarray(KEY_A_AT, KEY_A_AT + 16), srcKeyA)).toBe(true);

    /* decrypting the payload back with Key A returns the retargeted image */
    const back = cryptBytes(
      prep.payload.subarray(0, IMAGE_SIZE),
      stateFromKey(myKeyA, modern4x.cipher.whiteningK),
      modern4x.cipher,
    );
    expect(equalBytes(back.subarray(KEY_A_AT, KEY_A_AT + 16), myKeyA)).toBe(true);
    const header = parseImageHeader(back);
    expect(header?.magic).toBe(IMAGE_MAGIC);
    expect(header?.length).toBe(IMAGE_SIZE);
    expect(prep.length).toBe(IMAGE_SIZE);
    expect(prep.targetName).toBe('Slot B');
    expect(prep.bootedName).toBe('Slot A');
  });

  it('leaves an image that already carries this camera keys alone', () => {
    const state = makeDeviceState(myKeyA, myKeyB);
    const image = makePlainImage(myKeyA, myKeyB, modern4x);
    const suffix = keyFilenameSuffix(myKeyA, myKeyB);
    const prep = prepareImage(state, image, `fw${suffix}.bin`);
    expect(prep.keyPatch.changed).toBe(false);
    expect(prep.carriesMine).toBe(true);
  });
});

/* ==================================================================== *
 * readDeviceInfo
 * ==================================================================== */

describe('readDeviceInfo', () => {
  it('reports everything it can on a camera off the plain chain and refuses to flash', async () => {
    /* legacy-auth deliberately throws from selectBootSlot: its bootloader was
     * never decoded, so it will not fabricate a boot prediction. A device-info
     * run must still complete and say why flashing is off — the profile's
     * capability no longer refuses for it, so the reasons are the gate's: no
     * key table, no acceptance sum, no target, and no bank stored plain (the
     * only form this line's write path stages). */
    const camera = cameraFor(legacyAuth);
    const reporter = collectingReporter();
    const ctx = await contextFor(legacyAuth, camera, reporter);

    const state = await readDeviceInfo(ctx, { chunk: 4096 });

    expect(state.profile.id).toBe('legacy-auth');
    expect(state.boot).toBeNull();
    expect(state.plainChain).toBe(false);
    expect(state.canFlash).toBe(false);
    const blocked = state.flashBlockedBy.join(' ');
    expect(blocked).toContain('key table could not be confirmed');
    expect(blocked).toContain('acceptance sum');
    expect(blocked).toContain('the slot an upgrade would write could not be determined');
    expect(blocked).toContain('implemented only for the 2014 plaintext chain');
    expect(state.slots).toHaveLength(legacyAuth.slots.length);
    /* the emulated flash holds no firmware image, so no slot is present */
    expect(state.slots.every((s) => !s.present)).toBe(true);
    expect(state.cfg0).not.toBeNull();

    /* the authenticated channel is what the evidence saw — "it armed the bank",
     * not "the plain one was refused", because nothing tried the plain one */
    expect(state.evidence.authSelectorWorks).toBe(true);
    expect(state.evidence.plainSelectorWorks).toBeUndefined();
    expect(state.detection.best.profile.id).toBe('legacy-auth');
    /* and on that flag alone the family is a lead, not a verdict: the flag is
     * set by this profile's own map, so it cannot confirm the profile. The
     * camera also reports 1.1.0.0 now (it used to report nothing), and a
     * legacy-line version is what corroborates the detection, not the flag. */
    expect(state.evidence.firmwareVersion).toBe('1.1.0.0');
    const { firmwareVersion: _version, ...channelOnly } = state.evidence;
    expect(detectProfile(channelOnly).ambiguous).toBe(true);

    /* nothing in the flash command set was ever sent */
    const flashOps = new Set([0x50, 0x51]);
    expect(camera.calls.some((c) => flashOps.has(c.op))).toBe(false);
    expect(reporter.events.some((e) => e.type === 'log')).toBe(true);
  }, 60_000);

  it('uses the profile selector map, including the authenticated payloads', async () => {
    const entries = buildLegacyWindowMap();
    expect(entries.some((e) => e.auth === true && e.payload !== undefined)).toBe(true);
    /* a camera that refuses the plain payload proves the workflow sent the
     * 18-byte one: without it, arming the boot-config block would throw */
    const camera = cameraFor(legacyAuth);
    const ctx = await contextFor(legacyAuth, camera);
    await expect(readDeviceInfo(ctx, { chunk: 4096 })).resolves.toBeDefined();
  }, 60_000);

  it('records the plain channel on a profile whose map never sends a token', async () => {
    /* Every arm the 4.x map makes — boot config, bootloader block, slots — is
     * plain, so a run that got anywhere at all has observed the plain channel
     * working on banks the legacy firmware locks, and cannot have observed the
     * authenticated one. */
    const camera = cameraFor(modern4x);
    const ctx = await contextFor(modern4x, camera);

    const state = await readDeviceInfo(ctx, { chunk: 4096 });

    expect(state.evidence.plainSelectorWorks).toBe(true);
    expect(state.evidence.authSelectorWorks).toBeUndefined();
    /* legacy-auth is ruled out by that, not by which profile we acted under */
    const legacyMatch = state.detection.ranked.find((m) => m.profile.id === 'legacy-auth');
    expect(legacyMatch?.score).toBe(0);
  }, 60_000);

  it('arms no slot the plan leaves out: compact-2014 picked by hand, past the gate', async () => {
    /* compact-2014 plans nothing for any version, and a family picked by hand
     * (`--profile compact-2014`, the web app's override) on a camera that
     * reports 0.8.0.0 or later gets past the identity gate. The slot loop used
     * to fall back to each slot descriptor's own subcommand when the plan had
     * no entry, so this read sent BeginFirmwareUpgrade 7, 8 and 9 under a
     * profile whose plan says nothing is readable. A modern camera and a 2014
     * build (whose protected banks refuse the plain arm) both past the gate. */
    for (const camera of [cameraFor(modern4x), legacyBuildCamera('1.3.0.0')]) {
      const state = await readDeviceInfo(await contextFor(compact2014, camera), { chunk: 4096 });
      const version = state.version ?? 'no version';
      const table = compact2014.windowPlan(state.version).table;

      expect(camera.arms, version).toEqual([]);
      expect(
        camera.calls.filter((c) => c.op === OP.BEGIN_FIRMWARE_UPGRADE),
        version,
      ).toEqual([]);
      expect(state.slots.map((s) => s.key)).toEqual(['a', 'b', 'r']);
      for (const slot of state.slots) {
        const label = `${version} ${slot.name}`;
        expect(slot.present, label).toBe(false);
        expect(slot.unread, label).toBe(true);
        /* no selector reached it, so none is reported */
        expect(slot.subcmd, label).toBeNull();
        expect(slot.reason, label).toContain(`not readable on firmware ${version}`);
        expect(slot.reason, label).toContain(hex(slot.address, 8));
        expect(slot.reason, label).toContain(table);
        expect(slot.reason, label).toContain('nothing was armed for it');
        expect(state.flashBlockedBy, label).toContain(
          `${slot.name} could not be read (${slot.reason ?? ''})`,
        );
      }
      expect(state.canFlash, version).toBe(false);
    }
  }, 60_000);

  it('reports the selector the plan armed a slot with, never a guessed one', async () => {
    /* A slot descriptor's subcommand is the profile's label; the plan's entry
     * for that address is what goes on the wire. The state used to report the
     * label, which here names a selector (0x55, 0x58, 0x59) that was never
     * sent and that this camera does not have. */
    const relabelled: FirmwareProfile = {
      ...modern4x,
      id: 'test-relabelled-slots',
      slots: modern4x.slots.map((s) => ({ ...s, subcmd: s.subcmd + 0x50 })),
    };
    const camera = cameraFor(modern4x);
    const state = await readDeviceInfo(await contextFor(relabelled, camera), { chunk: 4096 });

    expect(state.slots.map((s) => s.subcmd)).toEqual([5, 8, 9]);
    expect(state.slots.every((s) => !s.unread)).toBe(true);
    expect(camera.arms.filter((s) => s >= 0x50)).toEqual([]);
  }, 60_000);

  it("arms the upgrade-target selector only when this firmware's own table has it", async () => {
    /* The upgrade-target probe arms `profile.boot.updateTargetSubcmd`. That
     * number is the profile's; whether the running build has it is its table's
     * to say. Here the table carries every window but not subcommand 0, and
     * the read still makes a boot prediction, which is when the probe runs. */
    const noUpgradeRow: FirmwareProfile = {
      ...modern4x,
      id: 'test-no-upgrade-row',
      windowPlan: (version) => {
        const plan = modernWindowPlan(version);
        return { ...plan, selectors: plan.selectors.filter((r) => r.subcmd !== 0) };
      },
    };
    const camera = cameraFor(modern4x);
    const reporter = collectingReporter();
    const state = await readDeviceInfo(await contextFor(noUpgradeRow, camera, reporter), {
      chunk: 4096,
    });

    expect(state.boot).not.toBeNull();
    expect(camera.arms).not.toContain(0);
    expect(state.updateTargetSubcmd).toBeNull();
    expect(state.targetConfirmed).toBeNull();
    expect(state.canFlash).toBe(false);
    expect(state.flashBlockedBy.join('\n')).toContain(
      "no upgrade-target selector 0x0 in this firmware's own table",
    );

    /* and under modern-4x itself the row is there, and it is the one armed */
    const modernCamera = cameraFor(modern4x);
    const modern = await readDeviceInfo(await contextFor(modern4x, modernCamera), {
      chunk: 4096,
    });
    expect(modern.boot).not.toBeNull();
    expect(modern.updateTargetSubcmd).toBe(0);
    expect(modernCamera.arms.at(-1)).toBe(0);
    expect(modern.flashBlockedBy.join('\n')).not.toContain('upgrade-target selector');
  }, 60_000);
});

describe('writeFirmware', () => {
  it('refuses an analysis that does not say which firmware the camera runs', async () => {
    /* Every id the write sends — 0x52, 0x50, 0x51 — is per build. readDeviceInfo
     * refuses a camera that does not name its build, so a state with no version
     * did not come from it, and nothing is sent. */
    const camera = cameraFor(modern4x);
    const ctx = await contextFor(modern4x, camera);
    const state: DeviceState = { ...makeDeviceState(makeKey(60), makeKey(61)), version: null };
    const error = await writeFirmware(ctx, state, {} as PreparedFlash).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('flash/refused');
    expect((error as SeekError).message).toContain('does not say which firmware');
    expect(camera.calls).toHaveLength(0);
  });

  it("refuses an analysis whose firmware's table has no upgrade-target selector", async () => {
    /* The selector the write arms is the one `readDeviceInfo` took from the
     * running build's own table, carried on the state. It used to be the
     * profile's `updateTargetSubcmd`, so an analysis whose table had no such
     * row still had subcommand 0 armed and the payload streamed at it. */
    const keyA = makeKey(62);
    const keyB = makeKey(63);
    const state: DeviceState = { ...makeDeviceState(keyA, keyB), updateTargetSubcmd: null };
    const prep = prepareImage(
      state,
      makePlainImage(keyA, keyB, modern4x),
      `fw${keyFilenameSuffix(keyA, keyB)}.bin`,
    );
    const camera = cameraFor(modern4x);
    const ctx = await contextFor(modern4x, camera);

    const error = await writeFirmware(ctx, state, prep).then(
      () => null,
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(SeekError);
    expect((error as SeekError).code).toBe('flash/refused');
    expect((error as SeekError).message).toContain('no upgrade-target selector');
    expect((error as SeekError).message).toContain('Nothing was written');
    expect(camera.arms).toEqual([]);
    expect(camera.calls).toHaveLength(0);
  });
});

/* ==================================================================== *
 * Offline profile detection
 * ==================================================================== */

describe('detectProfileForDump', () => {
  it('reads the evidence a dump can give about itself without a camera', () => {
    const { dump, slotOffset } = makeDumpWithImage(makeKey(40), makeKey(41), compact2016);
    const evidence = evidenceFromDump(dump);

    /* the acceptance sum is the plaintext word sum, so it is the same number
     * whichever profile computed it — that is what makes detection sound */
    expect(evidence.observedAcceptanceSums).toEqual([0]);
    expect(evidence.imageBaseOffsets).toEqual([slotOffset]);
    /* header.version lives in the cleartext window, so no decryption was needed —
     * and this fixture is a 2016 part, so it says so */
    expect(evidence.imageVersions).toEqual(['1.0.3.0']);
  });

  it('picks compact-2016 for a dump whose slots decrypt to a zero acceptance sum', () => {
    const { dump } = makeDumpWithImage(makeKey(40), makeKey(41), compact2016);
    const detection = detectProfileForDump(dump);
    expect(detection.best.profile.id).toBe('compact-2016');
    expect(detection.ambiguous).toBe(false);
  });

  it('picks modern-4x for a dump whose slots hit the 0x0000FFFF sum', () => {
    const { dump } = makeDumpWithImage(makeKey(42), makeKey(43), modern4x);
    const detection = detectProfileForDump(dump);
    expect(detection.best.profile.id).toBe('modern-4x');
    expect(detection.ambiguous).toBe(false);
  });

  it('decrypts under the detected profile when the caller names none', async () => {
    const keyA = makeKey(44);
    const keyB = makeKey(45);
    const { dump, plain, slotOffset } = makeDumpWithImage(keyA, keyB, compact2016);

    const result = await decryptDump(dump, 'auto', { dumpPath: 'auto.bin' }, silentReporter);

    expect(result.detection?.best.profile.id).toBe('compact-2016');
    const recovered = result.slots[0];
    if (recovered === undefined) throw new Error('no slot decrypted');
    expect(equalBytes(recovered.plain, plain)).toBe(true);
    expect(recovered.recovered.matchesProfile).toBe(true);
    expect(recovered.recovered.confidence).toBe('VERIFIED(profile)');
    expect(recovered.whitening.whiteningK).toBe(0);

    const tag = addrTag(FLASH_BASE + slotOffset);
    expect(namesOf(result.artifacts)).toContain(
      `decrypted/auto_decrypted_${tag}${keyFilenameSuffix(keyA, keyB)}.bin`,
    );
    if (!result.summary.attempted) throw new Error('expected attempted');
    expect(result.summary.note).toContain('compact-2016');
  });

  it('still names the key correctly when forced under the wrong profile', async () => {
    /* The same K=0 / sum=0 dump read as modern-4x: the acceptance sum no longer
     * matches, but the key is still named from the image's own plaintext and
     * the bootloader table is still found, because K and TARGET are separate
     * axes. This is the case the original page got wrong. */
    const keyA = makeKey(46);
    const keyB = makeKey(47);
    const { dump } = makeDumpWithImage(keyA, keyB, compact2016);

    const result = await decryptDump(
      dump,
      'forced',
      { profile: modern4x, dumpPath: 'forced.bin' },
      silentReporter,
    );

    const recovered = result.slots[0];
    if (recovered === undefined) throw new Error('no slot decrypted');
    expect(recovered.recovered.matchesProfile).toBe(false);
    expect(recovered.recovered.confidence).toBe('VERIFIED(structural)');
    expect(recovered.whitening.evidence).toBe('plaintext');
    expect(recovered.whitening.whiteningK).toBe(0);
    expect(recovered.whitening.keyHex).toBe(bytesToHex(keyA));
    expect(result.bootloaderKeys).not.toBeNull();
    expect(recovered.embedded).not.toBeNull();
  });
});

/* Keeps the unused-import checker honest about the type-only fixtures above. */
export type { BankPayload };

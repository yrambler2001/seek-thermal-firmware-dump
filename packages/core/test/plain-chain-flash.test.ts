/* ==================================================================== *
 * The 2014 plaintext chain through the toolkit's NORMAL flash path.
 *
 * THE CAMERA. Compact 1.3.0.0, serial 101310HSNEA2 — the v1 locked line on
 * the plaintext banks: its bootloader accepts a slot that carries the magic
 * 0xA1B2C3D4 at +0x200, a header.length below 0x10000, and whose STORED words
 * sum to 0. No cipher anywhere: the slot bytes are the image, there is no
 * footer, and no key material is involved on any step (`test/firmware` facts;
 * the preservation pipeline's v1-2014 family, whose staged form is `plain`
 * and whose commit is the u16 sum of the staged bytes).
 *
 * WHAT IS CHECKED. `readDeviceInfo` passes the flash gate ON that chain — the
 * key table, the acceptance sum and the boot replay are all cipher-chain
 * questions, and the camera's own active-slot word (the word
 * `fw_update_slot_address()` reads, mode 0's input) names both ends of an
 * upgrade — and `prepareImage`/`writeFirmware` stage and commit the image
 * bytes verbatim. A bank stored under a REAL keystream that merely also sums
 * to 0 (the 1.0.3.x cipher chain) is refused: the identity keystream is the
 * chain's signature, not the sum alone.
 *
 * The camera is the fake (fake-transport.ts) carrying the real dump's
 * geometry: slot A and the recovery bank hold the 1.3.0.0 image plain, slot B
 * is erased, cfg[0] is blank, and modes 2..9 answer only the 18-byte token.
 * The final test, when the real dump is present on this machine, runs the
 * whole path against the dump's own 47,768-byte slot A content.
 * ==================================================================== */

import { existsSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { viewOf } from '../src/bytes.js';
import { cryptBytes } from '../src/crypto/cipher.js';
import { stateFromKey } from '../src/crypto/keys.js';
import { SeekError } from '../src/errors.js';
import { collectingReporter, type Reporter } from '../src/events.js';
import { transferSum16, wordSum32 } from '../src/image/bank.js';
import {
  ADJUST_OFFSET,
  FOOTER_TAG,
  HEADER_OFFSET,
  IMAGE_MAGIC,
  LENGTH_OFFSET,
  TRY_KEYS_MAX_LEN,
  parseImageHeader,
} from '../src/image/header.js';
import { SeekDevice } from '../src/protocol/client.js';
import { OP } from '../src/protocol/ops.js';
import { legacyAuth, OLD_FW_UNLOCK_TOKEN } from '../src/profiles/legacy-auth.js';
import { readDeviceInfo } from '../src/workflows/device-info.js';
import { prepareImage, writeFirmware } from '../src/workflows/flash.js';
import type { DeviceState, WorkflowContext } from '../src/workflows/types.js';
import { fakeCamera, type FakeCamera, type FakeWindowSpec } from './fake-transport.js';

/** The real dump this whole question is about, when this machine has it. */
const REAL_DUMP =
  '/Users/yrambler2001/things/a.noindex/seek/SEEK_DUMPS/compacts/compact_101310HSNEA2_4mb.bin';
const SLOT_A_OFFSET = 0x50000;

/** The real slot A image's own header fields, measured on the dump. */
const REAL = {
  sp: 0x10008000,
  entry: 0x1008066d,
  imageId: 0xfcc4ae8e,
  version: 0x00000301 /* 1.3.0.0, low byte first */,
  length: 47768,
};

/** The flash addresses the v1 chain's own window table arms (modes 0..9). */
function legacyWindows(): FakeWindowSpec[] {
  return (
    [
      [0, 0x60000],
      [1, 0x20000],
      [2, 0x0],
      [3, 0x10000],
      [4, 0x20000],
      [5, 0x30000],
      [6, 0x40000],
      [7, 0x50000],
      [8, 0x60000],
      [9, 0x70000],
    ] as const
  ).map(([subcmd, offset]) => ({ subcmd, offset }));
}

/** `GetFirmwareInfo` selector 0: the build block — four version bytes, then
 *  the build string, exactly what the 1.3.0.0 image answers. */
function buildBlock(): Uint8Array {
  const out = new Uint8Array(36);
  out.set([1, 3, 0, 0], 0);
  out.set(new TextEncoder().encode('Oct 21 2014'), 4);
  return out;
}

/** Selector 10, the roots: word 2 is the active slot `fw_update_slot_address()`
 *  reads. 0 means the blank record's slot A is running, so the function arms
 *  slot B — the upgrade target. */
function rootsBlock(activeSlot: number): Uint8Array {
  const out = new Uint8Array(12);
  viewOf(out).setUint32(8, activeSlot, true);
  return out;
}

/** The 28-byte boot-config record as the dump holds it: cfg[0] blank (the
 *  bootloader's fixed A -> B -> recovery order boots A), then the slot table. */
function bootConfigBlock(): Uint8Array {
  const out = new Uint8Array(0x120).fill(0xff);
  const dv = viewOf(out);
  dv.setUint32(0, 0, true);
  dv.setUint32(4, 0x14050000, true);
  dv.setUint32(8, 0x14060000, true);
  dv.setUint32(12, 0x14070000, true);
  return out;
}

/**
 * The 1.3.0.0 image as the chain stores it: a sane vector table (words 7..10
 * zero — the GF(2) solve's input), the header at 0x200 with the measured
 * fields, and the adjust word at +0x238 balancing the stored word sum to the
 * bootloader's 0. 47,768 B, like the real slot A.
 */
export function plainImage2014(): Uint8Array {
  const image = new Uint8Array(REAL.length);
  const dv = viewOf(image);
  dv.setUint32(0, REAL.sp, true);
  dv.setUint32(4, REAL.entry, true);
  dv.setUint32(HEADER_OFFSET + 0, IMAGE_MAGIC, true);
  dv.setUint32(LENGTH_OFFSET, REAL.length, true);
  dv.setUint32(HEADER_OFFSET + 8, REAL.imageId, true);
  dv.setUint32(HEADER_OFFSET + 12, REAL.version, true);
  dv.setUint32(HEADER_OFFSET + 16, REAL.entry, true);
  /* some non-zero code words, so "plain" is not confused with "empty" */
  for (let i = 0x240; i < 0x340; i += 4) dv.setUint32(i, (0x69000000 + i) >>> 0, true);
  let sum = 0;
  for (let i = 0; i < REAL.length; i += 4) sum = (sum + dv.getUint32(i, true)) >>> 0;
  dv.setUint32(ADJUST_OFFSET, (0 - sum) >>> 0, true);
  return image;
}

/**
 * The v1 camera: plain banks, token-locked modes 2..9, blank cfg[0], roots
 * naming slot A active. Plain banks hold `plainImage2014()` in slot A and the
 * recovery bank; slot B stays erased, as on the real dump. With `plain: false`
 * the same image sits under a real keystream instead — the 1.0.3.x form.
 */
function camera2014(options: { plain?: boolean } = {}): FakeCamera {
  const flash = new Uint8Array(4 * 1024 * 1024).fill(0xff);
  const image = plainImage2014();
  if (options.plain !== false) {
    flash.set(image, SLOT_A_OFFSET);
    flash.set(image, 0x70000);
  } else {
    const key = stateFromKey(new Uint8Array(16).fill(0x5a), 0);
    flash.set(cryptBytes(image, key, legacyAuth.cipher), SLOT_A_OFFSET);
  }
  flash.set(bootConfigBlock(), 0x10000);
  return fakeCamera({
    flash,
    windows: legacyWindows(),
    authBanks: [2, 3, 4, 5, 6, 7, 8, 9],
    authToken: OLD_FW_UNLOCK_TOKEN,
    fwInfo: new Map([
      [0, buildBlock()],
      [10, rootsBlock(0)],
    ]),
  });
}

async function contextFor(camera: FakeCamera, reporter: Reporter): Promise<WorkflowContext> {
  await camera.open();
  return {
    device: new SeekDevice(camera, { reporter }),
    profile: legacyAuth,
    detection: null,
    reporter,
  };
}

/** The analysis the flash path acts on, over the v1 camera. */
async function read2014(camera: FakeCamera): Promise<DeviceState> {
  return readDeviceInfo(await contextFor(camera, collectingReporter()), { chunk: 4096 });
}

function logsOf(reporter: { readonly events: { readonly type: string }[] }): string {
  return reporter.events
    .filter((e): e is { type: 'log'; message: string } => e.type === 'log')
    .map((e) => e.message)
    .join('\n');
}

describe('the 2014 plaintext chain on the normal flash path', () => {
  it('passes the flash gate, and the gate says why', async () => {
    const reporter = collectingReporter();
    const state = await readDeviceInfo(await contextFor(camera2014(), reporter));

    /* the premise: the chain camera, read under the profile the locked line
     * probes as (the plain refusal of a protected bank plus the token working) */
    expect(state.version).toBe('1.3.0.0');
    expect(state.profile.id).toBe('legacy-auth');
    expect(state.keyTable).toBeNull();
    expect(state.plainChain).toBe(true);

    /* the gate */
    expect(state.canFlash, state.flashBlockedBy.join('\n')).toBe(true);
    expect(state.flashBlockedBy).toEqual([]);
    expect(logsOf(reporter)).toContain('2014 plaintext chain');

    /* the upgrade target: the camera's own active-slot word, not a replay */
    expect(state.boot).toEqual({ booted: 'a', target: 'b' });
    expect(state.updateTargetSubcmd).toBe(0);
  }, 60_000);

  it('stages the plain image verbatim — no cipher, no footer, no keys', async () => {
    const state = await read2014(camera2014());
    const image = plainImage2014();

    const prep = prepareImage(state, image, 'compact_1.3.0.0.bin');

    expect(prep.plainChain).toBe(true);
    /* the payload IS the image bytes, word for word */
    expect(prep.payload.length).toBe(image.length);
    expect(Buffer.from(prep.payload).equals(Buffer.from(image))).toBe(true);
    /* the bootloader's own acceptance: the stored words sum to 0 */
    expect(wordSum32(prep.payload, prep.payload.length)).toBe(0);
    /* the commit's own gate: the u16 sum of the staged bytes */
    expect(prep.sum16).toBe(transferSum16(prep.payload));
    /* no footer — the chain's slots hold the image alone */
    expect(prep.footer).toBeNull();
    expect(prep.footerFrom).toBeNull();
    /* no keys anywhere in it */
    expect(prep.keyPatch.changed).toBe(false);
    expect(prep.keyPatch.where).toMatch(/plaintext chain/);
    expect(prep.targetName).toBe('App image bank 0x14060000');
    expect(prep.bootedName).toBe('App image bank 0x14050000');
    expect(prep.lengthStamped).toBe(false);
  }, 60_000);

  it('commits the bytes into the update slot and leaves the rest of the camera alone', async () => {
    const camera = camera2014();
    const state = await read2014(camera);
    const image = plainImage2014();
    const prep = prepareImage(state, image, 'compact_1.3.0.0.bin');
    const reporter = collectingReporter();

    await writeFirmware(await contextFor(camera, reporter), state, prep);

    /* exactly one commit went out, after the arm of the upgrade-target selector */
    expect(camera.calls.filter((c) => c.op === OP.COMPLETE_MEMORY_UPGRADE)).toHaveLength(1);
    expect(camera.arms).toContain(0);
    /* slot B — the bank mode 0 arms — now holds the staged bytes, verbatim */
    const written = camera.flash.subarray(0x60000, 0x60000 + image.length);
    expect(Buffer.from(written).equals(Buffer.from(image))).toBe(true);
    /* and past the image the block is erased, as the commit leaves it */
    expect(camera.flash[0x60000 + image.length]).toBe(0xff);
    /* the running bank, the recovery bank and the boot record are untouched */
    expect(camera.flash[SLOT_A_OFFSET + HEADER_OFFSET]).toBe(0xd4); /* magic byte */
    expect(camera.flash[0x70000 + HEADER_OFFSET]).toBe(0xd4); /* magic byte */
    expect(viewOf(camera.flash.subarray(0x10000, 0x10004)).getUint32(0, true)).toBe(0);
    expect(logsOf(reporter)).toMatch(/stored verbatim/);
  }, 60_000);

  it('refuses a bank that sums to zero under a REAL keystream — the identity is the signature', async () => {
    /* the 1.0.3.x cipher chain: the same image, encrypted, whose decrypted sum
     * is 0 — but the stored bytes are a keystream apart, and staging them
     * verbatim would write ciphertext where the chain wants an image */
    const state = await read2014(camera2014({ plain: false }));

    expect(state.plainChain).toBe(false);
    expect(state.canFlash).toBe(false);
    expect(state.flashBlockedBy.join(' ')).toContain('2014 plaintext chain');
    expect(state.updateTargetSubcmd).toBeNull();
    let refused: unknown = null;
    try {
      prepareImage(state, plainImage2014(), 'compact_1.3.0.0.bin');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(SeekError);
    expect((refused as SeekError).code).toBe('flash/refused');
  }, 60_000);

  it("refuses an image past the chain's staging buffer, which holds 0xE000 bytes", async () => {
    const state = await read2014(camera2014());
    const image = plainImage2014();
    const big = new Uint8Array(TRY_KEYS_MAX_LEN - 4); /* < 0x10000, > 0xE000 */
    big.set(image.subarray(0, 0x240));
    viewOf(big).setUint32(LENGTH_OFFSET, big.length, true);
    let refused: unknown = null;
    try {
      prepareImage(state, big, 'compact_big.bin');
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(SeekError);
    expect((refused as SeekError).code).toBe('image/unsupported');
    expect((refused as SeekError).message).toContain('staging buffer');
  }, 60_000);

  it(
    'rounds the REAL dump’s own slot A image through the whole path',
    { timeout: 60_000 },
    async () => {
      if (!existsSync(REAL_DUMP)) {
        process.stderr.write(`\n[skip] the real dump is not on this machine: ${REAL_DUMP}\n`);
        return;
      }
      const dump = readFileSync(REAL_DUMP);
      const head = parseImageHeader(
        new Uint8Array(dump.buffer, dump.byteOffset + SLOT_A_OFFSET, 0x10000),
      );
      expect(head?.versionStr).toBe('1.3.0.0');
      const slotA = new Uint8Array(dump.buffer, dump.byteOffset + SLOT_A_OFFSET, head?.length ?? 0);

      const camera = camera2014();
      const state = await read2014(camera);
      expect(state.canFlash).toBe(true);
      const prep = prepareImage(state, slotA, 'compact_101310HSNEA2_slotA.bin');

      /* verbatim: the staged payload is the camera's own bytes, unmodified */
      expect(prep.lengthStamped).toBe(false);
      expect(prep.payload.length).toBe(REAL.length);
      expect(Buffer.from(prep.payload).equals(Buffer.from(slotA))).toBe(true);

      await writeFirmware(await contextFor(camera, collectingReporter()), state, prep);
      const written = camera.flash.subarray(0x60000, 0x60000 + REAL.length);
      expect(Buffer.from(written).equals(Buffer.from(slotA))).toBe(true);
      /* and the footer position stays erased — this chain keeps none */
      expect(viewOf(camera.flash.subarray(0x60000, 0x70000)).getUint32(0xbfc0, true)).not.toBe(
        FOOTER_TAG,
      );
    },
  );
});

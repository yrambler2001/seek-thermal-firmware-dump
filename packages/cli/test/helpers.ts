/**
 * Test fixtures: a synthetic but genuinely valid flash image, a fake camera
 * behind core's own `UsbTransport`, and an `Io` made of memory sinks.
 *
 * The image is built with core's helpers rather than a captured blob, so the
 * fixtures cannot drift from the cipher and the packaging they exercise.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADJUST_OFFSET,
  CHECK_ZERO_IDX,
  FOOTER_SIZE,
  HEADER_OFFSET,
  IMAGE_MAGIC,
  KNOWN_ZERO_IDX,
  buildBankPayload,
  modern4x,
  setAcceptSum,
  utf8,
  viewOf,
  type UsbBackend,
  type UsbTransport,
} from '@seek-fw/core';
import { fakeCamera, type FakeCameraOptions } from '../../core/test/fake-transport.js';
import type { BackendOptions } from '../src/backend.js';
import type { Io } from '../src/cli.js';
import { MemorySink } from '../src/sink.js';

/* Taken off the profile rather than written out again: the root barrel does not
 * re-export the modern family's address constants, and a second copy of
 * 0x14030000 in the fixtures is exactly the kind of drift these tests exist to
 * catch. */
export const FLASH_BASE = modern4x.memory.flashBase;
export const FLASH_SIZE = modern4x.memory.flashSize;

export function slotOffsetOf(key: 'a' | 'b' | 'r'): number {
  return slotAddress(key) - FLASH_BASE;
}

function slotAddress(key: 'a' | 'b' | 'r'): number {
  const slot = modern4x.slots.find((descriptor) => descriptor.key === key);
  if (slot === undefined) throw new Error(`the modern profile has no slot '${key}'`);
  return slot.address;
}

/** A key pair with no 0x14 in the first word, so it cannot look like a pointer. */
export const KEY_A = Uint8Array.from([
  0xf3, 0x2a, 0xd7, 0x71, 0x5c, 0x0e, 0x99, 0x42, 0xab, 0x13, 0x77, 0x60, 0x08, 0xc4, 0x31, 0xde,
]);
export const KEY_B = Uint8Array.from([
  0x99, 0x7e, 0xd6, 0xe5, 0x21, 0x84, 0x3b, 0xf0, 0x6d, 0x5a, 0xc2, 0x17, 0x90, 0x0b, 0xee, 0x38,
]);

export const IMAGE_LENGTH = 0x1000;

/**
 * A plaintext firmware image the cryptanalytic recovery can actually solve:
 * the four reserved vectors it treats as known plaintext are zero, word 13
 * (its free self-check) is zero, and the stack pointer and reset vector look
 * like an LPC43xx build. The key pair is embedded once, exactly as a real
 * image carries its own g_keyA/g_keyB.
 */
export function buildPlainImage(
  keys: { readonly keyA: Uint8Array; readonly keyB: Uint8Array } = { keyA: KEY_A, keyB: KEY_B },
): Uint8Array {
  const image = new Uint8Array(IMAGE_LENGTH);
  const dv = viewOf(image);

  dv.setUint32(0, 0x10004000, true); /* SP in SRAM, word-aligned */
  dv.setUint32(4, 0x1403_0201, true); /* reset vector, Thumb */
  const zero = new Set<number>([...KNOWN_ZERO_IDX, CHECK_ZERO_IDX]);
  for (let index = 2; index < 64; index++) {
    if (zero.has(index)) continue;
    dv.setUint32(4 * index, (0x1403_1000 + index * 4) >>> 0, true);
  }

  /* The image's own key table, at a fixed offset outside the header window. */
  image.set(keys.keyA, 0x300);
  image.set(keys.keyB, 0x310);

  /* Some body bytes so the image is not mostly zeroes. */
  for (let offset = 0x400; offset < IMAGE_LENGTH; offset += 4) {
    dv.setUint32(offset, (offset * 2654435761) >>> 0, true);
  }

  dv.setUint32(HEADER_OFFSET + 0, IMAGE_MAGIC, true);
  dv.setUint32(HEADER_OFFSET + 4, IMAGE_LENGTH, true);
  dv.setUint32(HEADER_OFFSET + 8, 0x0000_2a01, true); /* image id */
  dv.setUint32(HEADER_OFFSET + 12, 0x0005_0904, true); /* version 4.9.5.0 */
  dv.setUint32(HEADER_OFFSET + 16, 0x1403_0201, true); /* entry */
  dv.setUint32(ADJUST_OFFSET, 0, true);

  return setAcceptSum(image, modern4x.cipher).image;
}

export interface SyntheticFlash {
  readonly flash: Uint8Array;
  /** The stamped plaintext, i.e. what a decrypt of slot A must reproduce. */
  readonly plain: Uint8Array;
  /** The whole bank as the camera holds it: image + 0xFF pad + CODE footer. */
  readonly bank: Uint8Array;
  readonly slotOffset: number;
}

/** A device footer to carry over, so the bank looks like one a camera shipped. */
function footerTemplate(): Uint8Array {
  const template = new Uint8Array(FOOTER_SIZE);
  const dv = viewOf(template);
  dv.setUint32(8, 0x0000_2a01, true); /* image id */
  dv.setUint32(12, 0x0005_0904, true); /* version */
  template.set(utf8('SYNTH-PRO'), 16);
  return template;
}

/**
 * A 4 MiB flash carrying the bootloader's key table in its first block and one
 * encrypted firmware image in slot A — enough for detection, key recovery,
 * key-table identification and filename stamping to all have something real to
 * work on.
 */
export function buildSyntheticFlash(
  options: {
    /** The pair slot A's application embeds. Default: the bootloader's own. */
    readonly appKeys?: { readonly keyA: Uint8Array; readonly keyB: Uint8Array };
  } = {},
): SyntheticFlash {
  const flash = new Uint8Array(FLASH_SIZE).fill(0xff);
  /* The bank is built by core's own packaging, so slot A is byte-for-byte
   * what this tool would have written — footer included, which is what makes
   * the slot bootable rather than merely decryptable. */
  const bank = buildBankPayload(
    buildPlainImage(options.appKeys),
    KEY_A,
    footerTemplate(),
    modern4x.cipher,
    modern4x.memory.windowSize,
  );

  /* The bootloader's key table: the boot-config base as the anchor word,
   * then Key A and Key B, exactly as `findKeyCandidates` looks for it. */
  const tableAt = 0x1000;
  viewOf(flash).setUint32(tableAt, modern4x.memory.bootConfigBase, true);
  flash.set(KEY_A, tableAt + 4);
  flash.set(KEY_B, tableAt + 20);

  const slotOffset = slotAddress('a') - FLASH_BASE;
  flash.set(bank.payload, slotOffset);
  return { flash, plain: bank.image, bank: bank.payload, slotOffset };
}

/** Another camera's key pair, for the retargeting path. */
export const FOREIGN_KEY_A = Uint8Array.from([
  0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x0f, 0x10,
]);
export const FOREIGN_KEY_B = Uint8Array.from([
  0x21, 0x32, 0x43, 0x54, 0x65, 0x76, 0x87, 0x98, 0xa9, 0xba, 0xcb, 0xdc, 0xed, 0xfe, 0x1f, 0x20,
]);

/**
 * GetFirmwareInfo selector 0 of the build `buildPlainImage` stamps: 4.9.5.0.
 *
 * The camera reports the version of the image it runs, as every corpus build
 * does. Until the version rule (identity-gate.test.ts) this fixture reported
 * nothing, which a dump, a sweep and an analysis now refuse.
 */
export function runningBuildBlock(): Uint8Array {
  const block = new Uint8Array(36);
  block.set([4, 9, 5, 0], 0);
  block.set(utf8('Sep 20 2026 00:00:00'), 4);
  return block;
}

/** A fake camera wired to the selector map the modern profile actually issues. */
export function cameraWithFlash(
  flash: Uint8Array,
  options: Omit<FakeCameraOptions, 'flash' | 'windows'> = {},
): ReturnType<typeof fakeCamera> {
  const windows = modern4x
    .windowMap()
    .map((entry) => ({ subcmd: entry.subcmd, offset: entry.address - FLASH_BASE }));
  /* Selector 0 is the camera-resolved upgrade target: it is not in the map
   * because the camera picks the slot itself. Slot A is booted here, so it
   * resolves to slot B. */
  windows.push({
    subcmd: modern4x.boot.updateTargetSubcmd,
    offset: slotAddress('b') - FLASH_BASE,
  });
  return fakeCamera({ fwInfo: new Map([[0, runningBuildBlock()]]), ...options, flash, windows });
}

/** A `UsbBackend` that hands out exactly the transports it was given. */
export function fixedBackend(
  transports: readonly UsbTransport[],
): (options: BackendOptions) => UsbBackend {
  return (_options: BackendOptions): UsbBackend => ({
    listDevices: (): Promise<UsbTransport[]> => Promise.resolve([...transports]),
    requestDevice: (): Promise<UsbTransport> => {
      const first = transports[0];
      if (first === undefined) return Promise.reject(new Error('no devices'));
      return Promise.resolve(first);
    },
  });
}

export interface TestIo {
  readonly io: Io;
  readonly stdout: MemorySink;
  readonly stderr: MemorySink;
  /** Questions `confirm` was asked. */
  readonly questions: string[];
}

export function testIo(
  overrides: Partial<Io> & {
    /** The answer for every `confirm` question. */
    readonly answer?: boolean;
    /** Per-question answers, in order; `answer` covers the rest. */
    readonly answers?: readonly boolean[];
  } = {},
): TestIo {
  const stdout = new MemorySink(overrides.stdout instanceof MemorySink ? {} : {});
  const stderr = new MemorySink();
  const questions: string[] = [];
  const io: Io = {
    stdout,
    stderr,
    env: { NO_COLOR: '1' },
    stdinIsTty: false,
    platform: 'linux',
    version: '2.0.0-test',
    confirm: (question: string): Promise<boolean> => {
      const perQuestion = overrides.answers?.[questions.length];
      questions.push(question);
      return Promise.resolve((perQuestion ?? overrides.answer) === true);
    },
    ...stripTestOnly(overrides),
  };
  return { io, stdout, stderr, questions };
}

function stripTestOnly(
  overrides: Partial<Io> & { readonly answer?: boolean; readonly answers?: readonly boolean[] },
): Partial<Io> {
  const { answer: _answer, answers: _answers, ...rest } = overrides;
  return rest;
}

/** A temp directory that the caller removes with the returned function. */
export async function tempDir(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const path = await mkdtemp(join(tmpdir(), 'seek-fw-cli-'));
  return {
    path,
    cleanup: async (): Promise<void> => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * The write path.
 *
 * Two of these are the refusals the CLI itself owns — no camera is involved,
 * and the injected backend throws if anything reaches for one. The rest drive
 * the whole thing against core's fake camera: rescue dump, plan, prompt,
 * stream and commit, ending with a readback that proves what actually landed
 * in the slot.
 */

import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OP,
  bytesToHex,
  cryptImage,
  hexDump,
  keyFilenameSuffix,
  modern4x,
  stateFromKey,
  viewOf,
} from '@seek-fw/core';
import { run } from '../src/cli.js';
import { EXIT_FAILED, EXIT_OK } from '../src/errors.js';
import {
  FOREIGN_KEY_A,
  FOREIGN_KEY_B,
  IMAGE_LENGTH,
  KEY_A,
  KEY_B,
  buildPlainImage,
  buildSyntheticFlash,
  cameraWithFlash,
  fixedBackend,
  slotOffsetOf,
  tempDir,
  testIo,
  type SyntheticFlash,
} from './helpers.js';
import type { UsbBackend } from '@seek-fw/core';

let dir = '';
let cleanup: () => Promise<void> = (): Promise<void> => Promise.resolve();
let synthetic: SyntheticFlash;

beforeEach(async () => {
  const temp = await tempDir();
  dir = temp.path;
  cleanup = temp.cleanup;
  synthetic = buildSyntheticFlash();
});
afterEach(async () => {
  await cleanup();
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

/** A backend that fails the test if anything tries to touch a camera. */
function forbiddenBackend(): () => UsbBackend {
  return (): UsbBackend => ({
    listDevices: (): Promise<never> =>
      Promise.reject(new Error('the camera must not be touched on this path')),
    requestDevice: (): Promise<never> =>
      Promise.reject(new Error('the camera must not be touched on this path')),
  });
}

/** An image file named with the key pair it embeds, as `dump` writes them. */
async function writeImage(
  keys: { readonly keyA: Uint8Array; readonly keyB: Uint8Array },
  name = 'fw',
): Promise<string> {
  const path = join(dir, `${name}${keyFilenameSuffix(keys.keyA, keys.keyB)}.bin`);
  await writeFile(path, buildPlainImage(keys));
  return path;
}

describe('seek-fw flash refusals', () => {
  it('refuses when stdin is not a tty and --yes was not given', async () => {
    const image = await writeImage({ keyA: KEY_A, keyB: KEY_B });
    const { io, stderr } = testIo({ backend: forbiddenBackend(), stdinIsTty: false });
    const code = await run(['flash', image], io, signal());

    expect(code).toBe(EXIT_FAILED);
    expect(stderr.text).toContain('stdin is not a terminal');
    expect(stderr.text).toContain('--yes');
    /* And it decided that before opening anything. */
    expect(stderr.text).not.toContain('must not be touched');
  });

  it('refuses a profile that does not support flashing, before any device i/o', async () => {
    const image = await writeImage({ keyA: KEY_A, keyB: KEY_B });
    const { io, stderr } = testIo({ backend: forbiddenBackend(), stdinIsTty: true });
    const code = await run(['flash', image, '--profile', 'generic', '--yes'], io, signal());

    expect(code).toBe(EXIT_FAILED);
    expect(stderr.text).toContain('does not support flash');
    expect(stderr.text).not.toContain('must not be touched');
  });

  it('reports the refusal as JSON under --json', async () => {
    const image = await writeImage({ keyA: KEY_A, keyB: KEY_B });
    const { io, stdout } = testIo({ backend: forbiddenBackend(), stdinIsTty: false });
    const code = await run(['flash', image, '--json'], io, signal());
    expect(code).toBe(EXIT_FAILED);
    expect(JSON.parse(stdout.text)).toMatchObject({
      command: 'flash',
      ok: false,
      error: { code: 'flash/refused' },
    });
  });

  it('refuses an image whose name does not carry its key pair', async () => {
    const path = join(dir, 'unnamed.bin');
    await writeFile(path, buildPlainImage());
    const camera = cameraWithFlash(synthetic.flash);
    const { io, stderr } = testIo({ backend: fixedBackend([camera]), stdinIsTty: true });
    const code = await run(
      ['flash', path, '--yes', '--no-rescue-dump', '--chunk', '65536'],
      io,
      signal(),
    );

    expect(code).toBe(EXIT_FAILED);
    expect(stderr.text).toContain("this file's name does not carry its key pair");
    /* Nothing was staged or committed. */
    const sent = new Set(camera.calls.map((call) => call.op));
    expect(sent.has(OP.SET_FEATURED_FIRMWARE_DATA)).toBe(false);
    expect(sent.has(OP.COMPLETE_MEMORY_UPGRADE)).toBe(false);
  });

  it('refuses a camera whose running application does not carry its keys, before staging anything', async () => {
    /* FW-V1 Phase 51, Mosaic 10.9.1.31: the bootloader holds one pair, the running
     * application embeds another and decrypts every upload with ITS Key A, so the
     * commit answers OK and the camera boots the old slot. The flash must say so
     * up front (TESTING.md sec.21.2). Here slot A's application carries a foreign
     * pair while the bootloader's table holds KEY_A / KEY_B; then only Key B. */
    for (const [appKeys, why] of [
      [{ keyA: FOREIGN_KEY_A, keyB: FOREIGN_KEY_B }, "does not carry this camera's Key A"],
      [{ keyA: KEY_A, keyB: FOREIGN_KEY_B }, "carries this camera's Key A but not its Key B"],
    ] as const) {
      const camera = cameraWithFlash(buildSyntheticFlash({ appKeys }).flash);
      const image = await writeImage({ keyA: KEY_A, keyB: KEY_B });
      const before = camera.flash.slice(slotOffsetOf('b'), slotOffsetOf('b') + IMAGE_LENGTH);
      const { io, stderr } = testIo({ backend: fixedBackend([camera]), stdinIsTty: true });
      const code = await run(
        ['flash', image, '--yes', '--no-rescue-dump', '--chunk', '65536'],
        io,
        signal(),
      );

      expect(code, why).toBe(EXIT_FAILED);
      expect(stderr.text, why).toContain('cannot be flashed from here');
      expect(stderr.text, why).toContain(why);
      const sent = new Set(camera.calls.map((call) => call.op));
      expect(sent.has(OP.SET_FEATURED_FIRMWARE_DATA), why).toBe(false);
      expect(sent.has(OP.COMPLETE_MEMORY_UPGRADE), why).toBe(false);
      expect(camera.flash.slice(slotOffsetOf('b'), slotOffsetOf('b') + IMAGE_LENGTH), why).toEqual(
        before,
      );
    }
  });

  it('writes nothing when the prompt is answered no', async () => {
    const image = await writeImage({ keyA: KEY_A, keyB: KEY_B });
    const camera = cameraWithFlash(synthetic.flash);
    const before = camera.flash.slice(slotOffsetOf('b'), slotOffsetOf('b') + 0x100);
    const { io, stderr, questions } = testIo({
      backend: fixedBackend([camera]),
      stdinIsTty: true,
      answer: false,
    });
    const code = await run(['flash', image, '--no-rescue-dump', '--chunk', '65536'], io, signal());

    expect(code).toBe(EXIT_FAILED);
    expect(questions).toHaveLength(1);
    expect(questions[0]).toContain('Slot B');
    expect(stderr.text).toContain('aborted at the confirmation prompt');
    expect(camera.flash.slice(slotOffsetOf('b'), slotOffsetOf('b') + 0x100)).toEqual(before);
  });
});

describe('seek-fw flash', () => {
  it('backs up, retargets the keys, asks, writes, and says what is still unproven', async () => {
    const image = await writeImage({ keyA: FOREIGN_KEY_A, keyB: FOREIGN_KEY_B }, 'foreign');
    const camera = cameraWithFlash(synthetic.flash);
    const rescueDir = join(dir, 'rescue');
    const { io, stdout, questions } = testIo({
      backend: fixedBackend([camera]),
      stdinIsTty: true,
      answer: true,
    });

    const code = await run(['flash', image, '--out', rescueDir, '--chunk', '65536'], io, signal());
    expect(code).toBe(EXIT_OK);

    /* The rescue dump came first, and it is a real archive. */
    const rescue = await readdir(rescueDir);
    expect(rescue).toContain('manifest.json');
    expect(rescue).toContain('flash_4m_usb_partial_gap_ff.bin');

    /* The plan was shown before the question was asked. */
    expect(stdout.text).toContain('Flash plan');
    expect(stdout.text).toContain('key retargeting');
    expect(stdout.text).toContain('transfer checksum');
    expect(stdout.text).toContain('target slot');
    expect(questions).toHaveLength(1);

    /* Core's post-commit warning, verbatim and not hidden behind --verbose. */
    expect(stdout.text).toContain('NOW UNPLUG AND REPLUG THE CAMERA.');
    expect(stdout.text).toContain('Proven so far:');
    expect(stdout.text).toContain('NOT proven');

    /* What actually landed in slot B: the image, encrypted under THIS
     * camera's Key A, carrying THIS camera's key table rather than the one it
     * was built with. */
    const at = slotOffsetOf('b');
    const bank = camera.flash.subarray(at, at + IMAGE_LENGTH);

    /* The plan showed the head of those very bytes before the prompt: a
     * checksum says two things differ, the hex says what is being written. */
    expect(stdout.text).toContain('First 64 bytes of the payload');
    for (const row of hexDump(camera.flash.subarray(at, at + 64)).split('\n')) {
      expect(stdout.text).toContain(row);
    }

    const plain = cryptImage(
      viewOf(bank),
      0,
      IMAGE_LENGTH,
      stateFromKey(KEY_A, modern4x.cipher.whiteningK),
      modern4x.cipher,
    );
    expect(bytesToHex(plain.subarray(0x300, 0x310))).toBe(bytesToHex(KEY_A));
    expect(bytesToHex(plain.subarray(0x310, 0x320))).toBe(bytesToHex(KEY_B));
    expect(viewOf(plain).getUint32(0x200, true)).toBe(0xa1b2c3d4);
  });

  it('shows the plan even under --quiet, because it is about to be confirmed', async () => {
    const image = await writeImage({ keyA: KEY_A, keyB: KEY_B }, 'quiet');
    const camera = cameraWithFlash(synthetic.flash);
    const { io, stdout, questions } = testIo({
      backend: fixedBackend([camera]),
      stdinIsTty: true,
      answer: false,
    });

    const code = await run(
      ['flash', image, '--no-rescue-dump', '--chunk', '65536', '--quiet'],
      io,
      signal(),
    );
    expect(code).toBe(EXIT_FAILED);
    expect(questions).toHaveLength(1);
    expect(stdout.text).toContain('Flash plan');
    expect(stdout.text).toContain('transfer checksum');
    expect(stdout.text).toContain('First 64 bytes of the payload');
  });

  it('--no-rescue-dump skips the backup and says what that costs', async () => {
    const image = await writeImage({ keyA: KEY_A, keyB: KEY_B });
    const camera = cameraWithFlash(synthetic.flash);
    const { io, stdout } = testIo({
      backend: fixedBackend([camera]),
      stdinIsTty: true,
      answer: true,
    });

    const code = await run(
      ['flash', image, '--no-rescue-dump', '--chunk', '65536', '--json'],
      io,
      signal(),
    );
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(stdout.text) as {
      written: boolean;
      rescueDump: { taken: boolean; reason: string | null };
      plan: { keyPatch: { changed: boolean }; targetSlot: string; transferChecksum: string };
    };
    expect(parsed.written).toBe(true);
    expect(parsed.rescueDump).toMatchObject({ taken: false, reason: '--no-rescue-dump' });
    /* The file already carried this camera's pair, so nothing was rewritten. */
    expect(parsed.plan.keyPatch.changed).toBe(false);
    expect(parsed.plan.targetSlot).toBe('Slot B');
    expect(parsed.plan.transferChecksum).toMatch(/^0x[0-9A-F]{4}$/);
  });
});

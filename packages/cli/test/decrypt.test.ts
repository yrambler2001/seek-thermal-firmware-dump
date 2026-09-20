/**
 * The offline path, end to end through `run()` — no camera, no backend, no
 * USB permission. The dump it is given is synthesised with core's own cipher
 * helpers, so what is asserted here is that the CLI wires the real pipeline
 * up, not that a fixture was copied correctly.
 */

import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bytesToHex } from '@seek-fw/core';
import { run } from '../src/cli.js';
import { EXIT_FAILED, EXIT_OK } from '../src/errors.js';
import { KEY_A, KEY_B, buildSyntheticFlash, tempDir, testIo } from './helpers.js';

let dir = '';
let cleanup: () => Promise<void> = (): Promise<void> => Promise.resolve();
let dumpPath = '';
let plain: Uint8Array;

beforeEach(async () => {
  const temp = await tempDir();
  dir = temp.path;
  cleanup = temp.cleanup;
  const synthetic = buildSyntheticFlash();
  plain = synthetic.plain;
  dumpPath = join(dir, 'flash_4m_usb_partial_gap_ff.bin');
  await writeFile(dumpPath, synthetic.flash);
});
afterEach(async () => {
  await cleanup();
});

function signal(): AbortSignal {
  return new AbortController().signal;
}

describe('seek-fw decrypt', () => {
  it('decrypts a dump with no camera attached', async () => {
    const out = join(dir, 'out');
    const { io, stdout, stderr } = testIo();
    const code = await run(['decrypt', dumpPath, '--out', out], io, signal());

    expect(code).toBe(EXIT_OK);
    /* Human output on stdout, progress on stderr, nothing that looks like a
     * failure anywhere. */
    expect(stderr.text).not.toContain('error');
    expect(stderr.text).toContain('progress:');

    const files = (await readdir(out)).sort();
    expect(files).toEqual(['README.md', 'decrypted', 'manifest.json']);

    const decrypted = (await readdir(join(out, 'decrypted'))).sort();
    /* One image slot: its plaintext, its per-slot report, its key record,
     * plus the two combined reports. */
    expect(decrypted).toHaveLength(5);
    expect(decrypted).toContain('decryption_report.txt');

    /* The filename carries the key pair, because the image really does embed
     * the dump's own bootloader keys — checked, not assumed. */
    const suffix = `-KeyA-${bytesToHex(KEY_A)}-KeyB-${bytesToHex(KEY_B)}.bin`;
    const binary = decrypted.find((name) => name.endsWith(suffix));
    expect(
      binary,
      `no decrypted image named with the key pair in ${decrypted.join(', ')}`,
    ).toBeDefined();
    expect(binary).toContain('_decrypted_14030000');

    const bytes = await readFile(join(out, 'decrypted', binary ?? ''));
    expect(new Uint8Array(bytes)).toEqual(plain);

    const manifest: unknown = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8'));
    expect(manifest).toMatchObject({
      /* Core's builder, with the host and the profile the web app also names —
       * the two front ends write the same document. */
      producer: 'seek-thermal-firmware-dump (seek-fw CLI, modern-4x)',
      flashBase: '0x14000000',
      source: { fileName: 'flash_4m_usb_partial_gap_ff.bin' },
      profile: { id: 'modern-4x' },
    });

    expect(stdout.text).toContain('wrote');
    expect(stdout.text).toContain('14030000');
  });

  it('emits one JSON document on stdout and keeps logs on stderr', async () => {
    const { io, stdout, stderr } = testIo();
    const code = await run(
      ['decrypt', dumpPath, '--out', join(dir, 'json-out'), '--json', '--verbose'],
      io,
      signal(),
    );

    expect(code).toBe(EXIT_OK);
    const parsed: unknown = JSON.parse(stdout.text);
    expect(parsed).toMatchObject({
      command: 'decrypt',
      ok: true,
      profile: 'modern-4x',
      source: { file: 'flash_4m_usb_partial_gap_ff.bin' },
    });
    const document = parsed as { slots: { key: string; confidence: string; flash: string }[] };
    expect(document.slots).toHaveLength(1);
    expect(document.slots[0]?.flash).toBe('0x14030000');
    expect(document.slots[0]?.confidence).toBe('VERIFIED(profile)');
    expect(document.slots[0]?.key).toBe(bytesToHex(KEY_A));
    /* --verbose put plenty of human text somewhere; it must not be stdout. */
    expect(stderr.text.length).toBeGreaterThan(0);
  });

  it('--quiet leaves stdout empty in human mode', async () => {
    const { io, stdout, stderr } = testIo();
    const code = await run(['decrypt', dumpPath, '--out', join(dir, 'q'), '--quiet'], io, signal());
    expect(code).toBe(EXIT_OK);
    expect(stdout.text).toBe('');
    expect(stderr.text).toBe('');
  });

  it('honours --profile and --zip', async () => {
    const zip = join(dir, 'archive.zip');
    const { io } = testIo();
    const code = await run(
      ['decrypt', dumpPath, '--zip', zip, '--profile', 'compact-2016'],
      io,
      signal(),
    );
    expect(code).toBe(EXIT_OK);
    const bytes = await readFile(zip);
    expect(bytes.subarray(0, 2).toString()).toBe('PK');
    expect(bytes.toString('latin1')).toContain('decrypted/');
  });

  it('reports a missing file as a failure, not a crash', async () => {
    const { io, stderr } = testIo();
    const code = await run(['decrypt', join(dir, 'nope.bin')], io, signal());
    expect(code).toBe(EXIT_FAILED);
    expect(stderr.text).toContain('could not read');
  });

  it('reports the failure as JSON under --json', async () => {
    const { io, stdout } = testIo();
    const code = await run(['decrypt', join(dir, 'nope.bin'), '--json'], io, signal());
    expect(code).toBe(EXIT_FAILED);
    expect(JSON.parse(stdout.text)).toMatchObject({
      command: 'decrypt',
      ok: false,
      error: { code: 'cli/no-input' },
    });
  });
});

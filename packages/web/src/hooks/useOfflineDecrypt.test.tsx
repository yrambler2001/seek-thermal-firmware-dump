/**
 * The offline decryptor end to end, on a flash image synthesised with core's
 * own helpers — a real encrypted bank with a real bootloader key table, so the
 * cryptanalytic recovery, the key-table confirmation and the filename stamping
 * all have to work for this to pass.
 *
 * Only the download is stubbed: everything up to the `Blob` is the real path.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADJUST_OFFSET,
  HEADER_OFFSET,
  IMAGE_MAGIC,
  LENGTH_OFFSET,
  buildBankPayload,
  getProfile,
  keyFilenameSuffix,
  type Artifact,
} from '@seek-fw/core';
import { act } from 'react';
import { renderHook } from '../test-helpers';
import { useOfflineDecrypt } from './useOfflineDecrypt';
import { useRunner } from './useRunner';

const downloads: { dirName: string; artifacts: readonly Artifact[] }[] = [];

vi.mock('../lib/download', () => ({
  downloadArchive: (dirName: string, artifacts: readonly Artifact[]) => {
    downloads.push({ dirName, artifacts });
    return { fileName: `${dirName}.zip`, fileCount: artifacts.length, bytes: 1024, dataBytes: 512 };
  },
  mib: (bytes: number, digits = 1) => (bytes / (1024 * 1024)).toFixed(digits),
}));

const KEY_A = Uint8Array.from([
  0x9e, 0x3d, 0x71, 0x22, 0x5c, 0xb8, 0x04, 0xf1, 0x6a, 0xd0, 0x37, 0x8e, 0xc5, 0x19, 0x42, 0xab,
]);
const KEY_B = Uint8Array.from([
  0x11, 0x77, 0xe2, 0x05, 0x3b, 0x9c, 0x48, 0xd6, 0x20, 0xfe, 0x83, 0x51, 0x6d, 0x0a, 0xb4, 0xc7,
]);

/** Word indices the GF(2) solve assumes are zero, plus its own check word. */
const RESERVED_ZERO = new Set([7, 8, 9, 10, 13]);
const IMAGE_BYTES = 0x1000;
const SLOT_OFFSET = 0x10000;
const KEY_TABLE_AT = 0x1000;

/* `Uint8Array<ArrayBuffer>`, not the default `Uint8Array<ArrayBufferLike>`:
 * `BlobPart` excludes SharedArrayBuffer-backed views, so the narrower type is
 * what lets the result go straight into a `File`. */
function synthesiseDump(): Uint8Array<ArrayBuffer> {
  const profile = getProfile('modern-4x');

  const image = new Uint8Array(IMAGE_BYTES);
  const dv = new DataView(image.buffer);
  dv.setUint32(0, 0x10008000, true); /* initial SP */
  dv.setUint32(4, 0x14020301, true); /* reset vector, Thumb */
  for (let word = 2; word < IMAGE_BYTES / 4; word++) {
    if (RESERVED_ZERO.has(word)) continue;
    if (word >= 128 && word <= 143) continue; /* the cleartext header window */
    dv.setUint32(word * 4, (0x2000_0000 + word * 0x3b9) >>> 0, true);
  }
  dv.setUint32(HEADER_OFFSET, IMAGE_MAGIC, true);
  dv.setUint32(LENGTH_OFFSET, 0, true); /* stamped by setAcceptSum */
  dv.setUint32(HEADER_OFFSET + 8, 0x2b, true); /* image id */
  dv.setUint32(HEADER_OFFSET + 12, 0x04_09_01_05, true); /* version */
  dv.setUint32(HEADER_OFFSET + 16, 0x14020301, true); /* entry */
  dv.setUint32(ADJUST_OFFSET, 0, true);
  /* The key pair this image would use for its own upgrades, in its plaintext,
   * which is what makes the decrypted filename carry the keys. */
  image.set(KEY_A, 0x800);
  image.set(KEY_B, 0x810);

  const bank = buildBankPayload(image, KEY_A, null, profile.cipher, profile.memory.windowSize);

  const dump = new Uint8Array(0x30000).fill(0xff);
  dump.set(bank.payload, SLOT_OFFSET);
  /* The bootloader's key table: { g_boot_config_base, keyA[16], keyB[16] }. */
  new DataView(dump.buffer).setUint32(KEY_TABLE_AT, profile.memory.bootConfigBase, true);
  dump.set(KEY_A, KEY_TABLE_AT + 4);
  dump.set(KEY_B, KEY_TABLE_AT + 20);
  return dump;
}

function useHarness(): ReturnType<typeof useOfflineDecrypt> {
  const runner = useRunner();
  return useOfflineDecrypt({ id: 'offline', runner });
}

/** `decryptFile` returns the run's own promise, so the test just awaits it. */
async function decrypt(
  result: { current: ReturnType<typeof useOfflineDecrypt> },
  file: File,
): Promise<void> {
  await act(async () => {
    await result.current.decryptFile(file);
  });
}

beforeEach(() => {
  downloads.length = 0;
});

describe('useOfflineDecrypt', () => {
  it('decrypts a synthesised dump and packages the full artifact set', async () => {
    const bytes = synthesiseDump();
    const file = new File([bytes], 'dump.bin', { type: 'application/octet-stream' });

    const { result, unmount } = renderHook(useHarness);
    await decrypt(result, file);

    expect(downloads).toHaveLength(1);
    const [archive] = downloads;
    if (archive === undefined) throw new Error('no archive');

    expect(archive.dirName).toMatch(/^dump_decrypted_\d{4}-\d{2}-\d{2}T/);

    const names = archive.artifacts.map((file_) => file_.name).sort();
    const suffix = keyFilenameSuffix(KEY_A, KEY_B);
    expect(names).toEqual(
      [
        `decrypted/dump_decrypted_14010000${suffix}.bin`,
        'decrypted/dump_14010000.key',
        'decrypted/dump_decrypted_14010000.txt',
        'decrypted/decryption_report.txt',
        'decrypted/dump_keys.log',
        'manifest.json',
        'README.md',
      ].sort(),
    );

    /* The decrypted slot really is the plaintext we encrypted. */
    const decrypted = archive.artifacts.find((file_) => file_.name.endsWith('.bin'));
    if (decrypted === undefined) throw new Error('no decrypted image');
    expect(decrypted.data).toHaveLength(IMAGE_BYTES);
    const view = new DataView(decrypted.data.buffer, decrypted.data.byteOffset);
    expect(view.getUint32(0, true)).toBe(0x10008000);
    expect(view.getUint32(HEADER_OFFSET, true)).toBe(IMAGE_MAGIC >>> 0);

    /* The manifest names the source file and the profile it acted under. */
    const manifest = archive.artifacts.find((file_) => file_.name === 'manifest.json');
    if (manifest === undefined) throw new Error('no manifest');
    const parsed: unknown = JSON.parse(new TextDecoder().decode(manifest.data));
    expect(parsed).toMatchObject({
      producer: 'seek-thermal-firmware-dump (web, modern-4x)',
      source: { fileName: 'dump.bin', size: bytes.length },
      flashBase: '0x14000000',
      decryption: { attempted: true },
    });

    expect(result.current.reporter.progress.text).toContain('1/1 slot(s) decrypted');

    /* With no camera attached the family is scored from the file itself, and
     * the verdict is surfaced rather than assumed. */
    expect(result.current.detection).not.toBeNull();
    expect(result.current.detection?.best.profile.id).toBe('modern-4x');
    expect(result.current.detection?.best.reasons.length).toBeGreaterThan(0);
    expect(parsed).toMatchObject({ profile: { id: 'modern-4x' } });
    unmount();
  }, 20_000);

  it('refuses a file too small to hold a header, and packages nothing', async () => {
    const file = new File([new Uint8Array(16)], 'tiny.bin');
    const { result, unmount } = renderHook(useHarness);
    await decrypt(result, file);

    expect(downloads).toHaveLength(0);
    expect(result.current.reporter.progress.text).toBe('Not a usable dump.');
    expect(result.current.reporter.lines.map((line) => line.text)).toContain(
      'file is too small to contain a firmware image header',
    );
    unmount();
  });

  it('still packages a manifest when a well-formed file holds no image', async () => {
    /* The archive is the point. "Nothing was found in this file, here is its
     * SHA-256 and the profile that was tried" is a citable result, and the CLI
     * has always written one for the same input — only a file too small to
     * hold a header, or a cancel, packages nothing. */
    const bytes = new Uint8Array(0x20000).fill(0xff);
    const file = new File([bytes], 'blank.bin');
    const { result, unmount } = renderHook(useHarness);
    await decrypt(result, file);

    expect(downloads).toHaveLength(1);
    const [archive] = downloads;
    if (archive === undefined) throw new Error('no archive');
    expect(archive.artifacts.map((file_) => file_.name).sort()).toEqual([
      'README.md',
      'manifest.json',
    ]);

    const manifest = archive.artifacts.find((file_) => file_.name === 'manifest.json');
    if (manifest === undefined) throw new Error('no manifest');
    const parsed: unknown = JSON.parse(new TextDecoder().decode(manifest.data));
    expect(parsed).toMatchObject({
      producer: 'seek-thermal-firmware-dump (web, generic)',
      source: { fileName: 'blank.bin', size: bytes.length },
      /* The search ran and came up empty — which is the finding, and the
       * manifest says so rather than the archive simply not existing. */
      decryption: { attempted: true, images: [], note: 'no image slots found' },
    });
    /* The SHA-256 of the file that was searched is the whole evidentiary
     * value of a no-images manifest. */
    expect((parsed as { source: { sha256: string } }).source.sha256).toMatch(/^[0-9a-f]{64}$/);

    /* The log and the status stay honest about what was found. */
    expect(result.current.reporter.lines.map((line) => line.text)).toContain(
      'no firmware image in this file could be decrypted — packaging the manifest anyway',
    );
    expect(result.current.reporter.progress.text).toBe(
      'No images decrypted — see the log for why. The manifest is in your downloads.',
    );
    unmount();
  });
});

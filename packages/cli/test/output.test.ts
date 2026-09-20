import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildZip, zipEntryCount, zipTotalDataSize } from '@seek-fw/core';
import { CliError } from '../src/errors.js';
import {
  defaultOutputDirectory,
  resolveArtifactPath,
  writeArtifactsToDirectory,
  writeArtifactsToZip,
  writeOutputs,
} from '../src/output.js';
import { tempDir } from './helpers.js';

let dir = '';
let cleanup: () => Promise<void> = (): Promise<void> => Promise.resolve();

beforeEach(async () => {
  const temp = await tempDir();
  dir = temp.path;
  cleanup = temp.cleanup;
});
afterEach(async () => {
  await cleanup();
});

const ARTIFACTS = [
  { name: 'flash_4m_usb_partial_gap_ff.bin', data: Uint8Array.from([1, 2, 3, 4]) },
  { name: 'windows/addr_14030000_subcmd_05.bin', data: Uint8Array.from([5, 6]) },
  { name: 'decrypted/image_decrypted_14030000.bin', data: Uint8Array.from([7]) },
  { name: 'decrypted/decryption_report.txt', data: Uint8Array.from([8, 9]) },
  { name: 'README.md', data: Uint8Array.from([10]) },
];

describe('resolveArtifactPath', () => {
  it('accepts the nested names core actually produces', () => {
    expect(resolveArtifactPath('/out', 'windows/addr_14030000_subcmd_05.bin')).toBe(
      '/out/windows/addr_14030000_subcmd_05.bin',
    );
    expect(resolveArtifactPath('/out', 'decrypted/report.txt')).toBe('/out/decrypted/report.txt');
  });

  it.each([
    ['', 'empty'],
    ['../escape.bin', 'parent segment'],
    ['windows/../../escape.bin', 'traversal through a subdirectory'],
    ['/etc/passwd', 'absolute'],
    ['C:\\windows\\system32', 'drive letter'],
    ['windows\\addr.bin', 'backslash'],
    ['a//b.bin', 'empty segment'],
    ['nul\0.bin', 'NUL byte'],
  ])('refuses %j (%s)', (name) => {
    expect(() => resolveArtifactPath('/out', name)).toThrow(CliError);
    expect(() => resolveArtifactPath('/out', name)).toThrow(/refusing to write artifact/);
  });
});

describe('writeArtifactsToDirectory', () => {
  it('reproduces every name and every byte, including nested paths', async () => {
    const written = await writeArtifactsToDirectory(dir, ARTIFACTS);
    expect(written).toHaveLength(ARTIFACTS.length);

    for (const artifact of ARTIFACTS) {
      const bytes = await readFile(join(dir, artifact.name));
      expect(new Uint8Array(bytes)).toEqual(artifact.data);
    }
    expect((await readdir(join(dir, 'windows'))).sort()).toEqual(['addr_14030000_subcmd_05.bin']);
    expect((await readdir(join(dir, 'decrypted'))).sort()).toEqual([
      'decryption_report.txt',
      'image_decrypted_14030000.bin',
    ]);
  });

  it('writes nothing at all when one name is unsafe', async () => {
    await expect(
      writeArtifactsToDirectory(dir, [
        { name: 'good.bin', data: Uint8Array.from([1]) },
        { name: '../escaped.bin', data: Uint8Array.from([2]) },
      ]),
    ).rejects.toThrow(/refusing to write artifact/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('writeArtifactsToZip', () => {
  it('writes an archive with one entry per artifact', async () => {
    const target = join(dir, 'nested', 'dump.zip');
    const bytes = await writeArtifactsToZip(target, ARTIFACTS);
    const written = await readFile(target);
    expect(written.length).toBe(bytes);
    expect(written.subarray(0, 2)).toEqual(Buffer.from('PK'));
    expect(zipEntryCount(ARTIFACTS)).toBe(ARTIFACTS.length);
    /* Names are stored in clear in each local header, so they are visible in
     * the bytes without unzipping — enough to prove nothing was dropped. */
    const text = written.toString('latin1');
    for (const artifact of ARTIFACTS) expect(text).toContain(artifact.name);
    expect(bytes).toBe(buildZip(ARTIFACTS).length);
  });

  it('guards the zip against a slipping entry name too', async () => {
    await expect(
      writeArtifactsToZip(join(dir, 'evil.zip'), [
        { name: '../../etc/passwd', data: Uint8Array.from([1]) },
      ]),
    ).rejects.toThrow(/refusing to write artifact/);
  });
});

describe('writeOutputs', () => {
  it('writes a directory, a zip, or both', async () => {
    const both = await writeOutputs(
      { directory: join(dir, 'out'), zip: join(dir, 'out.zip') },
      ARTIFACTS,
    );
    expect(both.directory).toBe(join(dir, 'out'));
    expect(both.zip).toBe(join(dir, 'out.zip'));
    expect(both.files).toHaveLength(ARTIFACTS.length + 1);
    expect((await stat(join(dir, 'out.zip'))).isFile()).toBe(true);
    expect((await stat(join(dir, 'out', 'README.md'))).isFile()).toBe(true);
  });

  it('counts entries and bytes the way core counts them', async () => {
    const directoryOnly = await writeOutputs({ directory: join(dir, 'd'), zip: null }, ARTIFACTS);
    expect(directoryOnly.entries).toBe(zipEntryCount(ARTIFACTS));
    expect(directoryOnly.bytes).toBe(zipTotalDataSize(ARTIFACTS));

    /* A zip reports the archive's own size, headers included — but still one
     * entry per artifact, not one per path written. */
    const zipped = await writeOutputs({ directory: null, zip: join(dir, 'z.zip') }, ARTIFACTS);
    expect(zipped.entries).toBe(zipEntryCount(ARTIFACTS));
    expect(zipped.bytes).toBe(buildZip(ARTIFACTS).length);
    expect(zipped.files).toHaveLength(1);
  });
});

describe('defaultOutputDirectory', () => {
  it('is a timestamped directory under the working directory', () => {
    expect(defaultOutputDirectory('dump', new Date('2026-09-20T14:30:00Z'))).toBe(
      join('.', 'seek-dump-20260920-143000'),
    );
  });
});

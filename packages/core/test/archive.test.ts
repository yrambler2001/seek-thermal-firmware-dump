import { describe, expect, it } from 'vitest';

import type { Artifact } from '../src/events.js';
import { bytesToHex, utf8 } from '../src/bytes.js';
import { crc32 } from '../src/archive/crc32.js';
import { buildZip, zipEntryCount, zipTotalDataSize } from '../src/archive/zip.js';
import {
  buildBootloaderKeysSummary,
  buildDecryptionFailed,
  buildDecryptionNotAttempted,
  buildDecryptionSummary,
  buildDumpManifest,
  buildGapRecord,
  buildImageSummary,
  buildKeySummary,
  buildLegacyDumpManifest,
  buildOfflineDecryptManifest,
  buildSelectorRecord,
  buildSweepManifest,
  buildWindowRecord,
  manifestToJson,
  type BuildDumpManifestInput,
  type DeviceInfo,
  type ManifestProfileInfo,
  type TransportInfo,
} from '../src/archive/manifest.js';
import {
  makeLegacyReadme,
  makeOfflineDecryptReadme,
  makeReadme,
  makeSweepReadme,
} from '../src/archive/readme.js';

/* ==================================================================== *
 * crc32
 * ==================================================================== */

describe('crc32', () => {
  it('matches the standard check value for "123456789"', () => {
    expect(crc32(utf8('123456789'))).toBe(0xcbf43926);
  });

  it('is 0 for empty input', () => {
    expect(crc32(new Uint8Array(0))).toBe(0);
  });

  it('matches a second known vector ("The quick brown fox...")', () => {
    expect(crc32(utf8('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

/* ==================================================================== *
 * zip: a tiny independent reader, used only to verify buildZip's output
 * ==================================================================== */

interface ParsedEocd {
  readonly entryCount: number;
  readonly cdSize: number;
  readonly cdOffset: number;
}

function readEocd(zip: Uint8Array): ParsedEocd {
  // Our writer never emits a comment, so EOCD is exactly the last 22 bytes.
  const eocdOffset = zip.length - 22;
  const view = new DataView(zip.buffer, zip.byteOffset + eocdOffset, 22);
  expect(view.getUint32(0, true)).toBe(0x06054b50);
  return {
    entryCount: view.getUint16(10, true),
    cdSize: view.getUint32(12, true),
    cdOffset: view.getUint32(16, true),
  };
}

interface ParsedEntry {
  readonly name: string;
  readonly data: Uint8Array;
  readonly crc: number;
}

/** Walks the central directory (not just sequential local headers) to a set of entries. */
function parseZip(zip: Uint8Array): ParsedEntry[] {
  const { entryCount, cdOffset } = readEocd(zip);
  const decoder = new TextDecoder();
  const entries: ParsedEntry[] = [];
  let at = cdOffset;

  for (let i = 0; i < entryCount; i++) {
    const cv = new DataView(zip.buffer, zip.byteOffset + at, 46);
    expect(cv.getUint32(0, true)).toBe(0x02014b50);
    const crc = cv.getUint32(16, true);
    const compressedSize = cv.getUint32(20, true);
    const nameLen = cv.getUint16(28, true);
    const extraLen = cv.getUint16(30, true);
    const commentLen = cv.getUint16(32, true);
    const localOffset = cv.getUint32(42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLen));

    const lv = new DataView(zip.buffer, zip.byteOffset + localOffset, 30);
    expect(lv.getUint32(0, true)).toBe(0x04034b50);
    const localNameLen = lv.getUint16(26, true);
    const localExtraLen = lv.getUint16(28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const data = zip.slice(dataStart, dataStart + compressedSize);

    entries.push({ name, data, crc });
    at += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

function sampleFiles(): Artifact[] {
  const binary = new Uint8Array(300);
  for (let i = 0; i < binary.length; i++) binary[i] = i & 0xff;

  return [
    { name: 'seek_dump/manifest.json', data: utf8('{"ok":true}\n') },
    { name: 'seek_dump/windows/naïve_😀.bin', data: binary },
    { name: 'seek_dump/README.md', data: utf8('# hello\n') },
    { name: 'seek_dump/empty.bin', data: new Uint8Array(0) },
  ];
}

const FIXED_DATE = new Date(2024, 2, 5, 10, 20, 30); // local time; only used for determinism, never asserted absolutely

/* ==================================================================== *
 * buildZip
 * ==================================================================== */

describe('buildZip', () => {
  it('starts with a local file header signature', () => {
    const zip = buildZip(sampleFiles(), FIXED_DATE);
    const sig = new DataView(zip.buffer, zip.byteOffset, 4).getUint32(0, true);
    expect(sig).toBe(0x04034b50);
  });

  it('ends with a valid EOCD whose entry count matches the file count', () => {
    const files = sampleFiles();
    const zip = buildZip(files, FIXED_DATE);
    const { entryCount } = readEocd(zip);
    expect(entryCount).toBe(files.length);
    expect(zipEntryCount(files)).toBe(files.length);
  });

  it('points its central-directory offset/size at the bytes that are actually there', () => {
    const files = sampleFiles();
    const zip = buildZip(files, FIXED_DATE);
    const { cdOffset, cdSize } = readEocd(zip);

    const sig = new DataView(zip.buffer, zip.byteOffset + cdOffset, 4).getUint32(0, true);
    expect(sig).toBe(0x02014b50);
    // central directory + the 22-byte EOCD must exactly reach the end of the buffer
    expect(cdOffset + cdSize + 22).toBe(zip.length);
  });

  it("stores each entry's real CRC-32, recoverable by a fresh computation", () => {
    const files = sampleFiles();
    const zip = buildZip(files, FIXED_DATE);
    const entries = parseZip(zip);
    expect(entries).toHaveLength(files.length);
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const entry = entries[i]!;
      expect(entry.name).toBe(file.name);
      expect(entry.crc).toBe(crc32(file.data));
    }
  });

  it('round-trips UTF-8 names and binary content exactly', () => {
    const files = sampleFiles();
    const zip = buildZip(files, FIXED_DATE);
    const entries = parseZip(zip);
    for (let i = 0; i < files.length; i++) {
      const file = files[i]!;
      const entry = entries[i]!;
      expect(entry.name).toBe(file.name);
      expect(entry.data).toEqual(file.data);
    }
  });

  it('produces byte-identical archives for the same files and the same fixed Date', () => {
    const files = sampleFiles();
    const a = buildZip(files, FIXED_DATE);
    const b = buildZip(sampleFiles(), new Date(FIXED_DATE.getTime()));
    expect(a).toEqual(b);
  });

  it('reports total stored data size (store-only, so no compression to account for)', () => {
    const files = sampleFiles();
    expect(zipTotalDataSize(files)).toBe(files.reduce((n, f) => n + f.data.length, 0));
  });

  it('defaults `now` to the current time when omitted', () => {
    // Just needs to not throw and to still produce a structurally valid zip.
    const zip = buildZip(sampleFiles());
    const { entryCount } = readEocd(zip);
    expect(entryCount).toBe(4);
  });
});

/* ==================================================================== *
 * manifest.ts — window / gap / selector records
 * ==================================================================== */

describe('buildWindowRecord', () => {
  it('formats a fully-read window with hex(…,8)/(…,6) addresses, lower-case', () => {
    const data = new Uint8Array(65536).fill(0xaa);
    const record = buildWindowRecord({
      ok: true,
      address: 0x14030000,
      offset: 0x00030000,
      subcmd: 0x02,
      note: 'app image A',
      auth: false,
      requested: 65536,
      data,
      gapFill: 0xff,
      file: 'windows/addr_14030000_subcmd_02.bin',
    });

    expect(record.address).toBe('0x14030000');
    expect(record.offset).toBe('0x030000');
    expect(record.subcmd).toBe('0x2');
    expect(record.ok).toBe(true);
    if (record.ok) {
      expect(record.lengthRead).toBe(65536);
      expect(record.shortBy).toBe(0);
      expect(record.shortfallFilled).toBeNull();
      expect(record.preview).toBe(bytesToHex(data, 32));
    }
  });

  it('records a short read as a non-null shortfallFilled with a default reason', () => {
    const data = new Uint8Array(100).fill(0x11);
    const record = buildWindowRecord({
      ok: true,
      address: 0x14060000,
      offset: 0x00060000,
      subcmd: 0x09,
      note: 'gap bank',
      auth: true,
      requested: 65536,
      data,
      gapFill: 0xff,
      file: 'windows/addr_14060000_subcmd_09.bin',
    });

    expect(record.ok).toBe(false);
    if (!record.ok && 'shortfallFilled' in record) {
      expect(record.lengthRead).toBe(100);
      expect(record.shortBy).toBe(65536 - 100);
      expect(record.shortfallFilled).toEqual({
        from: '0x14060064',
        to: '0x1406ffff',
        length: 65436,
        fill: '0xff',
        reason: 'read stopped early',
      });
    }
  });

  it('honours an explicit stopReason over the default', () => {
    const data = new Uint8Array(10);
    const record = buildWindowRecord({
      ok: true,
      address: 0x14060000,
      offset: 0x60000,
      subcmd: 0x09,
      note: '',
      auth: false,
      requested: 65536,
      data,
      gapFill: 0x00,
      file: 'x.bin',
      stopReason: 'device stalled on control-IN',
    });
    if (!record.ok && 'shortfallFilled' in record) {
      expect(record.shortfallFilled?.reason).toBe('device stalled on control-IN');
    }
  });

  it('formats the error variant with ok: false and an error message, no byte fields', () => {
    const record = buildWindowRecord({
      ok: false,
      address: 0x14000000,
      offset: 0,
      subcmd: 0x00,
      note: 'boot bank',
      auth: false,
      requested: 65536,
      error: 'stalled after 3 attempts',
    });
    expect(record.ok).toBe(false);
    expect(record.address).toBe('0x14000000');
    expect(record.offset).toBe('0x000000');
    expect('error' in record && record.error).toBe('stalled after 3 attempts');
    expect('lengthRead' in record).toBe(false);
  });
});

describe('buildGapRecord', () => {
  it('formats address/offset/fill as hex strings matching the original widths', () => {
    const gap = buildGapRecord({
      address: 0x14060000,
      flashBase: 0x14000000,
      length: 65536,
      fill: 0xff,
      reason: 'No BeginFirmwareUpgrade selector is exposed for this 64 KiB block.',
    });
    expect(gap.address).toBe('0x14060000');
    expect(gap.offset).toBe('0x060000');
    expect(gap.fill).toBe('0xff');
    expect(gap.length).toBe(65536);
  });
});

describe('buildSelectorRecord', () => {
  it('formats subcmd/mappedAddress/errorCode with hex(), and preview from raw data', () => {
    const data = new Uint8Array(65536).fill(0x42);
    const record = buildSelectorRecord({
      subcmd: 0x1f,
      mappedAddress: 0x14030000,
      armed: true,
      begin: 'ok',
      errorCode: null,
      data,
      file: 'blocks/subcmd_1f_14030000.bin',
    });
    expect(record.subcmd).toBe('0x1f');
    expect(record.mappedAddress).toBe('0x14030000');
    expect(record.errorCode).toBeNull();
    expect(record.length).toBe(65536);
    expect(record.file).toBe('blocks/subcmd_1f_14030000.bin');
    expect(record.preview).toBe(bytesToHex(data, 32));
  });

  it('nulls out file/preview when nothing was read, even if armed', () => {
    const record = buildSelectorRecord({
      subcmd: 0x05,
      mappedAddress: null,
      armed: true,
      begin: 'ok',
      errorCode: null,
      data: new Uint8Array(0),
      file: 'blocks/would_be.bin',
    });
    expect(record.length).toBe(0);
    expect(record.file).toBeNull();
    expect(record.preview).toBeNull();
  });

  it('preserves the original quirk: an errorCode of 0 still formats to "0x0"', () => {
    const record = buildSelectorRecord({
      subcmd: 0x00,
      mappedAddress: null,
      armed: true, // caller decides armed-ness; the builder never re-derives it from errorCode
      begin: 'ok',
      errorCode: 0,
      data: null,
      file: null,
    });
    expect(record.errorCode).toBe('0x0');
    expect(record.armed).toBe(true);
  });

  it('records a stall with no data and no error code', () => {
    const record = buildSelectorRecord({
      subcmd: 0xaa,
      mappedAddress: null,
      armed: false,
      begin: 'stall',
      errorCode: null,
      data: null,
      file: null,
    });
    expect(record.begin).toBe('stall');
    expect(record.armed).toBe(false);
    expect(record.length).toBe(0);
  });

  it('carries an optional readError through untouched', () => {
    const record = buildSelectorRecord({
      subcmd: 0x03,
      mappedAddress: 0x14030000,
      armed: true,
      begin: 'ok',
      errorCode: null,
      data: null,
      file: null,
      readError: 'control-IN timed out',
    });
    expect(record.readError).toBe('control-IN timed out');
  });
});

/* ==================================================================== *
 * manifest.ts — decryption summary
 * ==================================================================== */

describe('image / key / decryption summary builders', () => {
  it('buildImageSummary uses hexUp (upper-case) for decryption-derived fields', () => {
    const key = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    const image = buildImageSummary({
      flash: 0x1403abcd,
      fileOffset: 0x0003abcd,
      length: 0x40000,
      cipherSha256: 'c'.repeat(64),
      plainSha256: 'p'.repeat(64),
      confidence: 'HIGH',
      key,
      state: [0x11111111, 0x22222222, 0x33333333, 0x44444444],
      derivedTarget: 0x0000ffff,
      profile: 'xs128/K=0x00000000',
      sp: 0x20001000,
      entry: 0x08001235,
      duplicateOf: null,
      embeddedKeyTable: null,
      file: 'decrypted/x_decrypted_1403ABCD.bin',
    });

    expect(image.flash).toBe('0x1403ABCD');
    expect(image.fileOffset).toBe('0x0003ABCD');
    expect(image.sp).toBe('0x20001000');
    expect(image.entry).toBe('0x08001235');
    expect(image.derivedTarget).toBe('0x0000FFFF');
    expect(image.state).toBe('0x11111111 0x22222222 0x33333333 0x44444444');
    expect(image.key).toBe(bytesToHex(key));
    expect(image.decrypted).toBe(true);
    expect(image.duplicateOf).toBeNull();
    expect(image.embeddedKeyTable).toBeNull();
  });

  it('buildImageSummary: null key, non-null duplicateOf, and an embedded key table', () => {
    const keyA = Uint8Array.from([1, 2, 3, 4]);
    const keyB = Uint8Array.from([5, 6, 7, 8]);
    const image = buildImageSummary({
      flash: 0x14050000,
      fileOffset: 0x50000,
      length: 0x40000,
      cipherSha256: 'c'.repeat(64),
      plainSha256: 'p'.repeat(64),
      confidence: 'UNVERIFIED',
      key: null,
      state: [1, 2, 3, 4],
      derivedTarget: 0,
      profile: 'xs128/K=? (unknown profile)',
      sp: 0x20000000,
      entry: 0x08000001,
      duplicateOf: 0x14030000,
      embeddedKeyTable: { keyAOffset: 0x218, keyBOffset: 0x21c, adjacent: true, keyA, keyB },
      file: 'decrypted/y.bin',
    });

    expect(image.key).toBeNull();
    expect(image.duplicateOf).toBe('0x14030000');
    expect(image.embeddedKeyTable).toEqual({
      keyAOffset: '0x000218',
      keyBOffset: '0x00021C',
      adjacent: true,
      keyA: bytesToHex(keyA),
      keyB: bytesToHex(keyB),
    });
  });

  it('buildKeySummary formats the key as plain (no "0x") lower-case hex', () => {
    const key = buildKeySummary({
      key: Uint8Array.from([0xab, 0xcd, 0xef]),
      profile: 'xs128/K=0x00000000',
      recovery: 'cryptanalytic',
      confidence: 'HIGH',
    });
    expect(key.key).toBe('abcdef');
    expect(key.profile).toBe('xs128/K=0x00000000');
  });

  it('buildBootloaderKeysSummary formats offset with hexUp width 6', () => {
    const summary = buildBootloaderKeysSummary(
      Uint8Array.from([1, 2, 3, 4]),
      Uint8Array.from([5, 6, 7, 8]),
      0x218,
    );
    expect(summary.offset).toBe('0x000218');
    expect(summary.keyA).toBe('01020304');
  });

  it('buildDecryptionNotAttempted / buildDecryptionFailed / buildDecryptionSummary shapes', () => {
    expect(buildDecryptionNotAttempted('disabled in options')).toEqual({
      attempted: false,
      reason: 'disabled in options',
    });

    expect(buildDecryptionFailed('boom')).toEqual({
      attempted: true,
      images: [],
      keys: [],
      error: 'boom',
    });

    const attempted = buildDecryptionSummary({ images: [], keys: [] });
    expect(attempted.attempted).toBe(true);
    expect(attempted.error).toBeNull();
    expect('note' in attempted).toBe(false);
    expect('bootloaderKeys' in attempted).toBe(false);

    const withNote = buildDecryptionSummary({ images: [], keys: [], note: 'no image slots found' });
    expect(withNote.note).toBe('no image slots found');
  });
});

/* ==================================================================== *
 * manifest.ts — top-level manifests
 * ==================================================================== */

function sampleDevice(): DeviceInfo {
  return { product: 'Seek Compact', manufacturer: 'Seek Thermal', serialNumber: 'SN123' };
}

function sampleTransport(): TransportInfo {
  return {
    api: 'WebUSB',
    requestType: 'vendor',
    recipient: 'device',
    bmRequestTypeOut: '0x40',
    bmRequestTypeIn: '0xc0',
    interface: 0,
    claimedInterface: false,
    userAgent: 'test-agent',
  };
}

function sampleProfile(): ManifestProfileInfo {
  return {
    id: 'modern-4x',
    name: 'Modern 4.x',
    detectionScore: 1,
    reasons: ['firmware version 4.9.1.5 matches the 4.x line'],
  };
}

function sampleDumpInput(): BuildDumpManifestInput {
  return {
    startedAt: '2024-03-05T10:20:30.000Z',
    finishedAt: '2024-03-05T10:25:00.000Z',
    vendorId: 0x289d,
    productId: 0x0010,
    device: sampleDevice(),
    flashBase: 0x14000000,
    flashSize: 0x400000,
    windowSize: 0x10000,
    chunk: 64,
    gapFill: 0xff,
    producer: 'seek-thermal-firmware-dump (WebUSB)',
    transport: sampleTransport(),
    safety: ['No flash-write/flash-modify RPCs were called.'],
    windows: [],
    gaps: [
      buildGapRecord({
        address: 0x14060000,
        flashBase: 0x14000000,
        length: 0x10000,
        fill: 0xff,
        reason: 'No BeginFirmwareUpgrade selector is exposed for this 64 KiB block.',
      }),
    ],
    combinedFile: 'flash_4m_usb_partial_gap_ff.bin',
    decryption: buildDecryptionNotAttempted('disabled in options'),
    usbReadableWindows: 63,
    expectedReadableWindows: 63,
    cancelled: false,
    profile: sampleProfile(),
  };
}

describe('buildDumpManifest', () => {
  it('formats vid/pid/flashBase/gapFill exactly, and JSON round-trips', () => {
    const manifest = buildDumpManifest(sampleDumpInput());
    expect(manifest.vid).toBe('0x289d');
    expect(manifest.pid).toBe('0x0010');
    expect(manifest.flashBase).toBe('0x14000000');
    expect(manifest.gapFill).toBe('0xff');
    expect(manifest.usbComplete).toBe(false);
    expect(manifest.gapFilled).toBe(true);
    expect(manifest.profile.id).toBe('modern-4x');

    const json = manifestToJson(manifest);
    expect(json.endsWith('\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(manifest)));
  });

  it('allows usbComplete/gapFilled to be overridden', () => {
    const manifest = buildDumpManifest({
      ...sampleDumpInput(),
      usbComplete: true,
      gapFilled: false,
    });
    expect(manifest.usbComplete).toBe(true);
    expect(manifest.gapFilled).toBe(false);
  });
});

describe('buildLegacyDumpManifest', () => {
  it('adds algorithm/unlockToken/authChannelBanks on top of the dump manifest shape', () => {
    const manifest = buildLegacyDumpManifest({
      ...sampleDumpInput(),
      unlockToken: Uint8Array.from([0xaa, 0xbb, 0xcc]),
      authChannelBanks: [0x14010000, 0x14020000],
    });
    expect(manifest.algorithm).toBe('legacy-locked-firmware');
    expect(manifest.unlockToken).toBe('aabbcc');
    expect(manifest.authChannelBanks).toEqual(['0x14010000', '0x14020000']);
    // still has the base dump manifest fields, correctly formatted
    expect(manifest.flashBase).toBe('0x14000000');
    expect(manifest.profile.name).toBe('Modern 4.x');
  });
});

describe('buildSweepManifest', () => {
  it('formats mode/channel/unlockToken for a normal sweep', () => {
    const manifest = buildSweepManifest({
      startedAt: 't0',
      finishedAt: 't1',
      legacy: false,
      vendorId: 0x289d,
      productId: 0x0010,
      device: sampleDevice(),
      flashBase: 0x14000000,
      flashSize: 0x400000,
      windowSize: 0x10000,
      chunk: 64,
      gapFill: 0xff,
      unlockToken: null,
      producer: 'seek-thermal-firmware-dump (WebUSB, selector sweep)',
      transport: sampleTransport(),
      safety: [],
      selectors: [],
      combinedFile: 'flash_4m_selectorsweep_gap_ff.bin',
      decryption: buildDecryptionNotAttempted('disabled in options'),
      selectorsArmed: 10,
      selectorsWithData: 8,
      placedInImage: 6,
      cancelled: false,
      profile: sampleProfile(),
    });
    expect(manifest.mode).toBe('selector-sweep');
    expect(manifest.channel).toBe('0x02');
    expect(manifest.unlockToken).toBeNull();
  });

  it('formats mode/channel/unlockToken for a legacy sweep', () => {
    const manifest = buildSweepManifest({
      startedAt: 't0',
      finishedAt: 't1',
      legacy: true,
      vendorId: 0x289d,
      productId: 0x0010,
      device: sampleDevice(),
      flashBase: 0x14000000,
      flashSize: 0x400000,
      windowSize: 0x10000,
      chunk: 64,
      gapFill: 0xff,
      unlockToken: Uint8Array.from([1, 2, 3, 4]),
      producer: 'seek-thermal-firmware-dump (WebUSB, selector sweep)',
      transport: sampleTransport(),
      safety: [],
      selectors: [],
      combinedFile: 'flash_4m_selectorsweep_gap_ff.bin',
      decryption: buildDecryptionNotAttempted('disabled in options'),
      selectorsArmed: 10,
      selectorsWithData: 8,
      placedInImage: 6,
      cancelled: false,
      profile: sampleProfile(),
    });
    expect(manifest.mode).toBe('selector-sweep-legacy');
    expect(manifest.channel).toBe('0x12 (unlock token)');
    expect(manifest.unlockToken).toBe('01020304');
  });
});

describe('buildOfflineDecryptManifest', () => {
  it('formats flashBase and carries the source block through untouched', () => {
    const manifest = buildOfflineDecryptManifest({
      producer: 'seek-thermal-firmware-dump (offline decrypt)',
      startedAt: 't0',
      finishedAt: 't1',
      source: { fileName: 'dump.bin', size: 0x400000, sha256: 's'.repeat(64) },
      flashBase: 0x14000000,
      decryption: buildDecryptionNotAttempted('no images found'),
      profile: sampleProfile(),
    });
    expect(manifest.flashBase).toBe('0x14000000');
    expect(manifest.source.fileName).toBe('dump.bin');
  });
});

/* ==================================================================== *
 * readme.ts
 * ==================================================================== */

describe('README generation', () => {
  it('makeReadme mentions the gap fill, the combined file, and the profile', () => {
    const manifest = buildDumpManifest(sampleDumpInput());
    const readme = makeReadme(manifest);
    expect(readme).toContain('# Seek Thermal 4 MiB USB Flash Dump');
    expect(readme).toContain('`0xff`');
    expect(readme).toContain(manifest.combinedFile);
    expect(readme).toContain('Modern 4.x');
    expect(readme.toLowerCase()).toContain('command-line');
  });

  it('makeLegacyReadme derives coverage and the gap list from the manifest itself', () => {
    /* The gap list is THIS firmware's. It used to be two fixed lines naming
     * 0x14000000 and the upper 2 MiB, which was wrong twice over on the 2014
     * builds: they arm 0x14000000 with the token, and have no selector for
     * 0x140C0000. So the README must say what the manifest says, not recite. */
    const manifest = buildLegacyDumpManifest({
      ...sampleDumpInput(),
      windows: [],
      gaps: [
        buildGapRecord({
          address: 0x140c0000,
          flashBase: 0x14000000,
          length: 0x10000,
          fill: 0xff,
          reason: 'No subcommand arms 0x140C0000 on this build.',
        }),
      ],
      usbReadableWindows: 58,
      expectedReadableWindows: 61,
      unlockToken: Uint8Array.from([0x12, 0x34]),
      authChannelBanks: [0x14010000],
      selectorTable: { firmwareVersion: '1.3.0.0', table: "legacy 1.3.0.0: this build's own" },
    });
    const readme = makeLegacyReadme(manifest);
    expect(readme).toContain('58 of 61 reachable 64 KiB windows were read.');
    expect(readme).toContain('1 gap(s) on this firmware');
    expect(readme).toContain('0x140c0000 + 65536 B: No subcommand arms 0x140C0000 on this build.');
    expect(readme).toContain(
      "Firmware 1.3.0.0; windows armed from legacy 1.3.0.0: this build's own",
    );
    expect(readme).not.toContain('hard-blocked');
    expect(readme).toContain('Modern 4.x');
  });

  it('makeSweepReadme reflects legacy vs normal mode and result counts', () => {
    const normal = buildSweepManifest({
      startedAt: 't0',
      finishedAt: 't1',
      legacy: false,
      vendorId: 0x289d,
      productId: 0x0010,
      device: sampleDevice(),
      flashBase: 0x14000000,
      flashSize: 0x400000,
      windowSize: 0x10000,
      chunk: 64,
      gapFill: 0xff,
      unlockToken: null,
      producer: 'p',
      transport: sampleTransport(),
      safety: [],
      selectors: [],
      combinedFile: 'sweep.bin',
      decryption: buildDecryptionNotAttempted('disabled in options'),
      selectorsArmed: 10,
      selectorsWithData: 8,
      placedInImage: 6,
      cancelled: false,
      profile: sampleProfile(),
    });
    const readme = makeSweepReadme(normal);
    expect(readme).toContain('10 of 256 selectors armed; 8 returned data.');
    expect(readme).toContain('6 had a known flash address');
    expect(readme).not.toContain('legacy / unlock token');
  });

  it('makeOfflineDecryptReadme includes the source file details', () => {
    const manifest = buildOfflineDecryptManifest({
      producer: 'p',
      startedAt: 't0',
      finishedAt: '2024-03-05T10:25:00.000Z',
      source: { fileName: 'my_dump.bin', size: 4194304, sha256: 'deadbeef'.repeat(8) },
      flashBase: 0x14000000,
      decryption: buildDecryptionNotAttempted('no images found'),
      profile: sampleProfile(),
    });
    const readme = makeOfflineDecryptReadme(manifest);
    expect(readme).toContain('my_dump.bin');
    expect(readme).toContain('4194304 bytes');
    expect(readme).toContain('deadbeef'.repeat(8));
  });

  it('does not cite a decryption report it did not write', () => {
    /* Both front ends now package an archive even when nothing decrypted, so a
     * README that always pointed at `decrypted/decryption_report.txt` would be
     * naming a file that is not in the zip. */
    const base = {
      producer: 'p',
      startedAt: 't0',
      finishedAt: '2024-03-05T10:25:00.000Z',
      source: { fileName: 'empty.bin', size: 1024, sha256: 'ab'.repeat(32) },
      flashBase: 0x14000000,
      profile: sampleProfile(),
    };

    const nothing = makeOfflineDecryptReadme(
      buildOfflineDecryptManifest({
        ...base,
        decryption: buildDecryptionNotAttempted('no images found'),
      }),
    );
    expect(nothing).not.toContain('decryption_report.txt');
    expect(nothing).toContain('No firmware image slot was decrypted');
    expect(nothing).toContain('manifest.json');

    const something = makeOfflineDecryptReadme(
      buildOfflineDecryptManifest({
        ...base,
        decryption: buildDecryptionSummary({
          images: [
            buildImageSummary({
              flash: 0x14030000,
              fileOffset: 0x30000,
              length: 0xaf08,
              cipherSha256: 'c'.repeat(64),
              plainSha256: 'p'.repeat(64),
              confidence: 'VERIFIED(profile)',
              key: new Uint8Array(16),
              state: [1, 2, 3, 4],
              derivedTarget: 0x0000ffff,
              profile: 'modern',
              sp: 0x1001f800,
              entry: 0x10000409,
              duplicateOf: null,
              embeddedKeyTable: null,
              file: 'decrypted/x.bin',
            }),
          ],
          keys: [],
        }),
      }),
    );
    expect(something).toContain('decryption_report.txt');
  });
});

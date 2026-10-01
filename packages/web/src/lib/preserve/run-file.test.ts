/**
 * The run-file round trip: state and checkpoints go into a ZIP, the same
 * state and the same bytes come back out — and a damaged or foreign archive
 * is refused rather than half-resumed.
 */

import { crc32, equalBytes, utf8 } from '@seek-fw/core';
import { describe, expect, it } from 'vitest';
import { buildRunFile, parseRunFile, parseZipEntries } from './run-file';
import { runFileName, type CheckpointName, type PreserveRunState } from './types';

function state(overrides: Partial<PreserveRunState> = {}): PreserveRunState {
  return {
    version: 1,
    runId: 'preserve-2026-10-01T10-00-00Z',
    buildFamily: 'v1-2014',
    imageSha256: '1'.repeat(64),
    expectedVersion: '1.3.0.0',
    createdAt: '2026-10-01T10:00:00.000Z',
    nextStep: 'drain',
    steps: {
      backup: { status: 'done', notes: '31 windows' },
      patch: { status: 'done' },
      commit: { status: 'done', notes: 'reset sent' },
    },
    detection: {
      cfgHex: 'ff',
      cfg0: 0,
      blank: true,
      bank: 'a',
      bankAddress: 0x14050000,
      bankMode: 7,
      verdict: 'blank -> bank A',
    },
    patch: {
      sites: [{ name: 'mov.w', offset: 0x3db4, before: [1, 2, 3, 4], after: [5, 6, 7, 8] }],
      rebalanceWord: 0x30006240,
      stagedLength: 0x4000,
      chunkCount: 256,
      patchedSha256: '2'.repeat(64),
    },
    rawDumpSha256: '3'.repeat(64),
    ...overrides,
  };
}

const CHECKPOINTS: readonly (readonly [CheckpointName, Uint8Array])[] = [
  ['preserve_backup_windows.bin', utf8('31 windows of backup bytes')],
  ['preserve_bank_capture.bin', new Uint8Array([0xde, 0xad, 0xbe, 0xef])],
];

interface RawEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

/** A hand-rolled store-only ZIP, for archives `buildRunFile` will not make. */
function handZip(entries: readonly RawEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(14, crc32(entry.data), true);
    lv.setUint32(18, entry.data.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    parts.push(local, entry.data);
    const dir = new Uint8Array(46 + name.length);
    const dv = new DataView(dir.buffer);
    dv.setUint32(0, 0x02014b50, true);
    dv.setUint32(16, crc32(entry.data), true);
    dv.setUint32(20, entry.data.length, true);
    dv.setUint32(24, entry.data.length, true);
    dv.setUint16(28, name.length, true);
    dv.setUint32(42, offset, true);
    dir.set(name, 46);
    central.push(dir);
    offset += local.length + entry.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let at = 0;
  for (const part of [...parts, ...central, eocd]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function sig32(bytes: Uint8Array, at: number): number {
  return (
    ((bytes[at] ?? 0) |
      ((bytes[at + 1] ?? 0) << 8) |
      ((bytes[at + 2] ?? 0) << 16) |
      ((bytes[at + 3] ?? 0) << 24)) >>>
    0
  );
}

describe('the run-file round trip', () => {
  it('build -> parse returns the same state and the same checkpoint bytes', () => {
    const before = state();
    const map = new Map<CheckpointName, Uint8Array>(CHECKPOINTS);
    const zip = buildRunFile(before, map);

    const parsed = parseRunFile(zip);
    expect(parsed.state).toEqual(before);
    expect([...parsed.checkpoints.keys()].sort()).toEqual([...map.keys()].sort());
    for (const [name, data] of map) {
      expect(equalBytes(parsed.checkpoints.get(name) ?? new Uint8Array(), data), name).toBe(true);
    }
    expect(parsed.extra.size).toBe(0);
  });

  it('carries only the checkpoints that exist so far, state file first', () => {
    const zip = buildRunFile(state(), new Map(CHECKPOINTS.slice(0, 1)));
    const entries = parseZipEntries(zip);
    expect(entries.map((entry) => entry.name)).toEqual([
      'preserve_run.json',
      'preserve_backup_windows.bin',
    ]);
  });

  it('unknown files ride along in extra and survive a rebuild', () => {
    const extra = new Map([['a-friends-notes.txt', utf8('kept')]]);
    const parsed = parseRunFile(buildRunFile(state(), new Map(CHECKPOINTS), extra));
    expect(
      equalBytes(parsed.extra.get('a-friends-notes.txt') ?? new Uint8Array(), utf8('kept')),
    ).toBe(true);

    const rebuilt = buildRunFile(parsed.state, parsed.checkpoints, parsed.extra);
    expect(parseRunFile(rebuilt).extra.has('a-friends-notes.txt')).toBe(true);
  });

  it('names the file after the run id', () => {
    expect(runFileName('preserve-2026-10-01T10-00-00Z')).toBe(
      'preserve-run-preserve-2026-10-01T10-00-00Z.zip',
    );
  });
});

describe('parseRunFile refusals', () => {
  it('refuses an archive that holds no run state', () => {
    const zip = handZip([{ name: 'someone-elses.bin', data: utf8('x') }]);
    expect(() => parseRunFile(zip)).toThrow(/holds no preserve_run\.json/);
  });

  it('refuses a run state from another version', () => {
    const future = { ...state(), version: 2 } as unknown as PreserveRunState;
    expect(() => parseRunFile(buildRunFile(future, new Map()))).toThrow(/reads version 1/);
  });

  it('refuses a truncated archive', () => {
    const zip = buildRunFile(state(), new Map(CHECKPOINTS));
    expect(() => parseRunFile(zip.slice(0, zip.length - 24))).toThrow();
  });

  it('refuses a file whose bytes failed their CRC-32', () => {
    const zip = new Uint8Array(buildRunFile(state(), new Map(CHECKPOINTS)));
    /* Byte 60 sits inside the state JSON's data region (30-byte local header
     * + the 17-byte name, then data). */
    zip[60] = (zip[60] ?? 0) ^ 0xff;
    expect(() => parseRunFile(zip)).toThrow(/CRC-32/);
  });

  it('refuses a compressed entry — run files are store-only', () => {
    const zip = new Uint8Array(buildRunFile(state(), new Map(CHECKPOINTS)));
    for (let at = 0; at < zip.length - 4; at++) {
      const sig = sig32(zip, at);
      if (sig === 0x04034b50) zip[at + 8] = 8;
      else if (sig === 0x02014b50) zip[at + 10] = 8;
    }
    expect(() => parseRunFile(zip)).toThrow(/store-only/);
  });

  it('refuses something that is not a ZIP at all', () => {
    expect(() => parseRunFile(utf8('definitely not a zip'))).toThrow(/not a ZIP archive/);
  });
});

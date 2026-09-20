/**
 * The web layer's half of core's "a workflow returns bytes, it never saves a
 * file" rule: core hands back `Artifact[]` and a ZIP as a `Uint8Array`, and
 * this module is the only one that knows what a `Blob` is.
 */

import { describe, expect, it, vi } from 'vitest';
import { utf8 } from '@seek-fw/core';
import {
  REVOKE_DELAY_MS,
  downloadArchive,
  downloadBytes,
  mib,
  type DownloadDeps,
} from './download';

interface Recorder {
  readonly deps: DownloadDeps;
  readonly created: Blob[];
  readonly revoked: string[];
  readonly downloads: { name: string; href: string }[];
  readonly timers: { fn: () => void; ms: number }[];
}

function recorder(): Recorder {
  const created: Blob[] = [];
  const revoked: string[] = [];
  const downloads: { name: string; href: string }[] = [];
  const timers: { fn: () => void; ms: number }[] = [];

  const deps: DownloadDeps = {
    doc: document,
    createObjectURL: (blob) => {
      created.push(blob);
      return `blob:test/${String(created.length)}`;
    },
    revokeObjectURL: (url) => {
      revoked.push(url);
    },
    setTimeout: (fn, ms) => {
      timers.push({ fn, ms });
      return 0;
    },
  };

  /* jsdom navigates on a real anchor click; record instead. */
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function mockClick(
    this: HTMLAnchorElement,
  ) {
    downloads.push({ name: this.download, href: this.href });
  });

  return { deps, created, revoked, downloads, timers };
}

describe('downloadBytes', () => {
  it('wraps the bytes in a Blob, clicks an anchor and schedules the revoke', async () => {
    const rec = recorder();
    downloadBytes(utf8('hello'), 'note.txt', 'text/plain', rec.deps);

    expect(rec.created).toHaveLength(1);
    expect(rec.created[0]?.type).toBe('text/plain');
    expect(await rec.created[0]?.text()).toBe('hello');
    expect(rec.downloads).toEqual([{ name: 'note.txt', href: 'blob:test/1' }]);

    /* The anchor is removed again — no growing pile of dead nodes. */
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);

    expect(rec.timers).toHaveLength(1);
    expect(rec.timers[0]?.ms).toBe(REVOKE_DELAY_MS);
    rec.timers[0]?.fn();
    expect(rec.revoked).toEqual(['blob:test/1']);
  });
});

describe('downloadArchive', () => {
  it('packs every artifact under one folder and reports what it built', async () => {
    const rec = recorder();
    const result = downloadArchive(
      'seek_flash4m_2026-09-20T15-00-00Z',
      [
        { name: 'manifest.json', data: utf8('{}') },
        { name: 'windows/addr_14000000_subcmd_00.bin', data: new Uint8Array(32) },
      ],
      rec.deps,
    );

    expect(result.fileName).toBe('seek_flash4m_2026-09-20T15-00-00Z.zip');
    expect(result.fileCount).toBe(2);
    /* Entries are stored, not deflated, so the ZIP is the payload plus its
     * own bookkeeping — never smaller. */
    expect(result.dataBytes).toBe(2 + 32);
    expect(result.bytes).toBeGreaterThan(result.dataBytes);
    expect(rec.downloads[0]?.name).toBe('seek_flash4m_2026-09-20T15-00-00Z.zip');
    expect(rec.created[0]?.type).toBe('application/zip');

    /* Every entry really is under the one top-level directory. */
    const zip = new Uint8Array(await (rec.created[0] ?? new Blob()).arrayBuffer());
    const text = new TextDecoder('latin1').decode(zip);
    expect(text).toContain('seek_flash4m_2026-09-20T15-00-00Z/manifest.json');
    expect(text).toContain('seek_flash4m_2026-09-20T15-00-00Z/windows/addr_14000000_subcmd_00.bin');
  });
});

describe('mib', () => {
  it('formats byte counts the way the original log lines did', () => {
    expect(mib(4 * 1024 * 1024)).toBe('4.0');
    expect(mib(1536 * 1024, 2)).toBe('1.50');
  });
});

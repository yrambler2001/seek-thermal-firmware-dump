/**
 * The camera-backed commands, driven against core's own fake transport.
 *
 * Nothing here needs hardware: `fakeCamera` answers the same vendor requests a
 * real camera does, and the flash it serves is built by `buildSyntheticFlash`
 * out of core's cipher — so the dump, the decrypt stage and the analysis all
 * have something real to work on.
 */

import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OP } from '@seek-fw/core';
import { run } from '../src/cli.js';
import { EXIT_CANCELLED, EXIT_FAILED, EXIT_OK } from '../src/errors.js';
import { MemorySink } from '../src/sink.js';
import {
  buildSyntheticFlash,
  cameraWithFlash,
  fixedBackend,
  tempDir,
  testIo,
  type SyntheticFlash,
} from './helpers.js';

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

describe('seek-fw devices', () => {
  it('says so, and exits 0, when nothing is attached', async () => {
    const { io, stdout } = testIo({ backend: fixedBackend([]) });
    const code = await run(['devices'], io, signal());
    expect(code).toBe(EXIT_OK);
    expect(stdout.text).toContain('no Seek camera found');
    /* The Linux hint, because an attached camera can be invisible there. */
    expect(stdout.text).toContain('70-seek-thermal.rules');
  });

  it('lists what it found', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const { io, stdout } = testIo({ backend: fixedBackend([camera]) });
    const code = await run(['devices'], io, signal());
    expect(code).toBe(EXIT_OK);
    expect(stdout.text).toContain('0x289d');
    expect(stdout.text).toContain('Seek Thermal Compact PRO');
  });

  it('describes them as JSON', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const { io, stdout } = testIo({ backend: fixedBackend([camera]) });
    await run(['devices', '--json'], io, signal());
    expect(JSON.parse(stdout.text)).toMatchObject({
      command: 'devices',
      ok: true,
      count: 1,
      devices: [{ vendorId: '0x289d', productName: 'Seek Thermal Compact PRO' }],
    });
  });
});

describe('seek-fw info', () => {
  it('reports the firmware, the slots, the keys and the boot config', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const { io, stdout } = testIo({ backend: fixedBackend([camera]) });
    const code = await run(['info'], io, signal());

    expect(code).toBe(EXIT_OK);
    expect(stdout.text).toContain('Slots');
    expect(stdout.text).toContain('0x14030000');
    expect(stdout.text).toContain('Key A');
    /* Detection, from evidence the read itself produced. */
    expect(stdout.text).toContain('modern-4x');
  });

  it('is read-only: no write opcode is ever sent', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const { io } = testIo({ backend: fixedBackend([camera]) });
    await run(['info'], io, signal());
    const sent = new Set(camera.calls.map((call) => call.op));
    expect(sent.has(OP.SET_FEATURED_FIRMWARE_DATA)).toBe(false);
    expect(sent.has(OP.COMPLETE_MEMORY_UPGRADE)).toBe(false);
  });

  it('serialises the whole analysis under --json', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const { io, stdout } = testIo({ backend: fixedBackend([camera]) });
    const code = await run(['info', '--json', '--profile', 'modern-4x'], io, signal());
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(stdout.text) as {
      ok: boolean;
      canFlash: boolean;
      keys: { keyA: string | null };
      slots: { name: string; bootable: boolean; accepts: boolean }[];
      boot: { booted: string | null; upgradeTarget: string | null };
    };
    expect(parsed.ok).toBe(true);
    expect(parsed.keys.keyA).toBe('f32ad7715c0e9942ab13776008c431de');
    expect(parsed.boot).toMatchObject({ booted: 'a', upgradeTarget: 'b' });
    expect(parsed.slots[0]).toMatchObject({ accepts: true, bootable: true });
    expect(parsed.canFlash).toBe(true);
  });

  it('refuses to flash under the generic fallback, and says why', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const { io, stdout } = testIo({ backend: fixedBackend([camera]) });
    await run(['info', '--json', '--profile', 'generic'], io, signal());
    const parsed = JSON.parse(stdout.text) as { canFlash: boolean; flashBlockedBy: string[] };
    expect(parsed.canFlash).toBe(false);
    expect(parsed.flashBlockedBy.join(' ')).toContain('does not support flashing');
  });
});

describe('seek-fw dump', () => {
  it('reads the whole flash, decrypts it and writes the archive', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const out = join(dir, 'dump');
    const { io, stdout } = testIo({ backend: fixedBackend([camera]) });
    const code = await run(['dump', '--out', out, '--chunk', '65536'], io, signal());

    expect(code).toBe(EXIT_OK);
    const files = (await readdir(out)).sort();
    expect(files).toContain('manifest.json');
    expect(files).toContain('README.md');
    expect(files).toContain('windows');
    expect(files).toContain('decrypted');
    expect(files).toContain('flash_4m_usb_partial_gap_ff.bin');

    /* The assembled image is the camera's flash, byte for byte, everywhere a
     * selector reaches. 0x14060000 has none and stays gap-filled. */
    const combined = await readFile(join(out, 'flash_4m_usb_partial_gap_ff.bin'));
    expect(combined.length).toBe(synthetic.flash.length);
    expect(new Uint8Array(combined.subarray(0, 0x60000))).toEqual(
      synthetic.flash.subarray(0, 0x60000),
    );

    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as {
      usbReadableWindows: number;
      decryption: { images?: unknown[] };
    };
    expect(manifest.usbReadableWindows).toBe(63);
    expect(manifest.decryption.images).toHaveLength(1);
    expect(stdout.text).toContain('63/63 windows');
  });

  it('never sends a write opcode', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const { io } = testIo({ backend: fixedBackend([camera]) });
    await run(['dump', '--out', join(dir, 'ro'), '--chunk', '65536'], io, signal());
    for (const call of camera.calls) {
      expect([
        OP.GET_ERROR_CODE,
        OP.SET_OPERATION_MODE,
        OP.GET_OPERATION_MODE,
        OP.GET_FEATURED_FIRMWARE_DATA,
        OP.BEGIN_FIRMWARE_UPGRADE,
      ]).toContain(call.op);
    }
  });

  it('saves the partial archive when interrupted, and still exits 130', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const controller = new AbortController();
    const out = join(dir, 'partial');

    /* Ctrl-C after a few windows: the sink pulls the trigger once the run has
     * logged its first reads. */
    const stdout = new AbortingSink(controller, 6);
    const { io } = testIo({ backend: fixedBackend([camera]), stdout });
    const code = await run(
      ['dump', '--out', out, '--chunk', '65536', '--verbose'],
      io,
      controller.signal,
    );

    expect(code).toBe(EXIT_CANCELLED);

    /* Core stops where it is and hands back everything it read, so a cancelled
     * dump is a COMPLETE archive describing a PARTIAL read — never silently
     * truncated output. */
    const written = await readdir(join(out, 'windows'));
    expect(written.length).toBeGreaterThan(0);
    expect(written.length).toBeLessThan(63);

    const files = (await readdir(out)).sort();
    expect(files).toContain('manifest.json');
    expect(files).toContain('README.md');
    expect(files).toContain('flash_4m_usb_partial_gap_ff.bin');

    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as {
      cancelled: boolean;
      usbReadableWindows: number;
      decryption: { attempted: boolean; reason?: string };
    };
    expect(manifest.cancelled).toBe(true);
    expect(manifest.usbReadableWindows).toBe(written.length);
    expect(manifest.decryption.attempted).toBe(false);
    expect(stdout.text).toContain('PARTIAL');
  });
});

describe('seek-fw sweep', () => {
  it('probes every selector and reports what answered', async () => {
    const camera = cameraWithFlash(synthetic.flash);
    const out = join(dir, 'sweep');
    const { io, stdout } = testIo({ backend: fixedBackend([camera]) });
    const code = await run(['sweep', '--out', out, '--chunk', '65536'], io, signal());

    expect(code).toBe(EXIT_OK);
    const files = await readdir(out);
    expect(files).toContain('blocks');
    expect(files).toContain('manifest.json');
    expect(stdout.text).toMatch(/selector\(s\) armed/);
  });
});

describe('failure reporting', () => {
  it('maps a missing camera onto a clear message and exit 1', async () => {
    const { io, stderr } = testIo({ backend: fixedBackend([]) });
    const code = await run(['dump'], io, signal());
    expect(code).toBe(EXIT_FAILED);
    expect(stderr.text).toContain('no Seek camera found');
    expect(stderr.text).toContain('70-seek-thermal.rules');
    expect(stderr.text).not.toContain('at Object.');
  });
});

/** A stdout sink that aborts the run once it has seen `after` writes. */
class AbortingSink extends MemorySink {
  private readonly controller: AbortController;
  private readonly after: number;

  constructor(controller: AbortController, after: number) {
    super();
    this.controller = controller;
    this.after = after;
  }

  override write(text: string): void {
    super.write(text);
    if (this.chunks.length >= this.after) this.controller.abort();
  }
}

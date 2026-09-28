/* ==================================================================== *
 * The flash gate, on the one dump whose running application cannot take an
 * upload: Mosaic 10.9.1.31 (TESTING.md sec.21.2).
 *
 * WHAT THE DUMP IS (FW-V1 Phase 51). Its bootloader's key pair is 874dfcf6... /
 * b23b0d20... (flash 0x17B4 / 0x17C4), and both image banks are encrypted under
 * it. Its application embeds f32ad771... / 997ed6e5... - the Compact PRO FF
 * 4.18.2.0 pilot's pair - and its per-device key slot is erased. The toolkit
 * encrypts an upload under the bootloader's Key A; the application decrypts it
 * with its own, the commit answers OK, the new slot fails the bootloader's
 * acceptance test under both of its keys, and the camera boots the old slot
 * again. FW-V1 ran exactly that upload on its emulator: OK, cfg[0] = 1, slot A.
 *
 * WHAT IS CHECKED HERE. The toolkit's own `readDeviceInfo`, over the emulated
 * camera, names the reason and turns flashing off; `prepareImage` then refuses
 * with that reason before a payload exists, and nothing that writes - no
 * SetFeaturedFirmwareData, no CompleteMemoryUpgrade - went out. Before sec.21.2
 * the same read reported this camera flashable. The emulator only: nothing here
 * is ever run against a real camera.
 *
 * AND IT NAMES NO OTHER CAMERA. The same read runs on every other full dump of
 * the post-2016 line (11 of them): on each, the running application carries its
 * bootloader's key pair and the gate adds no reason. Measured when this was
 * written; a camera that one day trips it is news about that camera.
 * ==================================================================== */

import { afterAll, describe, expect, it } from 'vitest';

import { SeekError } from '../src/errors.js';
import { silentReporter } from '../src/events.js';
import { SeekDevice } from '../src/protocol/client.js';
import { OP } from '../src/protocol/ops.js';
import { WebUsbTransport } from '../src/protocol/webusb.js';
import { getProfile } from '../src/profiles/registry.js';
import { bytesToHex } from '../src/bytes.js';
import { bootedSlot, readDeviceInfo } from '../src/workflows/device-info.js';
import { prepareImage } from '../src/workflows/flash.js';
import { keyFilenameSuffix } from '../src/crypto/keys.js';
import { liveEmulatorCount, RowEmulators } from './emulator/harness.js';
import {
  announceSkip,
  BOOT_TIMEOUT_MS,
  EMU_DIR,
  ENTRIES,
  URB_TIMEOUT_MS,
} from './emulator/suite.js';

const ENTRY = 'mosaic/2019.11.19-09.59.21-10.9.1.31/no-serial/dump';
const TIMEOUT_MS = Number(process.env.SEEK_EMU_FLASH_GATE_TIMEOUT_MS ?? '900000');
/** The two write opcodes of the upgrade (the arm of selector 0 is also a read). */
const WRITES: ReadonlySet<number> = new Set([
  OP.SET_FEATURED_FIRMWARE_DATA,
  OP.COMPLETE_MEMORY_UPGRADE,
]);

const available = EMU_DIR !== null && ENTRIES.some((entry) => entry.id === ENTRY);
if (!available) announceSkip(`the flash gate on ${ENTRY}`);

/** Every full dump of the post-2016 line: all but the 2014 Compact and the 2016
 *  Compact PROs, which are legacy builds `modern-4x` does not read. */
const OTHERS = ENTRIES.filter(
  (entry) =>
    entry.kind === 'full-dump' &&
    entry.id !== ENTRY &&
    !entry.id.startsWith('compact/2014.') &&
    !entry.id.startsWith('compact_pro/2016.'),
);

/** `readDeviceInfo` under `modern-4x` over one emulated dump, on its own clock. */
async function readOver(
  row: RowEmulators,
  entryId: string,
  sent: number[] = [],
): Promise<Awaited<ReturnType<typeof readDeviceInfo>>> {
  const emu = await row.start(EMU_DIR!, { entryId, readyTimeoutMs: BOOT_TIMEOUT_MS });
  return row.guard(emu, async () => {
    const device = await emu.attach({ urbTimeoutMs: URB_TIMEOUT_MS });
    const transport = new WebUsbTransport(device, {
      recipient: 'auto',
      api: 'usbip (emulator)',
      host: 'vitest',
      clock: device.deadlineClock,
    });
    const controlOut = transport.controlOut.bind(transport);
    transport.controlOut = (request, data, timeoutMs): Promise<void> => {
      sent.push(request);
      return controlOut(request, data, timeoutMs);
    };
    await transport.open();
    try {
      return await readDeviceInfo({
        device: new SeekDevice(transport),
        profile: getProfile('modern-4x'),
        detection: null,
        reporter: silentReporter,
      });
    } finally {
      await transport.close();
    }
  });
}

const KEY_REASON = /the running application .* (does not carry|but not its Key B)/;

describe.skipIf(!available)('the flash gate on the emulated Mosaic 10.9.1.31 dump', () => {
  afterAll(() => {
    expect(liveEmulatorCount(), 'every emulator this file started was stopped').toBe(0);
  });

  it(
    "refuses a camera whose running application does not carry its bootloader's Key A",
    { timeout: TIMEOUT_MS },
    async () => {
      const row = new RowEmulators(ENTRY);
      try {
        const sent: number[] = [];
        const state = await readOver(row, ENTRY, sent);

        /* ---- the premise, as FW-V1 Phase 51 has it ---- */
        expect(state.version, 'the running build').toBe('10.9.1.31');
        expect(state.keyTable, "the bootloader's key table, confirmed").not.toBeNull();
        if (state.keyTable === null) return;
        expect(bytesToHex(state.keyTable.keyA).slice(0, 8)).toBe('874dfcf6');
        expect(bytesToHex(state.keyTable.keyB).slice(0, 8)).toBe('b23b0d20');
        expect(state.storeKey.programmed, 'the per-device key slot is erased').toBe(false);
        const running = bootedSlot(state);
        expect(running?.plain, 'the running image, decrypted').not.toBeNull();
        if (running?.plain == null) return;

        /* ---- the gate ---- */
        expect(state.canFlash).toBe(false);
        const reason = state.flashBlockedBy.find((why) =>
          why.includes("does not carry this camera's Key A"),
        );
        expect(reason, state.flashBlockedBy.join('\n')).toBeDefined();
        expect(reason).toContain(bytesToHex(state.keyTable.keyA));
        expect(reason).toContain('10.9.1.31');

        /* ---- and the write path refuses with it, before a payload exists ---- */
        const name = `mosaic_10.9.1.31${keyFilenameSuffix(state.keyTable.keyA, state.keyTable.keyB)}.bin`;
        let refused: unknown = null;
        try {
          prepareImage(state, running.plain, name);
        } catch (error) {
          refused = error;
        }
        expect(refused).toBeInstanceOf(SeekError);
        expect((refused as SeekError).code).toBe('flash/refused');
        expect((refused as SeekError).message).toContain("does not carry this camera's Key A");
        expect(
          sent.filter((op) => WRITES.has(op)),
          'no upgrade write went out',
        ).toEqual([]);
        await row.assertDelivery();
      } finally {
        await row.finish();
      }
    },
  );

  it('has eleven other post-2016 dumps to hold the gate against', () => {
    expect(OTHERS.map((entry) => entry.id)).toHaveLength(11);
  });

  for (const entry of OTHERS) {
    it.concurrent(
      `${entry.id}: the running application carries its keys, and the gate says nothing`,
      { timeout: TIMEOUT_MS },
      async () => {
        const row = new RowEmulators(entry.id);
        try {
          const state = await readOver(row, entry.id);
          expect(state.keyTable, "the bootloader's key table, confirmed").not.toBeNull();
          expect(bootedSlot(state)?.plain, 'the running image, decrypted').not.toBeNull();
          expect(state.flashBlockedBy.filter((why) => KEY_REASON.test(why))).toEqual([]);
          await row.assertDelivery();
        } finally {
          await row.finish();
        }
      },
    );
  }
});

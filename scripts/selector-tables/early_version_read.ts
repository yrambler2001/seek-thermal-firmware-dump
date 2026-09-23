/* Can the toolkit read a firmware's version at the moment it plans a dump?  Backs
 * TESTING.md sec.10.4 (0.5.1.0 and 0.5.1.3) and FW-V1 docs/EMULATOR_CAMPAIGN_LOG.md,
 * Phase 21.  Run from the toolkit checkout:
 *
 *   npx jiti scripts/selector-tables/early_version_read.ts <corpus-entry-id-substring>
 *
 * SEEK_TOOLKIT_DIR (default: the current directory) and SEEK_EMU_DIR (default:
 * <toolkit>/../FW-V1/emu) locate the two checkouts.  Boots the entry with the tier-1
 * fill, attaches over USB/IP, and prints: GetFirmwareInfo unarmed at 36 and 4 bytes,
 * twice; GetErrorCode; then the toolkit's own probeSelectorChannel(), whose notes say
 * what version (if any) it saw and what it did about it.  On 0.5.1.0 and 0.5.1.3 every
 * one of those requests stalls, so the probe reports no version and goes on to arm;
 * on 0.5.0.2 the version comes back at once.  Ends with the delivery audit. */
import path from 'node:path';

const TOOLKIT = process.env.SEEK_TOOLKIT_DIR ?? process.cwd();
const EMU = process.env.SEEK_EMU_DIR ?? path.resolve(TOOLKIT, '..', 'FW-V1', 'emu');
const CORE = path.join(TOOLKIT, 'packages', 'core');
const { Emulator, loadManifest } = await import(path.join(CORE, 'test/emulator/harness.ts'));
const { WebUsbTransport } = await import(path.join(CORE, 'src/protocol/webusb.ts'));
const { SeekDevice } = await import(path.join(CORE, 'src/protocol/client.ts'));
const { probeSelectorChannel } = await import(path.join(CORE, 'src/workflows/capability.ts'));

const want = process.argv[2];
if (!want) throw new Error('usage: early_version_read.ts <corpus-entry-id-substring>');
const hits = loadManifest(EMU).filter((e: { id: string }) => e.id.includes(want));
if (hits.length !== 1) throw new Error(`${want} matches ${hits.length} corpus entries`);
const entry = hits[0].id;

const emu = await Emulator.start(EMU, {
  entryId: entry,
  fillSeed: 388609,
  fillScope: 'safe',
  readyTimeoutMs: 180_000,
});
const out: string[] = [`entry: ${entry}`];
try {
  const device = await emu.attach({ urbTimeoutMs: 30_000 });
  const transport = new WebUsbTransport(device, {
    recipient: 'auto',
    api: 'usbip',
    host: 'instrument',
  });
  await transport.open();
  const seek = new SeekDevice(transport);
  const tryIn = async (label: string, op: number, n: number): Promise<void> => {
    try {
      out.push(`${label}: ${Buffer.from(await seek.rpcIn(op, n)).toString('hex')}`);
    } catch (e) {
      out.push(`${label}: ERR ${(e as Error).message}`);
      await transport.close().catch(() => undefined);
      await transport.open().catch(() => undefined);
    }
  };
  await tryIn('GetFirmwareInfo 36 (first request)', 0x4e, 36);
  await tryIn('GetFirmwareInfo 4', 0x4e, 4);
  await tryIn('GetFirmwareInfo 36 (again)', 0x4e, 36);
  await tryIn('GetErrorCode 4', 0x35, 4);
  await tryIn('GetFirmwareInfo 36 (after GetErrorCode)', 0x4e, 36);
  const probe = await probeSelectorChannel(seek);
  out.push(`probeSelectorChannel: ${JSON.stringify(probe)}`);
  await transport.close().catch(() => undefined);
  await device.close().catch(() => undefined);
} finally {
  await emu.stop();
  out.push(`delivery violations: ${JSON.stringify(emu.auditDelivery().violations)}`);
}
console.log(out.join('\n'));

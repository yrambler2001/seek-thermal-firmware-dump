/* How often does `seek_emu.py --usbip` fail to stop on SIGTERM at the end of a row?
 * Backs FW-V1 docs/EMULATOR_CAMPAIGN_LOG.md, Phase 19.  Run from the toolkit checkout:
 *
 *   npx jiti scripts/recipient-fidelity/stop_stress.ts <entry> <new|old> [workers] [per]
 *
 * mode=new: the adapter as it is.  mode=old: the adapter's pre-fix behaviour (claim sends
 * SET_INTERFACE as bmRequestType 0x00, configuration starts null).  Each trial boots an
 * emulator, does the probe's shape (a few re-imports and vendor reads), closes, and stops
 * it with SIGTERM at once through the harness (`Emulator.stop()`, 30 s backstop).
 * MEASURED 2026-09-22, mode=new, 1.3.0.8 Compact: on the pre-fix emulator 0 hangs in 200
 * trials (80 idle, 120 under twelve `yes` loops), stop p50 0.26 s; on the fixed one 0 in 40,
 * p50 0.26 s.  So this timing does NOT reproduce the SIGTERM self-deadlock the suite hit
 * (3 of 198 processes); FW-V1 emu/selftest.py `check_usbip_signal_stop` forces it instead.  Kept
 * as the stop-latency check.  mode=old was not run. */
import path from 'node:path';

const TOOLKIT = process.env.SEEK_TOOLKIT_DIR ?? process.cwd();
const EMU = process.env.SEEK_EMU_DIR ?? path.resolve(TOOLKIT, '..', 'FW-V1', 'emu');
const CORE = path.join(TOOLKIT, 'packages', 'core');
const { Emulator } = await import(path.join(CORE, 'test/emulator/harness.ts'));
const { UsbIpWebUsbDevice } = await import(path.join(CORE, 'test/emulator/webusb-over-usbip.ts'));
const { WebUsbTransport } = await import(path.join(CORE, 'src/protocol/webusb.ts'));

const [entry, mode = 'new', workersText = '6', perText = '8'] = process.argv.slice(2);
if (!entry) throw new Error('usage: stop_stress.ts <entry> <new|old> [workers] [per]');
if (mode === 'old') {
  UsbIpWebUsbDevice.prototype.claimInterface = async function (n: number) {
    await (this as any).standardOut(0x00, 0x0b, 0, n);
  };
}
const results: { stopS: number; hung: boolean }[] = [];
async function trial(): Promise<void> {
  const emu = await Emulator.start(EMU, { entryId: entry!, readyTimeoutMs: 180_000 });
  const device = await emu.attach({ urbTimeoutMs: 30_000 });
  if (mode === 'old') (device as any).configuration = null;
  const t = new WebUsbTransport(device, { recipient: 'auto' });
  await t.open();
  for (let i = 0; i < 6; i++) {
    await t.controlIn(0x35, 4, 5000);
    await t.controlIn(0x4e, 4, 5000);
    await t.close();
    await t.open();
  }
  await t.controlIn(0x3d, 2, 5000);
  await t.close();
  await device.close();
  const t0 = Date.now();
  await emu.stop();
  results.push({ stopS: (Date.now() - t0) / 1000, hung: emu.auditDelivery().server === null });
}
await Promise.all(Array.from({ length: Number(workersText) }, async () => {
  for (let i = 0; i < Number(perText); i++) await trial();
}));
const stops = results.map((r) => r.stopS).sort((a, b) => a - b);
console.log(`mode=${mode} trials=${results.length} hung-on-SIGTERM=${results.filter((r) => r.hung).length} ` +
  `stop p50=${stops[Math.floor(stops.length / 2)]}s max=${stops.at(-1)}s`);

/* What the consumer's USB/IP adapter makes the toolkit's real transport do, and what one
 * emulated firmware answers to each recipient.  Backs FW-V1 docs/EMULATOR_CAMPAIGN_LOG.md,
 * Phase 19.  Run from the toolkit checkout:
 *
 *   npx jiti scripts/recipient-fidelity/ground_truth.ts <corpus-entry-id>
 *
 * SEEK_TOOLKIT_DIR (default: the current directory) and SEEK_EMU_DIR (default:
 * <toolkit>/../FW-V1/emu) locate the two checkouts.  Prints, for that firmware:
 * the import record's configuration and interface count; `transport.info` and any
 * `onWarning` after `WebUsbTransport.open()` with recipient 'auto'; SET_INTERFACE sent
 * raw as bmRequestType 0x00 and as 0x01; GET_INTERFACE; and four read-only vendor
 * requests as 0xC0, as 0xC1, and as 0xC1 with wIndex=1.  Against the pre-fix adapter
 * (toolkit dd336c0) the transport falls back to recipient=device with the warning
 * "could not claim interface 0 (control 11 stalled ...)"; against the fixed one it
 * claims interface 0 with no packet and stays on recipient=interface. */
import path from 'node:path';

const TOOLKIT = process.env.SEEK_TOOLKIT_DIR ?? process.cwd();
const EMU = process.env.SEEK_EMU_DIR ?? path.resolve(TOOLKIT, '..', 'FW-V1', 'emu');
const CORE = path.join(TOOLKIT, 'packages', 'core');
const { Emulator } = await import(path.join(CORE, 'test/emulator/harness.ts'));
const { WebUsbTransport } = await import(path.join(CORE, 'src/protocol/webusb.ts'));

const entry = process.argv[2];
if (!entry) throw new Error('usage: ground_truth.ts <corpus-entry-id>');
const emu = await Emulator.start(EMU, { entryId: entry, readyTimeoutMs: 180_000 });
const out: string[] = [`entry: ${entry}`];
try {
  const device = await emu.attach({ urbTimeoutMs: 30_000 });
  const rec = (device as any).session.device;
  out.push(`import record: bConfigurationValue=${rec.bConfigurationValue} bNumInterfaces=${rec.bNumInterfaces}`);
  out.push(`adapter.configuration at attach: ${JSON.stringify(device.configuration)}`);
  const warnings: string[] = [];
  const t = new WebUsbTransport(device, { recipient: 'auto', onWarning: (m: string) => warnings.push(m) });
  await t.open();
  out.push(`transport.info after open(): ${JSON.stringify(t.info)}`);
  out.push(`onWarning: ${JSON.stringify(warnings)}`);
  const s = (device as any).session;
  const ctl = async (bm: number, req: number, val: number, idx: number, len: number): Promise<string> => {
    try {
      const r = await s.controlTransfer({ bmRequestType: bm, bRequest: req, wValue: val, wIndex: idx }, null, len, 30_000);
      return `ok ${Buffer.from(r).toString('hex')}`;
    } catch (e) {
      return `ERR ${(e as Error).message}`;
    }
  };
  out.push(`SET_INTERFACE bm=0x00 (not a USB 2.0 request): ${await ctl(0x00, 0x0b, 0, 0, 0)}`);
  out.push(`SET_INTERFACE bm=0x01 (USB 2.0 sec.9.4.10):   ${await ctl(0x01, 0x0b, 0, 0, 0)}`);
  out.push(`GET_INTERFACE bm=0x81 wIndex=0:              ${await ctl(0x81, 0x0a, 0, 0, 1)}`);
  for (const [name, op, len] of [['GetErrorCode', 0x35, 4], ['GetOperationMode', 0x3d, 2], ['GetFirmwareInfo', 0x4e, 4], ['GetChipID', 0x36, 12]] as const) {
    out.push(`${name}: 0xC0 ${await ctl(0xc0, op, 0, 0, len)} | 0xC1 ${await ctl(0xc1, op, 0, 0, len)} | 0xC1 wIndex=1 ${await ctl(0xc1, op, 0, 1, len)}`);
  }
  s.close();
} finally {
  await emu.stop();
  const a = emu.auditDelivery();
  out.push(`delivery violations: ${JSON.stringify(a.violations)}`);
  out.push(...emu.log(400).split('\n').filter((l: string) => /usbip: urb/.test(l)));
}
console.log(out.join('\n'));

/* READ-ONLY cross-check against a real camera, through the CLI's own host stack.
 * Backs FW-V1 docs/EMULATOR_CAMPAIGN_LOG.md, Phase 19.  Run from the toolkit checkout with the
 * camera powered and nothing else holding it:
 *
 *   npx jiti scripts/recipient-fidelity/hw_readonly.ts
 *
 * The host stack is the `usb` package 3.x WebUSB shim (node-usb-rs over nusb), wrapped in
 * the toolkit's real WebUsbTransport exactly as packages/cli/src/backend.ts wraps it.  It
 * opens with recipient 'auto' (the CLI default) and then 'device', and sends ONLY these
 * vendor IN requests, each checked against packages/core/test/firmware/facts.json for
 * 4.18.2.0 (wire id = index + 53): 0x35 GetErrorCode, 0x36 GetChipID, 0x3D
 * GetOperationMode, 0x4E GetFirmwareInfo.  No OUT request of any kind.  On another build,
 * check its facts.json row before running this. */
import path from 'node:path';

const TOOLKIT = process.env.SEEK_TOOLKIT_DIR ?? process.cwd();
const { WebUSB } = await import(path.join(TOOLKIT, 'node_modules/usb/dist/index.js'));
const { WebUsbTransport } = await import(path.join(TOOLKIT, 'packages/core/src/protocol/webusb.ts'));

const READS: readonly (readonly [string, number, number])[] = [
  ['GetErrorCode', 0x35, 4],
  ['GetChipID', 0x36, 12],
  ['GetOperationMode', 0x3d, 2],
  ['GetFirmwareInfo', 0x4e, 4],
];
const ALLOWED = new Set(READS.map((r) => r[1]));

const all = await new WebUSB({ allowAllDevices: true }).getDevices();
const seek = all.filter((d: { vendorId: number }) => d.vendorId === 0x289d);
console.log(`devices: ${all.length} total, ${seek.length} Seek`);
if (seek.length !== 1) process.exit(2);
const dev = seek[0];
let cfg: unknown;
try {
  cfg = dev.configuration?.configurationValue;
} catch (e) {
  cfg = `THROWS: ${(e as Error).message}`;
}
console.log(`device: ${dev.productName} / ${dev.manufacturerName}; configuration before open = ${String(cfg)}`);
for (const preference of ['auto', 'device'] as const) {
  const warnings: string[] = [];
  const t = new WebUsbTransport(dev, {
    recipient: preference,
    api: 'node-usb 3.x (WebUSB shim)',
    host: `node ${process.version} ${process.platform}/${process.arch}`,
    onWarning: (m: string) => warnings.push(m),
  });
  await t.open();
  console.log(`\n[recipient: ${preference}] transport.info after open(): ${JSON.stringify(t.info)}`);
  console.log(`[recipient: ${preference}] onWarning: ${JSON.stringify(warnings)}`);
  for (const [name, op, len] of READS) {
    if (!ALLOWED.has(op)) throw new Error('refusing a request that is not on the allow-list');
    try {
      const got = await t.controlIn(op, len, 5000);
      console.log(`  ${t.info.recipient === 'interface' ? '0xC1' : '0xC0'} ${name.padEnd(17)} -> ok ${Buffer.from(got).toString('hex')}`);
    } catch (e) {
      console.log(`  ${name.padEnd(17)} -> ERR ${(e as Error).message}`);
    }
  }
  await t.close();
}

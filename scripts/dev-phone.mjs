/**
 * The dev server, reachable from an Android phone on the same Wi-Fi.
 *
 * WebUSB only exists in a secure context — HTTPS, or localhost — so a phone
 * opening the plain `http://<this-computer>:5173` gets no `navigator.usb` at
 * all. This serves the same app over HTTPS on the local network with a
 * self-signed certificate made here (once, and again when this computer's
 * address changes), and prints the address to open on the phone.
 *
 * Live reload is OFF in this mode, on purpose: the page tells a phone user to
 * switch on airplane mode before a write, and Vite's client reloads the page
 * when it finds the server again — a reload mid-write would end the run. With
 * the websocket off (vite.config.ts) the open page never talks to the server
 * again; reload it by hand after an edit.
 *
 * Usage:
 *   npm run dev:phone            (port 5174, so the usual `npm run dev` can keep 5173)
 *   PORT=8443 npm run dev:phone
 *   HTTP=1 npm run dev:phone     (plain HTTP, for a phone whose Chrome lists the
 *                                 address under "Insecure origins treated as secure")
 *
 * Needs `openssl` on the PATH (macOS and most Linux distributions ship it).
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const certDir = path.join(repoRoot, 'packages', 'web', '.cert');
const keyFile = path.join(certDir, 'dev-phone-key.pem');
const certFile = path.join(certDir, 'dev-phone-cert.pem');
const sanFile = path.join(certDir, 'dev-phone-san.txt');
const port = process.env.PORT ?? '5174';
const plainHttp = process.env.HTTP === '1';
const scheme = plainHttp ? 'http' : 'https';

/** Virtual adapters (VM bridges, VPN tunnels, containers): no phone is on them. */
const VIRTUAL = /^(bridge|vmnet|vboxnet|docker|br-|veth|utun|tun|tap|llw|awdl|anpi|ap\d)/;

/** This computer's IPv4 addresses a phone on the same network can reach —
 *  the real adapters first; the virtual ones only if nothing else is up. */
function lanAddresses() {
  const all = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue; /* link-local: no DHCP */
      all.push({ name, address: entry.address });
    }
  }
  const real = all.filter((entry) => !VIRTUAL.test(entry.name));
  return real.length > 0 ? real : all;
}

/** Makes the certificate unless one for exactly these addresses exists. */
function ensureCertificate(addresses) {
  const san = ['DNS:localhost', 'IP:127.0.0.1', ...addresses.map((a) => `IP:${a}`)].join(',');
  if (
    existsSync(keyFile) &&
    existsSync(certFile) &&
    existsSync(sanFile) &&
    readFileSync(sanFile, 'utf8') === san
  ) {
    return;
  }
  mkdirSync(certDir, { recursive: true });
  const made = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      keyFile,
      '-out',
      certFile,
      '-days',
      '365',
      '-subj',
      '/CN=seek-fw dev server',
      '-addext',
      `subjectAltName=${san}`,
      '-addext',
      'extendedKeyUsage=serverAuth',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  if (made.error !== undefined || made.status !== 0) {
    console.error(
      `could not make the HTTPS certificate with openssl: ${
        made.error?.message ?? made.stderr.toString().trim()
      }`,
    );
    process.exit(1);
  }
  writeFileSync(sanFile, san);
}

const lan = lanAddresses();
if (lan.length === 0) {
  console.error('no network address found — connect this computer to the Wi-Fi the phone uses');
  process.exit(1);
}
if (!plainHttp) ensureCertificate(lan.map((entry) => entry.address));

const rule = '─'.repeat(76);
console.log(
  [
    rule,
    'Phone access (Chrome on Android, same Wi-Fi as this computer). Open on the phone:',
    '',
    ...lan.map((entry) => `    ${scheme}://${entry.address}:${port}/#/preserve    (${entry.name})`),
    '',
    ...(plainHttp
      ? [
          'Plain HTTP has no WebUSB unless the phone trusts this address: open',
          'chrome://flags/#unsafely-treat-insecure-origin-as-secure on the phone, add',
          `http://<address above>:${port}, enable it and relaunch Chrome.`,
        ]
      : [
          'Chrome warns that the certificate is not trusted — it was made on this computer',
          'for this server. Tap "Advanced", then "Proceed to …".',
          '',
          'If "Connect device" stays unavailable on that page, run HTTP=1 npm run dev:phone',
          'and follow what it prints instead.',
        ]),
    '',
    'Plug the camera into the phone with a USB-C OTG adapter and press "Connect device".',
    'No live reload in this mode, so airplane mode mid-run is safe — the page never',
    'reloads itself. After an edit, reload the page on the phone yourself.',
    rule,
  ].join('\n'),
);

const child = spawn(
  'npm',
  [
    'run',
    'dev',
    '--workspace',
    '@seek-fw/web',
    '--',
    '--host',
    '0.0.0.0',
    '--port',
    port,
    '--strictPort',
  ],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      SEEK_DEV_PHONE: '1',
      ...(plainHttp ? {} : { SEEK_DEV_HTTPS_KEY: keyFile, SEEK_DEV_HTTPS_CERT: certFile }),
    },
  },
);
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal === null ? 0 : 1));
});

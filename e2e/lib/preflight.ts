/**
 * The pre-flight every real-camera run makes before it touches anything:
 * exactly one Seek camera on the bus, its interface held by no other program
 * (macOS shows a claim as an interface user client under the device), and
 * neither the CLI nor the user's own hardware probe running. Read-only: it
 * asks `ioreg` and `pgrep`, never the camera.
 */

import { execFileSync } from 'node:child_process';

/**
 * Why the camera cannot be used right now, or null when it can: it must be
 * on the bus exactly once, no program may hold its interface (macOS shows a
 * claim as an interface user client under the device), and neither the CLI nor
 * the user's own hardware probe may be running.
 */
export function cameraBusyReason(): string | null {
  let tree: string;
  try {
    tree = execFileSync('ioreg', ['-l', '-w0', '-p', 'IOService'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
  } catch (error) {
    return `ioreg failed: ${error instanceof Error ? error.message : String(error)}`;
  }
  const lines = tree.split('\n');
  /* A device's own properties run from its `+-o` line to the next one. */
  const ownProperties = (i: number): string[] => {
    const next = lines.findIndex((l, j) => j > i && l.includes('+-o'));
    return lines.slice(i + 1, next < 0 ? undefined : next);
  };
  const starts = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /\+-o .*<class IOUSBHostDevice/.test(line))
    .filter(({ i }) => ownProperties(i).some((l) => /"idVendor" = 10397\b/.test(l)));
  if (starts.length === 0) return 'no Seek camera (vendor 0x289d) is on the bus';
  if (starts.length > 1) return `${String(starts.length)} Seek cameras are on the bus`;
  const start = starts[0]?.i ?? 0;
  const indent = (lines[start] ?? '').indexOf('+-o');
  const holders: string[] = [];
  let inInterfaceClient = false;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const at = line.indexOf('+-o');
    if (at >= 0 && at <= indent) break;
    if (at >= 0) inInterfaceClient = line.includes('<class AppleUSBHostInterfaceUserClient');
    const creator = /"IOUserClientCreator" = "pid (\d+), (.*)"/.exec(line);
    if (inInterfaceClient && creator !== null && creator[2] !== 'accessoryd') {
      holders.push(`${creator[2] ?? '?'} (pid ${creator[1] ?? '?'})`);
    }
  }
  if (holders.length > 0) return `the camera's interface is held by ${holders.join(', ')}`;
  let running = '';
  try {
    running = execFileSync('pgrep', ['-fl', 'real-camera-probe|seek-fw|packages/cli/dist/bin.js'], {
      encoding: 'utf8',
    });
  } catch {
    /* pgrep exits 1 when nothing matches */
  }
  const others = running
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.includes('pgrep'));
  if (others.length > 0) return `another camera client is running: ${others.join('; ')}`;
  return null;
}

/**
 * Regenerate the emulator suites' pinned expectations.
 *
 *   node scripts/update-emulator-expectations.mjs              # both tiers
 *   node scripts/update-emulator-expectations.mjs --tier 1     # RPC surface only
 *   node scripts/update-emulator-expectations.mjs --tier2 all  # round-trip all 51
 *   node scripts/update-emulator-expectations.mjs --workers 4  # fewer emulators
 *
 * `--tier 1` leaves the round-trip expectations alone; the tier-2 suite skips
 * with an empty population and never rewrites its file.
 *
 * WHY IT RE-RUNS THE SUITE INSTEAD OF DOING THE WORK ITSELF.
 * A hand-written expectation rots, and so does one written by a second copy of
 * the measurement. This runs the very test files that will later check the
 * result, with `SEEK_EMU_REGEN=1`, which makes them record what they observed
 * instead of asserting it. An expectation therefore cannot claim something the
 * measurement never made.
 *
 * WHAT A DIFF MEANS. Adding a firmware to the corpus is an expansion — a new
 * key appears and nothing else moves. If regenerating alters an EXISTING entry,
 * something changed about what real firmware does over a real transport, or
 * about this toolkit's model of it. Read that diff; do not commit it unread.
 *
 * Needs the emulator: set SEEK_EMU_DIR, or keep an FW-V1 checkout beside this
 * one. Without it the suites skip and this script says so and exits 0.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
function flag(name, fallback = null) {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && at + 1 < args.length ? args[at + 1] : fallback;
}

const tier = flag('tier', 'both');
const tier2 = flag('tier2', process.env.SEEK_EMU_TIER2 ?? 'dumps');
const workers = flag('workers', process.env.SEEK_EMU_WORKERS ?? '6');

const emuDir =
  process.env.SEEK_EMU_DIR && process.env.SEEK_EMU_DIR.length > 0
    ? process.env.SEEK_EMU_DIR
    : path.resolve(root, '..', 'FW-V1', 'emu');

if (!existsSync(path.join(emuDir, 'seek_emu.py'))) {
  console.error(`no emulator at ${emuDir}`);
  console.error('set SEEK_EMU_DIR to a FW-V1 "emu" directory, or keep FW-V1 beside this repo');
  process.exit(0);
}

/* ONE vitest run, not one per tier.
 *
 * Both emulator suites write their own expectation file from their own
 * `afterAll`, so a single pass regenerates both — and a file filter would not
 * help anyway: under this repo's `projects` layout a positional path filter
 * matches nothing and vitest falls back to running every file. `--tier 1` is
 * therefore expressed as "run tier 2 over an empty population", which the tier-2
 * suite understands as a loud skip. */
const tier2Selection = tier === '1' ? 'none' : tier2;

console.log(`emulator : ${emuDir}`);
console.log(`tier     : ${tier}`);
console.log(`tier-2   : ${tier2Selection}`);
console.log(`workers  : ${workers} concurrent emulators per suite file`);
console.log('');

const result = spawnSync(
  'npx',
  ['vitest', 'run', '--project', 'core', '--disable-console-intercept'],
  {
    cwd: root,
    stdio: 'inherit',
    env: {
      ...process.env,
      SEEK_EMU_REGEN: '1',
      SEEK_EMU_DIR: emuDir,
      SEEK_EMU_TIER2: tier2Selection,
      SEEK_EMU_WORKERS: workers,
    },
  },
);
const failed = result.status === 0 ? 0 : 1;

/* The expectation files are generated, and `npm run check` runs prettier over
 * everything. Formatting them here keeps the generator from being the one thing
 * that fails the repo's own style gate. */
const generated = [
  'packages/core/test/emulator/expectations.rpc.json',
  'packages/core/test/emulator/expectations.roundtrip.json',
].filter((f) => existsSync(path.join(root, f)));
if (generated.length > 0) {
  spawnSync('npx', ['prettier', '--write', ...generated], { cwd: root, stdio: 'inherit' });
}

if (failed > 0) {
  console.error('\nthe regeneration run exited non-zero — read the output above.');
  process.exit(1);
}
console.log('\nDone. Read the diff before committing it.');

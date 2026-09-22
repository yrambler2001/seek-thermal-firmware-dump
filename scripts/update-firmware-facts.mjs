/**
 * Regenerate `packages/core/test/firmware/facts.json` — facts read out of real
 * decrypted Seek firmware images, with no camera and no emulator involved.
 *
 * WHY THIS EXISTS.
 * The profile tables in `packages/core/src/profiles` encode three claims about
 * every camera family: which vendor opcode is which command, which
 * BeginFirmwareUpgrade subcommand exposes which 64 KiB window, and whether a
 * bank needs the authenticated 18-byte selector. Until this file existed, not
 * one of those claims was checked against a firmware image. `profiles.test.ts`
 * checked that the table was sorted and duplicate-free — properties that hold
 * just as well when every address in it is wrong.
 *
 * WHAT IT READS, AND WHY THAT IS SOUND.
 * Every Seek application image carries its own RPC method table: an array of
 * 16-byte records whose first word points at the command's name string, in wire
 * order, with wire id = index + 53. That is not a guess — FW-V1's byte-exact
 * reconstruction of the Compact PRO FF names it (`g_rpc_method_table`,
 * `targets/compact_pro_ff/src/rpc_cmds.c`, "wire id = index + 53", and
 * `tu025_rpc_cmds_data.c` lists all 41 rows with their addresses). This script
 * finds that array in each image by the only structure it needs: consecutive
 * 16-byte slots whose first words, minus one unknown load base, land on
 * NUL-terminated identifier strings, starting at `GetErrorCode`.
 *
 * So the table is recovered from the image's own bytes. Nothing here decrypts,
 * disassembles, or consults a second implementation.
 *
 * WHERE THE IMAGES COME FROM.
 * `$SEEK_CORPUS_DIR/MANIFEST.json`, i.e. FW-V1's vendored corpus
 * (`FW-V1/emu/data/corpus`). Like the dump corpus and the emulator, it is an
 * optional input: absent, this script says so and exits 0, and the test that
 * reads the committed output keeps running because the output is committed.
 *
 * Usage:
 *   node scripts/update-firmware-facts.mjs [corpusDir]
 *
 * A DIFF IN THE OUTPUT IS NOT A ROUTINE UPDATE. Adding an image is an
 * expansion: new keys, nothing else moves. A changed key means the recovery
 * read something different out of bytes that did not change, which is a bug in
 * the recovery, not news about firmware.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'packages/core/test/firmware/facts.json');

/* ---- where the corpus is ------------------------------------------------ */

function corpusDir() {
  const explicit = process.argv[2] ?? process.env.SEEK_CORPUS_DIR;
  if (typeof explicit === 'string' && explicit.length > 0) return explicit;
  return path.resolve(root, '..', 'FW-V1', 'emu', 'data', 'corpus');
}

/* ---- the 16-byte unlock token the legacy handler memcmp()s -------------- *
 *
 * `legacy-auth`'s `OLD_FW_UNLOCK_TOKEN`. Searched for rather than assumed: the
 * profile used to call it build-specific, and whether that is true is exactly
 * the kind of claim this file exists to settle.
 */
const UNLOCK_TOKEN = Buffer.from('5316103180dd00b74af9e417c594bed4', 'hex');

/* ---- recovering the RPC method table ------------------------------------ */

const IDENT = /^[A-Za-z][A-Za-z0-9]{3,31}$/;

const isIdentByte = (b) =>
  (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a);

/**
 * Every NUL-terminated identifier-shaped string, by the byte offset a pointer
 * to it would carry.
 *
 * WALKED BACKWARDS FROM EACH NUL, not forwards from each NUL. The two are not
 * the same, and the difference cost seven images: in the Compact PRO FF the
 * name blob begins `... .SeekThermal\0 \xff\xff ... \xeb GetErrorCode\0`, so
 * splitting on NUL yields the token `\xebGetErrorCode`, which is not an
 * identifier, and the table anchored on `GetErrorCode` was never found at all.
 * A pointer into the middle of a NUL-run is perfectly ordinary in a linked
 * image; the string's START is wherever the identifier characters begin.
 */
function nameOffsets(buf) {
  const out = new Map();
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] !== 0) continue;
    let start = i;
    while (start > 0 && isIdentByte(buf[start - 1])) start--;
    const len = i - start;
    if (len < 4 || len > 32) continue;
    const text = buf.toString('latin1', start, i);
    if (IDENT.test(text)) out.set(start, text);
  }
  return out;
}

/**
 * The image's RPC method table, or null.
 *
 * STRIDE 16 AND NOTHING ELSE. `rpc_method_t` is {name, getter, setter, flags}
 * — four words — in the reconstruction, and every image where this finds a
 * table agrees with the emulator's measured behaviour on the same build, so a
 * second stride would only add ways to be wrong.
 *
 * THE DISTINCTNESS TEST IS LOAD-BEARING. Without it the search happily locks
 * onto a run of 974 words that all resolve to the same string — an arithmetic
 * coincidence in the image's data, not a table. A real table names each command
 * once, or nearly so: the Compact PRO FF reuses one name for three rows
 * (`SetFeaturedFlashData`, methods 17/20/34), which is the worst case seen.
 */
function findMethodTable(buf) {
  const names = nameOffsets(buf);
  const anchors = [...names].filter(([, n]) => n === 'GetErrorCode').map(([o]) => o);
  const words = Math.floor(buf.length / 4);
  let best = null;
  for (const anchor of anchors) {
    for (let p = 0; p + 4 <= buf.length; p += 4) {
      const base = (buf.readUInt32LE(p) - anchor) >>> 0;
      const entries = [];
      for (let q = p; q + 4 <= buf.length; q += 16) {
        const off = (buf.readUInt32LE(q) - base) >>> 0;
        const name = names.get(off);
        if (name === undefined) break;
        entries.push(name);
      }
      if (entries.length < 25) continue;
      const distinct = new Set(entries).size;
      if (distinct < entries.length - 4) continue;
      if (best === null || entries.length > best.entries.length) {
        best = { at: p, base, entries };
      }
    }
  }
  void words;
  return best;
}

/* ---- the opcodes the toolkit sends -------------------------------------- *
 *
 * Exactly `OP` from `packages/core/src/protocol/ops.ts`. Kept as a literal
 * rather than imported from `dist/`, so this script runs without a build and so
 * a wrong constant in the source cannot silently validate itself.
 */
const TOOLKIT_OPS = {
  0x35: 'GetErrorCode',
  0x3c: 'SetOperationMode',
  0x3d: 'GetOperationMode',
  0x4e: 'GetFirmwareInfo',
  0x4f: 'GetFeaturedFirmwareData',
  0x50: 'SetFeaturedFirmwareData',
  0x51: 'CompleteMemoryUpgrade',
  0x52: 'BeginFirmwareUpgrade',
  0x55: 'SetFirmwareInfoFeatures',
  0x5a: 'SetRamDataFeatures',
};

const WIRE_ID_BASE = 53;

/* ---- main --------------------------------------------------------------- */

const dir = corpusDir();
const manifestPath = path.join(dir, 'MANIFEST.json');
if (!existsSync(manifestPath)) {
  process.stderr.write(
    `no firmware corpus at ${manifestPath}. Set SEEK_CORPUS_DIR (or keep an FW-V1 ` +
      `checkout beside this one) to regenerate; the committed facts.json is unchanged.\n`,
  );
  process.exit(0);
}

const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
/* `vendored_path` is relative to FW-V1/emu, which is the corpus dir's grandparent. */
const emuRoot = path.resolve(dir, '..', '..');

const images = {};
let recovered = 0;
let missed = 0;

for (const entry of manifest.entries) {
  if (entry.kind !== 'image-only') continue; /* a full dump is ciphertext here */
  const file = path.join(emuRoot, entry.vendored_path);
  if (!existsSync(file)) continue;
  const buf = readFileSync(file);
  const sha256 = createHash('sha256').update(buf).digest('hex');

  const table = findMethodTable(buf);
  if (table === null) missed++;
  else recovered++;

  const opcodes = {};
  if (table !== null) {
    for (const [wire, expected] of Object.entries(TOOLKIT_OPS)) {
      const index = Number(wire) - WIRE_ID_BASE;
      const got = index >= 0 && index < table.entries.length ? table.entries[index] : null;
      opcodes[`0x${Number(wire).toString(16).toUpperCase().padStart(2, '0')}`] = {
        toolkitCalls: expected,
        firmwareCalls: got,
      };
    }
  }

  const tokenAt = buf.indexOf(UNLOCK_TOKEN);

  images[entry.id] = {
    family: entry.family,
    product: entry.product,
    version: entry.version,
    length: buf.length,
    sha256,
    /* The whole recovered table, so a future question about a command this
     * toolkit does not send can be answered without re-reading the corpus. */
    rpcMethods: table === null ? null : table.entries,
    rpcTableAt: table === null ? null : `0x${table.at.toString(16).toUpperCase()}`,
    /* The image's own load base for its string region, derived, not assumed.
     * These images are segmented: the 80 KB builds run most of their code from
     * SRAM bank B, so this is not 0x10000000 on every family. */
    rpcNameBase:
      table === null ? null : `0x${table.base.toString(16).toUpperCase().padStart(8, '0')}`,
    opcodes,
    unlockTokenAt: tokenAt < 0 ? null : `0x${tokenAt.toString(16).toUpperCase()}`,
  };
}

const sorted = {};
for (const key of Object.keys(images).sort()) sorted[key] = images[key];

const doc = {
  note:
    "Facts read directly out of real decrypted Seek firmware images: each build's own RPC " +
    'method table (wire id = index + 53) and whether it carries the legacy 16-byte unlock ' +
    'token. Generated by `node scripts/update-firmware-facts.mjs` from the FW-V1 vendored ' +
    'corpus; never edit by hand. The images are not in this repository — these derived facts ' +
    'are, which is what lets `firmware-facts.test.ts` hold the profile tables to them ' +
    'everywhere, including where the corpus is absent.',
  generatedBy: 'scripts/update-firmware-facts.mjs',
  source: 'FW-V1 emu/data/corpus (image-only entries)',
  wireIdBase: WIRE_ID_BASE,
  unlockToken: UNLOCK_TOKEN.toString('hex'),
  images: sorted,
};

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(doc, null, 2)}\n`);
process.stderr.write(
  `${OUT}: ${String(Object.keys(sorted).length)} image(s), ` +
    `${String(recovered)} RPC table(s) recovered, ${String(missed)} not found\n`,
);

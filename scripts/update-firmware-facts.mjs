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
 * So the table is recovered from the image's own bytes. Nothing here decrypts
 * or consults a second implementation. Two further facts are read the same way:
 * each row's getter and setter column (the words after the name), and the
 * BeginFirmwareUpgrade window table, which needs exactly four Thumb encodings
 * decoded (TBB, a PC-relative LDR, an unconditional B and the guard's CMP/B<cc>)
 * and nothing more general than that.
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
/**
 * THE FOURTH WORD IS `u8 flags; u8 reserved[3]`, AND THAT ENDS THE TABLE.
 *
 * FW-V1's reconstruction declares the record as {name, get_handler,
 * set_handler, u8 flags, u8 reserved[3]} (`targets/compact_pro_ff/include/
 * fw_types.h` `rpc_method_t`, with `_Static_assert`s on offset 12 and size 16),
 * and every row of every recovered table carries flags 0..3 with the reserved
 * bytes zero. Walking on name pointers alone ran one row past the end of
 * Compact 4.8.1.7 and 4.16.1.7 (both files each): the 39th slot is the first
 * record of the next table of function pointers, whose first word happens to
 * land on "HpGi6" / "HpGm6" in code and whose fourth word is a code address
 * (0x10004905 / 0x10004909), not a flags byte. The images' own dispatchers agree
 * that it is not a command: `SUB.W Rd, Rn, #0x35` then `CMP Rd, #0x25` - ids
 * 53..90, 38 rows - at 0x37B2 / 0x5D10 / 0x5E16 (4.8.1.7) and 0x37B6 / 0x5D14 /
 * 0x5E1A (4.16.1.7). FW-V1 Phase 46 found the row; TESTING.md sec.21.4.
 */
const isFlagsWord = (word) => word >>> 8 === 0;

function findMethodTable(buf) {
  const names = nameOffsets(buf);
  const anchors = [...names].filter(([, n]) => n === 'GetErrorCode').map(([o]) => o);
  const words = Math.floor(buf.length / 4);
  let best = null;
  for (const anchor of anchors) {
    for (let p = 0; p + 4 <= buf.length; p += 4) {
      const base = (buf.readUInt32LE(p) - anchor) >>> 0;
      const entries = [];
      for (let q = p; q + 16 <= buf.length; q += 16) {
        const off = (buf.readUInt32LE(q) - base) >>> 0;
        const name = names.get(off);
        if (name === undefined) break;
        if (!isFlagsWord(buf.readUInt32LE(q + 12))) break;
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

/* ---- the two handler columns -------------------------------------------- *
 *
 * NAMES ARE NOT ENOUGH, AND THIS IS WHERE THAT COST SOMETHING. A record is
 * {name, getter, setter, flags}, and the dispatcher routes a control IN to the
 * getter and a control OUT to the setter; a request whose column is empty is
 * stalled. 0.7.0.7 and 0.7.0.8 carry `GetFeaturedFirmwareData` at 0x4F with the
 * right NAME and the handler in the SETTER column, so the read a dump sends
 * there cannot be dispatched. The names-only table said those builds were fine
 * (TESTING.md sec.9.10). Both columns are recorded for every row now: the
 * handler's Thumb address as the image stores it, or null for an empty slot.
 */
const hexWord = (value) => `0x${(value >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

function methodColumns(buf, table) {
  return table.entries.map((name, index) => {
    const at = table.at + index * 16;
    const getter = buf.readUInt32LE(at + 4);
    const setter = buf.readUInt32LE(at + 8);
    return {
      name,
      getter: getter === 0 ? null : hexWord(getter),
      setter: setter === 0 ? null : hexWord(setter),
      flags: buf.readUInt32LE(at + 12),
    };
  });
}

/* ---- the BeginFirmwareUpgrade window table ------------------------------ *
 *
 * WHICH SUBCOMMAND ARMS WHICH 64 KiB BLOCK, READ OUT OF THE HANDLER ITSELF.
 * The profile tables carry this as a claim; until now nothing checked the claim
 * against the image, and the one place they disagree cost a real block: the
 * 2014 Compacts give subcommand 0x0E the SAME address as 0x0D.
 *
 * Every image from 0.5.0.2 on compiles the handler's switch to one `TBB` over
 * the mode byte, each case loading its destination with a PC-relative LDR and
 * branching to one shared store. Everything below is PC-relative, so no load
 * address is needed to decode it: the section bases are 4-aligned relative to
 * their raw offsets in every image. A case is recorded as `literal` only when it
 * is exactly "LDR Rt,=<address>" followed by the branch to the store (or by the
 * store itself); anything else - the image-id gate of case 0, a read of the
 * bootloader's config block, a load through a pointer - is `computed`, with the
 * literal words it loads listed so a reader can see what it computes from.
 *
 * THE HANDLER IS IDENTIFIED, NOT GUESSED: the TBB must sit inside the function
 * the method table registers as `BeginFirmwareUpgrade`'s setter. The code's load
 * address comes from the image's own copy table, whose records are
 * {source in flash, destination in RAM, length} words in the header window.
 * 0.3.0.1 (-O0, no TBB, and 0x52 is EnterBootloaderMode) decodes to null.
 */
const u16 = (buf, o) => buf.readUInt16LE(o);
const isWide = (h) => (h & 0xf800) === 0xe800 || (h & 0xf800) === 0xf000 || (h & 0xf800) === 0xf800;

function literalAt(buf, o) {
  const h = u16(buf, o);
  let at = null;
  let rt = null;
  if ((h & 0xf800) === 0x4800) {
    at = ((o + 4) & ~3) + (h & 0xff) * 4;
    rt = (h >> 8) & 7;
  } else if ((h & 0xff7f) === 0xf85f) {
    const h2 = u16(buf, o + 2);
    const base = (o + 4) & ~3;
    at = h & 0x80 ? base + (h2 & 0xfff) : base - (h2 & 0xfff);
    rt = h2 >> 12;
  }
  if (at === null || at < 0 || at + 4 > buf.length) return null;
  return { at, rt, value: buf.readUInt32LE(at) };
}

function branchTarget(buf, o) {
  const h = u16(buf, o);
  if ((h & 0xf800) !== 0xe000) return null;
  let imm = (h & 0x7ff) << 1;
  if (imm & 0x800) imm -= 0x1000;
  return o + 4 + imm;
}

const isFlashWindow = (v) => (v & 0xff00ffff) >>> 0 === 0x14000000;

/** Raw offset of a code VMA, through the image's own copy records. */
function codeRawOf(buf, vma) {
  for (let o = 0x240; o + 12 <= 0x2c0; o += 4) {
    const src = buf.readUInt32LE(o);
    const dst = buf.readUInt32LE(o + 4);
    const len = buf.readUInt32LE(o + 8);
    if (src < 0x14000000 || src >= 0x14400000) continue;
    if (dst < 0x10000000 || dst >= 0x10100000 || len === 0 || len > 0x100000) continue;
    if (vma >= dst && vma < dst + len) return src - 0x14000000 + (vma - dst);
  }
  /* Unsegmented images run where they are linked: raw 0 is 0x10000000. */
  const flat = vma - 0x10000000;
  return flat >= 0 && flat < buf.length ? flat : null;
}

function decodeWindowSwitch(buf, handlerRaw, from = handlerRaw, span = 0x200) {
  if (from === null) return null;
  const end = Math.min(buf.length - 8, from + span);
  for (let o = from; o < end; o += 2) {
    if (u16(buf, o) !== 0xe8df || (u16(buf, o + 2) & 0xfff0) !== 0xf000) continue;
    /* The switch guard: CMP Rn,#imm then BHI, immediately before the TBB. */
    let guard = null;
    for (const back of [2, 4, 6, 8]) {
      const p = o - back;
      if ((u16(buf, p) & 0xf800) === 0x2800 && (u16(buf, p + 2) & 0xff00) === 0xd800) {
        guard = (u16(buf, p) & 0xff) + 1;
        break;
      }
    }
    if (guard === null) continue;
    const table = o + 4;
    const targets = [];
    for (let n = 0; n < guard; n++) targets.push(table + 2 * buf[table + n]);

    /* The shared store is where the literal cases branch to. */
    const votes = new Map();
    for (const t of targets) {
      const lit = literalAt(buf, t);
      const next = t + (isWide(u16(buf, t)) ? 4 : 2);
      const b = lit === null ? null : branchTarget(buf, next);
      if (b !== null) votes.set(b, (votes.get(b) ?? 0) + 1);
    }
    const store = [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    if (store === null) continue;

    const rows = targets.map((t, mode) => {
      const lit = literalAt(buf, t);
      const next = t + (isWide(u16(buf, t)) ? 4 : 2);
      if (lit !== null && (branchTarget(buf, next) === store || next === store)) {
        return { mode, kind: 'literal', address: hexWord(lit.value) };
      }
      /* Computed: list what the case loads before it reaches the store. */
      const loads = [];
      let p = t;
      for (let i = 0; i < 6 && p !== store && p + 4 <= buf.length; i++) {
        const l = literalAt(buf, p);
        if (l !== null) loads.push(hexWord(l.value));
        const b = branchTarget(buf, p);
        if (b !== null) break;
        p += isWide(u16(buf, p)) ? 4 : 2;
      }
      return { mode, kind: 'computed', loads };
    });
    if (rows.filter((r) => r.kind === 'literal' && isFlashWindow(Number(r.address))).length < 20) {
      continue;
    }

    /* The gate, read off the same prologue: is mode 2 refused before the
     * channel test (`CMP Rm,#2 / BNE` ahead of the first `CMP Rm,#0x21`), and is
     * the plain channel locked on modes 2..9 (`SUBS Rm,#2 / [UXTB] / CMP Rm,#7 /
     * BLS`)? */
    let modeTwoRefused = false;
    let plainLocked = null;
    for (let p = handlerRaw ?? o; p < o; p += 2) {
      const h = u16(buf, p);
      if ((h & 0xf8ff) === 0x2802 && (u16(buf, p + 2) & 0xff00) === 0xd100) modeTwoRefused = true;
      if ((h & 0xf8ff) === 0x3802) {
        let q = p + 2;
        if ((u16(buf, q) & 0xffc0) === 0xb2c0) q += 2; /* UXTB */
        if ((u16(buf, q) & 0xf8ff) === 0x2807 && (u16(buf, q + 2) & 0xff00) === 0xd900) {
          plainLocked = [2, 9];
        }
      }
    }
    return {
      tbbAt: `0x${o.toString(16).toUpperCase()}`,
      modes: guard,
      /* Unknown (null) when the handler's start is not known: the gate is read
       * off its prologue, and a scan has no prologue to read. */
      modeTwoRefusedOutright: handlerRaw === null ? null : modeTwoRefused,
      plainChannelLockedModes: handlerRaw === null ? null : plainLocked,
      rows,
    };
  }
  return null;
}

function windowTable(buf, table) {
  const index = 0x52 - WIRE_ID_BASE;
  if (table === null || index >= table.entries.length) return null;
  const setter = buf.readUInt32LE(table.at + index * 16 + 8);
  if (setter === 0) return null;
  const raw = codeRawOf(buf, (setter & ~1) >>> 0);
  const decoded = decodeWindowSwitch(buf, raw);
  if (decoded !== null) {
    return {
      handler: table.entries[index],
      setter: hexWord(setter),
      located: 'inside the setter the method table registers at wire 0x52',
      handlerRaw: `0x${raw.toString(16).toUpperCase()}`,
      ...decoded,
    };
  }
  /* FALLBACK, AND LABELLED AS ONE. Compact PRO 4.9.1.15 keeps its copy records
   * in a layout the header walk above does not read, so the setter address does
   * not map to a raw offset. The switch is then found by scanning the whole image
   * for the one TBB whose cases load at least twenty window literals; if there is
   * not exactly one, nothing is recorded. */
  const found = [];
  for (let o = 0; o < buf.length - 8; o += 2) {
    const hit = decodeWindowSwitch(buf, null, o, 2);
    if (hit !== null) found.push(hit);
  }
  if (found.length !== 1) return null;
  return {
    handler: table.entries[index],
    setter: hexWord(setter),
    located: 'by scanning the image: the setter address did not map through the copy records',
    handlerRaw: null,
    ...found[0],
  };
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

  const columns = table === null ? null : methodColumns(buf, table);
  const opcodes = {};
  if (table !== null) {
    for (const [wire, expected] of Object.entries(TOOLKIT_OPS)) {
      const index = Number(wire) - WIRE_ID_BASE;
      const row = index >= 0 && index < columns.length ? columns[index] : null;
      opcodes[`0x${Number(wire).toString(16).toUpperCase().padStart(2, '0')}`] = {
        toolkitCalls: expected,
        firmwareCalls: row === null ? null : row.name,
        /* The column decides what the dispatcher does with the request: a
         * control IN reaches the getter, a control OUT the setter. */
        getter: row === null ? null : row.getter,
        setter: row === null ? null : row.setter,
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
    /* The same rows with both handler columns, wire id = index + 53. */
    rpcHandlers: columns,
    rpcTableAt: table === null ? null : `0x${table.at.toString(16).toUpperCase()}`,
    /* The image's own load base for its string region, derived, not assumed.
     * These images are segmented: the 80 KB builds run most of their code from
     * SRAM bank B, so this is not 0x10000000 on every family. */
    rpcNameBase:
      table === null ? null : `0x${table.base.toString(16).toUpperCase().padStart(8, '0')}`,
    opcodes,
    windowTable: windowTable(buf, table),
    unlockTokenAt: tokenAt < 0 ? null : `0x${tokenAt.toString(16).toUpperCase()}`,
  };
}

const sorted = {};
for (const key of Object.keys(images).sort()) sorted[key] = images[key];

const doc = {
  note:
    "Facts read directly out of real decrypted Seek firmware images: each build's own RPC " +
    'method table (wire id = index + 53) with both handler columns (getter = control IN, ' +
    'setter = control OUT), its BeginFirmwareUpgrade window table decoded from the ' +
    "handler's own switch, and whether it carries the legacy 16-byte unlock " +
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

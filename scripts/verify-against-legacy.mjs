/**
 * Differential test: decrypt real flash dumps with BOTH the original
 * `legacy/index.html` and the TypeScript core, and require identical results.
 *
 * The legacy page is the only version of this code that has ever driven real
 * hardware, so it — not the port — is the reference. Any divergence here is a
 * regression in `packages/core`, regardless of which one looks more correct.
 *
 * Usage:
 *   node scripts/verify-against-legacy.mjs [dumpDir]
 *
 * `dumpDir` defaults to $SEEK_DUMPS_DIR, then to ../SEEK_DUMPS next to the repo.
 * The dumps are real camera images and are deliberately NOT in this repository,
 * so this script is a local audit tool, not a CI gate. It exits non-zero on any
 * mismatch.
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { loadLegacy } from './legacy-oracle.mjs';

const FLASH_SIZE = 4 * 1024 * 1024;
const repoRoot = path.resolve(import.meta.dirname, '..');
const sha = (b) => createHash('sha256').update(b).digest('hex');

const dumpDir =
  process.argv[2] ?? process.env.SEEK_DUMPS_DIR ?? path.resolve(repoRoot, '..', 'SEEK_DUMPS');

if (!existsSync(dumpDir)) {
  console.error(`no dump directory at ${dumpDir}`);
  console.error('pass one as an argument or set SEEK_DUMPS_DIR');
  process.exit(2);
}

function findDumps(root, out = [], depth = 0) {
  if (depth > 3) return out;
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(root, e.name);
    if (e.isDirectory()) findDumps(p, out, depth + 1);
    else if (e.isFile() && /\.bin$/i.test(e.name) && statSync(p).size === FLASH_SIZE) out.push(p);
  }
  return out;
}

const legacy = loadLegacy(path.join(repoRoot, 'legacy', 'index.html'));

const D = path.join(repoRoot, 'packages', 'core', 'dist');
const { recoverKeyInfo } = await import(`${D}/crypto/recover.js`);
const { decryptImage } = await import(`${D}/crypto/cipher.js`);
const { findKeyCandidates, pickKeyTable } = await import(`${D}/crypto/keys.js`);
const { findImages } = await import(`${D}/image/scan.js`);
const { bankPayloadSize, footerOffsetFor } = await import(`${D}/image/header.js`);
const { buildBankPayload, transferSum16 } = await import(`${D}/image/bank.js`);
const { modern4x } = await import(`${D}/profiles/index.js`);
const { bytesToHex, viewOf } = await import(`${D}/bytes.js`);

/* The legacy page hardcodes one whitening constant and one clear-word window
 * for every image it touches. To compare like with like, the port is driven
 * with the same constants here — this script asks "is the port faithful?", not
 * "does the profile system pick better parameters?" (it does: run with
 * compact-2016 and it identifies key tables on sum=0 builds that the legacy
 * page misses, which is the whole point of decoupling K from TARGET). */
const CIPHER = modern4x.cipher;
const LEGACY_K = legacy.FLASH_K;

let checked = 0;
let failed = 0;
const fail = (what, expected, actual) => {
  failed++;
  console.error(`  MISMATCH ${what}\n    legacy: ${expected}\n    core  : ${actual}`);
};

for (const file of findDumps(dumpDir)) {
  const buf = new Uint8Array(readFileSync(file));
  const dv = viewOf(buf);
  console.log(`\n${path.basename(file)}`);

  const legacyImages = legacy.findImages(dv, buf.length);
  const coreImages = findImages(dv, buf.length);
  if (legacyImages.length !== coreImages.length) {
    fail('image count', legacyImages.length, coreImages.length);
    continue;
  }
  if (legacyImages.length === 0) {
    console.log('  no firmware images in this dump — both agree');
    continue;
  }

  const legacyInfos = legacyImages.map((im) => legacy.recoverKeyInfo(dv, im.base, im.len));
  const coreInfos = coreImages.map((im) => recoverKeyInfo(dv, im.base, im.len, CIPHER));

  const legacyTable = legacy.pickKeyTable(
    legacy.findKeyCandidates(buf.subarray(0, 0x8000)),
    legacyInfos.map((r) => ({ recovered: r })),
  );
  const coreTable = pickKeyTable(
    findKeyCandidates(buf.subarray(0, 0x8000)),
    coreInfos.map((r) => r.state),
    LEGACY_K,
  );
  if (!!legacyTable !== !!coreTable) {
    fail('key table found', !!legacyTable, !!coreTable);
  } else if (legacyTable) {
    if (legacy.bytesToHex(legacyTable.keyA) !== bytesToHex(coreTable.keyA)) {
      fail('keyA', legacy.bytesToHex(legacyTable.keyA), bytesToHex(coreTable.keyA));
    }
    if (legacy.bytesToHex(legacyTable.keyB) !== bytesToHex(coreTable.keyB)) {
      fail('keyB', legacy.bytesToHex(legacyTable.keyB), bytesToHex(coreTable.keyB));
    }
  }

  for (let i = 0; i < legacyImages.length; i++) {
    const im = legacyImages[i];
    const li = legacyInfos[i];
    const ci = coreInfos[i];
    const tag = `slot 0x${im.base.toString(16)}`;
    checked++;

    const lState = Array.from(li.state, (v) => v >>> 0).join(',');
    const cState = Array.from(ci.state, (v) => v >>> 0).join(',');
    if (lState !== cState) fail(`${tag} recovered state`, lState, cState);
    if (li.checksum >>> 0 !== ci.checksum >>> 0) {
      fail(`${tag} checksum`, (li.checksum >>> 0).toString(16), (ci.checksum >>> 0).toString(16));
    }
    if (li.selfConsistent !== ci.selfConsistent) {
      fail(`${tag} selfConsistent`, li.selfConsistent, ci.selfConsistent);
    }
    if (li.sane !== ci.sane) fail(`${tag} sane`, li.sane, ci.sane);

    const lPlain = legacy.decryptImage(dv, im.base, im.len, Uint32Array.from(li.state));
    const cPlain = decryptImage(dv, im.base, im.len, ci.state, CIPHER);
    if (sha(lPlain) !== sha(cPlain)) fail(`${tag} plaintext`, sha(lPlain), sha(cPlain));

    /* The brick-prone path: re-packaging a slot's own plaintext must reproduce
     * the bytes already in flash, byte for byte. */
    if (legacyTable && coreTable) {
      const bank = bankPayloadSize(im.len);
      const onFlash = buf.subarray(im.base, im.base + bank);
      const template = onFlash.slice(footerOffsetFor(im.len), bank);
      const writtenWith = ['keyA', 'keyB'].find((k) => {
        const st = legacy.stateFromKey(legacyTable[k], LEGACY_K);
        return st.every((v, j) => v >>> 0 === li.state[j] >>> 0);
      });
      if (writtenWith) {
        const lBank = legacy.buildBankPayload(lPlain, legacyTable[writtenWith], template);
        const cBank = buildBankPayload(cPlain, coreTable[writtenWith], template, CIPHER);
        if (sha(lBank.payload) !== sha(cBank.payload)) {
          fail(`${tag} bank payload`, sha(lBank.payload), sha(cBank.payload));
        }
        if (sha(cBank.payload) !== sha(onFlash)) {
          fail(`${tag} rebuilt bank != flash`, sha(onFlash), sha(cBank.payload));
        }
        if (legacy.transferSum16(lBank.payload) !== transferSum16(cBank.payload)) {
          fail(
            `${tag} transfer checksum`,
            legacy.transferSum16(lBank.payload),
            transferSum16(cBank.payload),
          );
        }
      }
    }
    console.log(`  ${tag} ok`);
  }
}

console.log(`\n${checked} slot(s) compared, ${failed} mismatch(es)`);
process.exit(failed === 0 ? 0 : 1);

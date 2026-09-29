/* ==================================================================== *
 * The real-dump corpus test.
 *
 * Every other test in this repository is synthetic: `test/helpers.ts` builds an
 * image with this code's own cipher and packager and then checks that this code
 * reads it back. That proves internal consistency and it is worth having, but it
 * is structurally incapable of catching the one failure that matters — this
 * code's MODEL of Seek firmware drifting away from what Seek firmware actually
 * is. A synthetic fixture drifts along with the model, silently, and every test
 * stays green.
 *
 * This test closes that hole. It runs the real decrypt path over real 4 MiB
 * camera dumps and asserts the exact facts each one is known to produce:
 * detected profile, slot addresses, image lengths, acceptance sum, whitening
 * constant, stack pointer, entry point, duplicate relationships, and the sha256
 * of every decrypted image.
 *
 * WHY THE EXPECTATIONS ARE COMMITTED AND THE DUMPS ARE NOT.
 * The dumps are real camera flash, ~4 MiB each, and are deliberately outside
 * this repository (see `scripts/verify-against-legacy.mjs`, which takes the same
 * view). What is committed is `corpus/expectations.json`: a ~19 KB table of
 * facts keyed by each dump's sha256. That table is the ground truth. Regenerate
 * it with `node scripts/update-corpus-expectations.mjs` and read the diff — a
 * change there is a change in behaviour on hardware, never a routine update.
 *
 * WHY IT SKIPS INSTEAD OF FAILING.
 * Nobody cloning this repository has the corpus, and CI never will. A test that
 * fails for a missing optional input teaches people to ignore red, which is
 * worse than not having the test. So: absent corpus -> loud skip, exit 0.
 *
 * ONE EXTERNAL REFERENCE IS PINNED INLINE.
 * `CROSS_REPO_ORACLE` below is not from this repository at all. It is the
 * Compact PRO FF image that an independent, byte-exact firmware reconstruction
 * project built from the same silicon, and the 64 KiB bootloader that sits in
 * front of it. Two unrelated codebases agreeing on those bytes is a far stronger
 * statement than this repository agreeing with itself, so it is asserted by
 * name, separately, and is the first thing to look at if this file goes red.
 * ==================================================================== */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { silentReporter } from '../src/events.js';
import { decryptDump } from '../src/workflows/decrypt.js';
import type { DecryptResult } from '../src/workflows/types.js';
import expectations from './corpus/expectations.json' with { type: 'json' };

const FLASH_SIZE = 4 * 1024 * 1024;

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');
const hex = (n: number): string => `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, '0')}`;

/**
 * Facts about the Compact PRO FF that were established OUTSIDE this repository,
 * by a separate byte-exact reconstruction of the same firmware. Independent
 * agreement, so these are pinned by hand rather than generated.
 */
const CROSS_REPO_ORACLE = {
  dumpSha256: '42b8fe1232de3452bc7a92207a94ed75aa55ea0e59c0fd427224a1d7fcbbf734',
  bootloaderSha256: '0f69f9128db87b39ff51e89cf4a4dcfdd6b83a8bb263ffbb11950a64e55ecdbe',
  imageLength: 44808,
  imageSha256: '48f0ebfd3f55d1dc4aee16f693eedd11c2d5cbbe88f4ca200a90c8ea1b19e735',
} as const;

interface SlotExpectation {
  readonly flash: string;
  readonly length: number;
  readonly acceptanceSum: string;
  readonly whiteningK: string;
  readonly sp: string;
  readonly entry: string;
  readonly confidence: string;
  readonly whiteningEvidence: string;
  readonly duplicateOf: string | null;
  readonly plainSha256: string;
}

interface DumpExpectation {
  readonly label: string;
  readonly profile: string | null;
  readonly ambiguous: boolean | null;
  readonly slots: readonly SlotExpectation[];
}

const table = expectations as unknown as { readonly dumps: Record<string, DumpExpectation> };

/* ---- locating the corpus ------------------------------------------- */

function corpusDir(): string | null {
  /* An explicitly set SEEK_DUMPS_DIR is used and ONLY it. Falling back to the
   * default when someone's override points at nothing would run the suite
   * against a corpus they did not choose, and report it as theirs. */
  const override = process.env.SEEK_DUMPS_DIR;
  if (typeof override === 'string' && override.length > 0) {
    return existsSync(override) ? override : null;
  }
  const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
  const fallback = path.resolve(repoRoot, '..', 'SEEK_DUMPS');
  return existsSync(fallback) ? fallback : null;
}

/** Every 4 MiB `*.bin` under `dir`, recursively. Size is the cheapest filter. */
function findDumps(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findDumps(full));
    else if (entry.isFile() && /\.bin$/i.test(entry.name) && statSync(full).size === FLASH_SIZE) {
      out.push(full);
    }
  }
  return out;
}

const dir = corpusDir();

/* Two files with the same bytes are one dump. Keying on content rather than on
 * path is what lets a corpus be reorganised without touching this test. */
const found = new Map<string, string>();
if (dir) {
  for (const file of findDumps(dir).sort()) {
    const digest = sha256(new Uint8Array(readFileSync(file)));
    if (!found.has(digest)) found.set(digest, file);
  }
}

const pinned = [...found].filter(([digest]) => digest in table.dumps);

/**
 * Decrypt a dump once and hand the same result to every assertion about it.
 *
 * Each `it` wants a different facet of one decrypt, and re-running the whole
 * cryptanalysis per assertion would make the suite five times slower for no
 * extra coverage — worse, it would let two assertions disagree about the same
 * dump without anyone noticing.
 */
const decrypted = new Map<string, Promise<DecryptResult>>();
function decryptOnce(digest: string, file: string): Promise<DecryptResult> {
  let run = decrypted.get(digest);
  if (!run) {
    const bytes = new Uint8Array(readFileSync(file));
    run = decryptDump(bytes, 'corpus', { dumpPath: file }, silentReporter);
    decrypted.set(digest, run);
  }
  return run;
}

/* ---- the suite ------------------------------------------------------ */

describe.skipIf(dir === null)('real dump corpus', () => {
  it('found at least one dump this repository has pinned expectations for', () => {
    expect(
      pinned.length,
      `no pinned dump found under ${String(dir)}. ` +
        `${String(found.size)} 4 MiB dump(s) are there but none is in corpus/expectations.json — ` +
        'either this is a different collection, or the expectations need regenerating with ' +
        '`node scripts/update-corpus-expectations.mjs`.',
    ).toBeGreaterThan(0);
  });

  for (const [digest, file] of pinned) {
    const want = table.dumps[digest];
    if (!want) continue;

    /* The committed label never names a local file (see the generator); the
     * local path is added here, at run time, so a failure still names a file. */
    describe(`${want.label} (${dir === null ? file : path.relative(dir, file)})`, () => {
      it('detects the same firmware profile', async () => {
        const got = await decryptOnce(digest, file);
        expect(got.detection?.best.profile.id ?? null).toBe(want.profile);
        expect(got.detection?.ambiguous ?? null).toBe(want.ambiguous);
      });

      it('finds the same slots, at the same addresses, with the same geometry', async () => {
        const got = await decryptOnce(digest, file);
        expect(got.slots.map((s) => hex(s.flash))).toEqual(want.slots.map((s) => s.flash));
        expect(got.slots.map((s) => s.length)).toEqual(want.slots.map((s) => s.length));
      });

      it('decrypts every slot to the same plaintext, byte for byte', async () => {
        const got = await decryptOnce(digest, file);
        /* sha256 rather than the bytes: a mismatch should say WHICH slot broke,
         * not print 44 kB of diff. */
        expect(got.slots.map((s) => s.plainSha256)).toEqual(want.slots.map((s) => s.plainSha256));
        /* The plaintext must also actually be the bytes the hash names — this
         * catches a `plainSha256` that stops being computed over `plain`. */
        for (const slot of got.slots) expect(sha256(slot.plain)).toBe(slot.plainSha256);
      });

      it('names the same key and acceptance sum, with the same evidence', async () => {
        const got = await decryptOnce(digest, file);
        expect(
          got.slots.map((s) => ({
            acceptanceSum: hex(s.recovered.checksum),
            whiteningK: hex(s.whitening.whiteningK),
            confidence: s.recovered.confidence,
            whiteningEvidence: s.whitening.evidence,
          })),
        ).toEqual(
          want.slots.map((s) => ({
            acceptanceSum: s.acceptanceSum,
            whiteningK: s.whiteningK,
            confidence: s.confidence,
            whiteningEvidence: s.whiteningEvidence,
          })),
        );
      });

      it('reads the same vector table and duplicate relationships', async () => {
        const got = await decryptOnce(digest, file);
        expect(
          got.slots.map((s) => ({
            sp: hex(s.sp),
            entry: hex(s.entry),
            duplicateOf: s.duplicateOf === null ? null : hex(s.duplicateOf),
          })),
        ).toEqual(
          want.slots.map((s) => ({ sp: s.sp, entry: s.entry, duplicateOf: s.duplicateOf })),
        );
      });
    });
  }

  describe.skipIf(!found.has(CROSS_REPO_ORACLE.dumpSha256))(
    'cross-repository oracle (Compact PRO FF)',
    () => {
      const file = found.get(CROSS_REPO_ORACLE.dumpSha256) ?? '';

      it('the 64 KiB bootloader is the one the reconstruction project reads', () => {
        const bytes = new Uint8Array(readFileSync(file));
        expect(sha256(bytes.subarray(0, 0x10000))).toBe(CROSS_REPO_ORACLE.bootloaderSha256);
      });

      it('slot A decrypts to the image an independent project rebuilt byte for byte', async () => {
        const got = await decryptOnce(CROSS_REPO_ORACLE.dumpSha256, file);
        const slotA = got.slots.find((s) => s.flash === 0x14030000);
        expect(slotA).toBeDefined();
        expect(slotA?.length).toBe(CROSS_REPO_ORACLE.imageLength);
        expect(slotA?.plainSha256).toBe(CROSS_REPO_ORACLE.imageSha256);
      });
    },
  );
});

if (dir === null) {
  /* Loud on purpose. A silent skip is how an optional test quietly stops
   * existing; this is the only line that tells a reader the backbone of the
   * real-hardware coverage did not run. Written straight to stderr rather than
   * through `console` so it survives the runner's console capture — and so it
   * does not need a `no-console` exemption to say something important. */
  process.stderr.write(
    '\n  ⚠ real dump corpus NOT FOUND — the corpus tests were SKIPPED, not passed.\n' +
      '    Point SEEK_DUMPS_DIR at a directory of 4 MiB Seek flash dumps, or put one\n' +
      '    at ../SEEK_DUMPS next to this repository, to run them.\n\n',
  );
}

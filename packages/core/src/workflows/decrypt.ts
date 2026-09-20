/* ==================================================================== *
 * Decrypting the firmware slots inside a flash dump.
 *
 * Works with NO device attached: this is both the dump's bonus stage and the
 * offline "decrypt a file I already have" path. Nothing here talks to a camera.
 *
 * The method is cryptanalytic, not a key search — `recoverState` solves the
 * 128-bit xorshift128 state straight out of each slot's ciphertext — so a slot
 * decrypts even when the dump's key region is missing or was never readable.
 *
 * IMPROVEMENT over the original page: it paired the whitening constant K with
 * the acceptance TARGET (`K=13579BDF <-> sum=FFFF`), which is measurably wrong.
 * `32K_43X0_1.3.0.8_COMPACT-16HZ` hits sum 0x0000FFFF and yet carries the
 * UNWHITENED (K=0) key in its own plaintext, so the original reported that
 * build's key as something the image does not contain. Key naming here goes
 * through `resolveWhitening`, which derives the key under each candidate K and
 * keeps the form the image itself holds — and every per-slot report says which
 * evidence decided it.
 * ==================================================================== */

import { addrTag, bytesToHex, hexUp, sha256hex, utf8, viewOf } from '../bytes.js';
import type { Artifact, Reporter } from '../events.js';
import {
  buildBootloaderKeysSummary,
  buildDecryptionSummary,
  buildImageSummary,
  buildKeySummary,
  type BootloaderKeysSummary,
  type ImageSummary,
  type KeySummary,
} from '../archive/manifest.js';
import { decryptImage } from '../crypto/cipher.js';
import {
  findEmbeddedKeyTable,
  findKeyCandidates,
  keyFilenameSuffix,
  keyFromState,
  keyTableWhere,
  pickKeyTable,
  resolveWhitening,
  type PickedKeyTable,
} from '../crypto/keys.js';
import {
  CANDIDATE_K,
  CHECK_ZERO_IDX,
  KNOWN_ZERO_IDX,
  recoverKeyInfo,
  type RecoveredKey,
} from '../crypto/recover.js';
import { parseImageHeader } from '../image/header.js';
import { findImages } from '../image/scan.js';
import { detectProfile, getProfile } from '../profiles/registry.js';
import type { DetectionResult, DeviceEvidence, FirmwareProfile } from '../profiles/types.js';
import type { DecryptResult, DecryptedSlot } from './types.js';

/** How much of a dump's head is scanned for the bootloader's key table. */
const KEY_TABLE_SCAN_BYTES = 0x8000;

export interface DecryptOptions {
  /**
   * Supplies the cipher (clear-word window, acceptance sum, K) and the flash
   * base. OPTIONAL: with no camera attached there is no device evidence, so an
   * omitted profile is detected from the dump itself via `detectProfileForDump`
   * and the choice is logged and recorded in the summary. The device path,
   * which already knows the profile, passes it explicitly.
   */
  readonly profile?: FirmwareProfile;
  /** What to print as the source in the reports, e.g. the dump's file name. */
  readonly dumpPath: string;
  readonly signal?: AbortSignal;
  /** Injectable clock, so report text is reproducible in tests. */
  readonly now?: () => Date;
  /**
   * Whitening constants to try, best first. Defaults to the profile's own K
   * followed by every other known one — `resolveWhitening` treats element 0 as
   * both the tie-break winner and the fallback.
   */
  readonly candidateKs?: readonly number[];
}

function candidateKsFor(profile: FirmwareProfile, options: DecryptOptions): readonly number[] {
  if (options.candidateKs !== undefined) return options.candidateKs;
  const own = profile.cipher.whiteningK >>> 0;
  return [own, ...CANDIDATE_K.filter((k) => k >>> 0 !== own)];
}

/* ==================================================================== *
 * Offline profile detection
 * ==================================================================== */

/**
 * Everything a dump file can say about itself, with no camera attached.
 *
 * The acceptance checksum looks profile-dependent and is not: `checksum32` is
 * the 32-bit word sum of the DECRYPTED image, and the only cipher field it
 * consults is `clearWords` (the header window left verbatim), which is
 * [128, 143] on every family measured. Neither K nor the acceptance TARGET
 * takes part — they are what the sum is COMPARED against. So one reference
 * cipher computes sums that every profile can then be scored on, which is why
 * picking a profile here to detect a profile is sound rather than circular.
 *
 * `imageVersions` likewise needs no decryption: `header.version` sits at 0x20C,
 * inside the cleartext window, which is exactly why the bootloader can read the
 * header before it has chosen a key.
 */
export function evidenceFromDump(bytes: Uint8Array): DeviceEvidence {
  /* The neutral choice: `generic` is the fallback profile, so using its cipher
   * here states plainly that no family has been assumed yet. */
  const reference = getProfile('generic').cipher;
  const view = viewOf(bytes);
  const images = findImages(view, bytes.length);

  const observedAcceptanceSums: number[] = [];
  const imageVersions: string[] = [];
  const imageBaseOffsets: number[] = [];
  for (const image of images) {
    imageBaseOffsets.push(image.base);
    observedAcceptanceSums.push(
      recoverKeyInfo(view, image.base, image.len, reference).checksum >>> 0,
    );
    const header = parseImageHeader(bytes, image.base);
    if (header !== null) imageVersions.push(header.versionStr);
  }
  return { observedAcceptanceSums, imageVersions, imageBaseOffsets };
}

/** Which firmware family a dump file looks like, scored and ranked. */
export function detectProfileForDump(bytes: Uint8Array): DetectionResult {
  return detectProfile(evidenceFromDump(bytes));
}

/**
 * The dump's own bootloader key table.
 *
 * Tried under each candidate K rather than only the profile's: the table maps
 * to a recovered state through `stateFromKey(key, K)`, and a build whose K is
 * not the profile's would otherwise look like "no key table in this dump" and
 * silently disable filename stamping.
 */
function findBootloaderKeys(
  bytes: Uint8Array,
  states: readonly Uint32Array[],
  bootConfigBase: number,
  candidateKs: readonly number[],
): { readonly table: PickedKeyTable; readonly whiteningK: number } | null {
  const head = bytes.subarray(0, Math.min(KEY_TABLE_SCAN_BYTES, bytes.length));
  const candidates = findKeyCandidates(head, bootConfigBase);
  if (candidates.length === 0 || states.length === 0) return null;
  for (const K of candidateKs) {
    const table = pickKeyTable(candidates, states, K);
    if (table) return { table, whiteningK: K };
  }
  return null;
}

/**
 * Decrypt every firmware slot in `bytes`, emitting one `.bin`, one `.txt`
 * report and one `.key` record per slot plus a combined report and key log.
 *
 * Never throws for a well-formed dump: a slot that fails every confidence check
 * is still decrypted and reported as UNVERIFIED, because the plaintext is
 * correct regardless of whether we can NAME the key that produced it.
 * Cancellation stops the loop and comes back as `cancelled: true` rather than
 * as an exception — this is a bonus stage and must never cost a caller its dump.
 */
export async function decryptDump(
  bytes: Uint8Array,
  stem: string,
  options: DecryptOptions,
  reporter: Reporter,
): Promise<DecryptResult> {
  const dumpPath = options.dumpPath;
  const clock = options.now ?? ((): Date => new Date());
  const cancelled = (): boolean => options.signal?.aborted === true;

  /* With no profile given there is no device evidence either, so the dump has
   * to speak for itself. The choice is logged and written into the summary —
   * a decrypt run must never silently act under a family the caller did not
   * see named. */
  let detection: DetectionResult | null = null;
  let profile = options.profile;
  let detectionNote: string | undefined;
  if (profile === undefined) {
    detection = detectProfileForDump(bytes);
    profile = detection.best.profile;
    detectionNote =
      `profile detected from the dump: ${profile.name} [${profile.id}, score ` +
      `${String(detection.best.score)}${detection.ambiguous ? ', AMBIGUOUS' : ''}] — ` +
      detection.best.reasons.join('; ');
    reporter.log(`decrypt: ${detectionNote}`, detection.ambiguous ? 'warn' : 'detail');
  }

  const candidateKs = candidateKsFor(profile, options);
  const flashBase = profile.memory.flashBase;

  const artifacts: Artifact[] = [];
  const slots: DecryptedSlot[] = [];
  const imageSummaries: ImageSummary[] = [];
  const keySummaries: KeySummary[] = [];

  const view = viewOf(bytes);
  const len = bytes.length;
  const images = findImages(view, len);

  reporter.log('');
  reporter.log('decrypt: scanning for firmware image slots ...', 'detail');
  if (images.length === 0) {
    reporter.log(
      'decrypt: no image slots found (no header magic at any 64 KiB boundary) — skipping',
      'warn',
    );
    return {
      artifacts,
      summary: buildDecryptionSummary({
        images: [],
        keys: [],
        note: 'no image slots found',
        bootloaderKeys: null,
      }),
      slots,
      bootloaderKeys: null,
      detection,
      cancelled: cancelled(),
    };
  }
  reporter.log(
    `decrypt: ${String(images.length)} slot(s) at ` +
      images.map((image) => hexUp(flashBase + image.base)).join(', '),
    'detail',
  );

  /* Recover every slot up front so the dump's own bootloader key table can be
   * identified before any filename is built. Results are cached by ciphertext,
   * so the main loop below reuses them rather than solving twice. */
  const infoByCipher = new Map<string, RecoveredKey>();
  for (const image of images) {
    if (cancelled()) break;
    const cipherHash = await sha256hex(bytes.subarray(image.base, image.base + image.len));
    if (!infoByCipher.has(cipherHash)) {
      infoByCipher.set(
        cipherHash,
        recoverKeyInfo(view, image.base, image.len, profile.cipher, candidateKs),
      );
    }
  }

  const found = findBootloaderKeys(
    bytes,
    Array.from(infoByCipher.values(), (info) => info.state),
    profile.memory.bootConfigBase,
    candidateKs,
  );
  const bootKeys = found?.table ?? null;
  if (bootKeys) {
    reporter.log(
      `decrypt: this dump's bootloader keys — A ${bytesToHex(bootKeys.keyA)}` +
        `  B ${bytesToHex(bootKeys.keyB)}`,
      'detail',
    );
    if (found && found.whiteningK !== profile.cipher.whiteningK) {
      reporter.log(
        `         (they match a slot under K=${hexUp(found.whiteningK)}, not this profile's ` +
          `K=${hexUp(profile.cipher.whiteningK)} — K and the acceptance TARGET are independent)`,
        'detail',
      );
    }
  }
  const bootloaderKeys: BootloaderKeysSummary | null = bootKeys
    ? buildBootloaderKeysSummary(bootKeys.keyA, bootKeys.keyB, bootKeys.offset)
    : null;

  const reportLines: string[] = [
    'Firmware decryption report',
    '==========================',
    `Generated : ${clock().toISOString()}`,
    `Dump      : ${dumpPath} (${String(len)} bytes)`,
    'Method    : cryptanalytic (xorshift128 linear GF(2) solve); no key search',
    `Profile   : ${profile.name} [${profile.id}]` +
      (detectionNote === undefined ? ' (given by the caller)' : ' (detected from this dump)'),
    `Slots     : ${images.map((image) => hexUp(flashBase + image.base)).join(', ')}`,
    '',
  ];
  const keyLog: string[] = [];
  const plainHashFirst = new Map<string, number>();

  for (let index = 0; index < images.length; index++) {
    if (cancelled()) break;
    const image = images[index];
    if (image === undefined) continue;

    reporter.progress(
      index,
      images.length,
      `decrypt: recovering key for ${hexUp(flashBase + image.base)} ...`,
    );

    const source = bytes.subarray(image.base, image.base + image.len);
    const cipherHash = await sha256hex(source);
    const flash = flashBase + image.base;
    const tag = `slot ${hexUp(flash)} (file ${hexUp(image.base)}, len ${hexUp(image.len)})`;

    let recovered = infoByCipher.get(cipherHash);
    if (recovered === undefined) {
      recovered = recoverKeyInfo(view, image.base, image.len, profile.cipher, candidateKs);
      infoByCipher.set(cipherHash, recovered);
    }

    const {
      state,
      checksum,
      matchesProfile,
      confidence,
      candidates,
      word13,
      selfConsistent,
      sane,
    } = recovered;
    const stateHex = Array.from(state, (word) => hexUp(word)).join(' ');

    const plain = decryptImage(view, image.base, image.len, state, profile.cipher);
    const plainHash = await sha256hex(plain);
    const plainView = viewOf(plain);
    const sp = plainView.getUint32(0, true);
    const entry = plainView.getUint32(4, true);
    const duplicateOf = plainHashFirst.get(plainHash) ?? null;
    if (duplicateOf === null) plainHashFirst.set(plainHash, flash);

    /* THE improvement: which key form this build actually uses is decided by
     * what its own plaintext holds, not by which acceptance TARGET it hit. */
    const whitening = resolveWhitening(plain, state, candidateKs);
    const keyHex = whitening.keyHex;
    const keyBytes = keyFromState(state, whitening.whiteningK);
    const named = matchesProfile || whitening.evidence === 'plaintext';
    const profileName = matchesProfile
      ? `${profile.name} (K=${hexUp(whitening.whiteningK)}, ` +
        `TARGET=${hexUp(profile.cipher.acceptanceSum)})`
      : `xs128/K=? (checksum=${hexUp(checksum)}, unknown profile)`;

    /* Only stamp the filename when the keys are genuinely inside this image.
     * A build that derives its key at runtime has no table to find, and saying
     * otherwise would make the flash-time substitution patch the wrong bytes. */
    const embedded = bootKeys ? findEmbeddedKeyTable(plain, bootKeys.keyA, bootKeys.keyB) : null;
    const keySuffix = embedded && bootKeys ? keyFilenameSuffix(bootKeys.keyA, bootKeys.keyB) : '';

    const binName = `${stem}_decrypted_${addrTag(flash)}${keySuffix}.bin`;
    const txtName = `${stem}_decrypted_${addrTag(flash)}.txt`;
    const keyName = `${stem}_${addrTag(flash)}.key`;

    const keyEvidence =
      whitening.evidence === 'plaintext'
        ? "this exact key is in the image's own plaintext, once — K resolved by evidence"
        : `no key form occurs in this image's plaintext, so ${profile.name}'s ` +
          `K=${hexUp(whitening.whiteningK)} is assumed (K is unidentifiable from ciphertext alone)`;

    const keyRecord =
      `slot           : flash ${hexUp(flash)}  (file ${hexUp(image.base)}, ` +
      `len ${hexUp(image.len)})\n` +
      `confidence     : ${confidence}\n` +
      `recovered state: ${stateHex}   (x y z w; the actual decryption secret)\n` +
      `derived TARGET : ${hexUp(checksum)}` +
      `${matchesProfile ? '  (matches known profile)' : '  (no known TARGET matched)'}\n` +
      `self-check     : word13 decrypts to ${word13 === null ? 'n/a' : hexUp(word13)}` +
      (selfConsistent ? '  == 0 OK' : word13 === null ? '' : '  != 0 (assumption may not hold)') +
      `; reset-vector sane=${String(sane)}\n` +
      `cipher profile : ${profileName}\n` +
      `key (K=${hexUp(whitening.whiteningK)}) : ${keyHex}\n` +
      `key evidence   : ${keyEvidence}\n` +
      (named
        ? ''
        : 'key UNKNOWN-K  : K is unidentifiable from ciphertext alone; candidates below.\n' +
          `${candidates.map((c) => `  K=${hexUp(c.K)} : ${c.keyHex}`).join('\n')}\n`);

    const infoText =
      'Firmware decryption report\n' +
      '==========================\n' +
      `Generated      : ${clock().toISOString()}\n` +
      `Input dump     : ${dumpPath}\n` +
      `Dump size      : ${String(len)} bytes (${hexUp(len)})\n` +
      '\n' +
      `Image slot     : flash ${hexUp(flash)}   (file offset ${hexUp(image.base)})\n` +
      `Image length   : ${String(image.len)} bytes (${hexUp(image.len)})\n` +
      '\n' +
      `Confidence     : ${confidence}\n` +
      'Key recovery   : cryptanalytic — xorshift128 linear GF(2) solve from ciphertext\n' +
      '                 (no key search; the stored key slot is never read)\n' +
      `  known-plaintext: image words ${KNOWN_ZERO_IDX.join(',')} ` +
      '(Cortex-M reserved vectors) == 0\n' +
      `  self-check     : word ${String(CHECK_ZERO_IDX)} decrypts to ` +
      (word13 === null ? 'n/a' : hexUp(word13)) +
      (selfConsistent ? ' (==0, consistent)' : '') +
      '\n' +
      '\n' +
      keyRecord +
      '\n' +
      `Decrypted SP    : ${hexUp(sp)}\n` +
      `Decrypted entry : ${hexUp(entry)}  (Thumb=${(entry & 1) === 1 ? 'yes' : 'no'})\n` +
      '\n' +
      `Ciphertext SHA-256 : ${cipherHash}\n` +
      `Plaintext  SHA-256 : ${plainHash}\n` +
      '\n' +
      `Embedded key table : ${
        embedded
          ? `yes, at image offset ${keyTableWhere(embedded)}\n` +
            '                     these are the keys this image will USE once it runs, and they are\n' +
            '                     in the filename so the flash view can retarget them to another camera\n'
          : bootKeys
            ? "not found — this image does not store this camera's key pair as plain bytes.\n" +
              '                     It may belong to a different key family, or derive its key at runtime.\n' +
              '                     No keys were added to the filename.\n'
            : "not checked — this dump's bootloader key table could not be identified.\n"
      }` +
      (duplicateOf !== null
        ? `Note            : identical decrypted image to slot ${hexUp(duplicateOf)} (redundant copy)\n`
        : '') +
      `Output image    : ${binName}\n`;

    pushArtifact(artifacts, reporter, { name: `decrypted/${binName}`, data: plain });
    pushArtifact(artifacts, reporter, { name: `decrypted/${txtName}`, data: utf8(infoText) });
    pushArtifact(artifacts, reporter, { name: `decrypted/${keyName}`, data: utf8(keyRecord) });
    keyLog.push(keyRecord);

    const dupNote = duplicateOf !== null ? `  (same plaintext as ${hexUp(duplicateOf)})` : '';
    reporter.log(
      `decrypt: ${tag} -> ${binName}${dupNote}`,
      confidence === 'UNVERIFIED' ? 'warn' : 'ok',
    );
    reporter.log(
      `         [${confidence}] ${named ? `key=${keyHex}` : `state=${stateHex}`}  [${profileName}]`,
      'detail',
    );
    reporter.log(
      `         SP=${hexUp(sp)} entry=${hexUp(entry)} sha256=${plainHash.slice(0, 24)}`,
      'detail',
    );
    if (embedded) {
      reporter.log(
        `         embedded keys at ${keyTableWhere(embedded)} — added to the filename`,
        'detail',
      );
    } else if (bootKeys) {
      reporter.log(
        "         no embedded key table for this camera's keys — filename left unstamped",
        'warn',
      );
    }

    reportLines.push(
      `${tag}: [${confidence}] ${named ? `key=${keyHex}` : `state=${stateHex}`}  [${profileName}]`,
      `      SP=${hexUp(sp)} entry=${hexUp(entry)}  plain-sha256=${plainHash}${dupNote}`,
      `      -> ${binName}`,
      '',
    );

    imageSummaries.push(
      buildImageSummary({
        flash,
        fileOffset: image.base,
        length: image.len,
        cipherSha256: cipherHash,
        plainSha256: plainHash,
        confidence,
        key: named ? keyBytes : null,
        state: Array.from(state),
        derivedTarget: checksum,
        profile: profileName,
        sp,
        entry,
        duplicateOf,
        embeddedKeyTable:
          embedded && bootKeys
            ? {
                keyAOffset: embedded.offsetA,
                keyBOffset: embedded.offsetB,
                adjacent: embedded.adjacent,
                keyA: bootKeys.keyA,
                keyB: bootKeys.keyB,
              }
            : null,
        file: `decrypted/${binName}`,
      }),
    );

    if (named && !keySummaries.some((k) => k.key === keyHex && k.profile === profileName)) {
      keySummaries.push(
        buildKeySummary({
          key: keyBytes,
          profile: profileName,
          recovery: 'cryptanalytic',
          confidence,
        }),
      );
    }

    slots.push({
      flash,
      fileOffset: image.base,
      length: image.len,
      recovered,
      whitening,
      plain,
      cipherSha256: cipherHash,
      plainSha256: plainHash,
      sp,
      entry,
      duplicateOf,
      embedded,
      file: `decrypted/${binName}`,
    });
  }

  reportLines.push(`Keys recovered (cryptanalytic): ${String(keySummaries.length)}`);
  for (const key of keySummaries) {
    reportLines.push(`  ${key.key}  [${key.profile}]  (${key.confidence})`);
  }
  reportLines.push('');

  pushArtifact(artifacts, reporter, {
    name: 'decrypted/decryption_report.txt',
    data: utf8(reportLines.join('\n')),
  });
  pushArtifact(artifacts, reporter, {
    name: `decrypted/${stem}_keys.log`,
    data: utf8(
      `Recovered keys — ${clock().toISOString()}\n` +
        'Method: cryptanalytic (xorshift128 linear solve); no key search.\n' +
        'The STATE is the true decryption secret. Which whitening constant K names it is\n' +
        "decided by the image's own plaintext, not by the acceptance TARGET — the two are\n" +
        'independent axes. When no key form occurs in the plaintext, nominal keys under\n' +
        'each candidate K are listed and the slot is flagged UNVERIFIED (still valid\n' +
        'plaintext).\n' +
        '================================================================================\n\n' +
        keyLog.join(
          '\n--------------------------------------------------------------------------------\n',
        ) +
        '\n',
    ),
  });

  reporter.log(
    `decrypt: ${String(imageSummaries.length)}/${String(images.length)} slot(s) decrypted from ` +
      'ciphertext (no key search)',
    imageSummaries.length > 0 ? 'ok' : 'warn',
  );

  return {
    artifacts,
    summary: buildDecryptionSummary({
      images: imageSummaries,
      keys: keySummaries,
      bootloaderKeys,
      ...(detectionNote !== undefined ? { note: detectionNote } : {}),
    }),
    slots,
    bootloaderKeys: bootKeys,
    detection,
    cancelled: cancelled(),
  };
}

function pushArtifact(artifacts: Artifact[], reporter: Reporter, artifact: Artifact): void {
  artifacts.push(artifact);
  reporter.artifact(artifact);
}

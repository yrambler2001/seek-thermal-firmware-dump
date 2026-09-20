/**
 * `seek-fw decrypt <file>` — the offline path.
 *
 * Touches no device, needs no USB permission and loads no native addon: the
 * key comes out of the ciphertext by cryptanalysis, so a dump from an SPI
 * programmer or a J-Link decrypts exactly as well as one this tool read.
 *
 * Profile detection is core's `detectProfileForDump`, reached by simply not
 * naming a profile: offline there is no device evidence, so the file's own
 * slots — where they sit, what acceptance sum each decrypts to, what version
 * each header declares — are what decides. `--profile` overrides it, and
 * either way the choice is printed and written into the manifest.
 */

import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  decryptDump,
  getProfile,
  hex,
  hexUp,
  makeOfflineDecryptReadme,
  manifestToJson,
  profileInfoOf,
  sha256hex,
  utf8,
  type Artifact,
  type DecryptOptions,
  type FirmwareProfile,
  type OfflineDecryptManifest,
} from '@seek-fw/core';
import type { CommandContext, CommandResult } from '../cli.js';
import { CliError } from '../errors.js';
import { table, uniqueArtifacts, writeRun } from './shared.js';

function stemOf(fileName: string): string {
  return fileName.replace(/\.[^./\\]+$/, '');
}

export async function decryptCommand(ctx: CommandContext): Promise<CommandResult> {
  const path = ctx.file;
  if (path === null) throw new CliError('decrypt needs a file argument', { code: 'cli/usage' });

  let bytes: Uint8Array;
  try {
    const buffer = await readFile(path);
    bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (error) {
    throw new CliError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'cli/no-input' },
    );
  }
  if (bytes.length === 0) throw new CliError(`${path} is empty`, { code: 'cli/no-input' });

  const fileName = basename(path);
  const startedAt = new Date().toISOString();

  /* With no --profile, core detects the family from the dump itself: offline
   * there is no device evidence, and the file's own slots are the only thing
   * that can speak for it. The choice comes back on the result so it can be
   * shown and recorded rather than silently applied. */
  const forced = ctx.options.profile === null ? null : getProfile(ctx.options.profile);
  if (forced !== null) ctx.reporter.log(`profile ${forced.id} (--profile)`, 'detail');
  ctx.reporter.log(`${fileName}: ${String(bytes.length)} B`, 'detail');

  const options: DecryptOptions = {
    dumpPath: fileName,
    signal: ctx.signal,
    ...(forced === null ? {} : { profile: forced }),
  };
  const result = await decryptDump(bytes, stemOf(fileName), options, ctx.reporter);

  const detection = result.detection;
  const profile: FirmwareProfile = forced ?? detection?.best.profile ?? getProfile('generic');

  const manifest: OfflineDecryptManifest = {
    producer: `seek-thermal-firmware-dump (seek-fw CLI offline decrypt, ${profile.id})`,
    startedAt,
    finishedAt: new Date().toISOString(),
    source: { fileName, size: bytes.length, sha256: await sha256hex(bytes) },
    flashBase: hex(profile.memory.flashBase, 8),
    decryption: result.summary,
    profile: profileInfoOf(profile, detection),
  };

  const extra: Artifact[] = [
    { name: 'manifest.json', data: utf8(manifestToJson(manifest)) },
    { name: 'README.md', data: utf8(makeOfflineDecryptReadme(manifest)) },
  ];
  for (const artifact of extra) ctx.reporter.artifact(artifact);

  const written = await writeRun(ctx, 'decrypt', uniqueArtifacts(ctx.reporter.artifacts));

  if (ctx.human) {
    ctx.out('');
    if (detection === null) {
      ctx.out(`profile: ${profile.id} — ${profile.name} (forced with --profile)`);
    } else {
      ctx.out(
        `profile: ${profile.id} — ${profile.name} (detected, score ` +
          `${detection.best.score.toFixed(2)}${detection.ambiguous ? ', AMBIGUOUS' : ''})`,
      );
      for (const reason of detection.best.reasons) ctx.out(`  · ${reason}`);
    }
    if (result.slots.length === 0) {
      ctx.out('no firmware image slots were found in this file');
    } else {
      ctx.out('');
      ctx.out(
        table(
          result.slots.map((slot) => [
            hexUp(slot.flash),
            `${String(slot.length)} B`,
            slot.recovered.confidence,
            hexUp(slot.recovered.checksum),
            hexUp(slot.whitening.whiteningK),
            slot.duplicateOf === null ? '' : `copy of ${hexUp(slot.duplicateOf)}`,
            slot.plainSha256.slice(0, 16),
          ]),
          ['slot', 'size', 'key', 'sum', 'K', 'note', 'sha256'],
        ),
      );
      ctx.out('');
    }
  }

  return {
    source: { file: fileName, size: bytes.length, sha256: manifest.source.sha256 },
    profile: profile.id,
    detection:
      detection === null
        ? null
        : {
            id: detection.best.profile.id,
            score: detection.best.score,
            ambiguous: detection.ambiguous,
            reasons: [...detection.best.reasons],
          },
    profileForced: forced !== null,
    slots: result.slots.map((slot) => ({
      flash: hexUp(slot.flash),
      fileOffset: hexUp(slot.fileOffset),
      length: slot.length,
      confidence: slot.recovered.confidence,
      acceptanceSum: hexUp(slot.recovered.checksum),
      whiteningK: hexUp(slot.whitening.whiteningK),
      whiteningEvidence: slot.whitening.evidence,
      key: slot.whitening.keyHex,
      sp: hexUp(slot.sp),
      entry: hexUp(slot.entry),
      duplicateOf: slot.duplicateOf === null ? null : hexUp(slot.duplicateOf),
      cipherSha256: slot.cipherSha256,
      plainSha256: slot.plainSha256,
      file: slot.file,
    })),
    cancelled: result.cancelled,
    output: { directory: written.directory, zip: written.zip, files: written.files },
    manifest,
  };
}

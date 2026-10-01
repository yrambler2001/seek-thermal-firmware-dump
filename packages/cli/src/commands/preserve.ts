/**
 * `seek-fw preserve <image>` — the full-flash preservation pipeline for the v1
 * locked line (Compact 1.0.0.0 / 1.2.0.0 / 1.3.0.0).
 *
 * THE HONEST RISK, STATED WHERE THE OPERATOR IS. Phases P2 and P4 write the
 * ACTIVE boot slot over the wire. On real hardware an interrupted write there
 * has NO bootable fallback: the other banks hold whatever they hold, the
 * recovery slot is not written by this pipeline, and a power loss mid-commit
 * is unrecoverable without an SPI programmer. The pipeline mitigates what a
 * pipeline can (P1 backs up every reachable window BEFORE the first write;
 * P4 puts the original bank back; the delivered dump is post-processed to the
 * camera's original content), but it cannot make an active-slot write safe.
 * Run it on mains power, on a bench, with the rescue dump kept.
 *
 * This file is the terminal's share of the protection: it refuses without a
 * confirmation, it shows the whole plan (the exact bytes that will move and
 * where), it derives the expected version FROM the image so the patch cannot
 * be sent to a build it was not derived from, and it writes every artifact —
 * the backup, the raw and the delivered dump — with its sha256 in the run
 * record.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import {
  buildV1Patch,
  hexUp,
  parseImageHeader,
  runPreservationPipeline,
  sha256hex,
  type SessionOpener,
  V1_2014_PATCH_SITES,
} from '@seek-fw/core';
import type { CommandContext, CommandResult } from '../cli.js';
import { CliError } from '../errors.js';
import { openSession, type Session } from './shared.js';

/** The artifacts land here when --out is not given. */
const DEFAULT_OUT = 'preserve-run';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function preserveCommand(ctx: CommandContext): Promise<CommandResult> {
  const imagePath = ctx.file;
  if (imagePath === null) {
    throw new CliError('preserve needs a decrypted firmware image argument', {
      code: 'cli/usage',
    });
  }

  /* Nobody to ask: same rule as flash, checked before the camera opens. */
  if (!ctx.options.yes && !ctx.io.stdinIsTty) {
    throw new CliError(
      'refusing to run the preservation pipeline without confirmation: stdin is not a ' +
        'terminal, so there is nobody to ask',
      {
        code: 'flash/refused',
        hint:
          'This pipeline WRITES the active boot slot (phases P2 and P4). Pass --yes to ' +
          'confirm non-interactively after reading the plan on a terminal.',
      },
    );
  }

  const fileName = basename(imagePath);
  let image: Uint8Array;
  try {
    const buffer = await readFile(imagePath);
    image = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (error) {
    throw new CliError(
      `could not read ${imagePath}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'cli/no-input' },
    );
  }

  /* The expected version comes FROM the image: the patch is derived from one
   * build's bytes, and the camera must report that build before anything is
   * sent. The builder also refuses an image that does not carry the 2014
   * update machinery, so a wrong file fails here, on the desk. */
  const header = parseImageHeader(image);
  if (header === null) {
    throw new CliError(
      `${fileName} does not parse as a decrypted Seek firmware image (no header at 0x200)`,
      { code: 'image/malformed' },
    );
  }
  const expectedVersion = header.versionStr;
  const patch = buildV1Patch(image); /* throws unless the sites match */

  const say = (text: string): void => {
    ctx.reporter.write(text);
  };
  say('');
  say(`preserve plan — ${fileName}`);
  say(`  image version      ${expectedVersion} (${String(image.length)} B)`);
  say(`  patch sites        ${String(V1_2014_PATCH_SITES.length)} instructions`);
  for (const site of V1_2014_PATCH_SITES) {
    say(`    ${hexUp(site.offset)}  ${site.what}`);
  }
  say(`  rebalance word     ${hexUp(patch.rebalanceWord)} at 0x00000238`);
  say(
    `  bytes that move    ${String(patch.diffOffsets.length)} on the part, all inside the ` +
      'active bank',
  );
  say('  phases             P1 backup -> P2 in-place patch -> P3 full dump -> P4 restore');
  say('  RISK               P2/P4 write the ACTIVE boot slot. On hardware an interrupted');
  say('                     write there has no bootable fallback (SPI programmer needed).');
  say('');

  if (!ctx.options.yes) {
    const confirmed = await ctx.io.confirm(
      `Patch the ACTIVE slot of this camera in place, dump the whole part, and restore ` +
        `it (${expectedVersion})? [y/N] `,
    );
    if (!confirmed) {
      throw new CliError('aborted at the confirmation prompt — nothing was written', {
        code: 'flash/refused',
      });
    }
  } else {
    ctx.reporter.log('--yes given: skipping the confirmation', 'warn');
  }

  /* A fresh session per phase boundary. After a wire-89 the camera re-enumerates,
   * so open() retries until the camera is back (or the run is cancelled). */
  let current: Session | null = null;
  const opener: SessionOpener = {
    open: async () => {
      for (let attempt = 0; ; attempt++) {
        if (ctx.signal.aborted) throw new CliError('cancelled', { code: 'cancelled' });
        try {
          current = await openSession(ctx);
          return current.device;
        } catch (error) {
          if (attempt >= 60) {
            throw new CliError(
              `the camera did not come back after ${String(attempt + 1)} attempts — ` +
                'replug it and re-run the phase that failed. Nothing more was written. ' +
                `Last error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await sleep(1000);
        }
      }
    },
    close: async () => {
      const session = current;
      current = null;
      await session?.close();
    },
  };

  const result = await runPreservationPipeline({
    opener,
    plain: image,
    expectedVersion,
    reporter: ctx.reporter,
  });

  /* ---- the artifacts -------------------------------------------------- */
  const outDir = resolve(ctx.options.out ?? DEFAULT_OUT);
  await mkdir(outDir, { recursive: true });
  const written = new Map<string, string>();
  const put = async (name: string, bytes: Uint8Array): Promise<string> => {
    const file = join(outDir, name);
    await writeFile(file, bytes);
    written.set(name, await sha256hex(bytes));
    return file;
  };

  /* The backup, assembled at its flash addresses into a 4 MiB image (the
   * unreachable windows stay 0xFF and the run record says the backup's real
   * coverage). */
  const backupImage = new Uint8Array(4 * 1024 * 1024).fill(0xff);
  for (const window of result.backupByAddress) {
    const [address, bytes] = window;
    backupImage.set(bytes, address - 0x14000000);
  }
  const files = {
    backup: await put('preserve_backup_windows.bin', backupImage),
    bankCapture: await put('preserve_bank_capture.bin', result.bankCapture),
    dumpPostWrite: await put('preserve_dump_postwrite.bin', result.rawDump),
    dumpOriginal: await put('preserve_dump_original.bin', result.processedDump),
  };

  const record = {
    command: 'preserve',
    image: { file: fileName, version: expectedVersion, bytes: image.length },
    detection: result.detection,
    patch: {
      sites: V1_2014_PATCH_SITES.map((site) => ({
        offset: hexUp(site.offset),
        what: site.what,
      })),
      rebalanceWord: hexUp(patch.rebalanceWord),
      diffOffsets: patch.diffOffsets.map((o) => hexUp(o)),
    },
    phases: result.records,
    verify: result.verify,
    sha256: {
      bankCapture: written.get('preserve_bank_capture.bin') ?? null,
      dumpPostWrite: written.get('preserve_dump_postwrite.bin') ?? null,
      dumpOriginal: written.get('preserve_dump_original.bin') ?? null,
    },
    files: Object.fromEntries([...written].map(([name, sha]) => [name, sha])),
  };
  const recordFile = join(outDir, 'preserve_run.json');
  await writeFile(recordFile, `${JSON.stringify(record, null, 2)}\n`);

  if (ctx.human) {
    for (const phase of result.records) {
      ctx.out(`${phase.phase} ${phase.ok ? 'PASS' : 'FAIL'}: ${phase.detail}`);
    }
    ctx.out(`delivered original-content dump: ${files.dumpOriginal}`);
    ctx.out(`run record: ${recordFile}`);
  }

  return {
    image: { file: fileName, version: expectedVersion },
    detection: {
      cfg0: result.detection.cfg0,
      blank: result.detection.blank,
      bankAddress: result.detection.bankAddress,
      verdict: result.detection.verdict,
    },
    phases: result.records,
    verify: result.verify,
    sha256: record.sha256,
    output: { directory: outDir, files: [...written.keys()], record: recordFile },
  };
}

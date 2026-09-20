/**
 * `seek-fw flash <image>` — the one command that can change the camera.
 *
 * Everything that decides whether a write is safe lives in core: the profile
 * capability gate, the image validation, the key retargeting, the acceptance
 * sum, the footer, the payload. This file adds the four things a terminal owes
 * the user before that runs:
 *
 *   1. it refuses when there is nobody to ask — stdin not a tty and no --yes;
 *   2. it takes the rescue dump BEFORE the write, unless told not to;
 *   3. it prints the whole plan and waits for an explicit yes;
 *   4. it never hides core's post-commit warning behind --verbose, because
 *      "the commit succeeded" and "the bootloader will boot it" are different
 *      statements and only the second one matters.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  CancelledError,
  getProfile,
  hexUp,
  prepareImage,
  requireCapability,
  runDump,
  sha256hex,
  writeFirmware,
  type DeviceState,
  type LogLevel,
  type PreparedFlash,
  type Reporter,
} from '@seek-fw/core';
import type { CommandContext, CommandResult } from '../cli.js';
import { CliError } from '../errors.js';
import { paint } from '../ansi.js';
import { analyseCamera, renderState } from './info.js';
import {
  dumpOptionsFrom,
  heading,
  openSession,
  table,
  uniqueArtifacts,
  workflowContext,
  writeRun,
} from './shared.js';

/** A reporter that shows `detail` lines too: during a write, nothing is noise. */
function loud(inner: Reporter): Reporter {
  return {
    log: (message: string, level: LogLevel = 'info'): void => {
      inner.log(message, level === 'detail' ? 'info' : level);
    },
    progress: (done: number, total: number, text?: string): void => {
      inner.progress(done, total, text);
    },
    artifact: (artifact) => {
      inner.artifact(artifact);
    },
  };
}

function planJson(prep: PreparedFlash, payloadSha256: string): Record<string, unknown> {
  return {
    file: prep.fileName,
    originalSize: prep.originalSize,
    declaredLengthBefore: prep.declaredBefore,
    lengthStamped: prep.lengthStamped,
    length: prep.length,
    adjust: hexUp(prep.adjust),
    version: prep.header.versionStr,
    imageId: hexUp(prep.header.imageId),
    targetSlot: prep.targetName,
    bootedSlot: prep.bootedName,
    runningSlot: prep.runningSlot,
    keyPatch: {
      where: prep.keyPatch.where,
      changed: prep.keyPatch.changed,
      adjacent: prep.keyPatch.adjacent,
      fromA: prep.keyPatch.fromA,
      fromB: prep.keyPatch.fromB,
      toA: prep.keyPatch.toA,
      toB: prep.keyPatch.toB,
    },
    carriesThisCamerasKeys: prep.carriesMine,
    layoutMoved: prep.layoutMoved,
    rekeyRisk: prep.rekeyRisk,
    payloadBytes: prep.payload.length,
    payloadSha256,
    footerOffset: hexUp(prep.footerOffset),
    footerFrom: prep.footerFrom,
    footerModel: prep.footer?.model ?? null,
    transferChecksum: hexUp(prep.sum16, 4),
    compare: prep.compare.map((row) => ({
      field: row.field,
      onCamera: row.onCamera,
      inImage: row.inImage,
    })),
  };
}

function renderPlan(ctx: CommandContext, prep: PreparedFlash, payloadSha256: string): void {
  /* Straight to the reporter rather than through `ctx.out`, which --quiet
   * silences: nobody is asked to confirm a write they were not shown, and a
   * quiet flash is still a flash. */
  const say = (text: string): void => {
    ctx.reporter.write(text);
  };
  say('');
  say(heading('Flash plan', ctx.color));
  say(
    table([
      ['  image', `${prep.fileName} (${String(prep.originalSize)} B)`],
      ['  version', `${prep.header.versionStr}  image id ${hexUp(prep.header.imageId)}`],
      [
        '  header.length',
        prep.lengthStamped
          ? `${String(prep.length)} B (stamped; the file declared ${String(prep.declaredBefore)})`
          : `${String(prep.length)} B (already correct)`,
      ],
      ['  acceptance sum', `balanced with adjust ${hexUp(prep.adjust)} at +0x238`],
      [
        '  key retargeting',
        prep.keyPatch.changed
          ? `rewritten at ${prep.keyPatch.where}: ${prep.keyPatch.fromA} -> ${prep.keyPatch.toA}`
          : `none needed — the image already carries this camera's keys (${prep.keyPatch.where})`,
      ],
      [
        '  target slot',
        `${prep.targetName ?? '(unknown)'}${
          prep.bootedName === null ? '' : ` (the camera booted ${prep.bootedName})`
        }`,
      ],
      [
        '  payload',
        `${String(prep.payload.length)} B, footer at ${hexUp(prep.footerOffset)}${
          prep.footerFrom === null ? '' : ` carried over from ${prep.footerFrom}`
        }`,
      ],
      ['  footer model', prep.footer?.model ?? '(none)'],
      ['  transfer checksum', hexUp(prep.sum16, 4)],
      ['  payload sha256', payloadSha256],
    ]),
  );

  if (prep.compare.length > 0) {
    say('');
    say(heading('Differences from what the camera is running', ctx.color));
    say(
      table(
        prep.compare.map((row) => [`  ${row.field}`, row.onCamera, '->', row.inImage]),
        ['  field', 'on camera', '', 'in this image'],
      ),
    );
  }

  const warnings: string[] = [];
  if (prep.layoutMoved) {
    warnings.push(
      'the stack pointer or reset vector moved: this is a differently linked build, not a ' +
        'rebuild of what the camera runs',
    );
  }
  if (!prep.carriesMine) {
    warnings.push(
      "the image does not carry this camera's key pair even after patching — later upgrades " +
        'may land under a key this bootloader cannot try',
    );
  }
  if (prep.rekeyRisk) {
    warnings.push(
      'the target slot already holds an image the bootloader cannot key, which is direct ' +
        'evidence that the running application re-encrypts with a key the bootloader will not ' +
        'try. This write will most likely land in the same state: committed, and skipped at boot.',
    );
  }
  if (warnings.length > 0) {
    say('');
    say(paint(heading('Warnings', ctx.color), 'yellow', ctx.color));
    for (const warning of warnings) say(paint(`  ! ${warning}`, 'yellow', ctx.color));
  }
  say('');
}

export async function flashCommand(ctx: CommandContext): Promise<CommandResult> {
  const path = ctx.file;
  if (path === null) throw new CliError('flash needs an image argument', { code: 'cli/usage' });

  /* (1) Nobody to ask. Checked before the camera is even opened, so a script
   * that forgot --yes fails immediately instead of after a 4 MiB rescue dump. */
  if (!ctx.options.yes && !ctx.io.stdinIsTty) {
    throw new CliError(
      'refusing to flash without confirmation: stdin is not a terminal, so there is nobody ' +
        'to ask',
      {
        code: 'flash/refused',
        hint:
          'Pass --yes to confirm non-interactively. Read the plan first with a dry run on ' +
          'a terminal, or with --json.',
      },
    );
  }

  /* (2) A profile the user named that cannot flash is refused before any
   * device I/O — the capability gate is core's, the early call is ours. */
  if (ctx.options.profile !== null) {
    requireCapability(getProfile(ctx.options.profile), 'flash');
  }

  const fileName = basename(path);
  let image: Uint8Array;
  try {
    const buffer = await readFile(path);
    image = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch (error) {
    throw new CliError(
      `could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
      { code: 'cli/no-input' },
    );
  }

  const session = await openSession(ctx);
  try {
    const { state } = await analyseCamera(ctx, session, { rereadOnAnyBetter: true });
    if (ctx.human) renderState(ctx, state);

    /* The gate again, now that detection has settled which family this is. */
    requireCapability(state.profile, 'flash');

    /* Packaging is pure and can refuse — for a filename with no key pair, a
     * still-encrypted file, a bad stack pointer — so it runs before the rescue
     * dump rather than after minutes of reading. */
    const prep = prepareImage(state, image, fileName);
    const payloadSha256 = await sha256hex(prep.payload);

    /* (3) The rescue dump, before anything is written. */
    const rescue = await takeRescueDump(ctx, session, state);

    /* Always rendered, even under --json (where it lands on stderr): nobody
     * should be asked to confirm a write they were not shown. */
    renderPlan(ctx, prep, payloadSha256);

    /* (4) The confirmation. */
    if (!ctx.options.yes) {
      const question =
        `Write ${prep.fileName} to ${prep.targetName ?? 'the upgrade slot'} on ` +
        `${state.description.productName ?? 'this camera'}${
          state.serial === null ? '' : ` (${state.serial})`
        }? [y/N] `;
      const confirmed = await ctx.io.confirm(question);
      if (!confirmed) {
        throw new CliError('aborted at the confirmation prompt — nothing was written', {
          code: 'flash/refused',
        });
      }
    } else {
      ctx.reporter.log('--yes given: skipping the confirmation', 'warn');
    }

    const workflow = {
      ...workflowContext(session, state.profile, state.detection, ctx),
      reporter: loud(ctx.reporter),
    };
    await writeFirmware(workflow, state, prep);

    return {
      file: fileName,
      profile: state.profile.id,
      plan: planJson(prep, payloadSha256),
      rescueDump: rescue,
      written: true,
    };
  } finally {
    await session.close();
  }
}

interface RescueSummary {
  readonly taken: boolean;
  readonly reason: string | null;
  readonly directory: string | null;
  readonly zip: string | null;
  readonly windowsRead: number | null;
  readonly windowsExpected: number | null;
}

/**
 * The full-flash backup. If the image does not boot, this dump is the only way
 * back — so a failure to take it stops the flash rather than being downgraded
 * to a warning.
 */
async function takeRescueDump(
  ctx: CommandContext,
  session: Awaited<ReturnType<typeof openSession>>,
  state: DeviceState,
): Promise<RescueSummary> {
  if (!ctx.options.rescueDump) {
    ctx.reporter.log(
      '--no-rescue-dump: skipping the full-flash backup. If the image does not boot, there ' +
        'is no way back without an SPI programmer or SWD/J-Link.',
      'warn',
    );
    return {
      taken: false,
      reason: '--no-rescue-dump',
      directory: null,
      zip: null,
      windowsRead: null,
      windowsExpected: null,
    };
  }

  ctx.reporter.log('rescue dump: reading the whole flash before writing ...', 'warn');
  const before = ctx.reporter.artifacts.length;
  const workflow = workflowContext(session, state.profile, state.detection, ctx);
  try {
    const result = await runDump(workflow, dumpOptionsFrom(ctx.options));
    const written = await writeRun(
      ctx,
      'rescue',
      uniqueArtifacts(ctx.reporter.artifacts.slice(before)),
    );
    if (result.cancelled) {
      /* The partial dump has been saved, but it is not a backup: refusing is
       * the only safe reading of "the user pressed Ctrl-C during the backup". */
      throw new CancelledError(
        'cancelled during the rescue dump — the partial read was saved and nothing was written ' +
          'to the camera',
      );
    }
    ctx.reporter.log('rescue dump complete', 'ok');
    return {
      taken: true,
      reason: null,
      directory: written.directory,
      zip: written.zip,
      windowsRead: result.windowsRead,
      windowsExpected: result.windowsExpected,
    };
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    throw new CliError(
      `the rescue dump failed (${error instanceof Error ? error.message : String(error)}) — ` +
        'refusing to write without a backup',
      {
        code: 'flash/refused',
        hint: 'Pass --no-rescue-dump only if you already have a dump of this camera.',
      },
    );
  }
}

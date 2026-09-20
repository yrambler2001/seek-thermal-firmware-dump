/**
 * `seek-fw dump` — the whole 4 MiB flash, then the decrypt stage.
 *
 * The interesting behaviour is the cancel path. Core does NOT throw when the
 * caller aborts: a dump takes minutes, so it stops where it is and returns a
 * complete result with `cancelled: true`, a partial image whose unread windows
 * are gap-filled and recorded as unread, and a manifest that says so. The CLI's
 * job is therefore to write that archive exactly as it writes a finished one,
 * say plainly that it is partial, and still exit 130 — a cancelled run is not
 * a successful one, and it is not a reason to throw the bytes away either.
 */

import { runDump } from '@seek-fw/core';
import type { CommandContext, CommandResult } from '../cli.js';
import {
  chooseProfile,
  dumpOptionsFrom,
  evidenceFromDevice,
  openSession,
  uniqueArtifacts,
  writeRun,
  workflowContext,
} from './shared.js';

export async function dumpCommand(ctx: CommandContext): Promise<CommandResult> {
  const session = await openSession(ctx);
  try {
    const choice = chooseProfile(ctx.options, evidenceFromDevice(session.transport));
    ctx.reporter.log(
      `acting under profile ${choice.profile.id}${choice.forced ? ' (--profile)' : ''}`,
      'detail',
    );
    const workflow = workflowContext(session, choice.profile, choice.detection, ctx);

    const result = await runDump(workflow, dumpOptionsFrom(ctx.options));
    const written = await writeRun(ctx, 'dump', uniqueArtifacts(result.artifacts));

    if (ctx.human) {
      ctx.out(
        `read ${String(result.windowsRead)}/${String(result.windowsExpected)} windows` +
          ` under profile ${choice.profile.id}`,
      );
      if (result.cancelled) {
        ctx.out(
          'cancelled: this archive is PARTIAL — every window that did not run is gap-filled ' +
            'and recorded as unread in manifest.json, and the decrypt stage was skipped',
        );
      }
    }

    return {
      profile: choice.profile.id,
      windowsRead: result.windowsRead,
      windowsExpected: result.windowsExpected,
      bytes: result.combined.length,
      cancelled: result.cancelled,
      output: { directory: written.directory, zip: written.zip, files: written.files },
      manifest: result.manifest,
    };
  } finally {
    await session.close();
  }
}

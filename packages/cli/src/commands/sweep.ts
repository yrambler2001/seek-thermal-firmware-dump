/**
 * `seek-fw sweep` — probe every BeginFirmwareUpgrade selector.
 *
 * Same shape as the dump, cancel path included: core returns what it probed
 * with `cancelled: true` rather than throwing, so the archive is written
 * either way and the exit code carries the difference.
 */

import { runSweep } from '@seek-fw/core';
import type { CommandContext, CommandResult } from '../cli.js';
import {
  chooseProfileByProbe,
  dumpOptionsFrom,
  openSession,
  uniqueArtifacts,
  writeRun,
  workflowContext,
} from './shared.js';

export async function sweepCommand(ctx: CommandContext): Promise<CommandResult> {
  const session = await openSession(ctx);
  try {
    const choice = await chooseProfileByProbe(ctx, session);
    const workflow = workflowContext(session, choice.profile, choice.detection, ctx);
    const [first, last] = choice.profile.sweepRange;
    ctx.reporter.log(
      `sweeping selectors ${String(first)}..${String(last)} under profile ${choice.profile.id}`,
      'detail',
    );

    const result = await runSweep(workflow, dumpOptionsFrom(ctx.options));
    const written = await writeRun(ctx, 'sweep', uniqueArtifacts(result.artifacts));

    if (ctx.human) {
      ctx.out(
        `${String(result.selectorsArmed)} selector(s) armed, ` +
          `${String(result.selectorsWithData)} returned data, ` +
          `${String(result.placedInImage)} placed in the assembled image`,
      );
      if (result.cancelled) ctx.out('cancelled: this sweep is PARTIAL — see manifest.json');
    }

    return {
      profile: choice.profile.id,
      selectorsArmed: result.selectorsArmed,
      selectorsWithData: result.selectorsWithData,
      placedInImage: result.placedInImage,
      cancelled: result.cancelled,
      output: { directory: written.directory, zip: written.zip, files: written.files },
      manifest: result.manifest,
    };
  } finally {
    await session.close();
  }
}

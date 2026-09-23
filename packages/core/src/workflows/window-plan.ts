/* ==================================================================== *
 * Which table to read with: asked of the camera, then looked up.
 *
 * A dump and a sweep both arm windows, and both used to take one selector map
 * per PROFILE. The legacy line has four tables, not one — the 2014 Compacts
 * give subcommand 0x0E the address of 0x0D, and 0.8.0.0 computes subcommand 1
 * from the bootloader's config block — so the map has to come from the build.
 * The build says what it is through GetFirmwareInfo, which every corpus image
 * answers with a getter at 0x4E, and that one read-only transfer is all this
 * adds to a run.
 * ==================================================================== */

import { SeekError } from '../errors.js';
import type { ProfileId, WindowPlan } from '../profiles/types.js';
import {
  identityGate,
  readRunningFirmware,
  type IdentityGate,
  type RunningFirmware,
} from './capability.js';
import type { WorkflowContext } from './types.js';

export interface DevicePlan {
  readonly firmware: RunningFirmware;
  readonly plan: WindowPlan;
}

/** The operations that plan from the camera's own table, as a refusal names them. */
export type PlannedOperation = 'dump' | 'sweep' | 'read the device info';

/**
 * The error a closed identity gate turns into, worded once.
 *
 * `planForDevice` throws it before a run's first arm, and a front end that
 * asked the camera first (`identifyCamera`) throws the same one before the run
 * starts, so the user reads one reason whichever of the two stopped them.
 */
export function identityRefusal(
  gate: Extract<IdentityGate, { readonly permitsArming: false }>,
  firmwareVersion: string | null,
  operation: PlannedOperation,
  profile: ProfileId,
): SeekError {
  return new SeekError(
    gate.code,
    `refusing to ${operation}: ${gate.reason}` +
      (firmwareVersion === null
        ? '. Nothing was armed. Unplug the camera, let it finish starting up, plug it back ' +
          'in and try again.'
        : ''),
    { detail: { firmwareVersion, capability: operation, profile } },
  );
}

/**
 * The running firmware's version, and the plan its own table gives.
 *
 * REFUSES A BUILD THAT CANNOT BE READ, WHATEVER THE PROFILE. The capability
 * gate is the profile's; this one is the firmware's. A caller who forces
 * `--profile legacy-auth` onto a 0.7.0.7 camera gets the same refusal detection
 * would have given it, before a single window is armed: that build has no read
 * handler, and on 0.3.0.1 the arm itself is `EnterBootloaderMode`.
 *
 * AND A CAMERA THAT DOES NOT SAY WHICH BUILD IT RUNS. This used to plan with
 * the rows every decoded build agrees on; but "every build" is every build the
 * toolkit knows, and the unknown build is the one that might be 0.3.0.1. So no
 * version is a refusal (`device/version-unknown`), and the one request sent to
 * find that out, `GetFirmwareInfo` unarmed, is in `SAFE_BEFORE_IDENTITY`.
 */
export async function planForDevice(
  ctx: WorkflowContext,
  operation: PlannedOperation,
): Promise<DevicePlan> {
  const firmware = await readRunningFirmware(ctx.device);
  const gate = identityGate(firmware);
  if (!gate.permitsArming) {
    throw identityRefusal(gate, firmware.version, operation, ctx.profile.id);
  }
  return { firmware, plan: ctx.profile.windowPlan(gate.version) };
}

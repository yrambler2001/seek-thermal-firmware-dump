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
import type { WindowPlan } from '../profiles/types.js';
import {
  predatesDumpProtocol,
  predatesDumpProtocolReason,
  readRunningFirmware,
  type RunningFirmware,
} from './capability.js';
import type { WorkflowContext } from './types.js';

export interface DevicePlan {
  readonly firmware: RunningFirmware;
  readonly plan: WindowPlan;
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
 * A version that does not come back is not a refusal: the profile then plans
 * with only the rows every build it knows agrees on, and the plan says so.
 */
export async function planForDevice(
  ctx: WorkflowContext,
  operation: 'dump' | 'sweep',
): Promise<DevicePlan> {
  const firmware = await readRunningFirmware(ctx.device);
  if (predatesDumpProtocol(firmware.version)) {
    const version = String(firmware.version);
    throw new SeekError(
      'profile/unsupported',
      `refusing to ${operation}: ${predatesDumpProtocolReason(version)}`,
      { detail: { firmwareVersion: version, capability: operation, profile: ctx.profile.id } },
    );
  }
  return { firmware, plan: ctx.profile.windowPlan(firmware.version) };
}

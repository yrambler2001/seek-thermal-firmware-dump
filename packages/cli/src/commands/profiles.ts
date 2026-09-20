/**
 * `seek-fw profiles` — the firmware families this build knows.
 *
 * Reads the registry rather than a hard-coded list, so a profile added to core
 * shows up here with no change to the CLI.
 */

import { hexUp, listProfiles, type CapabilityName, type FirmwareProfile } from '@seek-fw/core';
import type { CommandContext, CommandResult } from '../cli.js';
import { table } from './shared.js';

const CAPABILITIES: readonly CapabilityName[] = ['dump', 'sweep', 'decrypt', 'deviceInfo', 'flash'];

interface CapabilityInfo {
  readonly supported: boolean;
  readonly reason: string | null;
}

interface ProfileInfo {
  readonly id: string;
  readonly name: string;
  readonly summary: string;
  readonly cipher: {
    readonly whiteningK: string;
    readonly acceptanceSum: string;
    readonly clearWords: readonly number[];
  };
  readonly capabilities: Readonly<Record<string, CapabilityInfo>>;
  readonly sweepRange: readonly number[];
  readonly windows: number;
}

function capabilitiesOf(profile: FirmwareProfile): Record<string, CapabilityInfo> {
  const out: Record<string, CapabilityInfo> = {};
  for (const name of CAPABILITIES) {
    const support = profile.capabilities[name];
    out[name] = support.supported
      ? { supported: true, reason: null }
      : { supported: false, reason: support.reason };
  }
  return out;
}

function describe(profile: FirmwareProfile): ProfileInfo {
  return {
    id: profile.id,
    name: profile.name,
    summary: profile.summary,
    cipher: {
      whiteningK: hexUp(profile.cipher.whiteningK),
      acceptanceSum: hexUp(profile.cipher.acceptanceSum),
      clearWords: [...profile.cipher.clearWords],
    },
    capabilities: capabilitiesOf(profile),
    sweepRange: [...profile.sweepRange],
    windows: profile.windowMap().length,
  };
}

export function profilesCommand(ctx: CommandContext): Promise<CommandResult> {
  const profiles = listProfiles().map(describe);

  if (ctx.human) {
    ctx.out(
      table(
        profiles.map((profile) => [
          profile.id,
          profile.name,
          ...CAPABILITIES.map((name) =>
            profile.capabilities[name]?.supported === true ? 'yes' : 'no',
          ),
          profile.cipher.whiteningK,
          profile.cipher.acceptanceSum,
        ]),
        ['id', 'name', ...CAPABILITIES, 'K', 'sum'],
      ),
    );
    ctx.out('');
    for (const profile of profiles) {
      ctx.out(`${profile.id}: ${profile.summary}`);
      for (const name of CAPABILITIES) {
        const capability = profile.capabilities[name];
        if (capability !== undefined && !capability.supported && capability.reason !== null) {
          ctx.out(`  ${name} refused: ${capability.reason}`);
        }
      }
      ctx.out('');
    }
  }

  return Promise.resolve({ profiles });
}

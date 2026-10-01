/**
 * `seek-fw info` — what is this camera running?
 *
 * All of core's `readDeviceInfo` and none of its own analysis: this file only
 * decides what a terminal shows and what `--json` serialises. The one piece of
 * policy is the re-read: when detection confidently names a family whose
 * CIPHER differs from the one the read acted under, the analysis is redone
 * under it, because "does this slot pass acceptance?" is answered differently
 * by each cipher and reporting the wrong answer is worse than a second read.
 */

import {
  bytesToHex,
  hex,
  hexUp,
  readDeviceInfo,
  type DeviceState,
  type FirmwareProfile,
  type SlotState,
} from '@seek-fw/core';
import type { CommandContext, CommandResult } from '../cli.js';
import {
  betterProfile,
  chooseProfileByProbe,
  cipherDiffers,
  dumpOptionsFrom,
  heading,
  openSession,
  table,
  workflowContext,
  yesNo,
  type Session,
} from './shared.js';

function slotJson(slot: SlotState): Record<string, unknown> {
  return {
    key: slot.key,
    name: slot.name,
    address: hexUp(slot.address),
    /* null when the firmware's plan has no window for this slot: nothing armed it */
    subcmd: slot.subcmd === null ? null : hex(slot.subcmd),
    present: slot.present,
    reason: slot.reason,
    version: slot.plainHeader?.versionStr ?? slot.header?.versionStr ?? null,
    imageId: slot.header === null ? null : hexUp(slot.header.imageId),
    length: slot.header?.length ?? null,
    model: slot.footer?.model ?? null,
    key_name: slot.keyName,
    accepts: slot.accepts,
    footerOk: slot.footerOk,
    bootable: slot.bootable,
    sha256: slot.sha256,
  };
}

/** The whole analysis as JSON. No Uint8Arrays, no Maps — this must stringify. */
export function stateJson(state: DeviceState): Record<string, unknown> {
  return {
    readAt: state.readAt,
    device: {
      product: state.description.productName,
      manufacturer: state.description.manufacturerName,
      serial: state.description.serialNumber,
      vendorId: hex(state.description.vendorId, 4),
      productId: hex(state.description.productId, 4),
    },
    profile: {
      actedUnder: { id: state.profile.id, name: state.profile.name },
      detected: {
        id: state.detection.best.profile.id,
        name: state.detection.best.profile.name,
        score: state.detection.best.score,
        ambiguous: state.detection.ambiguous,
        reasons: [...state.detection.best.reasons],
      },
    },
    firmware: {
      version: state.version,
      build: state.buildString,
      bootloaderVersion: state.bootloaderVersion,
      bootloader: state.bootloaderString,
      platform: state.platform,
      usbSpeed: state.usbSpeed,
      serial: state.serial,
    },
    boot: {
      cfg0: state.cfg0 === null ? null : hexUp(state.cfg0),
      cfg0Meaning: state.cfg0 === null ? null : state.profile.boot.describeCfg0(state.cfg0),
      cfgSlots: state.cfgSlots === null ? null : state.cfgSlots.map((word) => hexUp(word)),
      activeSlotWord: state.activeSlotWord === null ? null : hexUp(state.activeSlotWord),
      booted: state.boot?.booted ?? null,
      upgradeTarget: state.boot?.target ?? null,
      targetConfirmed: state.targetConfirmed,
    },
    keys: {
      keyA: state.keyTable === null ? null : bytesToHex(state.keyTable.keyA),
      keyB: state.keyTable === null ? null : bytesToHex(state.keyTable.keyB),
      tableOffset: state.keyTable === null ? null : hexUp(state.keyTable.offset),
      confirmedAgainstSlot:
        state.keyTable === null ? null : state.keyTable.matchA || state.keyTable.matchB,
      candidates: state.keyTableCandidates,
      whiteningK: hexUp(state.keyWhiteningK),
      storeKey: { name: state.storeKey.name, programmed: state.storeKey.programmed },
      perDeviceKey: state.deviceKeySlot === null ? null : bytesToHex(state.deviceKeySlot),
    },
    slots: state.slots.map(slotJson),
    familyOk: state.familyOk,
    plainChain: state.plainChain,
    canFlash: state.canFlash,
    flashBlockedBy: [...state.flashBlockedBy],
  };
}

function pairs(ctx: CommandContext, rows: readonly (readonly [string, string])[]): void {
  ctx.out(table(rows.map((row) => [`  ${row[0]}`, row[1]])));
}

/** The human report. Also used by `flash`, which shows it before it asks. */
export function renderState(ctx: CommandContext, state: DeviceState): void {
  ctx.out('');
  ctx.out(heading('Camera', ctx.color));
  pairs(ctx, [
    ['product', state.description.productName ?? '(no product string)'],
    ['manufacturer', state.description.manufacturerName ?? '(none)'],
    ['serial', state.serial ?? state.description.serialNumber ?? '(unreadable)'],
    ['platform', state.platform ?? '(unreadable)'],
    ['usb link', state.usbSpeed ?? '(unreadable)'],
  ]);

  ctx.out('');
  ctx.out(heading('Firmware', ctx.color));
  pairs(ctx, [
    [
      'running',
      state.version === null
        ? '(unreadable)'
        : `${state.version}${state.buildString === null ? '' : `  ${state.buildString}`}`,
    ],
    [
      'bootloader',
      state.bootloaderVersion === null
        ? '(unreadable)'
        : `${state.bootloaderVersion}${
            state.bootloaderString === null ? '' : `  ${state.bootloaderString}`
          }`,
    ],
  ]);

  ctx.out('');
  ctx.out(heading('Profile', ctx.color));
  pairs(ctx, [
    ['read under', `${state.profile.id} — ${state.profile.name}`],
    [
      'detected',
      `${state.detection.best.profile.id} (score ${state.detection.best.score.toFixed(2)}` +
        `${state.detection.ambiguous ? ', ambiguous' : ''})`,
    ],
  ]);
  for (const reason of state.detection.best.reasons) ctx.out(`    · ${reason}`);

  ctx.out('');
  ctx.out(heading('Boot', ctx.color));
  pairs(ctx, [
    [
      'cfg[0]',
      state.cfg0 === null
        ? '(unreadable)'
        : `${hexUp(state.cfg0)} — ${state.profile.boot.describeCfg0(state.cfg0)}`,
    ],
    ['booted', state.boot === null ? '(not replayed)' : slotName(state, state.boot.booted)],
    [
      'upgrade target',
      state.boot === null
        ? '(not replayed)'
        : `${slotName(state, state.boot.target)}${
            state.targetConfirmed === null ? '' : ' (confirmed on the wire)'
          }`,
    ],
  ]);

  ctx.out('');
  ctx.out(heading('Keys', ctx.color));
  pairs(ctx, [
    ['key A', state.keyTable === null ? '(not identified)' : bytesToHex(state.keyTable.keyA)],
    ['key B', state.keyTable === null ? '(not identified)' : bytesToHex(state.keyTable.keyB)],
    [
      'table at',
      state.keyTable === null
        ? `${String(state.keyTableCandidates)} candidate(s), none confirmed`
        : `${hexUp(state.keyTable.offset)} in the bootloader block, confirmed against a slot`,
    ],
    ['whitening K', hexUp(state.keyWhiteningK)],
    [
      'store key',
      `${state.storeKey.name}${state.storeKey.programmed ? '' : ' (no per-device key programmed)'}`,
    ],
  ]);

  ctx.out('');
  ctx.out(heading('Slots', ctx.color));
  ctx.out(
    table(
      state.slots.map((slot) => [
        slot.name,
        hexUp(slot.address),
        slot.present ? (slot.plainHeader?.versionStr ?? slot.header?.versionStr ?? '?') : '—',
        slot.header === null ? '—' : `${String(slot.header.length)} B`,
        slot.keyName ?? '—',
        slot.present ? yesNo(slot.accepts) : '—',
        slot.present ? yesNo(slot.footerOk) : '—',
        slot.present ? yesNo(slot.bootable) : '—',
        slot.sha256 === null ? '—' : slot.sha256.slice(0, 16),
      ]),
      ['slot', 'address', 'version', 'size', 'key', 'accepts', 'footer', 'bootable', 'sha256'],
    ),
  );
  for (const slot of state.slots) {
    if (slot.reason !== null) ctx.out(`  ${slot.name}: ${slot.reason}`);
  }

  ctx.out('');
  ctx.out(heading('Flashing', ctx.color));
  if (state.canFlash) {
    ctx.out('  available — `seek-fw flash <image>` can write this camera');
  } else {
    ctx.out('  not available:');
    for (const reason of state.flashBlockedBy) ctx.out(`    · ${reason}`);
  }
  ctx.out('');
}

function slotName(state: DeviceState, key: string): string {
  return state.slots.find((slot) => slot.key === key)?.name ?? key;
}

/**
 * Reads the device analysis, re-reading under a confidently detected profile
 * when that would change what the numbers mean.
 */
export interface AnalyseOptions {
  /**
   * Re-read whenever detection names a different family, not only when its
   * cipher differs. `flash` needs this: the capability gate is a property of
   * the profile's identity, so acting under `generic` on a camera the evidence
   * says is `modern-4x` would refuse a write that is in fact supported.
   */
  readonly rereadOnAnyBetter?: boolean;
}

export async function analyseCamera(
  ctx: CommandContext,
  session: Session,
  analyseOptions: AnalyseOptions = {},
): Promise<{ readonly state: DeviceState; readonly profile: FirmwareProfile }> {
  /* ASKED, NOT GUESSED — and here the guess had a cost beyond a label. This
   * read arms the boot-config bank, which on the locked 2014-2017 line is
   * subcommand 3 behind the authenticated channel; picking `generic` off a USB
   * product string meant arming it with the modern map's plain selector and
   * reporting "no boot config" for a camera that would have answered. */
  const choice = await chooseProfileByProbe(ctx, session);
  ctx.reporter.log(
    `acting under profile ${choice.profile.id}${choice.forced ? ' (--profile)' : ''}`,
    'detail',
  );

  const options = dumpOptionsFrom(ctx.options);
  let state = await readDeviceInfo(
    workflowContext(session, choice.profile, choice.detection, ctx),
    options,
  );

  const better = betterProfile(state.profile, state.detection, choice.forced);
  const mustReread =
    better !== null &&
    (analyseOptions.rereadOnAnyBetter === true || cipherDiffers(state.profile, better));
  if (better !== null && mustReread) {
    ctx.reporter.log(
      `the evidence identifies this camera as ${better.id} (${better.name})` +
        (cipherDiffers(state.profile, better)
          ? ', whose cipher differs from the one this read used'
          : '') +
        ' — re-reading under it',
      'warn',
    );
    state = await readDeviceInfo(workflowContext(session, better, state.detection, ctx), options);
  } else if (better !== null) {
    ctx.reporter.log(
      `detection says ${better.id}; the analysis is unchanged because it shares this ` +
        `profile's cipher. Pass --profile ${better.id} to act under it.`,
      'detail',
    );
  }
  return { state, profile: state.profile };
}

export async function infoCommand(ctx: CommandContext): Promise<CommandResult> {
  const session = await openSession(ctx);
  try {
    const { state } = await analyseCamera(ctx, session);
    if (ctx.human) renderState(ctx, state);
    return stateJson(state);
  } finally {
    await session.close();
  }
}

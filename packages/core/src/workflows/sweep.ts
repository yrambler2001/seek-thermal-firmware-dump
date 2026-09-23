/* ==================================================================== *
 * Selector sweep: probe every BeginFirmwareUpgrade subcommand in the
 * profile's `sweepRange` and record which ones arm and what they expose.
 *
 * This is the tool for a camera whose map is not known — including the
 * `generic` fallback, which is exactly the case where a hand-written map cannot
 * be trusted. Selectors the firmware does not map simply stall, and a stall is
 * recorded rather than treated as an error.
 *
 * Read-only, like the dump: BeginFirmwareUpgrade selects a volatile read window
 * and GetFeaturedFirmwareData does the reads. Nothing here can write.
 * ==================================================================== */

import { hex, utf8 } from '../bytes.js';
import { CancelledError, errorMessage } from '../errors.js';
import type { Artifact } from '../events.js';
import {
  buildDecryptionFailed,
  buildDecryptionNotAttempted,
  buildSelectorRecord,
  buildSweepManifest,
  manifestToJson,
  type DecryptionSummary,
  type SelectorRecord,
} from '../archive/manifest.js';
import { makeSweepReadme } from '../archive/readme.js';
import { u16Payload } from '../protocol/client.js';
import { OP, WINDOW_SIZE } from '../protocol/ops.js';
import { placeableAddresses } from '../profiles/plan.js';
import { requireCapability } from '../profiles/registry.js';
import { decryptDump } from './decrypt.js';
import { planForDevice } from './window-plan.js';
import {
  deviceInfoOf,
  isCancelled,
  profileInfoOf,
  resolveDumpOptions,
  transportInfoOf,
  unlockTokenOf,
  usesAuthChannel,
  warnIfRecipientFellBack,
  type DumpOptions,
  type SweepResult,
  type WorkflowContext,
} from './types.js';

const SAFETY: readonly string[] = [
  'No flash-write/flash-modify RPCs were called.',
  'BeginFirmwareUpgrade was used only as a volatile read-window selector.',
  'GetFeaturedFirmwareData was used for control-IN reads.',
];

/**
 * The 18-byte authenticated selector payload for one subcommand, built from the
 * token the profile's own map carries. Derived from the map rather than
 * imported from a family module, so the sweep stays profile-agnostic.
 */
function authPayloadFrom(token: Uint8Array, subcmd: number): Uint8Array {
  const bytes = new Uint8Array(2 + token.length);
  new DataView(bytes.buffer).setUint16(0, subcmd & 0xffff, true);
  bytes.set(token, 2);
  return bytes;
}

/** `blocks/subcmd_0a[_14080000].bin`, as the original named them. */
function blockFileName(subcmd: number, address: number | null): string {
  const suffix = address === null ? '' : `_${address.toString(16)}`;
  return `blocks/subcmd_${subcmd.toString(16).padStart(2, '0')}${suffix}.bin`;
}

/**
 * Probe every selector the profile's `sweepRange` covers, assemble whatever
 * came back at a known address into a flash image, and report the full table.
 *
 * Like the dump, cancellation throws: the blocks already read have been handed
 * to `reporter.artifact()` as they completed, but no manifest is emitted for a
 * sweep that did not finish.
 */
export async function runSweep(
  ctx: WorkflowContext,
  options: Partial<DumpOptions> = {},
): Promise<SweepResult> {
  requireCapability(ctx.profile, 'sweep');
  const args = resolveDumpOptions(options);
  const { device, profile, reporter } = ctx;
  const { flashBase, flashSize, windowSize } = profile.memory;

  /* WHERE A SELECTOR'S BYTES GO IS THIS BUILD'S ANSWER, NOT THE PROFILE'S.
   * The sweep places each block at the address the running firmware's own
   * table gives its subcommand, and leaves a subcommand whose address that
   * table does not carry as a constant unplaced. With one map per profile, a
   * 2014 Compact's subcommand 0x0E — which serves 0x140B0000 — was placed at
   * 0x140C0000. The same version gate as the dump runs first: on 0.3.0.1 every
   * arm of a sweep would be `EnterBootloaderMode`. */
  const { plan } = await planForDevice(ctx, 'sweep');
  const entries = plan.windows;
  /* Recorded while the transport is open: the sweep closes it before the
   * manifest is built (see `runDump`). */
  const transport = transportInfoOf(device.transport.info);
  warnIfRecipientFellBack(ctx);
  const legacy = usesAuthChannel(entries);
  const unlockToken = unlockTokenOf(entries);
  const addressBySubcmd = placeableAddresses(plan);
  const [first, last] = profile.sweepRange;
  const span = last - first + 1;

  const startedAt = new Date().toISOString();
  const combined = new Uint8Array(flashSize).fill(args.gapFill);
  const artifacts: Artifact[] = [];
  const selectors: SelectorRecord[] = [];
  const combinedFile = `flash_4m_selectorsweep_gap_${args.gapFill
    .toString(16)
    .padStart(2, '0')}.bin`;

  let armedCount = 0;
  let withData = 0;
  let placed = 0;

  reporter.log(
    `selector sweep: subcommands ${hex(first)}..${hex(last)}` +
      (legacy ? ' with the authenticated channel-0x12 unlock token' : ' on the plain channel'),
    'detail',
  );
  reporter.log('stalls are expected for selectors the firmware does not map', 'detail');
  reporter.log('');

  let cancelled = false;

  try {
    try {
      await device.ensureMode0();
    } catch (error) {
      /* The sweep is a probe: report it and carry on, since a selector that
       * needs mode 0 will simply stall like any unmapped one. */
      if (error instanceof CancelledError) throw error;
      reporter.log(`could not confirm operation mode 0: ${errorMessage(error)}`, 'warn');
    }

    for (let subcmd = first; subcmd <= last; subcmd++) {
      /* Cancel stops the probe and keeps every selector already recorded, as
       * the original did. The manifest says `cancelled`, so a short sweep is
       * never mistaken for "these selectors do not exist". */
      if (isCancelled(ctx)) {
        cancelled = true;
        break;
      }
      reporter.progress(subcmd - first, span, `probe selector ${hex(subcmd)} ...`, 'items');

      const payload =
        legacy && unlockToken !== null ? authPayloadFrom(unlockToken, subcmd) : u16Payload(subcmd);
      const address = addressBySubcmd.get(subcmd) ?? null;

      let begin: 'ok' | 'stall' = 'ok';
      let errorCode: number | null = null;
      try {
        await device.rpcOut(OP.BEGIN_FIRMWARE_UPGRADE, payload);
      } catch (error) {
        if (error instanceof CancelledError) {
          cancelled = true;
          break;
        }
        begin = 'stall';
      }
      if (begin === 'ok') {
        try {
          errorCode = await device.getErrorCode();
        } catch (error) {
          if (error instanceof CancelledError) {
            cancelled = true;
            break;
          }
          errorCode = null;
        }
      }

      /* Original: `armed = begin === "ok" && !errCode` — an error code of 0 is
       * falsy and therefore counts as "no error", same as the legacy page. */
      const armed = begin === 'ok' && !errorCode;
      let data: Uint8Array | null = null;
      let readError: string | undefined;
      let file: string | null = null;

      if (armed) {
        armedCount++;
        const read = await device.readArmed(args.chunk, WINDOW_SIZE);
        data = read.data;
        if (read.stopReason !== null) readError = read.stopReason;
        if (read.data.length > 0) {
          withData++;
          const block = read.data.slice();
          file = blockFileName(subcmd, address);
          const artifact: Artifact = { name: file, data: block };
          artifacts.push(artifact);
          reporter.artifact(artifact);
          if (address !== null && address >= flashBase && address < flashBase + flashSize) {
            combined.set(
              block.subarray(0, Math.min(block.length, windowSize)),
              address - flashBase,
            );
            placed++;
          }
          reporter.log(
            `selector ${hex(subcmd)} -> ${address === null ? 'unmapped' : hex(address, 8)} ... ` +
              `${String(block.length)} B`,
            block.length === WINDOW_SIZE ? 'ok' : 'warn',
          );
        }
      }

      selectors.push(
        buildSelectorRecord({
          subcmd,
          mappedAddress: address,
          armed,
          begin,
          errorCode,
          data,
          file,
          ...(readError !== undefined ? { readError } : {}),
        }),
      );
      reporter.progress(subcmd - first + 1, span, undefined, 'items');
    }
  } finally {
    await device.transport.close();
  }

  reporter.log('');
  reporter.log(
    `selectors armed: ${String(armedCount)}/${String(span)}, returned data: ${String(withData)}, ` +
      `placed in the ${String(flashSize / (1024 * 1024))} MiB image: ${String(placed)}`,
    armedCount > 0 ? 'ok' : 'warn',
  );

  if (cancelled) reporter.log('cancelled — saving what was read', 'warn');

  /* Decryption is a bonus stage: it must never cost the user their sweep. */
  let decryption: DecryptionSummary;
  if (args.decrypt && placed > 0) {
    try {
      const stem = combinedFile.replace(/\.bin$/, '');
      const result = await decryptDump(
        combined,
        stem,
        { profile, dumpPath: combinedFile, ...(ctx.signal ? { signal: ctx.signal } : {}) },
        reporter,
      );
      for (const artifact of result.artifacts) artifacts.push(artifact);
      decryption = result.summary;
    } catch (error) {
      const message = errorMessage(error);
      reporter.log(`decrypt: failed (${message}) — the sweep itself is unaffected`, 'error');
      decryption = buildDecryptionFailed(message);
    }
  } else {
    decryption = buildDecryptionNotAttempted(
      args.decrypt ? 'no mapped windows were placed in the image' : 'disabled in options',
    );
  }

  const manifest = buildSweepManifest({
    startedAt,
    finishedAt: new Date().toISOString(),
    legacy,
    vendorId: device.transport.description.vendorId,
    productId: device.transport.description.productId,
    device: deviceInfoOf(device.transport.description),
    flashBase,
    flashSize,
    windowSize,
    chunk: args.chunk,
    gapFill: args.gapFill,
    unlockToken,
    producer: `seek-thermal-firmware-dump (${device.transport.info.api}, selector sweep)`,
    transport,
    safety: SAFETY,
    selectors,
    combinedFile,
    decryption,
    selectorsArmed: armedCount,
    selectorsWithData: withData,
    placedInImage: placed,
    cancelled,
    profile: profileInfoOf(profile, ctx.detection),
  });

  for (const artifact of [
    { name: combinedFile, data: combined },
    { name: 'manifest.json', data: utf8(manifestToJson(manifest)) },
    { name: 'README.md', data: utf8(makeSweepReadme(manifest)) },
  ] satisfies Artifact[]) {
    artifacts.push(artifact);
    reporter.artifact(artifact);
  }

  reporter.progress(
    1,
    1,
    `Done — ${String(armedCount)}/${String(span)} selectors armed, ${String(withData)} with data.`,
    'items',
  );

  return {
    artifacts,
    manifest,
    combined,
    selectorsArmed: armedCount,
    selectorsWithData: withData,
    placedInImage: placed,
    cancelled: manifest.cancelled,
  };
}

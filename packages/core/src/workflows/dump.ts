/* ==================================================================== *
 * Whole-flash dump.
 *
 * This ONE function replaces the original page's `runDump` and `runOldDump`.
 * Those two differed only in three things — which selectors to arm, whether a
 * bank needs the authenticated payload, and which blocks are unreachable — and
 * all three now come off the running firmware's own table
 * (`profile.windowPlan(version)`, resolved by `planForDevice`). Keeping two
 * near-identical 130-line copies in sync was how the legacy algorithm ended up
 * with a subtly different gap list from the modern one; the unification is the
 * point. One table per PROFILE was the same mistake one level down, and it cost
 * a block: the 2014 Compacts arm 0x140B0000 on subcommand 0x0E, so a shared
 * map wrote those bytes at 0x140C0000.
 *
 * Read-only by construction: the only opcodes reachable from here are the ones
 * in `READ_ONLY_OPS` (BeginFirmwareUpgrade is used purely as a volatile window
 * selector), which `ops.ts` asserts is disjoint from `FLASH_OPS` at load.
 * ==================================================================== */

import { hex, utf8 } from '../bytes.js';
import { CancelledError, errorMessage, SeekError } from '../errors.js';
import type { Artifact } from '../events.js';
import {
  buildDecryptionNotAttempted,
  buildDecryptionFailed,
  buildDumpManifest,
  buildGapRecord,
  buildLegacyDumpManifest,
  buildWindowRecord,
  manifestToJson,
  type DecryptionSummary,
  type DumpManifest,
  type GapRecord,
  type LegacyDumpManifest,
  type WindowRecord,
} from '../archive/manifest.js';
import { makeLegacyReadme, makeReadme } from '../archive/readme.js';
import { WINDOW_SIZE } from '../protocol/ops.js';
import { requireCapability } from '../profiles/registry.js';
import type { WindowEntry } from '../profiles/types.js';
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
  type DumpResult,
  type WorkflowContext,
} from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The safety statements the original wrote into every dump manifest. */
const SAFETY_STANDARD: readonly string[] = [
  'No flash-write/flash-modify RPCs were called.',
  'BeginFirmwareUpgrade was used only as a volatile read-window selector.',
  'GetFeaturedFirmwareData was used for control-IN reads.',
];

const SAFETY_AUTH: readonly string[] = [
  'No flash-write/flash-modify RPCs were called.',
  'BeginFirmwareUpgrade was used only as a volatile read-window selector.',
  'On protected banks it carried the channel-0x12 unlock token; nothing was written.',
  'GetFeaturedFirmwareData was used for control-IN reads.',
];

/** `windows/addr_14030000_subcmd_05.bin`, as the original named them. */
function windowFileName(entry: WindowEntry): string {
  return `windows/addr_${entry.address.toString(16)}_subcmd_${entry.subcmd
    .toString(16)
    .padStart(2, '0')}.bin`;
}

interface ReadWindowsOutcome {
  readonly records: readonly WindowRecord[];
  readonly okCount: number;
  /** True when the caller cancelled partway through the selector map. */
  readonly cancelled: boolean;
}

/**
 * The shared window-read loop, ported from `readWindowsInto`.
 *
 * Two behaviours here are load-bearing and are kept exactly as they were:
 *
 *   - A SHORT read is kept. 65280 good bytes are worth having, so the window is
 *     not retried (that would only lose them) and the missing tail is recorded
 *     as a `shortfallFilled` range naming the fill byte and the reason the read
 *     stopped. The gap-fill must never quietly stand in for real flash.
 *   - A window that threw every attempt records an `error` instead, and the
 *     gap-filled bytes stay gap-filled. A reader of the manifest can always
 *     tell which bytes came off the camera.
 *
 * Between attempts the device is closed and reopened: on a camera that has
 * wedged its control endpoint, that is the only thing that clears it.
 */
async function readWindowsInto(
  ctx: WorkflowContext,
  options: DumpOptions,
  entries: readonly WindowEntry[],
  combined: Uint8Array,
  artifacts: Artifact[],
  flashBase: number,
): Promise<ReadWindowsOutcome> {
  const { device, reporter } = ctx;
  const totalBytes = entries.length * WINDOW_SIZE;
  const records: WindowRecord[] = [];
  let bytesDone = 0;

  let cancelled = false;

  try {
    for (const entry of entries) {
      if (isCancelled(ctx)) {
        cancelled = true;
        break;
      }

      const offset = entry.address - flashBase;
      const name = windowFileName(entry);
      const label = `read ${hex(entry.address, 8)} subcmd=${hex(entry.subcmd)}${
        entry.auth === true ? ' (auth)' : ''
      }`;

      reporter.progress(bytesDone, totalBytes, `${label} ...`);

      let lastError: unknown = null;
      let raw: Awaited<ReturnType<typeof device.readWindow>> | null = null;
      const startBytes = bytesDone;

      for (let attempt = 0; attempt <= options.retries; attempt++) {
        try {
          bytesDone = startBytes;
          raw = await device.readWindow(entry, options.chunk, (n) => {
            bytesDone += n;
            reporter.progress(bytesDone, totalBytes);
          });
          lastError = null;
          if (attempt)
            reporter.log(`${label}: recovered on attempt ${String(attempt + 1)}`, 'warn');
          break;
        } catch (error) {
          /* A cancel is the caller's decision, not a device fault: never burn
           * retries on it and never let it be recorded as a read failure. */
          if (error instanceof CancelledError) {
            cancelled = true;
            break;
          }
          lastError = error;
          if (attempt < options.retries) {
            reporter.log(
              `${label}: attempt ${String(attempt + 1)} failed (${errorMessage(error)}); reopening ...`,
              'warn',
            );
            await device.transport.close();
            await sleep(options.retryDelayMs);
            await device.transport.open();
          }
        }
      }

      if (cancelled && raw === null) break;

      if (raw !== null && raw.data.length > 0) {
        const copy = raw.data.slice();
        const artifact: Artifact = { name, data: copy };
        artifacts.push(artifact);
        reporter.artifact(artifact);
        combined.set(copy, offset);
        bytesDone = startBytes + copy.length;

        records.push(
          buildWindowRecord({
            ok: true,
            address: entry.address,
            offset,
            subcmd: entry.subcmd,
            note: entry.note,
            auth: entry.auth === true,
            requested: WINDOW_SIZE,
            data: copy,
            gapFill: options.gapFill,
            file: name,
            ...(raw.stopReason !== null ? { stopReason: raw.stopReason } : {}),
          }),
        );

        if (copy.length === WINDOW_SIZE) {
          reporter.log(`${label} ... ${String(copy.length)} B`, 'ok');
        } else {
          /* Keep the bytes and say exactly which ones are missing, rather than
           * letting the gap-fill quietly stand in for real flash contents. */
          reporter.log(
            `${label} ... ${String(copy.length)} B — kept, short by ` +
              `${String(WINDOW_SIZE - copy.length)} B (${hex(entry.address + copy.length, 8)}..` +
              `${hex(entry.address + WINDOW_SIZE - 1, 8)} filled with ${hex(options.gapFill, 2)})`,
            'warn',
          );
          if (raw.stopReason !== null) reporter.log(`    ${raw.stopReason}`, 'detail');
        }
      } else {
        const message = lastError === null ? 'no data read' : errorMessage(lastError);
        bytesDone = startBytes;
        records.push(
          buildWindowRecord({
            ok: false,
            address: entry.address,
            offset,
            subcmd: entry.subcmd,
            note: entry.note,
            auth: entry.auth === true,
            requested: WINDOW_SIZE,
            error: message,
          }),
        );
        reporter.log(`${label} ... failed: ${message}`, 'error');
      }
      reporter.progress(bytesDone, totalBytes);
    }
  } finally {
    /* The original released the interface here so a standalone dump leaves the
     * camera to the OS. The flash path reopens before it writes. After this
     * the transport reports `claimedInterface: false`, which is why `runDump`
     * takes the manifest's transport record BEFORE the read, not after it. */
    await device.transport.close();
  }

  return { records, okCount: records.filter((record) => record.ok).length, cancelled };
}

/**
 * Read every window the profile's selector map exposes, assemble a flash image
 * with the unreachable blocks gap-filled, and (optionally) decrypt whatever
 * firmware slots the result contains.
 *
 * Cancellation STOPS the sweep and returns what was read, exactly as the
 * original page did: a dump takes minutes, and a user who cancels one still
 * wants the windows already off the camera. The result carries
 * `cancelled: true`, the manifest records it, and every window that did not run
 * is left gap-filled and reported as such — so a partial image can never be
 * mistaken for a complete one. The decrypt stage is skipped, because the image
 * is incomplete and stopping was the point.
 */
export async function runDump(
  ctx: WorkflowContext,
  options: Partial<DumpOptions> = {},
): Promise<DumpResult> {
  requireCapability(ctx.profile, 'dump');
  const args = resolveDumpOptions(options);
  const { profile, reporter, device } = ctx;
  const { flashBase, flashSize, windowSize } = profile.memory;

  if (windowSize !== WINDOW_SIZE) {
    /* `SeekDevice.readWindow` requests exactly one protocol window per arm. A
     * profile with different geometry needs its own read loop, not a silently
     * mis-sized one. */
    throw new SeekError(
      'device/window',
      `${profile.name} declares ${hex(windowSize)} windows, but the protocol client reads ` +
        `${hex(WINDOW_SIZE)} per selector`,
      { detail: { profileWindowSize: windowSize, protocolWindowSize: WINDOW_SIZE } },
    );
  }

  const startedAt = new Date().toISOString();
  /* The build first, then its own table. One read-only transfer, and a refusal
   * for a build with no read handler before anything is armed. */
  const { firmware, plan } = await planForDevice(ctx, 'dump');
  const entries = plan.windows;
  /* THE TRANSPORT THE WINDOWS ARE READ OVER, recorded while it is open. The
   * manifest used to take it after `readWindowsInto` had closed the transport,
   * so it said `claimedInterface: false` on every dump. The recipient cannot
   * change after this point — `WebUsbTransport` decides it once and a reopen
   * that cannot re-claim fails the dump — so one snapshot describes every
   * window. */
  const transport = transportInfoOf(device.transport.info);
  warnIfRecipientFellBack(ctx);
  const legacy = usesAuthChannel(entries);
  const unlockToken = unlockTokenOf(entries);

  const combined = new Uint8Array(flashSize).fill(args.gapFill);
  const artifacts: Artifact[] = [];

  const combinedFile =
    `flash_4m_usb${legacy ? '_legacy' : ''}_partial_gap_` +
    `${args.gapFill.toString(16).padStart(2, '0')}.bin`;

  /* Every block this firmware's table does not reach becomes a gap, with the
   * table's own reason. This is the one list: the modern table contributes
   * 0x14060000; the legacy ones the upper 2 MiB, plus the bootloader block where
   * the build refuses it and 0x140C0000 where the build has no selector for it.
   * The plan builder checks that windows and gaps tile the part exactly, so no
   * block can be both read and declared a gap, or neither. */
  const gaps: GapRecord[] = plan.unreachable.map((range) =>
    buildGapRecord({
      address: range.address,
      flashBase,
      length: range.length,
      fill: args.gapFill,
      reason: range.reason,
    }),
  );

  reporter.log(describeDevice(ctx), 'detail');
  reporter.log(firmware.note, 'detail');
  reporter.log(`selector table: ${plan.table}`, 'detail');
  reporter.log(
    `selector map: ${String(entries.length)} windows, ` +
      `${String((entries.length * WINDOW_SIZE) / 1024)} KiB expected` +
      (legacy ? ' (authenticated channel on the protected banks)' : ''),
    'detail',
  );
  reporter.log(
    `transport: vendor control, recipient=${transport.recipient}` +
      `${transport.claimedInterface ? ' (interface claimed)' : ''}, ` +
      `chunk=${String(args.chunk)} B, retries=${String(args.retries)}`,
    'detail',
  );
  reporter.log('');

  const { records, okCount, cancelled } = await readWindowsInto(
    ctx,
    args,
    entries,
    combined,
    artifacts,
    flashBase,
  );

  reporter.log('');
  reporter.log(
    `USB-readable windows: ${String(okCount)}/${String(entries.length)}`,
    okCount === entries.length ? 'ok' : 'warn',
  );
  if (cancelled) reporter.log('cancelled — saving what was read', 'warn');
  for (const gap of gaps) {
    reporter.log(
      `gap filled: ${gap.address} + ${String(gap.length)} B with ${gap.fill} — ${gap.reason}`,
      'detail',
    );
  }

  /* Decryption is a bonus stage: it must never cost the user their dump. Any
   * failure is logged and recorded in the manifest, and the flash image is
   * emitted regardless. */
  let decryption: DecryptionSummary;
  if (args.decrypt && cancelled) {
    decryption = buildDecryptionNotAttempted('the dump was cancelled');
  } else if (args.decrypt && okCount > 0) {
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
      reporter.log(`decrypt: failed (${message}) — the flash dump itself is unaffected`, 'error');
      decryption = buildDecryptionFailed(message);
    }
  } else if (!args.decrypt) {
    decryption = buildDecryptionNotAttempted('disabled in options');
  } else {
    decryption = buildDecryptionNotAttempted('no windows were read');
  }

  const manifestInput = {
    startedAt,
    finishedAt: new Date().toISOString(),
    vendorId: device.transport.description.vendorId,
    productId: device.transport.description.productId,
    device: deviceInfoOf(device.transport.description),
    flashBase,
    flashSize,
    windowSize,
    chunk: args.chunk,
    gapFill: args.gapFill,
    producer: `seek-thermal-firmware-dump (${device.transport.info.api}, ${profile.id})`,
    transport,
    safety: legacy ? SAFETY_AUTH : SAFETY_STANDARD,
    windows: records,
    gaps,
    combinedFile,
    decryption,
    usbReadableWindows: okCount,
    expectedReadableWindows: entries.length,
    cancelled,
    profile: profileInfoOf(profile, ctx.detection),
    selectorTable: { firmwareVersion: plan.firmwareVersion, table: plan.table },
  };

  let manifest: DumpManifest | LegacyDumpManifest;
  let readme: string;
  if (legacy) {
    const legacyManifest = buildLegacyDumpManifest({
      ...manifestInput,
      unlockToken: unlockToken ?? new Uint8Array(0),
      authChannelBanks: entries.filter((e) => e.auth === true).map((e) => e.address),
    });
    manifest = legacyManifest;
    readme = makeLegacyReadme(legacyManifest);
  } else {
    const dumpManifest = buildDumpManifest(manifestInput);
    manifest = dumpManifest;
    readme = makeReadme(dumpManifest);
  }

  pushArtifact(ctx, artifacts, { name: combinedFile, data: combined });
  pushArtifact(ctx, artifacts, { name: 'manifest.json', data: utf8(manifestToJson(manifest)) });
  pushArtifact(ctx, artifacts, { name: 'README.md', data: utf8(readme) });

  reporter.progress(1, 1, `Done — ${String(okCount)}/${String(entries.length)} windows read.`);

  return {
    artifacts,
    manifest,
    combined,
    windowsRead: okCount,
    windowsExpected: entries.length,
    cancelled,
  };
}

function pushArtifact(ctx: WorkflowContext, artifacts: Artifact[], artifact: Artifact): void {
  artifacts.push(artifact);
  ctx.reporter.artifact(artifact);
}

/** Original `describeDevice`: one line naming the camera and its ids. */
export function describeDevice(ctx: WorkflowContext): string {
  const d = ctx.device.transport.description;
  const parts = [
    `${d.productName ?? 'unknown product'} — ${d.manufacturerName ?? 'unknown vendor'}`,
    `VID ${hex(d.vendorId, 4)} PID ${hex(d.productId, 4)}`,
  ];
  if (d.serialNumber !== null) parts.push(`serial ${d.serialNumber}`);
  return parts.join(' · ');
}

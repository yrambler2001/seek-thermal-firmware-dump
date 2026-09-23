/**
 * The pieces every command shares: opening a camera, picking a profile,
 * turning global flags into core's `DumpOptions`, writing the artifacts out,
 * and laying out a table.
 */

import {
  SeekDevice,
  detectProfile,
  getProfile,
  hex,
  identifyCamera,
  type Artifact,
  type DetectionResult,
  type DeviceEvidence,
  type DumpOptions,
  type FirmwareProfile,
  type UsbBackend,
  type UsbTransport,
  type WorkflowContext,
} from '@seek-fw/core';
import { NodeUsbBackend, openCamera, type BackendOptions } from '../backend.js';
import type { CommandContext, GlobalOptions } from '../cli.js';
import { defaultOutputDirectory, writeOutputs, type WrittenOutput } from '../output.js';
import { paint } from '../ansi.js';

/** Only the knobs the user actually set; core fills in the rest. */
export function dumpOptionsFrom(options: GlobalOptions): Partial<DumpOptions> {
  return {
    ...(options.chunk === null ? {} : { chunk: options.chunk }),
    ...(options.gapFill === null ? {} : { gapFill: options.gapFill }),
    ...(options.retries === null ? {} : { retries: options.retries }),
    ...(options.retryDelayMs === null ? {} : { retryDelayMs: options.retryDelayMs }),
    /* Always forwarded: `--no-decrypt` has to be able to turn off a default
     * that is `true`, which an "only if set" spread could never express. */
    decrypt: options.decrypt,
  };
}

export interface ProfileChoice {
  readonly profile: FirmwareProfile;
  readonly detection: DetectionResult | null;
  /** True when `--profile` decided it rather than the evidence. */
  readonly forced: boolean;
}

/**
 * The profile a run acts under, before anything has been read.
 *
 * With no `--profile` this is detection on USB descriptors alone, which is
 * thin evidence and therefore usually lands on `generic` — a profile that
 * dumps and decrypts with the 4.x map and refuses to write. That is the
 * intended outcome: reads stay available, the destructive operation does not.
 */
export function chooseProfile(options: GlobalOptions, evidence: DeviceEvidence): ProfileChoice {
  if (options.profile !== null) {
    return { profile: getProfile(options.profile), detection: null, forced: true };
  }
  const detection = detectProfile(evidence);
  return { profile: detection.best.profile, detection, forced: false };
}

/**
 * The profile a run acts under, after ASKING the camera.
 *
 * `chooseProfile` above scores USB descriptors, which is the thinnest evidence
 * there is: a vendor id and a product string say nothing about which
 * BeginFirmwareUpgrade handler is behind them, so an unforced run landed on
 * `generic` almost every time and dumped with the post-2018 map whatever the
 * camera was. On a 2016 part that map refuses 38 of its 63 selectors and
 * gap-fills the six banks holding the boot config and the firmware images.
 *
 * This sends four read-only transfers first — the version, a plain arm of a
 * protected bank, an authenticated arm of the same bank, and a read of a bank
 * open on every line — and hands the answers to the same scoring. See
 * `probeSelectorChannel` for why each one is safe and what it settles; the
 * composition itself is core's `identifyCamera`, which the browser uses too.
 *
 * `--profile` still wins outright and skips the probe: a caller who has named
 * a family is not asking to be second-guessed, and on a camera the fewest
 * transfers is the safest run.
 */
export async function chooseProfileByProbe(
  ctx: CommandContext,
  session: Session,
): Promise<ProfileChoice> {
  const descriptors = evidenceFromDevice(session.transport);
  if (ctx.options.profile !== null) return chooseProfile(ctx.options, descriptors);
  if (!ctx.options.probe) {
    ctx.reporter.log('capability probe skipped (--no-probe)', 'detail');
    return chooseProfile(ctx.options, descriptors);
  }

  ctx.reporter.log('asking the camera which protocol it speaks ...', 'detail');
  const { probe, detection } = await identifyCamera(session.device);
  for (const note of probe.notes) ctx.reporter.log(`  ${note}`, 'detail');
  return { profile: detection.best.profile, detection, forced: false };
}

export function evidenceFromDevice(transport: UsbTransport): DeviceEvidence {
  const description = transport.description;
  return {
    ...(description.productName === null ? {} : { productName: description.productName }),
    vendorId: description.vendorId,
    productId: description.productId,
  };
}

/** The real backend, unless the caller injected one (tests only). */
export function backendFor(ctx: CommandContext, options: BackendOptions): UsbBackend {
  return ctx.io.backend?.(options) ?? new NodeUsbBackend(options);
}

export interface Session {
  readonly transport: UsbTransport;
  readonly device: SeekDevice;
  close(): Promise<void>;
}

/** Finds and opens one camera, with the reporter wired to the transport's warnings. */
export async function openSession(ctx: CommandContext): Promise<Session> {
  const backend = backendFor(ctx, {
    recipient: ctx.options.recipient,
    onWarning: (message) => {
      ctx.reporter.log(message, 'warn');
    },
  });
  const transport = await openCamera(backend, {
    serial: ctx.options.serial,
    platform: ctx.io.platform,
  });
  const device = new SeekDevice(transport, { reporter: ctx.reporter, signal: ctx.signal });
  return {
    transport,
    device,
    close: async (): Promise<void> => {
      await transport.close();
    },
  };
}

export function workflowContext(
  session: Session,
  profile: FirmwareProfile,
  detection: DetectionResult | null,
  ctx: CommandContext,
): WorkflowContext {
  return {
    device: session.device,
    profile,
    detection,
    reporter: ctx.reporter,
    signal: ctx.signal,
  };
}

/**
 * A confident detection that disagrees with the profile the run is acting
 * under, or null. `--profile` always wins: a user who named a family is not
 * second-guessed.
 */
export function betterProfile(
  acting: FirmwareProfile,
  detection: DetectionResult | null,
  forced: boolean,
): FirmwareProfile | null {
  if (forced || detection === null || detection.ambiguous) return null;
  const best = detection.best.profile;
  return best.id === acting.id ? null : best;
}

/** True when acting under `b` instead of `a` would change how slots decrypt. */
export function cipherDiffers(a: FirmwareProfile, b: FirmwareProfile): boolean {
  return (
    a.cipher.whiteningK !== b.cipher.whiteningK ||
    a.cipher.acceptanceSum !== b.cipher.acceptanceSum ||
    a.cipher.clearWords[0] !== b.cipher.clearWords[0] ||
    a.cipher.clearWords[1] !== b.cipher.clearWords[1]
  );
}

/** `--out`/`--zip`, or a timestamped directory when the user named neither. */
export function outputTarget(
  options: GlobalOptions,
  kind: string,
  now?: Date,
): { readonly directory: string | null; readonly zip: string | null } {
  if (options.out === null && options.zip === null) {
    return { directory: defaultOutputDirectory(kind, now ?? new Date()), zip: null };
  }
  return { directory: options.out, zip: options.zip };
}

/** Writes a run's artifacts and logs where they went. */
export async function writeRun(
  ctx: CommandContext,
  kind: string,
  artifacts: readonly Artifact[],
): Promise<WrittenOutput> {
  const target = outputTarget(ctx.options, kind, ctx.io.now?.());
  const written = await writeOutputs(target, artifacts);
  if (ctx.human) {
    if (written.directory !== null) {
      ctx.out(`wrote ${String(written.entries)} file(s) to ${written.directory}`);
    }
    if (written.zip !== null) ctx.out(`wrote ${written.zip} (${String(written.bytes)} B)`);
  }
  return written;
}

/** Artifacts as the reporter saw them, last write of a name winning. */
export function uniqueArtifacts(artifacts: readonly Artifact[]): readonly Artifact[] {
  const byName = new Map<string, Artifact>();
  for (const artifact of artifacts) byName.set(artifact.name, artifact);
  return [...byName.values()];
}

/* ---- text helpers ---------------------------------------------------- */

export function hex8(value: number): string {
  return hex(value, 8);
}

export function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** Left-aligned columns, one space of padding, no borders. */
export function table(rows: readonly (readonly string[])[], headers?: readonly string[]): string {
  const all = headers === undefined ? rows : [headers, ...rows];
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, index) => {
      widths[index] = Math.max(widths[index] ?? 0, cell.length);
    });
  }
  const render = (row: readonly string[]): string =>
    row
      .map((cell, index) => (index === row.length - 1 ? cell : cell.padEnd(widths[index] ?? 0)))
      .join('  ')
      .trimEnd();
  const lines = rows.map(render);
  if (headers === undefined) return lines.join('\n');
  const rule = widths.map((width) => '-'.repeat(width)).join('  ');
  return [render(headers), rule, ...lines].join('\n');
}

export function heading(text: string, color: boolean): string {
  return paint(text, 'bold', color);
}

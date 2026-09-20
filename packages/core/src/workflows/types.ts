/* ==================================================================== *
 * Shared workflow vocabulary: the options a run takes, the context it runs
 * in, and the shapes it hands back.
 *
 * Two rules shape everything in this directory, and both come from mistakes
 * the original page made:
 *
 *   1. NO module-global state. The original kept `cancelRequested`, `running`
 *      and `deviceState` as page globals, which is why a second camera could
 *      inherit the first one's Key A. Here every run carries its own
 *      `WorkflowContext`, and the analysis a flash is built from is an
 *      argument, not an ambient.
 *   2. NO platform APIs. A workflow RETURNS `Artifact[]`; it never writes a
 *      file, never builds a Blob and never triggers a download. The CLI and
 *      the web app each decide what to do with the bytes.
 * ==================================================================== */

import { SeekError } from '../errors.js';
import type { Artifact, Reporter } from '../events.js';
import type { DeviceDescription, TransportInfo } from '../protocol/transport.js';
import type { SeekDevice } from '../protocol/client.js';
import { DEFAULT_READ_CHUNK, WINDOW_SIZE } from '../protocol/ops.js';
import type {
  BootPrediction,
  DetectionResult,
  DeviceEvidence,
  FirmwareProfile,
  SlotKey,
  WindowEntry,
} from '../profiles/types.js';
import type {
  DecryptionSummary,
  DeviceInfo,
  DumpManifest,
  LegacyDumpManifest,
  ManifestProfileInfo,
  SweepManifest,
  TransportInfo as ManifestTransportInfo,
} from '../archive/manifest.js';
import type { RecoveredKey } from '../crypto/recover.js';
import type {
  EmbeddedKeyTable,
  PickedKeyTable,
  StoreKey,
  WhiteningResolution,
} from '../crypto/keys.js';
import type { ImageFooter, ImageHeader } from '../image/header.js';

/* ==================================================================== *
 * Options
 * ==================================================================== */

/**
 * The four read-loop knobs plus the decrypt toggle, ported from the original's
 * `readOptions()`.
 */
export interface DumpOptions {
  /** Bytes per GetFeaturedFirmwareData request. Adapts downward on its own. */
  readonly chunk: number;
  /** Byte written into unreachable blocks and into a short window's shortfall. */
  readonly gapFill: number;
  /** Extra whole-window attempts, each with a device reopen in between. */
  readonly retries: number;
  /** Pause between those attempts, in milliseconds. */
  readonly retryDelayMs: number;
  /** Run the decryption stage after the read. Never affects the flash image. */
  readonly decrypt: boolean;
}

/** The original page's own defaults, so an options-free call behaves as it did. */
export const DEFAULT_DUMP_OPTIONS: DumpOptions = {
  chunk: DEFAULT_READ_CHUNK,
  gapFill: 0xff,
  retries: 2,
  retryDelayMs: 500,
  decrypt: true,
};

/**
 * `detail.option` names the offending field, so a front end can point at the
 * right input instead of parsing the message text.
 */
function badOption(option: string, value: unknown, requirement: string): SeekError {
  return new SeekError('options/invalid', `${option} ${requirement}, got ${String(value)}`, {
    detail: { option, value },
  });
}

/**
 * Validates and fills in `DumpOptions`. Range checks are the original
 * `readOptions()`'s, value for value: chunk 1..65536, gapFill 0..255,
 * retries >= 0, retryDelayMs >= 0.
 */
export function resolveDumpOptions(options: Partial<DumpOptions> = {}): DumpOptions {
  const resolved: DumpOptions = { ...DEFAULT_DUMP_OPTIONS, ...options };

  const { chunk, gapFill, retries, retryDelayMs } = resolved;
  if (!Number.isInteger(chunk) || chunk <= 0 || chunk > WINDOW_SIZE) {
    throw badOption('chunk', chunk, `must be an integer between 1 and ${String(WINDOW_SIZE)}`);
  }
  if (!Number.isInteger(gapFill) || gapFill < 0 || gapFill > 0xff) {
    throw badOption('gapFill', gapFill, 'must be a single byte (0..255)');
  }
  if (!Number.isInteger(retries) || retries < 0) {
    throw badOption('retries', retries, 'must be an integer of zero or more');
  }
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw badOption('retryDelayMs', retryDelayMs, 'must be an integer of zero or more');
  }
  return resolved;
}

/* ==================================================================== *
 * Context
 * ==================================================================== */

/**
 * Everything a run needs, passed explicitly.
 *
 * `profile` is the profile the run ACTS under — the selector map it reads, the
 * cipher it names keys with, the capabilities it is gated by. `detection` is
 * what the evidence suggested, which may disagree; keeping them separate is
 * what lets a UI offer a manual override without the workflow silently
 * substituting its own opinion.
 */
export interface WorkflowContext {
  readonly device: SeekDevice;
  readonly profile: FirmwareProfile;
  readonly detection: DetectionResult | null;
  readonly reporter: Reporter;
  readonly signal?: AbortSignal;
}

export function isCancelled(ctx: { readonly signal?: AbortSignal | undefined }): boolean {
  return ctx.signal?.aborted ?? false;
}

/* ==================================================================== *
 * Results
 * ==================================================================== */

export interface DumpResult {
  /** Every file the run produced, in the order it produced them. */
  readonly artifacts: readonly Artifact[];
  readonly manifest: DumpManifest | LegacyDumpManifest;
  /** The assembled flash image, gap-filled. */
  readonly combined: Uint8Array;
  readonly windowsRead: number;
  readonly windowsExpected: number;
  /**
   * Mirrors `manifest.cancelled`. A cancelled run throws `CancelledError`
   * rather than returning, so this is `false` on every result a caller
   * receives; the field exists because the manifest records it and because a
   * consumer reading a manifest back needs the same shape.
   */
  readonly cancelled: boolean;
}

export interface SweepResult {
  readonly artifacts: readonly Artifact[];
  readonly manifest: SweepManifest;
  readonly combined: Uint8Array;
  readonly selectorsArmed: number;
  readonly selectorsWithData: number;
  readonly placedInImage: number;
  readonly cancelled: boolean;
}

/** One firmware slot recovered from a dump, as the decrypt stage saw it. */
export interface DecryptedSlot {
  /** Flash address, i.e. `flashBase + fileOffset`. */
  readonly flash: number;
  /** Offset within the scanned buffer. */
  readonly fileOffset: number;
  readonly length: number;
  readonly recovered: RecoveredKey;
  /** Which whitening constant this build actually uses, and what decided it. */
  readonly whitening: WhiteningResolution;
  readonly plain: Uint8Array;
  readonly cipherSha256: string;
  readonly plainSha256: string;
  readonly sp: number;
  readonly entry: number;
  /** Flash address of the first slot with this plaintext, when it is a copy. */
  readonly duplicateOf: number | null;
  /** Where this image keeps the dump's own Key A / Key B, when it does at all. */
  readonly embedded: EmbeddedKeyTable | null;
  /** Artifact name of the decrypted image, key suffix included when stamped. */
  readonly file: string;
}

export interface DecryptResult {
  readonly artifacts: readonly Artifact[];
  readonly summary: DecryptionSummary;
  readonly slots: readonly DecryptedSlot[];
  /** The bootloader key table identified in this dump, when one was. */
  readonly bootloaderKeys: PickedKeyTable | null;
  /**
   * Non-null only when the caller did NOT name a profile and it was detected
   * from the dump itself — so a front end can show what was decided and why,
   * and offer an override.
   */
  readonly detection: DetectionResult | null;
  /**
   * True only where a cancel actually cut work short. A run that finished every
   * slot it found is `false` even if the signal aborted while the artifacts
   * were being written, and so is one that found no slots at all.
   */
  readonly cancelled: boolean;
}

/* ---- device state -------------------------------------------------- */

/**
 * One firmware slot as read from the camera.
 *
 * `accepts` and `bootable` are deliberately separate, and that separation is
 * the whole point of `identifyKey`: a slot always decrypts under the key it was
 * written with and can pass the acceptance sum, while `image_try_keys()` only
 * ever tries the store key and Key A. A slot can therefore be perfect and still
 * be skipped at boot.
 */
export interface SlotState {
  readonly key: SlotKey;
  readonly name: string;
  readonly subcmd: number;
  readonly address: number;
  readonly present: boolean;
  /** Why the slot holds no usable image, when it does not. */
  readonly reason: string | null;
  /**
   * The READ failed — the window would not arm, or the transfer died — as
   * opposed to a window that read back cleanly and simply holds no image.
   * The difference matters: an unread slot means the picture of the camera is
   * incomplete, so nothing may be written on the strength of it.
   */
  readonly unread: boolean;
  /** Header as read. It lives in the cleartext window, so it is readable as-is. */
  readonly header: ImageHeader | null;
  /** The whole bank as read: image + pad + footer. */
  readonly raw: Uint8Array | null;
  readonly footer: ImageFooter | null;
  readonly recovered: RecoveredKey | null;
  readonly plain: Uint8Array | null;
  readonly plainHeader: ImageHeader | null;
  /** The decrypted image hits the profile's acceptance sum. */
  readonly accepts: boolean;
  readonly footerOk: boolean;
  readonly sha256: string | null;
  /** 'Key A' / 'Key B' / 'per-device key' / 'unknown key', or null when unread. */
  readonly keyName: string | null;
  /** The bootloader can actually key AND take this slot. Not implied by `accepts`. */
  readonly bootable: boolean;
}

export interface DeviceState {
  readonly readAt: string;
  /** The profile the read was performed under. */
  readonly profile: FirmwareProfile;
  /** What the evidence gathered during this read suggests the camera is. */
  readonly detection: DetectionResult;
  readonly evidence: DeviceEvidence;
  readonly description: DeviceDescription;

  readonly version: string | null;
  readonly buildString: string | null;
  readonly bootloaderVersion: string | null;
  readonly bootloaderString: string | null;
  readonly platform: string | null;
  readonly usbSpeed: string | null;
  /** roots[2]: the word `fw_update_slot_address()` reads. 0 means slot B. */
  readonly activeSlotWord: number | null;
  readonly serial: string | null;

  readonly cfg0: number | null;
  readonly cfgSlots: readonly number[] | null;

  /** 16 bytes at `memory.deviceKeySlotOffset`, or null when unread. */
  readonly deviceKeySlot: Uint8Array | null;
  readonly keyTableCandidates: number;
  readonly keyTable: PickedKeyTable | null;
  /**
   * The whitening constant under which this camera's key table actually
   * resolved. Usually the profile's own K; when it is not, K and the profile
   * disagree and a write would encrypt under the wrong constant, so the flash
   * gate refuses.
   */
  readonly keyWhiteningK: number;
  readonly storeKey: StoreKey;

  readonly slots: readonly SlotState[];
  readonly byKey: ReadonlyMap<SlotKey, SlotState>;

  /** The bootloader's own replayed choice, or null when it could not be replayed. */
  readonly boot: BootPrediction | null;
  /** The slot the upgrade selector's window was read back from, when it could be told. */
  readonly targetConfirmed: SlotKey | null;

  /** At least one slot decrypts to this profile's acceptance sum. */
  readonly familyOk: boolean;
  readonly canFlash: boolean;
  /** Why `canFlash` is false, for a UI that has to explain the greyed-out button. */
  readonly flashBlockedBy: readonly string[];
}

export function slotByKey(state: DeviceState, key: SlotKey): SlotState | null {
  return state.byKey.get(key) ?? null;
}

/* ---- prepared flash ------------------------------------------------- */

/** One field that differs between what the camera runs and what is about to be written. */
export interface ComparisonRow {
  readonly field: string;
  readonly onCamera: string;
  readonly inImage: string;
}

/** The retarget of an image's own g_keyA/g_keyB to this camera's pair. */
export interface KeyPatchRecord {
  readonly offsetA: number;
  readonly offsetB: number;
  readonly adjacent: boolean;
  /** Display form: one offset when the keys are adjacent, two when not. */
  readonly where: string;
  readonly fromA: string;
  readonly fromB: string;
  readonly toA: string;
  readonly toB: string;
  /** False when the file already carried this camera's keys and was left alone. */
  readonly changed: boolean;
}

/**
 * A staged, encrypted bank payload and everything a UI needs to describe it
 * before anyone presses the button.
 *
 * `payload` is only valid for the ONE camera whose Key A built it. It is
 * returned rather than stored precisely so that it cannot be carried across a
 * device swap the way the original page's `pendingFlash` global could.
 *
 * The payload SHA-256 is deliberately absent: hashing is async and this is not.
 * A caller that wants it awaits `sha256hex(prep.payload)`, exactly as the
 * original did at its call site.
 */
export interface PreparedFlash {
  readonly compare: readonly ComparisonRow[];
  /** The SP or reset vector moved: a differently linked build. */
  readonly layoutMoved: boolean;
  readonly keyPatch: KeyPatchRecord;
  /** The image (after patching) carries this camera's key pair. */
  readonly carriesMine: boolean;
  /**
   * The slot this write targets already holds an image the bootloader cannot
   * key — so the running application demonstrably re-encrypts with a key the
   * bootloader will not try, and this write lands in the same state.
   */
  readonly rekeyRisk: boolean;
  readonly targetName: string | null;
  readonly bootedName: string | null;
  readonly runningSlot: string | null;
  readonly fileName: string;
  readonly originalSize: number;
  readonly declaredBefore: number;
  readonly lengthStamped: boolean;
  readonly length: number;
  readonly adjust: number;
  readonly header: ImageHeader;
  readonly keyA: Uint8Array;
  readonly payload: Uint8Array;
  readonly footerOffset: number;
  readonly footer: ImageFooter | null;
  /** Name of the slot whose footer was carried over, or null when none was. */
  readonly footerFrom: string | null;
  readonly sum16: number;
}

/* ==================================================================== *
 * Manifest adapters
 *
 * The archive layer takes already-typed input and does all value formatting.
 * These three turn what a workflow has to hand into what it expects, so no
 * workflow duplicates hex policy.
 * ==================================================================== */

export function profileInfoOf(
  profile: FirmwareProfile,
  detection: DetectionResult | null,
): ManifestProfileInfo {
  const match = detection?.ranked.find((entry) => entry.profile.id === profile.id);
  return {
    id: profile.id,
    name: profile.name,
    detectionScore: match?.score ?? 0,
    reasons: match?.reasons ?? ['profile selected by the caller; no detection was run'],
  };
}

export function deviceInfoOf(description: DeviceDescription): DeviceInfo {
  return {
    product: description.productName,
    manufacturer: description.manufacturerName,
    serialNumber: description.serialNumber,
  };
}

/**
 * Original: the `transport` object literal every manifest carried. The
 * bmRequestType bytes are re-derived from the recipient exactly as the page
 * did, and `userAgent` now carries the transport's free-form host string —
 * a browser UA in the web app, a node/platform string in the CLI.
 */
export function transportInfoOf(info: TransportInfo): ManifestTransportInfo {
  return {
    api: info.api,
    requestType: 'vendor',
    recipient: info.recipient,
    bmRequestTypeOut: info.recipient === 'interface' ? '0x41' : '0x40',
    bmRequestTypeIn: info.recipient === 'interface' ? '0xc1' : '0xc0',
    interface: info.interfaceNumber,
    claimedInterface: info.claimedInterface,
    userAgent: info.host ?? 'unknown',
  };
}

/* ==================================================================== *
 * Window-map helpers
 *
 * A profile's selector map is the single source of truth for HOW a bank is
 * armed. These read facts off it rather than branching on `ProfileId`, which
 * is what keeps one dump function covering both the modern and the legacy
 * algorithms.
 * ==================================================================== */

/**
 * True when this map arms protected banks through the 18-byte authenticated
 * selector. That is the legacy locked firmware's signature, and it is what
 * decides which manifest and which README a run emits — read off the map
 * itself, never off the profile's id.
 */
export function usesAuthChannel(entries: readonly WindowEntry[]): boolean {
  return entries.some((entry) => entry.auth === true && entry.payload !== undefined);
}

/**
 * The 16-byte unlock token the map carries, taken from the first authenticated
 * entry's payload (bytes 2..17). Null when the map does not use the channel.
 */
export function unlockTokenOf(entries: readonly WindowEntry[]): Uint8Array | null {
  for (const entry of entries) {
    if (entry.auth === true && entry.payload !== undefined && entry.payload.length > 2) {
      return entry.payload.slice(2);
    }
  }
  return null;
}

/** The map entry that arms `address`, or null when no selector reaches it. */
export function entryForAddress(
  entries: readonly WindowEntry[],
  address: number,
): WindowEntry | null {
  return entries.find((entry) => entry.address === address) ?? null;
}

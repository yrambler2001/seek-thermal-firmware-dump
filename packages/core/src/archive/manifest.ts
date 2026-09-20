/**
 * Manifest JSON shapes, ported field-for-field from `legacy/index.html`'s
 * `runDump` / `runOldDump` / `runSweep` / `decryptPickedFile`.
 *
 * These are PRESERVED OUTPUT FORMATS: downstream scripts and this project's
 * own history read `manifest.json` files produced by the old page, so every
 * field name and every value's string formatting (which addresses go through
 * `hex()` vs `hexUp()`, which are zero-padded and to how many digits) is kept
 * byte-identical to the original. See the doc comment on each builder for the
 * exact original expression it reproduces.
 *
 * One field is genuinely new: `profile`, added to every manifest so a report
 * records which `FirmwareProfile` the tool detected/acted under. It is additive
 * only — nothing existing is renamed or removed.
 *
 * Builders take structured, already-typed input (raw numbers, `Uint8Array`s)
 * and do the string formatting here, in one place, so a caller never has to
 * duplicate `hex`/`hexUp`/`bytesToHex` policy to stay byte-identical.
 */

import { bytesToHex, hex, hexUp } from '../bytes.js';
import type { ProfileId } from '../profiles/types.js';

/* ==================================================================== *
 * Shared pieces
 * ==================================================================== */

export interface DeviceInfo {
  readonly product: string | null;
  readonly manufacturer: string | null;
  readonly serialNumber: string | null;
}

export interface TransportInfo {
  readonly api: string;
  readonly requestType: string;
  readonly recipient: string;
  readonly bmRequestTypeOut: string;
  readonly bmRequestTypeIn: string;
  readonly interface: number;
  readonly claimedInterface: boolean;
  readonly userAgent: string;
}

/** NEW field recorded on every manifest: which firmware profile the tool acted under. */
export interface ManifestProfileInfo {
  readonly id: ProfileId;
  readonly name: string;
  readonly detectionScore: number;
  readonly reasons: readonly string[];
}

/* ==================================================================== *
 * Window records (runDump / runOldDump `manifest.windows[]`)
 * ==================================================================== */

/** Original: `{ from: hex(addr+len,8), to: hex(addr+requested-1,8), length, fill: hex(gapFill,2), reason }`. */
export interface ShortfallFill {
  readonly from: string;
  readonly to: string;
  readonly length: number;
  readonly fill: string;
  readonly reason: string;
}

/** A window whose read attempt returned bytes (possibly fewer than requested). */
export interface WindowRecordRead {
  readonly address: string;
  readonly offset: string;
  readonly subcmd: string;
  readonly note: string;
  readonly auth: boolean;
  readonly requested: number;
  readonly lengthRead: number;
  readonly shortBy: number;
  readonly shortfallFilled: ShortfallFill | null;
  readonly file: string;
  readonly preview: string;
  /** `lengthRead === requested`. Can be `false` on a short-but-not-thrown read. */
  readonly ok: boolean;
}

/** A window whose read attempt threw (every retry exhausted, or nothing was read). */
export interface WindowRecordError {
  readonly address: string;
  readonly offset: string;
  readonly subcmd: string;
  readonly note: string;
  readonly auth: boolean;
  readonly requested: number;
  readonly error: string;
  readonly ok: false;
}

export type WindowRecord = WindowRecordRead | WindowRecordError;

interface WindowRecordInputBase {
  readonly address: number;
  /** Byte offset within the combined image, i.e. `address - flashBase`. */
  readonly offset: number;
  readonly subcmd: number;
  readonly note: string;
  readonly auth: boolean;
  readonly requested: number;
}

export interface WindowRecordReadInput extends WindowRecordInputBase {
  readonly ok: true;
  /** The bytes actually read; may be shorter than `requested`. */
  readonly data: Uint8Array;
  readonly gapFill: number;
  /** Why the read stopped short, when it did. Defaults to "read stopped early". */
  readonly stopReason?: string;
  readonly file: string;
}

export interface WindowRecordErrorInput extends WindowRecordInputBase {
  readonly ok: false;
  readonly error: string;
}

export type WindowRecordInput = WindowRecordReadInput | WindowRecordErrorInput;

/**
 * Original (readWindowsInto): the `manifest.windows.push({...})` object, built
 * either from a successful (possibly short) read or from the caught error.
 */
export function buildWindowRecord(input: WindowRecordInput): WindowRecord {
  const base = {
    address: hex(input.address, 8),
    offset: hex(input.offset, 6),
    subcmd: hex(input.subcmd),
    note: input.note,
    auth: input.auth,
    requested: input.requested,
  };

  if (!input.ok) {
    return { ...base, error: input.error, ok: false };
  }

  const lengthRead = input.data.length;
  const complete = lengthRead === input.requested;
  const shortfallFilled: ShortfallFill | null = complete
    ? null
    : {
        from: hex(input.address + lengthRead, 8),
        to: hex(input.address + input.requested - 1, 8),
        length: input.requested - lengthRead,
        fill: hex(input.gapFill, 2),
        reason: input.stopReason ?? 'read stopped early',
      };

  return {
    ...base,
    lengthRead,
    shortBy: input.requested - lengthRead,
    shortfallFilled,
    file: input.file,
    preview: bytesToHex(input.data, 32),
    ok: complete,
  };
}

/* ==================================================================== *
 * Gap records (unreachable / gap-filled 64 KiB blocks)
 * ==================================================================== */

/** Original: `{ address: hex(a,8), offset: hex(a-FLASH_BASE,6), length, fill: hex(gapFill,2), reason }`. */
export interface GapRecord {
  readonly address: string;
  readonly offset: string;
  readonly length: number;
  readonly fill: string;
  readonly reason: string;
}

export interface GapRecordInput {
  readonly address: number;
  readonly flashBase: number;
  readonly length: number;
  readonly fill: number;
  readonly reason: string;
}

export function buildGapRecord(input: GapRecordInput): GapRecord {
  return {
    address: hex(input.address, 8),
    offset: hex(input.address - input.flashBase, 6),
    length: input.length,
    fill: hex(input.fill, 2),
    reason: input.reason,
  };
}

/* ==================================================================== *
 * Selector records (runSweep `manifest.selectors[]`)
 * ==================================================================== */

export interface SelectorRecord {
  readonly subcmd: string;
  readonly mappedAddress: string | null;
  readonly armed: boolean;
  readonly begin: 'ok' | 'stall';
  readonly errorCode: string | null;
  readonly length: number;
  readonly file: string | null;
  readonly preview: string | null;
  readonly readError?: string;
}

export interface SelectorRecordInput {
  readonly subcmd: number;
  readonly mappedAddress: number | null;
  /**
   * Original: `begin === "ok" && !errCode` — note this treats an errorCode of
   * `0` as "no error" too (falsy), same as the legacy page. Pass the value you
   * want recorded, not a re-derivation, so this quirk isn't silently dropped.
   */
  readonly armed: boolean;
  readonly begin: 'ok' | 'stall';
  readonly errorCode: number | null;
  /** Bytes read while armed, or `null`/empty when nothing came back. */
  readonly data: Uint8Array | null;
  readonly file: string | null;
  readonly readError?: string;
}

export function buildSelectorRecord(input: SelectorRecordInput): SelectorRecord {
  const length = input.data?.length ?? 0;
  const record: SelectorRecord = {
    subcmd: hex(input.subcmd),
    mappedAddress: input.mappedAddress != null ? hex(input.mappedAddress, 8) : null,
    armed: input.armed,
    begin: input.begin,
    errorCode: input.errorCode != null ? hex(input.errorCode) : null,
    length,
    file: length > 0 ? input.file : null,
    preview: length > 0 && input.data ? bytesToHex(input.data, 32) : null,
  };
  return input.readError !== undefined ? { ...record, readError: input.readError } : record;
}

/* ==================================================================== *
 * Decryption summary (decryptDump's `summary`, embedded in every manifest
 * as `manifest.decryption`, and standalone in the offline-decrypt manifest)
 * ==================================================================== */

/** Original: `{ keyAOffset: hexUp(off,6), keyBOffset: hexUp(off,6), adjacent, keyA: bytesToHex(...), keyB: bytesToHex(...) }`. */
export interface EmbeddedKeyTable {
  readonly keyAOffset: string;
  readonly keyBOffset: string;
  readonly adjacent: boolean;
  readonly keyA: string;
  readonly keyB: string;
}

export interface EmbeddedKeyTableInput {
  readonly keyAOffset: number;
  readonly keyBOffset: number;
  readonly adjacent: boolean;
  readonly keyA: Uint8Array;
  readonly keyB: Uint8Array;
}

/**
 * One `summary.images[]` entry. NOTE: unlike window/gap/selector records,
 * decryption fields use `hexUp` (upper-case), matching the original exactly.
 */
export interface ImageSummary {
  readonly flash: string;
  readonly fileOffset: string;
  readonly length: number;
  readonly cipherSha256: string;
  readonly plainSha256: string;
  readonly decrypted: boolean;
  readonly confidence: string;
  readonly key: string | null;
  readonly state: string;
  readonly derivedTarget: string;
  readonly profile: string;
  readonly sp: string;
  readonly entry: string;
  readonly duplicateOf: string | null;
  readonly embeddedKeyTable: EmbeddedKeyTable | null;
  readonly file: string;
}

export interface ImageSummaryInput {
  readonly flash: number;
  readonly fileOffset: number;
  readonly length: number;
  readonly cipherSha256: string;
  readonly plainSha256: string;
  readonly confidence: string;
  /** `null` when K is unidentifiable from ciphertext alone (unknown-profile candidates only). */
  readonly key: Uint8Array | null;
  /** The recovered xorshift128 state, x/y/z/w — the actual decryption secret. */
  readonly state: readonly number[];
  readonly derivedTarget: number;
  readonly profile: string;
  readonly sp: number;
  readonly entry: number;
  readonly duplicateOf: number | null;
  readonly embeddedKeyTable: EmbeddedKeyTableInput | null;
  readonly file: string;
}

/** Original: the object pushed to `summary.images` in `decryptDump`. */
export function buildImageSummary(input: ImageSummaryInput): ImageSummary {
  return {
    flash: hexUp(input.flash),
    fileOffset: hexUp(input.fileOffset),
    length: input.length,
    cipherSha256: input.cipherSha256,
    plainSha256: input.plainSha256,
    decrypted: true,
    confidence: input.confidence,
    key: input.key ? bytesToHex(input.key) : null,
    state: input.state.map((word) => hexUp(word)).join(' '),
    derivedTarget: hexUp(input.derivedTarget),
    profile: input.profile,
    sp: hexUp(input.sp),
    entry: hexUp(input.entry),
    duplicateOf: input.duplicateOf != null ? hexUp(input.duplicateOf) : null,
    embeddedKeyTable: input.embeddedKeyTable
      ? {
          keyAOffset: hexUp(input.embeddedKeyTable.keyAOffset, 6),
          keyBOffset: hexUp(input.embeddedKeyTable.keyBOffset, 6),
          adjacent: input.embeddedKeyTable.adjacent,
          keyA: bytesToHex(input.embeddedKeyTable.keyA),
          keyB: bytesToHex(input.embeddedKeyTable.keyB),
        }
      : null,
    file: input.file,
  };
}

/** Original: `{ key: bytesToHex(key), profile: profName, recovery: "cryptanalytic", confidence }`. */
export interface KeySummary {
  readonly key: string;
  readonly profile: string;
  readonly recovery: string;
  readonly confidence: string;
}

export interface KeySummaryInput {
  readonly key: Uint8Array;
  readonly profile: string;
  readonly recovery: string;
  readonly confidence: string;
}

export function buildKeySummary(input: KeySummaryInput): KeySummary {
  return {
    key: bytesToHex(input.key),
    profile: input.profile,
    recovery: input.recovery,
    confidence: input.confidence,
  };
}

/** Original: `{ keyA: bytesToHex(bootKeys.keyA), keyB: bytesToHex(bootKeys.keyB), offset: hexUp(bootKeys.offset,6) }`. */
export interface BootloaderKeysSummary {
  readonly keyA: string;
  readonly keyB: string;
  readonly offset: string;
}

export function buildBootloaderKeysSummary(
  keyA: Uint8Array,
  keyB: Uint8Array,
  offset: number,
): BootloaderKeysSummary {
  return { keyA: bytesToHex(keyA), keyB: bytesToHex(keyB), offset: hexUp(offset, 6) };
}

export interface DecryptionNotAttempted {
  readonly attempted: false;
  readonly reason: string;
}

/** Original: `manifest.decryption = { attempted: false, reason }` (disabled, or nothing to decrypt). */
export function buildDecryptionNotAttempted(reason: string): DecryptionNotAttempted {
  return { attempted: false, reason };
}

export interface DecryptionAttempted {
  readonly attempted: true;
  readonly images: readonly ImageSummary[];
  readonly keys: readonly KeySummary[];
  /** Non-null only on the caught-exception path; a normal run leaves this `null`. */
  readonly error: string | null;
  /** e.g. "no image slots found". */
  readonly note?: string;
  readonly bootloaderKeys?: BootloaderKeysSummary | null;
}

export type DecryptionSummary = DecryptionNotAttempted | DecryptionAttempted;

export interface DecryptionSummaryInput {
  readonly images: readonly ImageSummary[];
  readonly keys: readonly KeySummary[];
  readonly note?: string;
  readonly bootloaderKeys?: BootloaderKeysSummary | null;
}

/** Original: the `summary` object built up over `decryptDump`'s main loop. */
export function buildDecryptionSummary(input: DecryptionSummaryInput): DecryptionAttempted {
  return {
    attempted: true,
    images: input.images,
    keys: input.keys,
    error: null,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(input.bootloaderKeys !== undefined ? { bootloaderKeys: input.bootloaderKeys } : {}),
  };
}

/** Original: `manifest.decryption = { attempted: true, error: msg, images: [], keys: [] }` (catch path). */
export function buildDecryptionFailed(error: string): DecryptionAttempted {
  return { attempted: true, images: [], keys: [], error };
}

/* ==================================================================== *
 * DumpManifest (runDump)
 * ==================================================================== */

export interface DumpManifest {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly vid: string;
  readonly pid: string;
  readonly device: DeviceInfo;
  readonly flashBase: string;
  readonly flashSize: number;
  readonly windowSize: number;
  readonly chunk: number;
  readonly usbComplete: boolean;
  readonly gapFilled: boolean;
  readonly gapFill: string;
  readonly producer: string;
  readonly transport: TransportInfo;
  readonly safety: readonly string[];
  readonly windows: readonly WindowRecord[];
  readonly gaps: readonly GapRecord[];
  readonly combinedFile: string;
  readonly decryption: DecryptionSummary;
  readonly usbReadableWindows: number;
  readonly expectedReadableWindows: number;
  readonly cancelled: boolean;
  /** NEW: which firmware profile this run detected/acted under. */
  readonly profile: ManifestProfileInfo;
}

export interface BuildDumpManifestInput {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly vendorId: number;
  readonly productId: number;
  readonly device: DeviceInfo;
  readonly flashBase: number;
  readonly flashSize: number;
  readonly windowSize: number;
  readonly chunk: number;
  readonly gapFill: number;
  readonly producer: string;
  readonly transport: TransportInfo;
  readonly safety: readonly string[];
  readonly windows: readonly WindowRecord[];
  readonly gaps: readonly GapRecord[];
  readonly combinedFile: string;
  readonly decryption: DecryptionSummary;
  readonly usbReadableWindows: number;
  readonly expectedReadableWindows: number;
  readonly cancelled: boolean;
  readonly profile: ManifestProfileInfo;
  /** Always `false` in the original; kept overridable rather than hard-coded dead weight. */
  readonly usbComplete?: boolean;
  /** Always `true` in the original (a dump always fills unreachable blocks). */
  readonly gapFilled?: boolean;
}

/** Original: the `manifest` object literal built at the top of `runDump`, plus its late fields. */
export function buildDumpManifest(input: BuildDumpManifestInput): DumpManifest {
  return {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    vid: hex(input.vendorId, 4),
    pid: hex(input.productId, 4),
    device: input.device,
    flashBase: hex(input.flashBase, 8),
    flashSize: input.flashSize,
    windowSize: input.windowSize,
    chunk: input.chunk,
    usbComplete: input.usbComplete ?? false,
    gapFilled: input.gapFilled ?? true,
    gapFill: hex(input.gapFill, 2),
    producer: input.producer,
    transport: input.transport,
    safety: input.safety,
    windows: input.windows,
    gaps: input.gaps,
    combinedFile: input.combinedFile,
    decryption: input.decryption,
    usbReadableWindows: input.usbReadableWindows,
    expectedReadableWindows: input.expectedReadableWindows,
    cancelled: input.cancelled,
    profile: input.profile,
  };
}

/* ==================================================================== *
 * LegacyDumpManifest (runOldDump) — everything DumpManifest has, plus the
 * legacy algorithm's unlock-token bookkeeping.
 * ==================================================================== */

export interface LegacyDumpManifest extends DumpManifest {
  readonly algorithm: 'legacy-locked-firmware';
  readonly unlockToken: string;
  readonly authChannelBanks: readonly string[];
}

export interface BuildLegacyDumpManifestInput extends BuildDumpManifestInput {
  readonly unlockToken: Uint8Array;
  /** Flash addresses of the banks that needed the authenticated selector payload. */
  readonly authChannelBanks: readonly number[];
}

/**
 * Original: `runOldDump`'s manifest object literal (same base shape as
 * `runDump`, plus `algorithm`, `unlockToken` and `authChannelBanks`).
 */
export function buildLegacyDumpManifest(input: BuildLegacyDumpManifestInput): LegacyDumpManifest {
  return {
    ...buildDumpManifest(input),
    algorithm: 'legacy-locked-firmware',
    unlockToken: bytesToHex(input.unlockToken),
    authChannelBanks: input.authChannelBanks.map((address) => hex(address, 8)),
  };
}

/* ==================================================================== *
 * SweepManifest (runSweep)
 * ==================================================================== */

export interface SweepManifest {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly mode: 'selector-sweep' | 'selector-sweep-legacy';
  readonly vid: string;
  readonly pid: string;
  readonly device: DeviceInfo;
  readonly flashBase: string;
  readonly flashSize: number;
  readonly windowSize: number;
  readonly chunk: number;
  readonly gapFill: string;
  readonly channel: string;
  readonly unlockToken: string | null;
  readonly producer: string;
  readonly transport: TransportInfo;
  readonly safety: readonly string[];
  readonly selectors: readonly SelectorRecord[];
  readonly combinedFile: string;
  readonly decryption: DecryptionSummary;
  readonly selectorsArmed: number;
  readonly selectorsWithData: number;
  readonly placedInImage: number;
  readonly cancelled: boolean;
  /** NEW: which firmware profile this run detected/acted under. */
  readonly profile: ManifestProfileInfo;
}

export interface BuildSweepManifestInput {
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly legacy: boolean;
  readonly vendorId: number;
  readonly productId: number;
  readonly device: DeviceInfo;
  readonly flashBase: number;
  readonly flashSize: number;
  readonly windowSize: number;
  readonly chunk: number;
  readonly gapFill: number;
  readonly unlockToken: Uint8Array | null;
  readonly producer: string;
  readonly transport: TransportInfo;
  readonly safety: readonly string[];
  readonly selectors: readonly SelectorRecord[];
  readonly combinedFile: string;
  readonly decryption: DecryptionSummary;
  readonly selectorsArmed: number;
  readonly selectorsWithData: number;
  readonly placedInImage: number;
  readonly cancelled: boolean;
  readonly profile: ManifestProfileInfo;
}

/** Original: the `manifest` object literal built at the top of `runSweep`, plus its late fields. */
export function buildSweepManifest(input: BuildSweepManifestInput): SweepManifest {
  return {
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    mode: input.legacy ? 'selector-sweep-legacy' : 'selector-sweep',
    vid: hex(input.vendorId, 4),
    pid: hex(input.productId, 4),
    device: input.device,
    flashBase: hex(input.flashBase, 8),
    flashSize: input.flashSize,
    windowSize: input.windowSize,
    chunk: input.chunk,
    gapFill: hex(input.gapFill, 2),
    channel: input.legacy ? '0x12 (unlock token)' : '0x02',
    unlockToken: input.unlockToken ? bytesToHex(input.unlockToken) : null,
    producer: input.producer,
    transport: input.transport,
    safety: input.safety,
    selectors: input.selectors,
    combinedFile: input.combinedFile,
    decryption: input.decryption,
    selectorsArmed: input.selectorsArmed,
    selectorsWithData: input.selectorsWithData,
    placedInImage: input.placedInImage,
    cancelled: input.cancelled,
    profile: input.profile,
  };
}

/* ==================================================================== *
 * OfflineDecryptManifest (decryptPickedFile) — decrypting a dump file the
 * user already has, no camera attached.
 * ==================================================================== */

export interface OfflineDecryptSource {
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

export interface OfflineDecryptManifest {
  readonly producer: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly source: OfflineDecryptSource;
  readonly flashBase: string;
  readonly decryption: DecryptionSummary;
  /** NEW: which firmware profile this run detected/acted under. */
  readonly profile: ManifestProfileInfo;
}

export interface BuildOfflineDecryptManifestInput {
  readonly producer: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly source: OfflineDecryptSource;
  readonly flashBase: number;
  readonly decryption: DecryptionSummary;
  readonly profile: ManifestProfileInfo;
}

/** Original: the small `manifest` object literal built in `decryptPickedFile`. */
export function buildOfflineDecryptManifest(
  input: BuildOfflineDecryptManifestInput,
): OfflineDecryptManifest {
  return {
    producer: input.producer,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    source: input.source,
    flashBase: hex(input.flashBase, 8),
    decryption: input.decryption,
    profile: input.profile,
  };
}

/* ==================================================================== *
 * JSON serialisation
 * ==================================================================== */

/** Original: `JSON.stringify(manifest, null, 2) + "\n"`, always written as `manifest.json`. */
export function manifestToJson(manifest: unknown): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

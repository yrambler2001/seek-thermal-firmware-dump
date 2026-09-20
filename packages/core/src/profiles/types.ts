/**
 * Per-firmware-version support.
 *
 * Seek cameras do not all speak the same protocol. Three axes vary independently
 * between build families, and conflating them is how this tool used to get things
 * wrong:
 *
 *   1. The BeginFirmwareUpgrade selector map (which subcommand exposes which
 *      64 KiB window, and whether the protected banks need an auth token).
 *   2. The cipher's whitening constant K (how a stored 16-byte key maps to the
 *      xorshift128 state).
 *   3. The bootloader's acceptance sum TARGET (what the decrypted word sum must
 *      equal).
 *
 * (2) and (3) are NOT a matched pair. A measured 1.3.0.8 Compact build has
 * TARGET 0x0000FFFF and yet no whitening at all (K = 0). So `CipherProfile`
 * keeps them as separate fields and key reporting resolves K by evidence —
 * see `resolveWhitening` in ../crypto/keys.ts — rather than by assuming the
 * pairing holds.
 */

/** The families that ship with this package. */
export type BuiltInProfileId = 'modern-4x' | 'legacy-auth' | 'compact-2016' | 'generic';

/**
 * A profile identifier. Open on purpose: the built-in ids autocomplete, but any
 * string is accepted so that adding a family really is one new file plus one
 * `registerProfile()` call, with no edit to this union.
 */
export type ProfileId = BuiltInProfileId | (string & {});

export type SlotKey = 'a' | 'b' | 'r';

/** Whether a profile supports an operation, and if not, why not. */
export type Support =
  { readonly supported: true } | { readonly supported: false; readonly reason: string };

export const SUPPORTED: Support = { supported: true };

export function unsupported(reason: string): Support {
  return { supported: false, reason };
}

export interface CipherProfile {
  /**
   * Whitening constant. key[0..3] = state[w,x,y,z] XOR K. K = 0 means the stored
   * key IS the raw state. Used only to *name* a key; the state alone decrypts.
   */
  readonly whiteningK: number;
  /** 32-bit word sum the decrypted image must produce for the bootloader to take it. */
  readonly acceptanceSum: number;
  /**
   * Inclusive word-index range left in cleartext (the image header window).
   * [128, 143] == bytes 0x200..0x23F on every family measured so far.
   */
  readonly clearWords: readonly [number, number];
}

export interface MemoryLayout {
  readonly flashBase: number;
  readonly flashSize: number;
  readonly windowSize: number;
  readonly bootConfigBase: number;
  /** Offset of the per-device key slot within the bootloader block (0x218). */
  readonly deviceKeySlotOffset: number;
  readonly deviceKeySlotLength: number;
  /** Blocks this profile's protocol cannot reach at all, recorded as dump gaps. */
  readonly unreachable: readonly UnreachableRange[];
}

export interface UnreachableRange {
  readonly address: number;
  readonly length: number;
  readonly reason: string;
}

export interface WindowEntry {
  readonly subcmd: number;
  readonly address: number;
  readonly note: string;
  /** True when this bank needs the authenticated 18-byte selector payload. */
  readonly auth?: boolean;
  /** Exact BeginFirmwareUpgrade payload. Defaults to the 2-byte little-endian subcmd. */
  readonly payload?: Uint8Array;
}

export interface SlotDescriptor {
  readonly key: SlotKey;
  readonly name: string;
  readonly subcmd: number;
  readonly address: number;
}

export interface BootPrediction {
  /** The slot the bootloader selected. */
  readonly booted: SlotKey;
  /** The slot an upgrade would therefore overwrite. */
  readonly target: SlotKey;
}

export interface BootPolicy {
  /** Selector that arms the slot the camera did NOT boot from. */
  readonly updateTargetSubcmd: number;
  describeCfg0(cfg0: number): string;
  /** Replays the bootloader's select_boot_slot() over observed slot state. */
  selectBootSlot(cfg0: number, isBootable: (key: SlotKey) => boolean): BootPrediction;
}

export interface ProfileCapabilities {
  readonly dump: Support;
  readonly sweep: Support;
  readonly decrypt: Support;
  readonly deviceInfo: Support;
  readonly flash: Support;
}

/**
 * Everything cheaply observable about a camera or a dump, used to pick a profile.
 * Every field is optional: detection runs on whatever evidence is to hand, which
 * offline (a dump file) is much less than online (an attached camera).
 */
export interface DeviceEvidence {
  readonly firmwareVersion?: string;
  readonly bootloaderVersion?: string;
  readonly bootloaderString?: string;
  readonly platform?: string;
  readonly productName?: string;
  readonly vendorId?: number;
  readonly productId?: number;
  /** Acceptance sums produced by decrypting the slots that were found. */
  readonly observedAcceptanceSums?: readonly number[];
  /** Image header version strings found in a dump or on the device. */
  readonly imageVersions?: readonly string[];
  /**
   * A plain 2-byte BeginFirmwareUpgrade armed a protected bank.
   *
   * A real observation of the camera: `armWindow` throws on a refusal, so this
   * is only ever set by an arm that came back clean, and the legacy firmware
   * refuses the plain channel on exactly these banks.
   */
  readonly plainSelectorWorks?: boolean;
  /**
   * The 18-byte authenticated BeginFirmwareUpgrade armed a protected bank.
   *
   * "Worked", NOT "was required". Whoever set this sent the authenticated
   * payload because their own selector map said to, and never tried the plain
   * 2-byte one on that bank; a firmware that reads the first two bytes of the
   * setup packet and ignores the rest would arm on it too. Only a plain arm of
   * a protected bank coming back REFUSED can establish that the authenticated
   * channel is required, and no read path makes that observation today — so
   * profiles score this as corroboration, never as a verdict.
   */
  readonly authSelectorWorks?: boolean;
  /** Byte offsets at which image-header magic was found in a dump. */
  readonly imageBaseOffsets?: readonly number[];
}

export interface DetectionVerdict {
  /** 0 = ruled out, 1 = certain. Detection picks the highest score. */
  readonly score: number;
  /** Human-readable justification, shown in the UI and written into reports. */
  readonly reasons: readonly string[];
}

export interface FirmwareProfile {
  readonly id: ProfileId;
  readonly name: string;
  readonly summary: string;
  readonly cipher: CipherProfile;
  readonly memory: MemoryLayout;
  readonly capabilities: ProfileCapabilities;
  readonly slots: readonly SlotDescriptor[];
  readonly boot: BootPolicy;
  /** The full selector map for a whole-flash dump. */
  windowMap(): readonly WindowEntry[];
  /** Inclusive subcommand range a selector sweep should probe. */
  readonly sweepRange: readonly [number, number];
  detect(evidence: DeviceEvidence): DetectionVerdict;
}

export interface ProfileMatch {
  readonly profile: FirmwareProfile;
  readonly score: number;
  readonly reasons: readonly string[];
}

export interface DetectionResult {
  readonly best: ProfileMatch;
  /** Every profile scored, best first — so the UI can offer a manual override. */
  readonly ranked: readonly ProfileMatch[];
  /** True when the winner scored no better than the generic fallback. */
  readonly ambiguous: boolean;
}

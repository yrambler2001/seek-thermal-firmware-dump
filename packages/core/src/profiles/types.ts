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
export type BuiltInProfileId =
  'modern-4x' | 'legacy-auth' | 'compact-2016' | 'compact-2014' | 'generic';

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
  /**
   * Blocks this profile's protocol reaches on NONE of the builds it covers.
   *
   * Not the dump's gap list. A dump records the gaps of the one firmware it is
   * talking to, which is `windowPlan(version).unreachable` and can be longer:
   * the 2014 Compacts, for one, cannot arm 0x140C0000 at all.
   */
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

/**
 * One row of a firmware's own BeginFirmwareUpgrade switch: what one subcommand
 * arms, as THAT build's handler decides it.
 *
 * WHY ROWS AND NOT A MAP. A dump needs one selector per block; the firmware has
 * one row per subcommand, and the two differ in exactly the places that cost
 * bytes. Two rows can name the same block (subcommand 4 is a second door onto
 * 0x14020000), a row can compute its address at run time rather than carry it
 * (case 0 on every build, case 1 on 0.8.0.0), and on the 2014 Compacts two rows
 * name the same block by mistake, which leaves a third block with no row at
 * all. The dump plan is derived from these rows, so none of that can be
 * papered over by a table that assumes a linear run.
 */
export interface SelectorRow {
  readonly subcmd: number;
  /**
   * The block the handler arms, when the image carries it as a constant. Null
   * when the handler computes it at run time (from the boot record, or from the
   * bootloader's config block), and null when the builds one version string can
   * name disagree about it. A dump never arms a row whose address is null.
   */
  readonly address: number | null;
  /** The payload the handler accepts: plain 2-byte, the 18-byte token, or none. */
  readonly channel: 'plain' | 'auth' | 'refused';
  readonly note: string;
}

/**
 * What a dump of ONE firmware reads, resolved from that firmware's own table.
 *
 * `windows` holds one selector per reachable block, each at the address the
 * table gives it; `unreachable` holds every other block with the reason. The
 * two tile the whole part exactly, which the builder checks, so a block is
 * either read from the address its selector really arms or declared a gap —
 * never filled from somewhere else.
 */
export interface WindowPlan {
  /** The version the plan was resolved for, as the camera reported it, or null. */
  readonly firmwareVersion: string | null;
  /** Which table this is and what it was read from, for the log and the manifest. */
  readonly table: string;
  /** The firmware's whole table, one row per subcommand its handler switches on. */
  readonly selectors: readonly SelectorRow[];
  readonly windows: readonly WindowEntry[];
  readonly unreachable: readonly UnreachableRange[];
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
  /**
   * A plain 2-byte BeginFirmwareUpgrade of a protected bank was REFUSED.
   *
   * THE OBSERVATION THAT SETTLES THE AUTH QUESTION, and until 2026-09-22 the
   * comment on `authSelectorWorks` said in as many words that nothing made it.
   * Something does now: `probeSelectorChannel` sends the plain arm on purpose
   * and records the refusal, and the emulator sweep confirms the split is real
   * — 26 firmwares accept the plain arm of subcommand 5, and nine refuse it and
   * accept the same bank on the 18-byte channel (and refuse an 18-byte payload
   * carrying the wrong token, so the token is genuinely compared).
   *
   * `true` rules the 4.x line out and names the legacy locked firmware; `false`
   * does the reverse. Absent, as it is for every offline dump, both profiles
   * fall back to the weaker signals they used before.
   */
  readonly plainSelectorRefused?: boolean;
  /**
   * A window the selector map says is open on the plain channel actually served
   * bytes. False means `GetFeaturedFirmwareData` did not answer — which on the
   * earliest Compacts is not a wedge but the truth: that opcode is not in their
   * RPC table at all (see `compact-2014`).
   */
  readonly windowReadable?: boolean;
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
  /**
   * The selector map when the firmware version is NOT known: `windowPlan(null)`'s
   * windows. A dump, a sweep and a device read all resolve the version first and
   * use `windowPlan` instead; this remains for listings and for callers with no
   * camera to ask.
   */
  windowMap(): readonly WindowEntry[];
  /**
   * The selector table and dump plan for one firmware build.
   *
   * `firmwareVersion` is what the running camera reports through
   * GetFirmwareInfo, or null when it could not be read. A profile whose builds
   * disagree about a subcommand answers a null or unrecognised version with only
   * the rows every build it knows agrees on, and declares the rest unreachable.
   */
  windowPlan(firmwareVersion: string | null): WindowPlan;
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

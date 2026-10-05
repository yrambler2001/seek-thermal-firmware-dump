/**
 * The wire geometry of the v1 preservation pipeline: which BeginFirmwareUpgrade
 * windows it arms, which one is the boot-config block, which are the image
 * banks, and how the active slot is read out of the boot config.
 *
 * All of this is measured on the v1 locked line (Compact 1.0.0.0 / 1.2.0.0 /
 * 1.3.0.0 on the 2016-donor bootloader generation; FW-V1 docs 33 sec. 11.7 and
 * 34 sec. 34.11), and it is the same table every build of the line decodes to
 * (`legacy-auth.ts`'s 0.9.0.2..1.3.0.0 rows): modes 3..9 answer only the
 * 18-byte token form, 0x0A..0x21 arm on the plain 2-byte form, and each mode
 * exposes exactly one 64 KiB block.
 *
 * READ/WRITE ASYMMETRY, AND WHY IT SHAPES THE PIPELINE. Over this wire the
 * reachable part is the lower 2 MiB: 0x14010000..0x141FFFFF (modes 3..0x21 —
 * 31 windows), and `mode > 0x21` is refused outright. The upper 2 MiB is
 * unreachable to a stock camera. The in-place patch WIDENS the mode-2 window
 * to the whole part (`dc = 0x400000`), which is what phase P3's full-4-MiB
 * drain reads through — and why the stock window set is the backup's unit and
 * the widened window is the dump's.
 */

import { bytesToHex, hexUp } from '../bytes.js';
import { SeekError } from '../errors.js';
import { authPayload, OLD_FW_UNLOCK_TOKEN } from '../profiles/legacy-auth.js';
import { WINDOW_SIZE } from '../profiles/modern-4x.js';
import type { WindowEntry } from '../profiles/types.js';

/** The boot-config block, armed by mode 3. */
export const BOOT_CONFIG_ADDRESS = 0x14010000;
export const CFG_MODE = 3;

/** The image-select record the bootloader keeps in the boot-config block. */
export const BOOT_CONFIG_BYTES = 28;

/**
 * The first 28 bytes of the block at 0x14020000 — the page-shift anchor,
 * measured against the J-Link dump of the reference Compact (sha 40447c7e…,
 * 2026-10-03). Some boots serve every window one 64 KiB page UP (window m
 * answers with the plan's block m+1): the mode-3 probe then returns THESE
 * bytes instead of the boot-config record, which is how the pipeline tells a
 * page-shifted boot from a healthy one before it trusts any window read.
 */
export const PAGE_SHIFT_ANCHOR = Uint8Array.from(
  Object.freeze([
    0x01, 0x00, 0x31, 0xf7, 0x10, 0x00, 0x13, 0x00, 0xce, 0x00, 0x09, 0x00, 0x8a, 0x00, 0xca, 0x00,
    0x31, 0x30, 0x31, 0x33, 0x31, 0x30, 0x48, 0x53, 0x4e, 0x45, 0x41, 0x32,
  ]),
);

/** True when a mode-3 probe read is the page-shift anchor instead of the
 *  boot-config record — the boot is serving windows one page up. */
export function isPageShiftedHead(block: Uint8Array): boolean {
  if (block.length < PAGE_SHIFT_ANCHOR.length) return false;
  for (let i = 0; i < PAGE_SHIFT_ANCHOR.length; i++) {
    if (block[i] !== PAGE_SHIFT_ANCHOR[i]) return false;
  }
  return true;
}

/** The three app-image banks, in the bootloader's A/B/recovery order. */
export const BANKS = [
  { key: 'a', mode: 7, address: 0x14050000 },
  { key: 'b', mode: 8, address: 0x14060000 },
  { key: 'r', mode: 9, address: 0x14070000 },
] as const;

export type BankKey = (typeof BANKS)[number]['key'];

/** The bank the donor bootloader's fixed validate order boots when the record
 *  is blank: A (disassembly of the dump at 0x14000334..0x1400035e — validate
 *  A, then B, then recovery). */
export const BLANK_CFG_BANK: BankKey = 'a';

/** The widened window the PATCHED image serves (mode 2, window length 0x400000). */
export const WIDENED_MODE = 2;

/** One window's length (64 KiB) — re-exported under the pipeline's name. */
export const WINDOW_BYTES = WINDOW_SIZE;

/** The stock backup: modes 3..9 (7) plus 0x0A..0x21 (24). */
export const BACKUP_WINDOW_COUNT = 31;

/** The boot-config window entry (mode 3, token form). */
export function cfgWindow(): WindowEntry {
  return {
    subcmd: CFG_MODE,
    address: BOOT_CONFIG_ADDRESS,
    note: 'boot-config block (the image-select record)',
    payload: authPayload(CFG_MODE, OLD_FW_UNLOCK_TOKEN),
  };
}

/** The 31 windows a stock v1 camera can read: modes 3..9 (token form) and
 *  0x0A..0x21 (plain form) — 0x14010000..0x141FFFFF, one 64 KiB block each. */
export function preservationWindows(): readonly WindowEntry[] {
  const windows: WindowEntry[] = [];
  for (let mode = 3; mode <= 9; mode++) {
    windows.push({
      subcmd: mode,
      address: 0x14010000 + (mode - 3) * WINDOW_SIZE,
      note: `protected window (auth): ${hexUp(0x14010000 + (mode - 3) * WINDOW_SIZE, 8)}`,
      payload: authPayload(mode, OLD_FW_UNLOCK_TOKEN),
    });
  }
  for (let mode = 0x0a; mode <= 0x21; mode++) {
    windows.push({
      subcmd: mode,
      address: 0x14080000 + (mode - 0x0a) * WINDOW_SIZE,
      note: `linear window: ${hexUp(0x14080000 + (mode - 0x0a) * WINDOW_SIZE, 8)}`,
    });
  }
  return windows;
}

/** The window entry for one bank, armed for a WRITE phase (P2/P4). */
export function bankWindow(key: BankKey): WindowEntry {
  const bank = BANKS.find((b) => b.key === key);
  if (bank === undefined) throw new SeekError('pipeline/refused', `no bank ${key}`);
  return {
    subcmd: bank.mode,
    address: bank.address,
    note: `app image bank ${key} (${hexUp(bank.address, 8)}), write-capable window`,
    payload: authPayload(bank.mode, OLD_FW_UNLOCK_TOKEN),
  };
}

/** The plan's own window for one 64 KiB block — the entry of
 *  `preservationWindows()` whose address equals `address`. The plan covers
 *  every block of 0x14010000..0x141FFFFF exactly once, so a bank address
 *  always resolves; anything else refuses rather than guess. */
export function planWindowAt(address: number): WindowEntry {
  const entry = preservationWindows().find((w) => w.address === address);
  if (entry === undefined) {
    throw new SeekError(
      'pipeline/refused',
      `the stock window plan names no window at ${hexUp(address, 8)} — the plan covers ` +
        '0x14010000..0x141FFFFF, one 64 KiB block per mode',
    );
  }
  return entry;
}

/**
 * The two independently-armed windows the backup's double read serves the
 * active slot through: the bank's own window (mode 7/8/9 per `BANKS`) and the
 * plain plan window whose address equals the bank's. Two arms = two separate
 * BeginFirmwareUpgrade descriptors — the firmware's arm handler re-stages the
 * reader descriptor at every arm (remaining, cursor, capacity, source) — so
 * the two reads draw on two descriptor lifetimes rather than on one arm whose
 * budget the first read already spent. Measured on the real Compact
 * (TESTING.md secs. 23.3, 28.4 and the 2026-10-02 incident): a window re-read
 * through a spent arm truncates mid-stream, so the double read may never ask
 * one arm for the whole 64 KiB twice.
 *
 * For every bank the two entries carry the SAME mode id — the plan's row at a
 * bank address IS the bank's row (modes 7/8/9 are both the bank windows and
 * plan modes 3..9) — the pair is still two arms, each with its own descriptor.
 */
export function doubleReadWindows(bank: BankKey): readonly [WindowEntry, WindowEntry] {
  const bankEntry = bankWindow(bank);
  return [bankEntry, planWindowAt(bankEntry.address)];
}

/**
 * The lead every spent-reader refusal carries, with the read's own signature
 * after it. The wording is shared so every refusal that names the remedy names
 * it the same way: the diagnosis and the power-cycle remedy FIRST (the one
 * action that un-blocks a real camera), the technical detail after.
 */
export function spentReaderRefusal(signature: string): string {
  return (
    'the camera’s window reader is budgeted per boot and these reads came back from a spent ' +
    'reader — power-cycle the camera (unplug and replug it, or use its power switch), then ' +
    `re-run \`preserve --resume <run-directory>\`. Signature: ${signature}`
  );
}

/** True when a whole window read is unprogrammed fill, every byte 0xFF. The
 *  canary reads in `backupWindows` use it on two rows whose co-occurrence no
 *  running camera can produce (see the canary comment there). */
export function isBlankWindow(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte !== 0xff) return false;
  }
  return true;
}

/** True when a boot-config word is the stale-descriptor shape: an SRAM address
 *  (the bootloader vector's initial SP, 0x10018000 measured on the real
 *  Compact) served where a record selector should be. */
export function isStaleDescriptorWord(word: number): boolean {
  const w = word >>> 0;
  return w >= 0x10000000 && w < 0x20000000;
}

/** The widened mode-2 window entry (P3's drain). */
export function widenedWindow(): WindowEntry {
  return {
    subcmd: WIDENED_MODE,
    address: 0x14000000,
    note: "bootloader block through the patched image's widened window",
    payload: authPayload(WIDENED_MODE, OLD_FW_UNLOCK_TOKEN),
  };
}

export interface SlotDetection {
  /** The 28 bytes as served. */
  readonly cfgHex: string;
  /** cfg[0], the selector word. */
  readonly cfg0: number;
  /** True when cfg[0] is 0xFFFFFFFF or 0 — no record written, the bootloader's
   *  fixed A -> B -> recovery validate order decides, and that order boots A. */
  readonly blank: boolean;
  /** The bank key the bootloader boots. */
  readonly bank: BankKey;
  /** The bank's flash address. */
  readonly bankAddress: number;
  /** The BeginFirmwareUpgrade mode that arms the active bank for a write. */
  readonly bankMode: number;
  readonly verdict: string;
}

/**
 * Parse the 28-byte boot-config record into the active-slot verdict.
 *
 * cfg[0] 0xFFFFFFFF or 0 -> blank -> slot A; 1 -> B; 2 -> recovery. Anything
 * else names no slot this bootloader generation validates, and the pipeline
 * refuses rather than guess — the whole point of the preservation route is
 * that the write lands ONLY in the slot the camera actually boots.
 */
export function parseBootConfig(block: Uint8Array): SlotDetection {
  if (block.length < BOOT_CONFIG_BYTES) {
    throw new SeekError(
      'pipeline/refused',
      `boot-config read is ${String(block.length)} B, want ${String(BOOT_CONFIG_BYTES)}`,
    );
  }
  const cfg0 = new DataView(block.buffer, block.byteOffset, block.byteLength).getUint32(0, true);
  const byKey = (k: BankKey): { mode: number; address: number } => {
    const bank = BANKS.find((b) => b.key === k);
    if (bank === undefined) throw new SeekError('pipeline/refused', `no bank ${k}`);
    return { mode: bank.mode, address: bank.address };
  };
  if (cfg0 === 0 || cfg0 === 0xffffffff) {
    const { mode, address } = byKey(BLANK_CFG_BANK);
    return {
      cfgHex: bytesToHex(block),
      cfg0: cfg0 >>> 0,
      blank: true,
      bank: BLANK_CFG_BANK,
      bankAddress: address,
      bankMode: mode,
      verdict:
        `cfg[0]=${hexUp(cfg0)} is blank -> the bootloader's fixed A->B->recovery validate ` +
        `order boots bank A (${hexUp(address)})`,
    };
  }
  if (cfg0 === 1 || cfg0 === 2) {
    const key: BankKey = cfg0 === 1 ? 'b' : 'r';
    const { mode, address } = byKey(key);
    return {
      cfgHex: bytesToHex(block),
      cfg0,
      blank: false,
      bank: key,
      bankAddress: address,
      bankMode: mode,
      verdict: `cfg[0]=${String(cfg0)} names bank ${key} (${hexUp(address)})`,
    };
  }
  /* A word shaped like the bootloader vector's own initial SP (an SRAM
   * address, 0x10018000 measured on the real Compact) is the stale-descriptor
   * signature: a spent reader serving the bootloader block's first bytes into
   * the boot-config read. That is a reader state, not a boot-config puzzle —
   * the refusal leads with the power-cycle remedy, never with the slot table.
   */
  if (isStaleDescriptorWord(cfg0)) {
    throw new SeekError(
      'pipeline/refused',
      spentReaderRefusal(
        `cfg[0]=${hexUp(cfg0)} is an SRAM-shaped word — the bootloader vector’s initial SP ` +
          'served through a stale reader descriptor, not a record the bootloader wrote — and ' +
          'no slot can be named from it; nothing is written',
      ),
      { detail: { cfg0: cfg0 >>> 0 } },
    );
  }
  throw new SeekError(
    'pipeline/refused',
    `cfg[0]=${hexUp(cfg0)} names no slot this bootloader validates (0, 1, 2 or blank) — ` +
      'refusing to pick a write target on a guess',
    { detail: { cfg0: cfg0 >>> 0 } },
  );
}

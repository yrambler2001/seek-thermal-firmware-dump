/**
 * Vendor control opcodes and the timing constants that surround them.
 *
 * Everything here is a measured property of the camera's RPC dispatch table,
 * not a design choice, so the comments are part of the data.
 */

import { hex } from '../bytes.js';

/** Seek Thermal, Inc. — any product id. */
export const SEEK_VENDOR_ID = 0x289d;

export const OP = {
  GET_ERROR_CODE: 0x35,
  SET_OPERATION_MODE: 0x3c,
  GET_OPERATION_MODE: 0x3d,
  GET_FEATURED_FIRMWARE_DATA: 0x4f,
  BEGIN_FIRMWARE_UPGRADE: 0x52,
  /**
   * The one command every corpus build answers the same way, which is what
   * makes it the version probe. Recovering each image's own RPC method table
   * puts `GetFirmwareInfo` at 0x4E on all 36 decrypted images, from 0.3.0.1
   * (May 2014) to 4.16.1.7 (Sep 2018) — see `test/firmware/facts.json`.
   */
  GET_FIRMWARE_INFO: 0x4e,
  /* --- used by the flash path only (see FLASH_OPS below) --- */
  SET_FEATURED_FIRMWARE_DATA: 0x50,
  COMPLETE_MEMORY_UPGRADE: 0x51,
  SET_FIRMWARE_INFO_FEATURES: 0x55,
  SET_RAM_DATA_FEATURES: 0x5a,
} as const satisfies Record<string, number>;

export type OpName = keyof typeof OP;
export type Opcode = (typeof OP)[OpName];

/**
 * Which handler column of the firmware's RPC method table each opcode reaches.
 *
 * The camera's dispatcher routes a control IN to the record's GETTER and a
 * control OUT to its SETTER, and stalls a request whose column is empty. So an
 * opcode being at the right wire id with the right NAME is not enough: 0.7.0.7
 * and 0.7.0.8 have `GetFeaturedFirmwareData` at 0x4F with its handler in the
 * setter column, and every read this toolkit sends there stalls (TESTING.md
 * sec.9.10). `firmware-facts.test.ts` holds this table to both columns of every
 * corpus image, and `workflows.test.ts` holds the client to it: every request a
 * dump sends goes out in the direction written here.
 */
export const OP_DIRECTION: Readonly<Record<Opcode, 'in' | 'out'>> = {
  [OP.GET_ERROR_CODE]: 'in',
  [OP.SET_OPERATION_MODE]: 'out',
  [OP.GET_OPERATION_MODE]: 'in',
  [OP.GET_FEATURED_FIRMWARE_DATA]: 'in',
  [OP.BEGIN_FIRMWARE_UPGRADE]: 'out',
  [OP.GET_FIRMWARE_INFO]: 'in',
  [OP.SET_FEATURED_FIRMWARE_DATA]: 'out',
  [OP.COMPLETE_MEMORY_UPGRADE]: 'out',
  [OP.SET_FIRMWARE_INFO_FEATURES]: 'out',
  [OP.SET_RAM_DATA_FEATURES]: 'out',
};

/** Every opcode a dump is allowed to touch. The write path asserts against this
 *  set so a stray call cannot leak into a read-only run. */
export const READ_ONLY_OPS: ReadonlySet<Opcode> = new Set<Opcode>([
  OP.GET_ERROR_CODE,
  OP.SET_OPERATION_MODE,
  OP.GET_OPERATION_MODE,
  OP.GET_FEATURED_FIRMWARE_DATA,
  OP.BEGIN_FIRMWARE_UPGRADE,
  /**
   * MOVED HERE FROM `FLASH_OPS`, 2026-09-22, and the move is a reclassification
   * rather than a relaxation.
   *
   * These sets are not "harmless" and "dangerous": the header above `FLASH_OPS`
   * says it is "every opcode that can change the camera, PLUS the info reads
   * that only the flash path needs", and `GetFirmwareInfo` was one of those
   * info reads. It is a control IN that returns a 36-byte block and writes
   * nothing, which is precisely what `READ_ONLY_OPS` means.
   *
   * It is here because the capability probe needs it BEFORE anything else is
   * sent. The 0.3.0.1 Compact has `EnterBootloaderMode` at wire id 0x52 — the
   * id a dump arms 63 windows with — and the only way to know that before
   * sending it is to read the version, which `GetFirmwareInfo` gives on every
   * build there is. A safety gate that could only be reached by leaving the
   * read-only set would not be much of one.
   *
   * The selector it is normally paired with, `SetFirmwareInfoFeatures`, stays
   * in `FLASH_OPS`: the version read never sets one. It does not trust the
   * selector to be 0 either — an earlier program can leave it set, and only a
   * read clears it — so it reads twice and takes the second answer
   * (`readRunningFirmware`).
   */
  OP.GET_FIRMWARE_INFO,
]);

/**
 * The ONLY requests this toolkit sends before the camera has told it which
 * firmware it runs — and each only as a control IN.
 *
 * A wire id is an index into each build's own RPC method table, and the tables
 * are not the same: on Compact 0.3.0.1 wire id 0x52, the selector arm, is
 * `EnterBootloaderMode`. So until `GetFirmwareInfo` has come back with a
 * version, a request is safe only if it means the same READ on every image
 * there is. Built from `test/firmware/facts.json` (all 36 decrypted corpus
 * images, 0.3.0.1 to 44.27.3.10): the wire ids whose method-table row has the
 * same name on every image, a getter, and nothing in the setter column. There
 * are ten —
 *
 *   0x35 GetErrorCode      0x36 GetChipID       0x39 GetShutterPolarity
 *   0x3D GetOperationMode  0x3F GetIPMode       0x41 GetDataPage
 *   0x44 GetCurrentCmd     0x47 GetDefaultCmd   0x4D GetRDAC
 *   0x4E GetFirmwareInfo
 *
 * — and this toolkit needs three of them. Everything else it sends differs
 * somewhere: 0x52 and 0x4F change meaning, and 0x3C and 0x55 are the same name
 * everywhere but are setters. `identity-gate.test.ts` re-derives the ten from
 * the facts on every run, pins them, and holds this set to them; it also runs
 * every entry point against a camera whose version does not come back and
 * checks that nothing outside this set went on the wire.
 */
export const SAFE_BEFORE_IDENTITY: ReadonlySet<Opcode> = new Set<Opcode>([
  OP.GET_ERROR_CODE,
  OP.GET_OPERATION_MODE,
  OP.GET_FIRMWARE_INFO,
]);

/** Every opcode that can change the camera, plus the info reads that only the
 *  flash path needs. Nothing in here may ever run during a dump. */
export const FLASH_OPS: ReadonlySet<Opcode> = new Set<Opcode>([
  OP.SET_FEATURED_FIRMWARE_DATA,
  OP.COMPLETE_MEMORY_UPGRADE,
  OP.SET_FIRMWARE_INFO_FEATURES,
  OP.SET_RAM_DATA_FEATURES,
]);

/**
 * Documents the split, and fails loudly if the two sets ever overlap.
 *
 * This is a safety property rather than a tidiness one: the read-only guarantee
 * of a dump is exactly "no opcode outside READ_ONLY_OPS is ever sent", and an
 * opcode present in both sets would silently void it. Called at module load, as
 * in the original, so a bad edit cannot ship.
 */
export function assertOpSetsDisjoint(): void {
  for (const op of FLASH_OPS) {
    if (READ_ONLY_OPS.has(op)) throw new Error(`op ${hex(op)} is in both command sets`);
  }
}

assertOpSetsDisjoint();

export function isReadOnlyOp(op: number): boolean {
  return READ_ONLY_OPS.has(op as Opcode);
}

export function isFlashOp(op: number): boolean {
  return FLASH_OPS.has(op as Opcode);
}

/** Every BeginFirmwareUpgrade selector exposes exactly one 64 KiB block. */
export const WINDOW_SIZE = 0x10000;

export const INTERFACE_NUMBER = 0;
export const CONFIGURATION_VALUE = 1;

/** USB_CORE_CTRL_T.EP0Buf[64]: longer OUT chunks are truncated. */
export const EP0_BUF = 64;

/**
 * 64 bytes is the EP0 max packet size, so a request never spans packets. Some
 * firmware serves most of a window at 256 and then never answers the request
 * that would empty it (seen on a 4.9.x PIR324, where the same bytes come back
 * fine in 64-byte requests). Larger is faster; this is the size that works
 * everywhere, and readArmed() falls back toward it on its own if a camera
 * stalls at whatever you pick.
 */
export const DEFAULT_READ_CHUNK = 64;

/**
 * The most a single control IN may ask for: ONE 64-byte EP0 packet, whatever
 * chunk the caller chose (TESTING.md sec.21.3).
 *
 * The LPC43xx boot ROM's USB ISR write-1-clears an endpoint's ENDPTCOMPLETE bit
 * only after that endpoint's handler returns, and EP0's handler primes the NEXT
 * packet of a control read itself. If the host finishes that packet before the
 * handler returns, its completion is erased unread, nothing more is primed, and
 * the read ends short with no status stage: packet 2 of a 128-byte or longer
 * read. At 96 MHz the window (~19-39 instructions) is shorter than any
 * transaction; at the 12 MHz / 500 kHz idle clocks of Compact PRO 4.9.2.0,
 * 4.9.1.15 and 1.0.3.2 it is not (FW-V1 Phase 44, item 42; TESTING.md sec.14.2).
 * A one-packet read is primed from the SETUP handler, never from inside the IN
 * handler, so it cannot lose a packet this way - which is how FW-V1's own sweep
 * reads a stage. The default was always 64; this makes a larger `--chunk` safe
 * rather than a gamble per packet, and keeps a lost read from shifting the rest
 * of a window by a request the firmware counted as served.
 */
export const MAX_CONTROL_IN = 64;

/** The floor readArmed() shrinks to before it gives up on a chunk. */
export const MIN_READ_CHUNK = 32;

/** Per control transfer. */
export const USB_TIMEOUT_MS = 5000;

/**
 * The shrink retries: a camera that ignored one request for 5 s will not
 * suddenly need 5 s more to ignore a smaller one, and this keeps a dead window
 * from costing half a minute.
 */
export const USB_PROBE_TIMEOUT_MS = 1500;

/* ---- CompleteMemoryUpgrade: how long the ONE transfer can take --------- *
 *
 * The firmware erases, programs and verifies inside the request, and only then
 * completes the transfer. What it does there, for the flash path's selector 0
 * (data type 0), is the same in all eight FW-V1 reconstructions of a writable
 * build — `cmd_CompleteMemoryUpgrade` (targets/compact_pro_ff/src/rpc_cmds.c)
 * calling `fw_validate_decrypt_program` and `update_write_boot_config`
 * (targets/compact_pro_ff/src/update.c):
 *
 *   1. sum the staged bytes and compare with the host's checksum      CPU
 *   2. decrypt with Key A, re-encrypt with the device's key          CPU
 *   3. erase the slot's 64 KiB block (`flash_erase_block`: unlock, one
 *      block erase, read the block back to check it is all 0xFF)      flash
 *   4. erase the NEXT block too, only if the length exceeds 0x10000    flash
 *   5. program the image, at most 65,536 B = 256 pages of 256 B      flash
 *   6. read it back and compare                                      CPU
 *   7. erase the boot-config block at 0x14010000                     flash
 *   8. program the 284-byte boot record: 2 pages                     flash
 *   9. read it back and compare                                      CPU
 *
 * Step 4 cannot run on the path this toolkit uses — BeginFirmwareUpgrade sets
 * the staging capacity to FLASH_BLOCK_BYTES (0x10000) and SetFeaturedFirmwareData
 * refuses to stage past it — but it is in the code, so the bound counts it,
 * and counts step 5 as 128 KiB (512 pages) to go with it.
 *
 * The part is a Winbond W25Q32FV (the firmware's own SPIFI device table: JEDEC
 * EF 40 16, 64 blocks of 64 KiB, 256-byte pages). Its datasheet, rev. J of
 * 2016-06-03, sec.9.6 "AC Electrical Characteristics", MAX column:
 * tBE2 (64 KB block erase) 2,000 ms, tPP (page program) 3 ms, tW (write status
 * register) 15 ms. Typical values are 150 ms, 0.7 ms and 10 ms.
 *
 *   block erases       3 x 2,000 ms                          = 6,000 ms
 *   page programs    514 x     3 ms   (512 image + 2 record) = 1,542 ms
 *   status writes      5 x    15 ms   (one per erase/program,
 *                                      counted, not verified) =    75 ms
 *   CPU work: two cipher passes and a sum over 64 KiB, three read-backs —
 *   single-digit milliseconds at the LPC43xx clock; an allowance of      500 ms
 *                                                              ---------
 *   worst case, every operation at its datasheet maximum        8,117 ms
 *
 * The path that can actually run (2 erases, 258 pages, 4 status writes) is
 * 5,334 ms at the maximums and about 0.52 s at the typical values.
 *
 * The deadline is TWICE the 8,117 ms bound, rounded up to a whole 5 s: 20 s,
 * the value this constant already had. It was right and was not being honoured:
 * under the CLI the `usb` package gave the transfer its own 1,000 ms default,
 * below the 5.3 s the reachable path can take (TESTING.md sec.11). The
 * transport now hands this number to the host stack, and in a browser, which
 * has no per-transfer timeout, it is the transport's own timer — so on either
 * host nothing ends a commit sooner than 20 s.
 */
const W25Q32FV_BLOCK_ERASE_64K_MAX_MS = 2000; /* tBE2 */
const W25Q32FV_PAGE_PROGRAM_MAX_MS = 3; /* tPP, one 256-byte page */
const W25Q32FV_WRITE_STATUS_MAX_MS = 15; /* tW */
const COMMIT_BLOCK_ERASES = 3;
const COMMIT_PAGE_PROGRAMS = 512 + 2;
const COMMIT_STATUS_WRITES = 5;
const COMMIT_CPU_ALLOWANCE_MS = 500;

/** The longest `CompleteMemoryUpgrade` can take, from the firmware's steps and the datasheet. */
export const COMMIT_WORST_CASE_MS =
  COMMIT_BLOCK_ERASES * W25Q32FV_BLOCK_ERASE_64K_MAX_MS +
  COMMIT_PAGE_PROGRAMS * W25Q32FV_PAGE_PROGRAM_MAX_MS +
  COMMIT_STATUS_WRITES * W25Q32FV_WRITE_STATUS_MAX_MS +
  COMMIT_CPU_ALLOWANCE_MS;

/** CompleteMemoryUpgrade erases and programs inside the transfer: 2 x the worst case, rounded up. */
export const USB_COMMIT_TIMEOUT_MS = 20000;

/** How long to let a camera finish leaving imaging mode. */
export const MODE_SETTLE_MS = 3000;

/** CompleteMemoryUpgrade transfer-checksum rejection. Checked before anything is
 *  erased, so a camera reporting it is untouched. */
export const ERR_BAD_CHECKSUM = 0x70000;

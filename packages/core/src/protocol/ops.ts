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
  /* --- used by the flash path only (see FLASH_OPS below) --- */
  GET_FIRMWARE_INFO: 0x4e,
  SET_FEATURED_FIRMWARE_DATA: 0x50,
  COMPLETE_MEMORY_UPGRADE: 0x51,
  SET_FIRMWARE_INFO_FEATURES: 0x55,
  SET_RAM_DATA_FEATURES: 0x5a,
} as const satisfies Record<string, number>;

export type OpName = keyof typeof OP;
export type Opcode = (typeof OP)[OpName];

/** Every opcode a dump is allowed to touch. The write path asserts against this
 *  set so a stray call cannot leak into a read-only run. */
export const READ_ONLY_OPS: ReadonlySet<Opcode> = new Set<Opcode>([
  OP.GET_ERROR_CODE,
  OP.SET_OPERATION_MODE,
  OP.GET_OPERATION_MODE,
  OP.GET_FEATURED_FIRMWARE_DATA,
  OP.BEGIN_FIRMWARE_UPGRADE,
]);

/** Every opcode that can change the camera, plus the info reads that only the
 *  flash path needs. Nothing in here may ever run during a dump. */
export const FLASH_OPS: ReadonlySet<Opcode> = new Set<Opcode>([
  OP.GET_FIRMWARE_INFO,
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

/** CompleteMemoryUpgrade erases and programs inside the transfer. */
export const USB_COMMIT_TIMEOUT_MS = 20000;

/** How long to let a camera finish leaving imaging mode. */
export const MODE_SETTLE_MS = 3000;

/** CompleteMemoryUpgrade transfer-checksum rejection. Checked before anything is
 *  erased, so a camera reporting it is untouched. */
export const ERR_BAD_CHECKSUM = 0x70000;

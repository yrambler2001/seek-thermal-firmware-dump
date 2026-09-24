/**
 * The full-flash preservation pipeline for the v1 locked line.
 *
 * A deliberate exception to this core's "read-only over the wire" posture:
 * these modules drive the raw type-7 write path (BeginFirmwareUpgrade modes
 * 7..9 + the token, SetFeaturedFirmwareData staging, CompleteMemoryUpgrade
 * commit) against the ACTIVE boot slot, because that is what in-place
 * preservation means. The general flash workflow refuses this generation for
 * good reason and is untouched; this directory is an operator-invoked tool
 * with its own gates, its own backups and its own honest risk note.
 */

export {
  buildV1Patch,
  conjugateCapture,
  keystream,
  sum16,
  verifyCapture,
  wordSum,
  xorWindowVerbatim,
  REBALANCE_WORD_OFFSET,
  V1_2014_PATCH_SITES,
  V1_PAYLOAD_VMA_BASE,
} from './patch.js';
export type { PatchSite, V1Patch } from './patch.js';

export {
  BACKUP_WINDOW_COUNT,
  BANKS,
  BLANK_CFG_BANK,
  BOOT_CONFIG_ADDRESS,
  BOOT_CONFIG_BYTES,
  CFG_MODE,
  WIDENED_MODE,
  WINDOW_BYTES,
  bankWindow,
  cfgWindow,
  parseBootConfig,
  preservationWindows,
  widenedWindow,
} from './windows.js';
export type { BankKey, SlotDetection } from './windows.js';

export {
  PostResetWedgeError,
  backupSlice,
  backupWindows,
  commitToBank,
  detectActiveSlot,
  drainExact,
  drainWholePart,
  postProcessDump,
  probeWidenedWindow,
  readVersion,
  resetDevice,
  resetOpPayload,
  runPreservationPipeline,
  verifyAgainstBackup,
  DRAIN_RETRIES,
  PROBE_OFFSET,
  READ_CHUNK,
  RESET_OP,
  STAGE_CHUNK,
} from './pipeline.js';
export type {
  BackupResult,
  PipelineArtifacts,
  PipelineOptions,
  PipelineRecord,
  SessionOpener,
  WindowBytes,
} from './pipeline.js';

/**
 * The five operations a user actually runs: dump, sweep, decrypt, device-info
 * and flash.
 *
 * Everything here is isomorphic and side-effect-free at the platform level — a
 * workflow returns `Artifact[]` and reports through a `Reporter`, and both the
 * React app and the Node CLI call exactly these functions.
 */

export type {
  ComparisonRow,
  DecryptResult,
  DecryptedSlot,
  DeviceState,
  DumpOptions,
  DumpResult,
  KeyPatchRecord,
  PreparedFlash,
  SlotState,
  SweepResult,
  WorkflowContext,
} from './types.js';
export {
  DEFAULT_DUMP_OPTIONS,
  deviceInfoOf,
  entryForAddress,
  isCancelled,
  profileInfoOf,
  resolveDumpOptions,
  slotByKey,
  transportInfoOf,
  unlockTokenOf,
  usesAuthChannel,
} from './types.js';

export { describeDevice, runDump } from './dump.js';
export { runSweep } from './sweep.js';
export {
  decryptDump,
  detectProfileForDump,
  evidenceFromDump,
  type DecryptOptions,
} from './decrypt.js';
export { assertFlashable, bootedSlot, readDeviceInfo, targetSlot } from './device-info.js';
export { flashInvalidatesAnalysis, prepareImage, writeFirmware } from './flash.js';

/**
 * Per-firmware-version support: the profile registry and its built-in families.
 *
 * Importing this barrel (or `registry.js` directly) registers the built-ins.
 */

export * from './types.js';
export {
  AMBIGUITY_MARGIN,
  CONFIDENT_SCORE,
  TIE_MARGIN,
  detectProfile,
  getProfile,
  hasCapability,
  listProfiles,
  registerProfile,
  requireCapability,
  unregisterProfile,
} from './registry.js';
export type { CapabilityName } from './registry.js';

export {
  ACCEPT_SUM,
  BOOT_CONFIG_BASE,
  DEVICE_KEY_SLOT_LENGTH,
  DEVICE_KEY_SLOT_OFFSET,
  FLASH_BASE,
  FLASH_K,
  FLASH_SIZE,
  GAP_ADDRESS,
  HDR_HI,
  HDR_LO,
  MODERN_BOOT,
  MODERN_CIPHER,
  MODERN_MEMORY,
  MODERN_SLOTS,
  MODERN_SWEEP_RANGE,
  SLOT_A_BASE,
  SLOT_B_BASE,
  SLOT_RECOVERY_BASE,
  SUBCMD_BOOTLOADER,
  SUBCMD_BOOT_CONFIG,
  SUBCMD_RECOVERY,
  SUBCMD_SLOT_A,
  SUBCMD_SLOT_B,
  SUBCMD_UPDATE_TARGET,
  WINDOW_SIZE,
  buildModernWindowMap,
  modern4x,
  modernWindowPlan,
} from './modern-4x.js';

export {
  LEGACY_BOOT,
  LEGACY_KNOWN_VERSIONS,
  LEGACY_MEMORY,
  LEGACY_SLOTS,
  LEGACY_SWEEP_RANGE,
  OLD_FW_UNLOCK_TOKEN,
  authPayload,
  buildLegacyWindowMap,
  legacyAuth,
  legacySelectorRows,
  legacyWindowPlan,
} from './legacy-auth.js';
export { agreedRows, buildWindowPlan, placeableAddresses } from './plan.js';
export { compact2016 } from './compact-2016.js';
export { compact2014, FIRST_READABLE_VERSION } from './compact-2014.js';
export { parseVersion, primaryVersion, versionsIn, versionSource } from './version.js';
export type { FirmwareVersion } from './version.js';
export { GENERIC_BASELINE, generic } from './generic.js';

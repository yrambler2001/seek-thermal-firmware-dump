/**
 * `@seek-fw/core` — the whole toolkit as one dependency-free, isomorphic
 * library.
 *
 * Nothing here touches the DOM, `process`, `node:fs` or a `Blob`. The only host
 * capability core depends on is WebCrypto's SHA-256, which is a global in both
 * browsers and Node. Workflows RETURN `Artifact[]`; the web app downloads them
 * and the CLI writes them to disk.
 *
 * The exports are grouped by layer, from the bottom up. Two names are aliased
 * because they collide across layers — `TransportInfo` (the live transport vs.
 * its manifest record) and `EmbeddedKeyTable` (the located key pair vs. its
 * manifest record) — and the aliases always go to the manifest side, since the
 * structural type is the one callers reach for more often.
 */

/* ---- bytes, hex and hashing ------------------------------------------ */
export {
  addrTag,
  asciiz,
  bytesToHex,
  concatBytes,
  equalBytes,
  findAll,
  hex,
  hexDump,
  hexToBytes,
  hexUp,
  isoStamp,
  parseNumber,
  sha256hex,
  utf8,
  viewOf,
} from './bytes.js';

/* ---- error taxonomy --------------------------------------------------- */
export { CancelledError, SeekError, errorMessage, isSeekError } from './errors.js';
export type { SeekErrorCode, SeekErrorOptions } from './errors.js';

/* ---- progress, logging and outputs ------------------------------------ */
export { collectingReporter, prefixed, silentReporter } from './events.js';
export type {
  Artifact,
  ArtifactEvent,
  LogEvent,
  LogLevel,
  ProgressEvent,
  Reporter,
  RunEvent,
} from './events.js';

/* ---- the cipher and cryptanalytic key recovery ------------------------ */
export {
  CANDIDATE_K,
  CHECK_ZERO_IDX,
  KEY_SUFFIX_RE,
  KNOWN_ZERO_IDX,
  BOOT_CONFIG_BASE,
  Xorshift128,
  checksum32,
  cloneState,
  cryptBytes,
  cryptImage,
  decryptImage,
  describeKeyTableMismatch,
  findEmbeddedKeyTable,
  findKeyCandidates,
  identifyKey,
  isEncryptedWord,
  keyFilenameSuffix,
  keyFromState,
  keyTableWhere,
  parseKeyFilenameSuffix,
  pickKeyTable,
  recoverKeyInfo,
  recoverState,
  resolveWhitening,
  sameState,
  stateFromKey,
  stateOf,
  storeKeyOf,
  xsNext,
} from './crypto/index.js';
export type {
  EmbeddedKeyTable,
  KeyConfidence,
  KeyIdentity,
  KeyPair,
  KeyTableCandidate,
  KeyUnderK,
  PickedKeyTable,
  RecoveredKey,
  SlotKeyEvidence,
  StoreKey,
  WhiteningResolution,
  Xorshift128State,
} from './crypto/index.js';

/* ---- image headers, footers and bank payloads ------------------------- */
export {
  ADJUST_OFFSET,
  DEFAULT_WINDOW_SIZE,
  FOOTER_MODEL_LENGTH,
  FOOTER_MODEL_OFFSET,
  FOOTER_SIZE,
  FOOTER_TAG,
  HEADER_OFFSET,
  HEADER_SIZE,
  IMAGE_MAGIC,
  LENGTH_OFFSET,
  MAX_IMAGE_LEN,
  SLOT_STEP,
  TRY_KEYS_MAX_LEN,
  assertBankPayload,
  bankPayloadSize,
  buildBankPayload,
  findImages,
  footerOffsetFor,
  parseFooter,
  parseImageHeader,
  setAcceptSum,
  transferSum16,
  versionString,
  wordSum32,
} from './image/index.js';
export type {
  AcceptSumResult,
  BankPayload,
  ImageFooter,
  ImageHeader,
  ImageSlot,
} from './image/index.js';

/* ---- USB protocol: opcodes, the transport boundary, the client -------- */
export {
  CONFIGURATION_VALUE,
  DEFAULT_READ_CHUNK,
  EP0_BUF,
  ERR_BAD_CHECKSUM,
  FLASH_OPS,
  INTERFACE_NUMBER,
  MIN_READ_CHUNK,
  MODE_SETTLE_MS,
  OP,
  READ_ONLY_OPS,
  SEEK_VENDOR_ID,
  SeekDevice,
  USB_COMMIT_TIMEOUT_MS,
  USB_PROBE_TIMEOUT_MS,
  USB_TIMEOUT_MS,
  WINDOW_SIZE,
  WebUsbTransport,
  assertOpSetsDisjoint,
  isFlashOp,
  isReadOnlyOp,
  u16Payload,
  withTimeout,
} from './protocol/index.js';
export type {
  ChunkListener,
  DeviceDescription,
  OpName,
  Opcode,
  ReadResult,
  Recipient,
  RecipientPreference,
  SeekDeviceOptions,
  TransportInfo,
  UsbBackend,
  UsbTransport,
  WebUsbDevice,
  WebUsbTransportOptions,
} from './protocol/index.js';

/* ---- firmware profiles: the registry and its built-in families -------- */
export {
  AMBIGUITY_MARGIN,
  CONFIDENT_SCORE,
  GENERIC_BASELINE,
  ACCEPT_SUM,
  DEVICE_KEY_SLOT_LENGTH,
  DEVICE_KEY_SLOT_OFFSET,
  FLASH_BASE,
  FLASH_K,
  FLASH_SIZE,
  GAP_ADDRESS,
  MODERN_BOOT,
  MODERN_CIPHER,
  MODERN_MEMORY,
  MODERN_SLOTS,
  MODERN_SWEEP_RANGE,
  OLD_FW_UNLOCK_TOKEN,
  SLOT_A_BASE,
  SLOT_B_BASE,
  SLOT_RECOVERY_BASE,
  SUPPORTED,
  TIE_MARGIN,
  buildLegacyWindowMap,
  buildModernWindowMap,
  compact2016,
  detectProfile,
  generic,
  getProfile,
  hasCapability,
  legacyAuth,
  listProfiles,
  modern4x,
  registerProfile,
  requireCapability,
  unsupported,
} from './profiles/index.js';
export type {
  BootPolicy,
  BootPrediction,
  CapabilityName,
  CipherProfile,
  DetectionResult,
  DetectionVerdict,
  DeviceEvidence,
  FirmwareProfile,
  MemoryLayout,
  ProfileCapabilities,
  ProfileId,
  ProfileMatch,
  SlotDescriptor,
  SlotKey,
  Support,
  UnreachableRange,
  WindowEntry,
} from './profiles/index.js';

/* ---- output packaging: manifests, READMEs and the ZIP writer ---------- */
export {
  buildBootloaderKeysSummary,
  buildDecryptionFailed,
  buildDecryptionNotAttempted,
  buildDecryptionSummary,
  buildDumpManifest,
  buildGapRecord,
  buildImageSummary,
  buildKeySummary,
  buildLegacyDumpManifest,
  buildOfflineDecryptManifest,
  buildSelectorRecord,
  buildSweepManifest,
  buildWindowRecord,
  buildZip,
  crc32,
  makeLegacyReadme,
  makeOfflineDecryptReadme,
  makeReadme,
  makeSweepReadme,
  manifestToJson,
  zipEntryCount,
  zipTotalDataSize,
} from './archive/index.js';
export type {
  BootloaderKeysSummary,
  DecryptionAttempted,
  DecryptionNotAttempted,
  DecryptionSummary,
  DeviceInfo,
  DumpManifest,
  EmbeddedKeyTable as EmbeddedKeyTableRecord,
  GapRecord,
  ImageSummary,
  KeySummary,
  LegacyDumpManifest,
  ManifestProfileInfo,
  OfflineDecryptManifest,
  OfflineDecryptSource,
  SelectorRecord,
  ShortfallFill,
  SweepManifest,
  TransportInfo as TransportInfoRecord,
  WindowRecord,
  WindowRecordError,
  WindowRecordRead,
} from './archive/index.js';

/* ---- the five workflows ----------------------------------------------- */
export {
  DEFAULT_DUMP_OPTIONS,
  assertFlashable,
  bootedSlot,
  decryptDump,
  describeDevice,
  detectProfileForDump,
  deviceInfoOf,
  entryForAddress,
  evidenceFromDump,
  flashInvalidatesAnalysis,
  isCancelled,
  prepareImage,
  profileInfoOf,
  readDeviceInfo,
  resolveDumpOptions,
  runDump,
  runSweep,
  slotByKey,
  targetSlot,
  transportInfoOf,
  unlockTokenOf,
  usesAuthChannel,
  writeFirmware,
} from './workflows/index.js';
export type {
  ComparisonRow,
  DecryptOptions,
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
} from './workflows/index.js';

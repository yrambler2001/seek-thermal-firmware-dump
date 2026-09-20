/* ==================================================================== *
 * Reading what a camera is actually running.
 *
 * This is the analysis the write path is built from: this camera's Key A, the
 * slot an upgrade would land in, and a footer template taken off the device.
 * Every one of those is a property of ONE camera, which is why the result is
 * RETURNED rather than stashed in a module global the way the original page's
 * `deviceState` was — carrying it across a device swap is how a payload built
 * for one unit gets sent to another.
 *
 * The careful distinction this file exists to preserve: "this slot decrypts
 * under its own key" and "the bootloader can key this slot" are different
 * questions. The GF(2) solve recovers whatever keystream a slot was written
 * with, so every slot decrypts and can pass the acceptance sum;
 * `image_try_keys()` only ever tries the store key and Key A. `identifyKey`
 * keeps those apart, and nothing here re-conflates them.
 * ==================================================================== */

import { asciiz, bytesToHex, hex, hexUp, sha256hex, viewOf } from '../bytes.js';
import { CancelledError, errorMessage, SeekError } from '../errors.js';
import { decryptImage } from '../crypto/cipher.js';
import {
  findKeyCandidates,
  identifyKey,
  pickKeyTable,
  storeKeyOf,
  type PickedKeyTable,
  type StoreKey,
} from '../crypto/keys.js';
import { CANDIDATE_K, recoverKeyInfo } from '../crypto/recover.js';
import {
  bankPayloadSize,
  footerOffsetFor,
  FOOTER_TAG,
  HEADER_OFFSET,
  HEADER_SIZE,
  IMAGE_MAGIC,
  parseFooter,
  parseImageHeader,
  TRY_KEYS_MAX_LEN,
  type ImageFooter,
  type ImageHeader,
} from '../image/header.js';
import { WINDOW_SIZE } from '../protocol/ops.js';
import type { SeekDevice } from '../protocol/client.js';
import { detectProfile, hasCapability, requireCapability } from '../profiles/registry.js';
import type {
  BootPrediction,
  DeviceEvidence,
  FirmwareProfile,
  SlotDescriptor,
  SlotKey,
  WindowEntry,
} from '../profiles/types.js';
import {
  entryForAddress,
  resolveDumpOptions,
  type DeviceState,
  type DumpOptions,
  type SlotState,
  type WorkflowContext,
} from './types.js';

/** Bytes of the bootloader block scanned for the key table. */
const BOOT_BLOCK_BYTES = 0x8000;
/** Bytes of the boot-config block read: cfg[0..3] plus room for the slot table. */
const BOOT_CONFIG_BYTES = 0x120;

/* ---- one slot ------------------------------------------------------- */

interface RawSlot {
  readonly present: boolean;
  readonly reason: string | null;
  readonly header: ImageHeader | null;
  readonly raw: Uint8Array | null;
  readonly footer: ImageFooter | null;
}

/**
 * Read one slot: enough for the header, then out to the end of its bank so the
 * "CODE" footer comes along too. Reads are sequential from the armed window, so
 * this is a single arm and two continuing reads.
 */
async function readSlot(
  device: SeekDevice,
  entry: WindowEntry,
  chunk: number,
  onChunk: (n: number) => void,
): Promise<RawSlot> {
  const none = (reason: string, header: ImageHeader | null): RawSlot => ({
    present: false,
    reason,
    header,
    raw: null,
    footer: null,
  });

  await device.armWindow(entry);
  const probeLen = HEADER_OFFSET + HEADER_SIZE;
  const head = await device.readArmed(chunk, probeLen, onChunk);
  if (head.data.length < probeLen) {
    return none(`short read (${String(head.data.length)} B)`, null);
  }

  const header = parseImageHeader(head.data);
  if (header === null) return none('could not parse an image header', null);
  if (header.magic !== IMAGE_MAGIC) {
    return none(`no image header (magic ${hexUp(header.magic)})`, header);
  }
  if (header.length < HEADER_OFFSET || header.length >= TRY_KEYS_MAX_LEN || header.length & 3) {
    return none(`header.length ${hexUp(header.length)} is out of range`, header);
  }

  const total = bankPayloadSize(header.length);
  const rest = await device.readArmed(chunk, total - head.data.length, onChunk);
  const raw = new Uint8Array(head.data.length + rest.data.length);
  raw.set(head.data, 0);
  raw.set(rest.data, head.data.length);
  if (raw.length < total) {
    return none(`bank read stopped at ${String(raw.length)}/${String(total)} B`, header);
  }

  return {
    present: true,
    reason: null,
    header,
    raw,
    footer: parseFooter(raw, footerOffsetFor(header.length)),
  };
}

interface AnalysedSlot extends RawSlot {
  readonly recovered: ReturnType<typeof recoverKeyInfo> | null;
  readonly plain: Uint8Array | null;
  readonly plainHeader: ImageHeader | null;
  readonly accepts: boolean;
  readonly footerOk: boolean;
  readonly sha256: string | null;
}

/**
 * Recover the slot's keystream state from its own ciphertext (the same GF(2)
 * solve the dump view uses), decrypt it, and check the bootloader's acceptance
 * sum.
 */
async function analyseSlot(slot: RawSlot, profile: FirmwareProfile): Promise<AnalysedSlot> {
  if (!slot.present || slot.raw === null || slot.header === null) {
    return {
      ...slot,
      recovered: null,
      plain: null,
      plainHeader: null,
      accepts: false,
      footerOk: false,
      sha256: null,
    };
  }
  const view = viewOf(slot.raw);
  const recovered = recoverKeyInfo(view, 0, slot.header.length, profile.cipher);
  const plain = decryptImage(view, 0, slot.header.length, recovered.state, profile.cipher);
  return {
    ...slot,
    recovered,
    plain,
    plainHeader: parseImageHeader(plain),
    accepts: recovered.checksum === profile.cipher.acceptanceSum,
    footerOk:
      slot.footer !== null &&
      slot.footer.tag === FOOTER_TAG &&
      slot.footer.length === slot.header.length,
    sha256: await sha256hex(plain),
  };
}

/* ---- upgrade-target confirmation ------------------------------------ */

/**
 * Arm the selector an upgrade uses and read its first bytes back, then see
 * which slot those bytes came from. This is a plain read — the write only ever
 * happens at CompleteMemoryUpgrade — and it turns "which slot would be written"
 * from an inference into an observation. Returns null when it cannot tell,
 * which is the normal case on a camera whose slots hold identical images.
 */
async function confirmUpgradeTarget(
  ctx: WorkflowContext,
  chunk: number,
  subcmd: number,
  address: number,
  byKey: ReadonlyMap<SlotKey, AnalysedSlot>,
): Promise<SlotKey | null> {
  const probeLen = HEADER_OFFSET + HEADER_SIZE;
  let head;
  try {
    await ctx.device.armWindow({ subcmd, address, note: 'upgrade target' });
    head = await ctx.device.readArmed(chunk, probeLen);
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    ctx.reporter.log(`  could not probe the upgrade window: ${errorMessage(error)}`, 'detail');
    return null;
  }
  if (head.data.length < probeLen) return null;

  const matches = (['a', 'b'] as const).filter((key) => {
    const slot = byKey.get(key);
    if (!slot?.raw || slot.raw.length < probeLen) return false;
    for (let i = 0; i < probeLen; i++) if (slot.raw[i] !== head.data[i]) return false;
    return true;
  });
  if (matches.length !== 1) {
    ctx.reporter.log(
      `  selector ${hex(subcmd)}'s window matches ${matches.length ? 'both slots' : 'neither slot'}` +
        ' — the slots are identical, so the target cannot be read off the wire',
      'detail',
    );
    return null;
  }
  return matches[0] ?? null;
}

/* ---- the read -------------------------------------------------------- */

/**
 * Read and analyse everything the flash path depends on.
 *
 * NEW versus the original: the evidence gathered along the way is fed to
 * `detectProfile`, so the returned state carries what the camera looks like as
 * well as what it was read as. `canFlash` additionally requires the acting
 * profile to declare `flash` supported — a read-only profile cannot be talked
 * into a write by a camera that happens to look right.
 */
export async function readDeviceInfo(
  ctx: WorkflowContext,
  options: Partial<DumpOptions> = {},
): Promise<DeviceState> {
  requireCapability(ctx.profile, 'deviceInfo');
  const args: DumpOptions = resolveDumpOptions(options);
  const { device, profile, reporter } = ctx;
  const chunk = args.chunk;
  const entries = profile.windowMap();
  const readAt = new Date().toISOString();

  /* Whether a PROTECTED bank opened on the plain 2-byte channel or only on the
   * 18-byte authenticated one is the single most decisive piece of detection
   * evidence there is, and it falls out of doing the reads anyway. */
  const armedProtectedBanks: WindowEntry[] = [];
  const noteArmed = (entry: WindowEntry): void => {
    armedProtectedBanks.push(entry);
  };

  reporter.log('firmware info selectors ...', 'detail');
  const build = await device.tryFwInfo(0, 36, 'build info');
  const version =
    build && build.length >= 4 ? [build[0], build[1], build[2], build[3]].join('.') : null;
  const buildString = build && build.length >= 4 ? asciiz(build.subarray(4)) : null;

  const boot = await device.tryFwInfo(1, 36, 'bootloader info');
  const bootloaderVersion =
    boot && boot.length >= 4 ? [boot[0], boot[1], boot[2], boot[3]].join('.') : null;
  const bootloaderString = boot && boot.length >= 4 ? asciiz(boot.subarray(4)) : null;

  const platformRaw = await device.tryFwInfo(20, 64, 'platform string');
  const platform = platformRaw ? asciiz(platformRaw) : null;

  const speed = await device.tryFwInfo(17, 2, 'USB port speed');
  let usbSpeed: string | null = null;
  if (speed && speed.length >= 2) {
    const bits = viewOf(speed).getUint16(0, true);
    usbSpeed =
      bits === 2 ? 'high (480 Mbit/s)' : bits === 0 ? 'full (12 Mbit/s)' : `code ${String(bits)}`;
  }

  const roots = await device.tryFwInfo(10, 64, 'firmware info roots');
  const activeSlotWord = roots && roots.length >= 12 ? viewOf(roots).getUint32(8, true) : null;

  const serial = await device.readSerial();
  if (version !== null) {
    reporter.log(`  running firmware ${version}${buildString ? `  ${buildString}` : ''}`, 'ok');
  }
  if (bootloaderString) reporter.log(`  bootloader ${bootloaderString}`, 'detail');
  if (serial !== null) reporter.log(`  serial ${serial}`, 'detail');

  /* ---- boot config ------------------------------------------------- */
  let cfg0: number | null = null;
  let cfgSlots: readonly number[] | null = null;
  const cfgEntry = entryForAddress(entries, profile.memory.bootConfigBase);
  reporter.log('');
  if (cfgEntry === null) {
    reporter.log(
      `no selector reaches the boot config at ${hex(profile.memory.bootConfigBase, 8)} on ` +
        `${profile.name} — boot prediction will be unavailable`,
      'warn',
    );
  } else {
    reporter.log(`boot config at ${hex(cfgEntry.address, 8)} ...`, 'detail');
    await device.armWindow(cfgEntry);
    noteArmed(cfgEntry);
    const cfg = await device.readArmed(chunk, BOOT_CONFIG_BYTES);
    if (cfg.data.length >= 16) {
      const cv = viewOf(cfg.data);
      cfg0 = cv.getUint32(0, true);
      cfgSlots = [1, 2, 3].map((i) => cv.getUint32(i * 4, true));
      reporter.log(`  cfg[0] = ${hexUp(cfg0)} — ${profile.boot.describeCfg0(cfg0)}`, 'detail');
    }
  }

  /* ---- bootloader block / key material ----------------------------- */
  let deviceKeySlot: Uint8Array | null = null;
  let candidates: ReturnType<typeof findKeyCandidates> = [];
  const bootEntry = entryForAddress(entries, profile.memory.flashBase);
  reporter.log('');
  if (bootEntry === null) {
    reporter.log(
      `no selector reaches the bootloader block at ${hex(profile.memory.flashBase, 8)} on ` +
        `${profile.name} — this camera's key table cannot be confirmed`,
      'warn',
    );
  } else {
    reporter.log(`bootloader block at ${hex(bootEntry.address, 8)} (key material) ...`, 'detail');
    await device.armWindow(bootEntry);
    const bootBlock = await device.readArmed(chunk, BOOT_BLOCK_BYTES);
    const keyAt = profile.memory.deviceKeySlotOffset;
    const keyLen = profile.memory.deviceKeySlotLength;
    deviceKeySlot =
      bootBlock.data.length >= keyAt + keyLen ? bootBlock.data.slice(keyAt, keyAt + keyLen) : null;
    candidates = findKeyCandidates(bootBlock.data, profile.memory.bootConfigBase);
    reporter.log(`  ${String(candidates.length)} key-table candidate(s)`, 'detail');
  }

  /* ---- the slots ---------------------------------------------------- */
  reporter.log('');
  const analysed: AnalysedSlot[] = [];
  const descriptors: readonly SlotDescriptor[] = profile.slots;
  const budget = descriptors.length * WINDOW_SIZE; /* upper bound; slots are usually 0xc000 */
  let done = 0;
  for (const descriptor of descriptors) {
    reporter.progress(done, budget, `Reading ${descriptor.name} ...`);
    reporter.log(`reading ${descriptor.name} at ${hex(descriptor.address, 8)} ...`, 'detail');
    const entry: WindowEntry = entryForAddress(entries, descriptor.address) ?? {
      subcmd: descriptor.subcmd,
      address: descriptor.address,
      note: descriptor.name,
    };
    let read: RawSlot;
    try {
      read = await readSlot(device, entry, chunk, (n) => {
        done += n;
        reporter.progress(done, budget);
      });
      noteArmed(entry);
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      read = {
        present: false,
        reason: errorMessage(error),
        header: null,
        raw: null,
        footer: null,
      };
    }
    analysed.push(await analyseSlot(read, profile));
  }
  reporter.progress(1, 1, 'Analysing ...');

  /* ---- key table ---------------------------------------------------- */
  const states = analysed
    .map((slot) => slot.recovered?.state)
    .filter((state): state is Uint32Array => state !== undefined);

  /* K and the acceptance TARGET are independent axes, so the table is tried
   * under each candidate K rather than only the profile's. The K that matches
   * is remembered: it, not the profile's, is the one an encrypt would have to
   * use, and a disagreement is a reason to refuse to write. */
  let keyTable: PickedKeyTable | null = null;
  let keyWhiteningK = profile.cipher.whiteningK;
  for (const K of [profile.cipher.whiteningK, ...CANDIDATE_K]) {
    const picked = pickKeyTable(candidates, states, K);
    if (picked) {
      keyTable = picked;
      keyWhiteningK = K;
      break;
    }
  }

  if (keyTable) {
    reporter.log('');
    reporter.log(
      `key table at dump offset ${hexUp(keyTable.offset, 6)} — confirmed against a slot's ` +
        'recovered keystream state',
      'ok',
    );
    reporter.log(`  Key A ${bytesToHex(keyTable.keyA)}`, 'detail');
    reporter.log(`  Key B ${bytesToHex(keyTable.keyB)}`, 'detail');
    if (keyWhiteningK !== profile.cipher.whiteningK) {
      reporter.log(
        `  it matches under K=${hexUp(keyWhiteningK)}, not ${profile.name}'s ` +
          `K=${hexUp(profile.cipher.whiteningK)} — writing under the wrong K would produce an ` +
          'image this camera cannot decrypt, so flashing stays disabled',
        'error',
      );
    }
  } else {
    reporter.log('');
    reporter.log("could not confirm this camera's key table — flashing is disabled", 'error');
  }

  const storeKey: StoreKey = storeKeyOf(deviceKeySlot, keyTable);

  /* ---- per-slot identification -------------------------------------- */
  const byKeyAnalysed = new Map<SlotKey, AnalysedSlot>();
  const slots: SlotState[] = [];
  const byKey = new Map<SlotKey, SlotState>();
  for (let i = 0; i < descriptors.length; i++) {
    const descriptor = descriptors[i];
    const slot = analysed[i];
    if (descriptor === undefined || slot === undefined) continue;
    byKeyAnalysed.set(descriptor.key, slot);

    const identity = identifyKey(
      { state: slot.recovered?.state ?? null, accepts: slot.accepts },
      keyTable,
      storeKey,
      keyWhiteningK,
    );
    const bootable = identity.bootable && slot.footerOk;

    const state: SlotState = {
      key: descriptor.key,
      name: descriptor.name,
      subcmd: descriptor.subcmd,
      address: descriptor.address,
      present: slot.present,
      reason: slot.reason,
      header: slot.header,
      raw: slot.raw,
      footer: slot.footer,
      recovered: slot.recovered,
      plain: slot.plain,
      plainHeader: slot.plainHeader,
      accepts: slot.accepts,
      footerOk: slot.footerOk,
      sha256: slot.sha256,
      keyName: identity.name,
      bootable,
    };
    slots.push(state);
    byKey.set(descriptor.key, state);

    if (!slot.present) {
      reporter.log(`${descriptor.name}: ${slot.reason ?? 'not readable'}`, 'warn');
    } else {
      reporter.log(
        `${descriptor.name}: firmware ${slot.plainHeader?.versionStr ?? '?'}, ` +
          `${String(slot.header?.length ?? 0)} B, ${identity.name ?? 'unknown key'}, ` +
          `acceptance ${slot.accepts ? 'ok' : 'FAILS'}, footer ${slot.footerOk ? 'ok' : 'BAD'}` +
          ` -> ${bootable ? 'bootable' : 'NOT bootable'}`,
        bootable ? 'ok' : 'warn',
      );
      if (slot.accepts && slot.footerOk && !identity.bootable) {
        reporter.log(
          '    it decrypts and checksums under its own key, but the bootloader only tries ' +
            `${storeKey.name} and Key A — so it will be skipped at boot`,
          'error',
        );
      }
    }
  }

  /* ---- boot prediction ---------------------------------------------- */
  let prediction: BootPrediction | null = null;
  let targetConfirmed: SlotKey | null = null;
  if (cfg0 !== null) {
    try {
      prediction = profile.boot.selectBootSlot(cfg0, (key) => byKey.get(key)?.bootable === true);
    } catch (error) {
      /* A profile whose bootloader was never decoded refuses to predict rather
       * than fabricating "booted A, would write B". That is not a failure of
       * this read: everything else it found is still reported. */
      if (error instanceof CancelledError) throw error;
      prediction = null;
      reporter.log('');
      reporter.log(`boot prediction unavailable: ${errorMessage(error)}`, 'warn');
    }
  }

  if (prediction !== null) {
    reporter.log('');
    reporter.log(
      `boot config replay: booted ${byKey.get(prediction.booted)?.name ?? prediction.booted}, ` +
        `so an upgrade would write ${byKey.get(prediction.target)?.name ?? prediction.target}`,
      'detail',
    );

    /* The replay above is inference. These two are the camera's own answer:
     * active_slot is the word fw_update_slot_address() reads, and the upgrade
     * selector arms the very window a write would land in — so reading it back
     * and matching it against the slots names the target from evidence. */
    if (activeSlotWord !== null) {
      const fromDevice: SlotKey = activeSlotWord === 0 ? 'b' : 'a';
      if (fromDevice !== prediction.target) {
        reporter.log(
          `  the camera's active-slot word says ${byKey.get(fromDevice)?.name ?? fromDevice}` +
            ' instead — trusting the camera',
          'warn',
        );
        prediction = { booted: prediction.booted, target: fromDevice };
      }
    }

    if (profile.boot.updateTargetSubcmd >= 0) {
      const targetAddress = byKey.get(prediction.target)?.address ?? profile.memory.flashBase;
      targetConfirmed = await confirmUpgradeTarget(
        ctx,
        chunk,
        profile.boot.updateTargetSubcmd,
        targetAddress,
        byKeyAnalysed,
      );
      if (targetConfirmed !== null && targetConfirmed !== prediction.target) {
        reporter.log(
          `  the window selector ${hex(profile.boot.updateTargetSubcmd)} arms is ` +
            `${byKey.get(targetConfirmed)?.name ?? targetConfirmed} — trusting that over the ` +
            'boot-config replay',
          'warn',
        );
        prediction = { booted: prediction.booted, target: targetConfirmed };
      }
    }

    const targetSlot = byKey.get(prediction.target);
    if (targetSlot) {
      reporter.log(
        `an upgrade writes ${targetSlot.name} at ${hex(targetSlot.address, 8)}` +
          (targetConfirmed !== null
            ? ' (confirmed by reading the window the upgrade selector arms)'
            : ''),
        'detail',
      );
    }
  }

  /* ---- family check and detection ------------------------------------ */
  const familyOk = slots.some((slot) => slot.accepts);
  if (!familyOk) {
    reporter.log('');
    reporter.log(
      `no slot on this camera decrypts to the ${hexUp(profile.cipher.acceptanceSum)} acceptance ` +
        `sum ${profile.name} expects — this is probably a different firmware family. ` +
        'Flashing is disabled.',
      'error',
    );
  }

  const evidence: DeviceEvidence = {
    ...(version !== null ? { firmwareVersion: version } : {}),
    ...(bootloaderVersion !== null ? { bootloaderVersion } : {}),
    ...(bootloaderString !== null && bootloaderString !== '' ? { bootloaderString } : {}),
    ...(platform !== null && platform !== '' ? { platform } : {}),
    ...(device.transport.description.productName !== null
      ? { productName: device.transport.description.productName }
      : {}),
    vendorId: device.transport.description.vendorId,
    productId: device.transport.description.productId,
    observedAcceptanceSums: slots
      .map((slot) => slot.recovered?.checksum)
      .filter((sum): sum is number => sum !== undefined),
    imageVersions: slots
      .map((slot) => slot.plainHeader?.versionStr)
      .filter((v): v is string => v !== undefined),
    ...(armedProtectedBanks.some((entry) => entry.auth !== true)
      ? { plainSelectorWorks: true }
      : {}),
    ...(armedProtectedBanks.some((entry) => entry.auth === true)
      ? { authSelectorRequired: true }
      : {}),
  };
  const detection = detectProfile(evidence);

  /* ---- the flash gate ------------------------------------------------ */
  const blocked: string[] = [];
  if (!keyTable) blocked.push("this camera's key table could not be confirmed");
  if (!familyOk) {
    blocked.push(
      `no slot decrypts to ${profile.name}'s ${hexUp(profile.cipher.acceptanceSum)} acceptance sum`,
    );
  }
  if (prediction === null) blocked.push('the slot an upgrade would write could not be determined');
  if (!hasCapability(profile, 'flash')) {
    const support = profile.capabilities.flash;
    blocked.push(
      `${profile.name} does not support flashing: ${support.supported ? '' : support.reason}`,
    );
  }
  if (keyWhiteningK !== profile.cipher.whiteningK) {
    blocked.push(
      `this camera's key table resolves under K=${hexUp(keyWhiteningK)} but ${profile.name} ` +
        `encrypts under K=${hexUp(profile.cipher.whiteningK)}`,
    );
  }
  if (!detection.ambiguous && detection.best.profile.id !== profile.id) {
    /* The evidence names a different family than the one we are acting under.
     * Key A would be this camera's, but the selector map, the cipher and the
     * boot policy would not — so refuse and let the user pick deliberately. */
    blocked.push(
      `the evidence says this camera is ${detection.best.profile.name}, not ${profile.name} ` +
        `(${detection.best.reasons.join('; ')})`,
    );
  }

  if (blocked.length > 0) {
    reporter.log('');
    for (const reason of blocked) reporter.log(`flashing disabled: ${reason}`, 'error');
  }

  const state: DeviceState = {
    readAt,
    profile,
    detection,
    evidence,
    description: device.transport.description,
    version,
    buildString,
    bootloaderVersion,
    bootloaderString,
    platform,
    usbSpeed,
    activeSlotWord,
    serial,
    cfg0,
    cfgSlots,
    deviceKeySlot,
    keyTableCandidates: candidates.length,
    keyTable,
    keyWhiteningK,
    storeKey,
    slots,
    byKey,
    boot: prediction,
    targetConfirmed,
    familyOk,
    canFlash: blocked.length === 0,
    flashBlockedBy: blocked,
  };

  reporter.progress(
    1,
    1,
    state.canFlash
      ? `Read. ${String(slots.filter((s) => s.present).length)}/${String(descriptors.length)} slots readable.`
      : 'Read, but this camera cannot be flashed from here — see the log.',
  );
  return state;
}

/** The slot the camera booted from, when the boot policy could name one. */
export function bootedSlot(state: DeviceState): SlotState | null {
  return state.boot === null ? null : (state.byKey.get(state.boot.booted) ?? null);
}

/** The slot an upgrade would overwrite, when the boot policy could name one. */
export function targetSlot(state: DeviceState): SlotState | null {
  return state.boot === null ? null : (state.byKey.get(state.boot.target) ?? null);
}

/** Thrown when a workflow is handed an analysis that cannot support a write. */
export function assertFlashable(state: DeviceState): void {
  if (state.canFlash) return;
  throw new SeekError(
    'flash/refused',
    `this camera cannot be flashed from here: ${state.flashBlockedBy.join('; ')}`,
    { detail: { blockedBy: state.flashBlockedBy } },
  );
}

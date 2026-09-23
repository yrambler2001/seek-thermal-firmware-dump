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
import { detectProfile, requireCapability } from '../profiles/registry.js';
import type {
  BootPrediction,
  DeviceEvidence,
  FirmwareProfile,
  SlotDescriptor,
  SlotKey,
  WindowEntry,
  WindowPlan,
} from '../profiles/types.js';
import {
  entryForAddress,
  resolveDumpOptions,
  type DeviceState,
  type DumpOptions,
  type SlotState,
  type WorkflowContext,
  warnIfRecipientFellBack,
} from './types.js';
import { planForDevice } from './window-plan.js';

/** Bytes of the bootloader block scanned for the key table. */
const BOOT_BLOCK_BYTES = 0x8000;
/** Bytes of the boot-config block read: cfg[0..3] plus room for the slot table. */
const BOOT_CONFIG_BYTES = 0x120;

/* ---- one slot ------------------------------------------------------- */

interface RawSlot {
  readonly present: boolean;
  readonly reason: string | null;
  /**
   * True when the slot was not read: the read threw, or the plan has no window
   * for it and nothing was armed. A clean read of an empty slot is false.
   */
  readonly unread?: boolean;
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

/**
 * Why a slot the running firmware's plan does not reach was not read.
 *
 * NO SUBCOMMAND IS GUESSED IN ITS PLACE. The slot descriptor carries one, but
 * that number is the profile's label for the slot on the builds it was decoded
 * from. On the camera in front of us only the plan says what arms what, and a
 * plan with no window at this address (`compact-2014` plans none at all, for
 * any version) is that firmware's answer. This read used to fall back to the
 * descriptor's subcommand, so a `compact-2014` read of a camera past the
 * identity gate armed 7, 8 and 9 under a profile whose plan reads nothing.
 */
function notInPlan(plan: WindowPlan, version: string | null, address: number): string {
  return (
    `not readable on firmware ${version ?? 'of unknown version'}: its plan (${plan.table}) has ` +
    `no window at ${hex(address, 8)}, so nothing was armed for it`
  );
}

/**
 * The upgrade-target selector, if the running firmware's own table has it.
 *
 * The profile's boot policy names the subcommand an upgrade arms (0 on the
 * post-2018 line, none on the legacy line); whether THIS build switches on it
 * is its table's to say. The camera computes the block, so the row carries no
 * address, but it has to be there, and plain, because the read-back here and
 * `writeFirmware` both send the plain 2-byte payload.
 */
function upgradeSelectorIn(plan: WindowPlan, profile: FirmwareProfile): number | null {
  const subcmd = profile.boot.updateTargetSubcmd;
  if (subcmd < 0) return null;
  return plan.selectors.some((row) => row.subcmd === subcmd && row.channel === 'plain')
    ? subcmd
    : null;
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
  const readAt = new Date().toISOString();

  /* Which channel each bank actually armed on, which falls out of doing the
   * reads anyway. Only SUCCESSES land here — `armWindow` throws on a refusal
   * rather than returning — so nothing built from this list can say a channel
   * was refused, only that one worked. The banks that reach it are the ones the
   * legacy firmware locks behind the authenticated channel (boot config, the
   * image slots) plus the bootloader block at flashBase, which the 2016-2017
   * builds refuse on every channel and the 2014 builds from 0.9.0.2 arm with
   * the token. */
  const armedBanks: WindowEntry[] = [];
  const noteArmed = (entry: WindowEntry): void => {
    armedBanks.push(entry);
  };

  /* THE BUILD FIRST, AND NOTHING ELSE UNTIL IT IS KNOWN. This read used to
   * open with `tryFwInfo(0)` — SetFirmwareInfoFeatures, a SETTER — and to arm
   * the boot config, the bootloader block and the slots whatever the version
   * said, or whether it said anything: on 0.3.0.1 every one of those arms is
   * `EnterBootloaderMode`. It now goes through the dump's own gate: one
   * unarmed GetFirmwareInfo (in `SAFE_BEFORE_IDENTITY`), a refusal for no
   * version or a build that predates the dump protocol, and otherwise THIS
   * build's own table for every arm below. Selector 0 of GetFirmwareInfo is
   * the build block, so the unarmed read is the same bytes `tryFwInfo(0)` got. */
  const { firmware, plan } = await planForDevice(ctx, 'read the device info');
  const version = firmware.version;
  const buildString = firmware.buildString;
  /* EVERY ARM BELOW COMES FROM THIS PLAN, and a block it has no window for is
   * reported as not readable on this firmware rather than armed some other
   * way: the boot config, the bootloader block, each slot, and the upgrade
   * target, which must be a row of this build's table too. */
  const entries = plan.windows;
  const updateTargetSubcmd = upgradeSelectorIn(plan, profile);
  warnIfRecipientFellBack(ctx);

  reporter.log('firmware info selectors ...', 'detail');
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
    /* Counts as evidence like the other two arms do. No shipped profile puts
     * this block on a different channel from its boot config, so today it can
     * only confirm what the boot-config arm already said; a family that splits
     * them is exactly the case this was silently missing. */
    noteArmed(bootEntry);
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
  /* The selector each slot was armed with, from the plan, or null for none. */
  const armedWith: (number | null)[] = [];
  const descriptors: readonly SlotDescriptor[] = profile.slots;
  const budget = descriptors.length * WINDOW_SIZE; /* upper bound; slots are usually 0xc000 */
  let done = 0;
  for (const descriptor of descriptors) {
    reporter.progress(done, budget, `Reading ${descriptor.name} ...`);
    /* The plan's entry or nothing: see `notInPlan`. */
    const entry = entryForAddress(entries, descriptor.address);
    armedWith.push(entry?.subcmd ?? null);
    let read: RawSlot;
    if (entry === null) {
      read = {
        present: false,
        reason: notInPlan(plan, version, descriptor.address),
        unread: true,
        header: null,
        raw: null,
        footer: null,
      };
    } else {
      reporter.log(`reading ${descriptor.name} at ${hex(descriptor.address, 8)} ...`, 'detail');
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
          unread: true,
          header: null,
          raw: null,
          footer: null,
        };
      }
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
      subcmd: armedWith[i] ?? null,
      address: descriptor.address,
      present: slot.present,
      reason: slot.reason,
      unread: slot.unread === true,
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

    /* The selector comes from this build's table (`upgradeSelectorIn`), not
     * from the profile alone: a profile's number is armed only where the
     * running firmware's own switch has that row. */
    if (updateTargetSubcmd !== null) {
      const targetAddress = byKey.get(prediction.target)?.address ?? profile.memory.flashBase;
      targetConfirmed = await confirmUpgradeTarget(
        ctx,
        chunk,
        updateTargetSubcmd,
        targetAddress,
        byKeyAnalysed,
      );
      if (targetConfirmed !== null && targetConfirmed !== prediction.target) {
        reporter.log(
          `  the window selector ${hex(updateTargetSubcmd)} arms is ` +
            `${byKey.get(targetConfirmed)?.name ?? targetConfirmed} — trusting that over the ` +
            'boot-config replay',
          'warn',
        );
        prediction = { booted: prediction.booted, target: targetConfirmed };
      }
    } else if (profile.boot.updateTargetSubcmd >= 0) {
      reporter.log(
        `  this firmware's own table (${plan.table}) has no upgrade-target selector ` +
          `${hex(profile.boot.updateTargetSubcmd)}, so nothing was armed to confirm the target`,
        'warn',
      );
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
    /* Both flags say which channel WORKED; neither says the other was refused.
     * Every arm above used the channel this profile's own map names for that
     * bank, and the other channel is never tried.
     *
     * `plainSelectorWorks` survives that as an observation about the camera:
     * the legacy firmware refuses the plain 2-byte channel on these banks, so a
     * plain arm of one rules that family out.
     *
     * `authSelectorWorks` does not, and is named for what it is. Under
     * `legacy-auth` every protected bank carries `auth: true`, so it is set on
     * every run and describes the map we chose more than the camera — which is
     * why no profile treats it as decisive. The stronger claim, "the
     * authenticated channel is REQUIRED", needs the one measurement nothing
     * here takes: arm a protected bank with the plain 2-byte payload and see it
     * refused. `runSweep` under a profile whose map carries no token already
     * probes precisely that (every selector, plain channel, armed or stalled);
     * its table is simply not fed back into evidence. */
    ...(armedBanks.some((entry) => entry.auth !== true) ? { plainSelectorWorks: true } : {}),
    ...(armedBanks.some((entry) => entry.auth === true) ? { authSelectorWorks: true } : {}),
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
  /* The original threw out of readDeviceInfo the moment any slot's window
   * refused to arm, so a partial picture could never reach the write path at
   * all. Reporting the rest of the read is more useful than throwing it away,
   * but the refusal has to survive: a slot that was never read could be the
   * one an upgrade overwrites, and `confirmUpgradeTarget` cannot match a
   * window against bytes it does not have. */
  for (const slot of slots) {
    if (slot.unread) {
      blocked.push(`${slot.name} could not be read (${slot.reason ?? 'unknown error'})`);
    }
  }
  const flashSupport = profile.capabilities.flash;
  if (!flashSupport.supported) {
    blocked.push(`${profile.name} does not support flashing: ${flashSupport.reason}`);
  }
  /* A profile that writes through a selector this build's table does not have
   * has no window to write, and `writeFirmware` would refuse on the state
   * anyway; saying so here keeps the button honest. A profile that names no
   * selector at all is already blocked by its capability, or by the write. */
  if (profile.boot.updateTargetSubcmd >= 0 && updateTargetSubcmd === null) {
    blocked.push(
      `there is no upgrade-target selector ${hex(profile.boot.updateTargetSubcmd)} in this ` +
        `firmware's own table (${plan.table}), so there is no window to write`,
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
     * boot policy would not — so refuse and let the user pick deliberately.
     *
     * Honestly: with the families that ship here this refusal cannot be the
     * first one to fire, and is kept as defence in depth rather than as
     * protection anyone relies on. `modern-4x` is the only profile that
     * declares `flash` supported, and every entry in `buildModernWindowMap()`
     * is plain — so any arm at all sets `plainSelectorWorks`, which zeroes
     * `legacy-auth`; the only other family that can then win is `compact-2016`,
     * and it wins only on a slot summing to 0 with none summing to 0xFFFF,
     * which is `familyOk === false` and therefore already in `blocked`. Under
     * every other profile `capabilities.flash` is unsupported and blocks above.
     * It stays because that chain is a property of today's four profiles, not
     * of the design: a family added later can win on evidence the family check
     * cannot see, and this is the only check that would catch it.
     *
     * This is deliberately NOT an auto-adopt. Detection needs the slots, and
     * which addresses the slots live at is itself a property of the profile,
     * so a read always commits to one family before it can judge the family.
     * Switching silently at this point would make this very refusal vacuous
     * and would change what the tool acts under without the user asking. A
     * caller that wants the detected family re-reads under it explicitly —
     * one extra read is a cheap price for the adoption being a decision
     * somebody made rather than one the code made quietly. */
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
    updateTargetSubcmd,
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

/* ==================================================================== *
 * Writing a firmware image to a camera.
 *
 * This is the code that can brick a camera, so every guard the original page
 * grew is carried over here unchanged, and none of them is softened:
 *
 *   BeginFirmwareUpgrade(0)   arms the descriptor at fw_update_slot_address(),
 *                             i.e. the slot the camera did NOT boot from, with
 *                             a 64 KiB cap.
 *   SetFeaturedFirmwareData   appends <= 64 B per call into a RAM staging
 *                             buffer (EP0Buf is 64 B; longer OUT chunks are
 *                             silently truncated by the device).
 *   CompleteMemoryUpgrade(s)  checks sum(staged bytes) & 0xFFFF == s, then
 *                             decrypts with Key A, re-encrypts with Key B or
 *                             the per-device key, erases the 64 KiB block,
 *                             programs, verifies, and rewrites cfg[0] to point
 *                             at that slot.
 *
 * The two structural facts that make this dangerous, and the two guards that
 * answer them, live in `image/bank.ts`: a bank is image + 0xFF pad + a "CODE"
 * footer (`buildBankPayload`), and anything else must not be streamed
 * (`assertBankPayload`). What lives HERE is everything that is about a
 * particular camera: its key table, its target slot, its footer.
 * ==================================================================== */

import { bytesToHex, equalBytes, hex, hexUp, viewOf } from '../bytes.js';
import { CancelledError, errorMessage, SeekError } from '../errors.js';
import {
  describeKeyTableMismatch,
  findEmbeddedKeyTable,
  identifyKey,
  keyFilenameSuffix,
  keyTableWhere,
  parseKeyFilenameSuffix,
} from '../crypto/keys.js';
import { recoverState } from '../crypto/recover.js';
import { assertBankPayload, buildBankPayload, transferSum16 } from '../image/bank.js';
import {
  FOOTER_TAG,
  HEADER_OFFSET,
  HEADER_SIZE,
  IMAGE_MAGIC,
  LENGTH_OFFSET,
  parseImageHeader,
  TRY_KEYS_MAX_LEN,
} from '../image/header.js';
import {
  DEFAULT_READ_CHUNK,
  EP0_BUF,
  ERR_BAD_CHECKSUM,
  USB_COMMIT_TIMEOUT_MS,
} from '../protocol/ops.js';
import { requireCapability } from '../profiles/registry.js';
import { bootedSlot, targetSlot } from './device-info.js';
import {
  isCancelled,
  type ComparisonRow,
  type DeviceState,
  type KeyPatchRecord,
  type PreparedFlash,
  type SlotState,
  type WorkflowContext,
  warnIfRecipientFellBack,
} from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll the device's status word this often while streaming. */
const STATUS_POLL_MASK = 0xfff; /* every 4 KiB */
/** Report progress this often. */
const PROGRESS_MASK = 0x7ff;

/**
 * An error raised after the commit transfer, when flash may already have
 * changed. A caller seeing this MUST discard its `DeviceState` and re-read
 * before doing anything else — the original dropped the page's global; there is
 * no global now, so the contract is carried on the error itself.
 */
export function flashInvalidatesAnalysis(error: unknown): boolean {
  return error instanceof SeekError && error.detail?.dropAnalysis === true;
}

/* ==================================================================== *
 * prepareImage
 * ==================================================================== */

/**
 * Turn a decrypted firmware image into a bank payload for THIS camera.
 *
 * Nothing is sent here. Every refusal below is a case where continuing could
 * leave a camera that accepts the flash and then will not boot it, and each one
 * is the original page's, verbatim in behaviour and in explanation.
 */
export function prepareImage(
  state: DeviceState,
  bytes: Uint8Array,
  fileName: string,
): PreparedFlash {
  /* The hard gate first: a profile that does not declare `flash` never reaches
   * the point of having a payload lying around. */
  requireCapability(state.profile, 'flash');

  if (!state.canFlash) {
    throw new SeekError(
      'flash/refused',
      "read the device info first — the camera's Key A and target slot come from it" +
        (state.flashBlockedBy.length > 0 ? ` (${state.flashBlockedBy.join('; ')})` : ''),
      { detail: { blockedBy: state.flashBlockedBy } },
    );
  }
  const keyTable = state.keyTable;
  const target = targetSlot(state);
  if (keyTable === null || target === null) {
    throw new SeekError(
      'flash/refused',
      "the device analysis does not name this camera's key table and target slot",
    );
  }

  if (bytes.length < HEADER_OFFSET + HEADER_SIZE) {
    throw new SeekError('image/malformed', 'file is too small to hold an image header');
  }
  if (bytes.length & 3) {
    throw new SeekError(
      'image/malformed',
      `image size must be a multiple of 4 (got ${String(bytes.length)} B)`,
    );
  }
  if (bytes.length >= TRY_KEYS_MAX_LEN) {
    throw new SeekError(
      'image/unsupported',
      `image is ${String(bytes.length)} B; the bootloader rejects any header.length >= ` +
        `${hexUp(TRY_KEYS_MAX_LEN)}, so it would never boot`,
      { detail: { length: bytes.length, max: TRY_KEYS_MAX_LEN } },
    );
  }

  const dv = viewOf(bytes);
  const magic = dv.getUint32(HEADER_OFFSET, true);
  if (magic !== IMAGE_MAGIC) {
    throw new SeekError(
      'image/malformed',
      `no image header at ${hexUp(HEADER_OFFSET)} (magic ${hexUp(magic)}, expected ` +
        `${hexUp(IMAGE_MAGIC)}) — this must be a decrypted Seek firmware image, not an ` +
        'encrypted slot or a flash dump',
      { detail: { magic, expected: IMAGE_MAGIC } },
    );
  }

  const sp = dv.getUint32(0, true);
  const entry = dv.getUint32(4, true);
  if (sp >>> 24 !== 0x10 && sp >>> 24 !== 0x20) {
    throw new SeekError(
      'image/malformed',
      `initial stack pointer ${hexUp(sp)} is not in LPC43xx SRAM — this does not look decrypted`,
    );
  }
  if (sp & 3) {
    throw new SeekError(
      'image/malformed',
      `initial stack pointer ${hexUp(sp)} is not word-aligned`,
    );
  }
  if (!(entry & 1)) {
    throw new SeekError('image/malformed', `reset vector ${hexUp(entry)} is not a Thumb address`);
  }

  const declaredBefore = dv.getUint32(LENGTH_OFFSET, true);
  const myKeyA = keyTable.keyA;
  const myKeyB = keyTable.keyB;

  /* ---- retarget the image's own key table to this camera ------------------
   * The keys inside the image are the ones it will use once it runs. If they
   * belong to the camera it was dumped from rather than this one, every later
   * upgrade lands under a key this bootloader cannot try. The dump view puts
   * the source keys in the filename precisely so they can be found and
   * replaced here. */
  const named = parseKeyFilenameSuffix(fileName);
  if (named === null) {
    /* Without the keys in the name there is no way to tell whether this image
     * embeds a table for this camera, for another one, or none at all — and the
     * wrong pair silently stops the camera taking any future update. Refusing is
     * the only answer that cannot be wrong. */
    const mine = findEmbeddedKeyTable(bytes, myKeyA, myKeyB);
    throw new SeekError(
      'flash/refused',
      "this file's name does not carry its key pair. " +
        (mine
          ? `The image does contain this camera's keys, at ${keyTableWhere(mine)} — rename the ` +
            `file to end with "${keyFilenameSuffix(myKeyA, myKeyB)}.bin" to say so deliberately.`
          : "The image does not contain this camera's key pair either, so it carries another " +
            "camera's keys or none at all. Re-dump it with this tool — decrypted files come out " +
            'named with the keys they actually contain.'),
      { detail: { containsThisCamerasKeys: mine !== null } },
    );
  }

  const srcA = named.keyA;
  const srcB = named.keyB;
  const at = findEmbeddedKeyTable(bytes, srcA, srcB);
  if (at === null) {
    throw new SeekError(
      'image/key-table',
      `the filename claims Key A ${bytesToHex(srcA)} and Key B ${bytesToHex(srcB)}, but ` +
        `${describeKeyTableMismatch(bytes, srcA, srcB)}. Both keys must be present, exactly ` +
        'once each — this file has been renamed, edited, or is not the one those keys came from',
    );
  }
  for (const offset of [at.offsetA, at.offsetB]) {
    if (offset < HEADER_OFFSET + HEADER_SIZE && offset + 16 > HEADER_OFFSET) {
      /* Those bytes are stored verbatim so the bootloader can read the length
       * before it has a key. Rewriting them would change what the bootloader
       * reads, not what the application uses. */
      throw new SeekError(
        'flash/refused',
        `this image keeps a key at ${hexUp(offset)}, inside the cleartext header window — ` +
          'refusing to patch it',
        { detail: { offset } },
      );
    }
  }

  /* The two keys must occupy DISTINCT bytes.
   *
   * `findEmbeddedKeyTable` checks each key occurs exactly once, independently,
   * so a filename naming the same key twice satisfies it with
   * `offsetA === offsetB` — and the patch below then writes Key A and Key B to
   * the same 16 bytes, leaving Key A nowhere in the image. The original
   * accepted that and offered the payload anyway, which is exactly the "every
   * later upgrade lands under a key the bootloader cannot try" outcome this
   * whole mechanism exists to prevent. */
  if (at.offsetA < at.offsetB + 16 && at.offsetB < at.offsetA + 16) {
    throw new SeekError(
      'image/key-table',
      `the filename's Key A and Key B resolve to overlapping bytes at ${hexUp(at.offsetA)} ` +
        `and ${hexUp(at.offsetB)} — they must be two distinct 16-byte values, so this is ` +
        'either the same key named twice or a file that does not carry a real key pair',
      { detail: { offsetA: at.offsetA, offsetB: at.offsetB } },
    );
  }

  /* The original expressed this as "the source key occurs exactly once inside
   * the 16 bytes of my key", which is equality with extra steps. */
  const alreadyMine = equalBytes(srcA, myKeyA) && equalBytes(srcB, myKeyB);
  let image = bytes;
  if (!alreadyMine) {
    image = bytes.slice();
    image.set(myKeyA, at.offsetA);
    image.set(myKeyB, at.offsetB);
  }

  const keyPatch: KeyPatchRecord = {
    offsetA: at.offsetA,
    offsetB: at.offsetB,
    adjacent: at.adjacent,
    where: keyTableWhere(at),
    fromA: bytesToHex(srcA),
    fromB: bytesToHex(srcB),
    toA: bytesToHex(myKeyA),
    toB: bytesToHex(myKeyB),
    changed: !alreadyMine,
  };
  const carriesMine = findEmbeddedKeyTable(image, myKeyA, myKeyB) !== null;
  if (!carriesMine) {
    /* The patch is the whole point: after it, the image must carry THIS
     * camera's pair. If it does not, the keys did not land where they were
     * meant to and the camera would re-encrypt its next upgrade under a key
     * its bootloader cannot try. The original computed this and never looked
     * at it. */
    throw new SeekError(
      'image/key-table',
      "after retargeting, the image does not carry this camera's key pair exactly once — " +
        'refusing to build a payload whose later upgrades the bootloader could not key',
    );
  }

  /* Carry over a footer that is already on this camera: its image_id, version
   * and model string stay whatever the camera shipped with, and only footer[1]
   * gets patched. Prefer the target slot's own; fall back to any valid one. */
  const hasFooter = (slot: SlotState | null): boolean =>
    slot !== null && slot.footer !== null && slot.footer.tag === FOOTER_TAG;
  const source = hasFooter(target) ? target : (state.slots.find((s) => hasFooter(s)) ?? null);
  const templateBytes = source?.footer?.raw ?? null;
  const footerFrom = source?.name ?? null;

  const built = buildBankPayload(
    image,
    myKeyA,
    templateBytes,
    state.profile.cipher,
    state.profile.memory.windowSize,
  );
  assertBankPayload(built.payload);

  const mine = parseImageHeader(built.image);
  if (mine === null) {
    throw new SeekError('image/malformed', 'the stamped image no longer parses as one');
  }

  /* Nothing here is blocking — a deliberate upgrade or downgrade changes all of
   * these. It is here because picking the wrong decrypted file looks exactly
   * like picking the right one, and the camera cannot tell you afterwards. */
  const running = bootedSlot(state);
  const now = running?.plainHeader ?? null;
  const compare: ComparisonRow[] =
    now === null
      ? []
      : (
          [
            ['Firmware version', now.versionStr, mine.versionStr],
            ['Image id', hexUp(now.imageId), hexUp(mine.imageId)],
            ['Initial SP', hexUp(now.sp), hexUp(mine.sp)],
            ['Reset vector', hexUp(now.entry), hexUp(mine.entry)],
            ['Size', `${String(now.length)} B`, `${String(built.length)} B`],
          ] as const
        )
          .filter(([, a, b]) => a !== b)
          .map(([field, onCamera, inImage]) => ({ field, onCamera, inImage }));
  const layoutMoved = now !== null && (now.sp !== mine.sp || now.entry !== mine.entry);

  /* If the slot an upgrade writes already holds a valid image under a key the
   * bootloader cannot use, the application demonstrably re-encrypts with that
   * key — so this write will land in the same unbootable state. */
  const rekeyRisk = target.present && target.accepts && target.footerOk && !target.bootable;

  return {
    compare,
    layoutMoved,
    keyPatch,
    carriesMine,
    rekeyRisk,
    targetName: target.name,
    bootedName: running?.name ?? null,
    runningSlot: running?.name ?? null,
    fileName,
    originalSize: image.length,
    declaredBefore,
    lengthStamped: declaredBefore !== image.length,
    length: built.length,
    adjust: built.adjust,
    header: mine,
    keyA: myKeyA,
    payload: built.payload,
    footerOffset: built.footerOffset,
    footer: built.footer,
    footerFrom,
    sum16: transferSum16(built.payload),
  };
}

/* ==================================================================== *
 * writeFirmware
 * ==================================================================== */

/**
 * Stream a prepared payload into the upgrade window and commit it.
 *
 * `state` must be the SAME analysis `prep` was built from: Key A, the target
 * slot and the footer template are all properties of one camera, and a payload
 * built for one unit must never be streamed at another.
 */
export async function writeFirmware(
  ctx: WorkflowContext,
  state: DeviceState,
  prep: PreparedFlash,
): Promise<void> {
  /* `state.profile`, NOT `ctx.profile`: everything below — the update-target
   * selector, the cipher that built `prep` — comes from the analysed state, so
   * a gate that inspected a different object than the one it protects would be
   * worth nothing. They are normally the same; this is the last line. */
  requireCapability(state.profile, 'flash');
  const { device, reporter } = ctx;

  if (!device.transport.isOpen) await device.transport.open(); /* a dump closes it */
  warnIfRecipientFellBack(ctx);

  /* The analysis can go stale between preparing and writing — a disconnect
   * during the rescue dump drops it — and a payload is only valid for the
   * camera whose Key A built it. */
  if (!state.canFlash) {
    throw new SeekError(
      'flash/refused',
      'the device analysis went stale before the write — read the device info again and ' +
        're-pick your image. Nothing was written.',
      { detail: { blockedBy: state.flashBlockedBy } },
    );
  }
  /* Everything below arms 0x52 and streams 0x50 / commits 0x51, ids whose
   * meaning is per build; `readDeviceInfo` refuses a camera that does not name
   * its build, so a state without a version did not come from it. */
  if (state.version === null) {
    throw new SeekError(
      'flash/refused',
      'the analysis does not say which firmware the camera runs, and command ids mean ' +
        'different things on different builds. Read the device info again. Nothing was written.',
    );
  }
  const target = targetSlot(state);
  if (target === null) {
    throw new SeekError('flash/refused', 'the analysis no longer names a target slot');
  }
  /* THE SELECTOR THE ANALYSIS TOOK FROM THIS BUILD'S TABLE, not the profile's
   * number. `readDeviceInfo` sets it only when the running firmware's own plan
   * carries the profile's upgrade-target row; a state without one has no
   * window to write, and nothing is armed on a guess. */
  const subcmd = state.updateTargetSubcmd;
  if (subcmd === null) {
    const named = state.profile.boot.updateTargetSubcmd;
    throw new SeekError(
      'flash/refused',
      (named < 0
        ? `${state.profile.name} exposes no upgrade-target selector`
        : `the analysis found no upgrade-target selector ${hex(named)} in this firmware's own ` +
          'table') + ', so there is no window to write. Nothing was written.',
    );
  }

  assertBankPayload(prep.payload); /* last gate before anything is sent */

  reporter.log(
    `target: ${target.name} at ${hex(target.address, 8)} (selector ${hex(subcmd)} — the camera ` +
      'resolves this itself)',
    'detail',
  );

  await device.armWindow({ subcmd, address: target.address, note: 'upgrade target' });
  reporter.log('upgrade window armed', 'ok');

  const total = prep.payload.length;
  const startedAt = Date.now();

  /* Both staging failures the firmware can report are sticky — the "not armed"
   * one because nothing re-arms it, the overflow one because it clears the
   * descriptor and every later chunk then reports not-armed — so a single check
   * at the end cannot miss one. Polling every 4 KiB just stops the stream near
   * the fault instead of pushing the rest of the payload at a disarmed
   * descriptor. */
  const abort = (deviceCode: number, offset: number): never => {
    throw new SeekError(
      'flash/refused',
      `the camera reported ${hex(deviceCode)} while staging at offset ${hex(offset)} — aborted ` +
        'before CompleteMemoryUpgrade, so nothing was written to flash',
      { deviceCode, detail: { offset } },
    );
  };

  for (let offset = 0; offset < total; offset += EP0_BUF) {
    if (isCancelled(ctx)) {
      throw new CancelledError('cancelled before commit — nothing was written to flash');
    }
    const end = Math.min(offset + EP0_BUF, total);
    await device.setFeaturedFirmwareData(prep.payload.subarray(offset, end));
    if ((end & STATUS_POLL_MASK) === 0 && end !== total) {
      const code = await device.getErrorCode();
      if (code) abort(code, end);
    }
    if ((offset & PROGRESS_MASK) === 0 || end === total) {
      const seconds = Math.max(0.001, (Date.now() - startedAt) / 1000);
      const kbs = end / 1024 / seconds;
      reporter.progress(
        end,
        total,
        `Streaming ${String(end)}/${String(total)} B (${kbs.toFixed(1)} KiB/s) ...`,
      );
    }
  }
  reporter.progress(total, total, `Streamed ${String(total)} B.`);
  reporter.log(
    `streamed ${String(total)} B in ${((Date.now() - startedAt) / 1000).toFixed(1)} s`,
    'ok',
  );

  const streamError = await device.getErrorCode();
  if (streamError) abort(streamError, total);

  reporter.log(`committing: CompleteMemoryUpgrade(${hexUp(prep.sum16, 4)}) ...`, 'warn');
  try {
    await device.completeMemoryUpgrade(prep.sum16, USB_COMMIT_TIMEOUT_MS);
  } catch (error) {
    /* The erase/program/verify chain runs INSIDE this transfer, so a transfer
     * that times out or stalls says nothing about whether flash was touched —
     * the camera may be part-way through programming the block. Treat it like
     * any other post-erase failure and invalidate the analysis, so a caller
     * cannot press Write again against a picture that may now be wrong. The
     * plain rejection carried no such marker, and the front ends kept their
     * state. */
    if (error instanceof CancelledError) throw error;
    throw new SeekError(
      'flash/commit',
      `CompleteMemoryUpgrade did not complete (${errorMessage(error)}) — the camera may be ` +
        'part-way through erasing or programming the target slot. Re-read the device info ' +
        'before doing anything else, and keep your rescue dump.',
      { cause: error, detail: { dropAnalysis: true, safeToRetry: false } },
    );
  }
  await sleep(200); /* erase + program + verify runs inside this call */
  const commitError = await device.getErrorCode();
  if (commitError === ERR_BAD_CHECKSUM) {
    /* This one is checked before anything is erased, so the camera is untouched
     * and the prepared payload is still good to retry. */
    throw new SeekError(
      'flash/commit',
      `the camera rejected the transfer checksum (${hex(ERR_BAD_CHECKSUM)}) — nothing was ` +
        'committed',
      { deviceCode: commitError, detail: { safeToRetry: true } },
    );
  }
  if (commitError) {
    /* Any other code comes from the erase/program/verify chain, which means
     * flash may already have changed. The caller must drop its analysis so
     * nothing is retried against a stale picture of the device. */
    throw new SeekError(
      'flash/commit',
      `CompleteMemoryUpgrade returned ${hex(commitError)} — the target slot may be partially ` +
        'written. Re-read the device info before doing anything else, and keep your rescue dump.',
      { deviceCode: commitError, detail: { dropAnalysis: true, safeToRetry: false } },
    );
  }

  reporter.log(`committed — ${target.name} programmed and cfg[0] repointed at it`, 'ok');

  /* Not a readback compare — a 576-byte read of the vector table, which is all
   * the GF(2) solve needs to name the key the camera just stored it under. That
   * answers the only question that matters: will the bootloader take this slot?
   * Committing without an error does NOT imply it. */
  try {
    await device.armWindow({ subcmd, address: target.address, note: 'upgrade target' });
    const probeLen = HEADER_OFFSET + HEADER_SIZE;
    const head = await device.readArmed(DEFAULT_READ_CHUNK, probeLen);
    if (head.data.length < probeLen) throw new SeekError('device/window', 'short read');
    const hv = viewOf(head.data);
    if (hv.getUint32(HEADER_OFFSET, true) !== IMAGE_MAGIC) {
      throw new SeekError('image/malformed', 'no image header in the slot');
    }
    const identity = identifyKey(
      { state: recoverState(hv, 0), accepts: true },
      state.keyTable,
      state.storeKey,
      state.keyWhiteningK,
    );
    if (identity.bootable) {
      reporter.log(
        `stored under ${identity.name ?? 'a known key'} — the bootloader will accept this slot`,
        'ok',
      );
    } else {
      reporter.log(
        `the camera stored it under a key the bootloader does not know (${identity.name ?? 'unknown key'})`,
        'error',
      );
      reporter.log(
        '  it will be SKIPPED at boot and the camera will keep running whatever else is ' +
          'bootable. This is a property of the firmware currently running on the camera, not of ' +
          'the image you chose. Use an SPI programmer or SWD/J-Link to change what this camera runs.',
        'error',
      );
    }
  } catch (error) {
    if (error instanceof CancelledError) throw error;
    reporter.log(
      `could not check which key the camera stored it under: ${errorMessage(error)} — re-read ` +
        'the device info after replugging',
      'warn',
    );
  }

  reporter.log('');
  reporter.log('NOW UNPLUG AND REPLUG THE CAMERA.', 'warn');
  reporter.log(
    'Proven so far: the payload streamed, the camera accepted its checksum, and the commit ' +
      'returned no error. NOT proven: that the bootloader will select this slot, or that the ' +
      'image runs. The bank switch only takes effect on a real power cycle, so replug and read ' +
      'the device info again — the running version it reports is the only thing that settles it.',
    'detail',
  );
  reporter.progress(
    1,
    1,
    'Written. Unplug and replug, then re-read — the reported version is the real answer.',
  );
}

/**
 * The write side: read what the camera is running, package an image for it,
 * and stream it through the camera's own upgrade path.
 *
 * The invariant this hook exists to hold is the original page's hardest-won
 * one. Key A, the upgrade target slot and the footer template are properties
 * of ONE camera. The original kept them in page globals and had to remember to
 * clear them; here they live in this hook's state and are dropped whenever
 * `device.generation` changes — a connect, a disconnect, a device swap — and
 * again after every completed write, because the banks have swapped roles and
 * everything read before the commit is stale.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CancelledError,
  SeekError,
  SeekDevice,
  errorMessage,
  flashInvalidatesAnalysis,
  getProfile,
  hex,
  hexUp,
  isoStamp,
  prepareImage,
  readDeviceInfo,
  runDump,
  sha256hex,
  targetSlot,
  writeFirmware,
  type DeviceState,
  type PreparedFlash,
  type ProfileId,
  type WorkflowContext,
} from '@seek-fw/core';
import { downloadArchive, mib } from '../lib/download';
import {
  asOptionsFailure,
  readOptions,
  type OptionsFailure,
  type OptionsForm,
} from '../lib/options';
import { yieldToUi } from '../lib/yield-to-ui';
import { useReporter, type ReporterHandle } from './useReporter';
import type { DeviceHandle } from './useDevice';
import type { Runner } from './useRunner';

export const INFO_PANEL_ID = 'fwinfo';
export const PREPARE_PANEL_ID = 'prepare';
export const FLASH_PANEL_ID = 'flash';

/** 'auto' means "whatever the last read detected", falling back to modern-4x. */
export type ProfileChoice = ProfileId | 'auto';

export interface PreparedImage {
  readonly prep: PreparedFlash;
  /** Async, so it is computed here rather than inside `PreparedFlash`. */
  readonly sha256: string;
}

export interface FlashPanelParams {
  readonly runner: Runner;
  readonly device: DeviceHandle;
  readonly form: OptionsForm;
  readonly profileChoice: ProfileChoice;
  readonly onOptionsFailure: (failure: OptionsFailure | null) => void;
}

export interface FlashPanelApi {
  readonly infoReporter: ReporterHandle;
  readonly flashReporter: ReporterHandle;
  readonly deviceState: DeviceState | null;
  readonly prepared: PreparedImage | null;
  readonly readingInfo: boolean;
  readonly writing: boolean;
  readonly canWrite: boolean;
  readInfo: () => Promise<void>;
  pickImage: (file: File) => Promise<void>;
  write: (dumpFirst: boolean) => Promise<void>;
  cancelInfo: () => void;
  cancelWrite: () => void;
}

/**
 * The write gate, as a value rather than a tangle of `&&` in JSX.
 *
 * All four conditions are load-bearing: there has to be a camera, nothing else
 * may be running, an image must be packaged for THIS camera, and the analysis
 * must say the camera can be flashed at all (which includes the acting
 * profile declaring `flash` supported).
 */
export function canWriteNow(args: {
  readonly hasDevice: boolean;
  readonly busy: boolean;
  readonly hasImage: boolean;
  readonly state: DeviceState | null;
}): boolean {
  return args.hasDevice && !args.busy && args.hasImage && args.state?.canFlash === true;
}

export function useFlashPanel(params: FlashPanelParams): FlashPanelApi {
  const { runner, device, form, profileChoice, onOptionsFailure } = params;
  const infoReporter = useReporter('Idle.');
  const flashReporter = useReporter('No image chosen.');

  const [deviceState, setDeviceState] = useState<DeviceState | null>(null);
  const [prepared, setPrepared] = useState<PreparedImage | null>(null);
  const stateRef = useRef<DeviceState | null>(null);
  const preparedRef = useRef<PreparedImage | null>(null);

  /* Depend on the two stable callbacks, NOT on the reporter handles.
   *
   * A reporter handle is a fresh object on every log line and every progress
   * tick — it has to be, since it carries the current lines and progress for
   * rendering. Closing over the handles here made `dropAnalysis` change
   * identity constantly, which re-fired the device-changed effect below on
   * every log line and wiped the analysis the read had just produced. The
   * `setStatus` functions are `useCallback(..., [])`, so this is stable. */
  const { setStatus: setInfoStatus } = infoReporter;
  const { setStatus: setFlashStatus } = flashReporter;

  const dropAnalysis = useCallback(
    (reason: string | null): void => {
      const had = stateRef.current !== null || preparedRef.current !== null;
      stateRef.current = null;
      preparedRef.current = null;
      setDeviceState(null);
      setPrepared(null);
      if (had && reason !== null) {
        setInfoStatus(reason);
        setFlashStatus(reason);
      }
    },
    [setFlashStatus, setInfoStatus],
  );

  /* The whole point of `generation`: a new or vanished camera invalidates
   * everything read from the previous one. */
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) {
      firstRun.current = false;
      return;
    }
    dropAnalysis(
      device.device === null
        ? 'Device disconnected — read the device info again.'
        : 'New device selected — read the device info again.',
    );
  }, [device.generation, device.device, dropAnalysis]);

  const profileFor = useCallback(
    (state: DeviceState | null): ProfileId => {
      if (profileChoice !== 'auto') return profileChoice;
      return state?.detection.best.profile.id ?? 'modern-4x';
    },
    [profileChoice],
  );

  /* ---- read device info --------------------------------------------- */

  const readInfo = useCallback(
    (): Promise<void> =>
      runner.start(INFO_PANEL_ID, async (signal) => {
        infoReporter.reset('Reading ...');
        flashReporter.setStatus('No image chosen.');
        dropAnalysis(null);
        onOptionsFailure(null);
        let transport: ReturnType<DeviceHandle['makeTransport']> | null = null;
        try {
          const options = readOptions(form);
          const profile = getProfile(profileFor(null));
          transport = device.makeTransport({
            recipient: options.recipient,
            onWarning: (message) => {
              infoReporter.reporter.log(message, 'warn');
            },
          });
          const client = new SeekDevice(transport, { reporter: infoReporter.reporter, signal });
          await transport.open();
          const ctx: WorkflowContext = {
            device: client,
            profile,
            detection: null,
            reporter: infoReporter.reporter,
            signal,
          };
          const state = await readDeviceInfo(ctx, {
            chunk: options.chunk,
            gapFill: options.gapFill,
            retries: options.retries,
            retryDelayMs: options.retryDelayMs,
            decrypt: options.decrypt,
          });
          stateRef.current = state;
          setDeviceState(state);
          const readable = state.slots.filter((slot) => slot.present).length;
          infoReporter.reporter.progress(
            1,
            1,
            state.canFlash
              ? `Read. ${String(readable)}/${String(state.slots.length)} slots readable.`
              : 'Read, but this camera cannot be flashed from here — see the log.',
          );
        } catch (error) {
          const failure = asOptionsFailure(error);
          if (failure !== null) onOptionsFailure(failure);
          if (error instanceof CancelledError) {
            infoReporter.log('cancelled', 'warn');
            infoReporter.setStatus('Cancelled.');
          } else {
            infoReporter.log(`ERROR: ${errorMessage(error)}`, 'error');
            infoReporter.setStatus('Failed — see the log above.');
          }
        } finally {
          if (transport !== null) await transport.close();
          infoReporter.flush();
        }
      }),
    [device, dropAnalysis, flashReporter, form, infoReporter, onOptionsFailure, profileFor, runner],
  );

  /* ---- pick an image ------------------------------------------------- */

  const pickImage = useCallback(
    (file: File): Promise<void> =>
      runner.start(PREPARE_PANEL_ID, async () => {
        flashReporter.reset('Reading image ...');
        preparedRef.current = null;
        setPrepared(null);
        const state = stateRef.current;
        try {
          if (state === null) {
            throw new Error(
              "read the device info first — the camera's Key A and target slot come from it",
            );
          }
          const bytes = new Uint8Array(await file.arrayBuffer());
          flashReporter.reporter.log(
            `${file.name} — ${bytes.length.toLocaleString()} bytes`,
            'detail',
          );
          const prep = prepareImage(state, bytes, file.name);
          const sha256 = await sha256hex(prep.payload);
          const ready: PreparedImage = { prep, sha256 };
          preparedRef.current = ready;
          setPrepared(ready);
          flashReporter.reporter.log(
            `packaged ${String(prep.payload.length)} B bank payload, transfer checksum ` +
              hexUp(prep.sum16, 4),
            'ok',
          );
          flashReporter.reporter.log('nothing sent to the camera yet', 'detail');
          flashReporter.reporter.progress(
            1,
            1,
            'Ready — review the plan above, then press "Write to camera".',
          );
        } catch (error) {
          flashReporter.log(`cannot use this file: ${errorMessage(error)}`, 'error');
          flashReporter.setStatus('Rejected — see the log above.');
        } finally {
          flashReporter.flush();
        }
      }),
    [flashReporter, runner],
  );

  /* ---- write --------------------------------------------------------- */

  const write = useCallback(
    (dumpFirst: boolean): Promise<void> =>
      runner.start(FLASH_PANEL_ID, async (signal) => {
        const state = stateRef.current;
        const ready = preparedRef.current;
        flashReporter.reset('Writing ...');
        if (state === null || ready === null) {
          flashReporter.log('ERROR: no prepared image', 'error');
          flashReporter.setStatus('Failed — see the log above.');
          return;
        }
        const { prep } = ready;
        let transport: ReturnType<DeviceHandle['makeTransport']> | null = null;
        try {
          const options = readOptions(form);
          const profile = getProfile(profileFor(state));
          transport = device.makeTransport({
            recipient: options.recipient,
            onWarning: (message) => {
              flashReporter.reporter.log(message, 'warn');
            },
          });
          const client = new SeekDevice(transport, { reporter: flashReporter.reporter, signal });
          await transport.open();
          const ctx: WorkflowContext = {
            device: client,
            profile,
            detection: state.detection,
            reporter: flashReporter.reporter,
            signal,
          };

          /* This log is the record of what was flashed, so it has to name the
           * file — the line written when the file was picked is cleared when
           * this run starts. */
          const target = targetSlot(state);
          const log = flashReporter.reporter;
          log.log(`image: ${prep.fileName}`, 'ok');
          log.log(
            `  ${prep.originalSize.toLocaleString()} B on disk, firmware ` +
              `${prep.header.versionStr}, image ${hexUp(prep.header.imageId)}`,
            'detail',
          );
          log.log(
            `  header.length ${hexUp(prep.length)}` +
              (prep.lengthStamped ? ` (stamped from ${hexUp(prep.declaredBefore)})` : '') +
              `, adjust word ${hexUp(prep.adjust)}`,
            'detail',
          );
          log.log(
            `  key table at ${prep.keyPatch.where}: ` +
              (prep.keyPatch.changed
                ? `${prep.keyPatch.fromA} / ${prep.keyPatch.fromB}  ->  ` +
                  `${prep.keyPatch.toA} / ${prep.keyPatch.toB}`
                : "already this camera's keys, left alone"),
            'detail',
          );
          log.log(
            `  payload ${String(prep.payload.length)} B, transfer checksum ` +
              `${hexUp(prep.sum16, 4)}, sha256 ${ready.sha256}`,
            'detail',
          );
          if (target !== null) {
            log.log(`  target ${target.name} at ${hex(target.address, 8)}`, 'detail');
          }
          log.log('');

          if (dumpFirst) {
            log.log('dumping the whole flash first — this is your rescue copy', 'warn');
            log.log('');
            const result = await runDump(ctx, {
              chunk: options.chunk,
              gapFill: options.gapFill,
              retries: options.retries,
              retryDelayMs: options.retryDelayMs,
              decrypt: options.decrypt,
            });
            flashReporter.setStatus('Building rescue archive ...');
            await yieldToUi();
            const archive = downloadArchive(`seek_flash4m_${isoStamp()}`, result.artifacts);
            log.log(
              `downloaded ${archive.fileName} — ${String(archive.fileCount)} files, ` +
                `${mib(archive.bytes)} MiB`,
              'ok',
            );
            if (result.cancelled) {
              /* The rescue dump is the reason the write is allowed to be
               * risky. A partial one is not a rescue copy. */
              throw new CancelledError(
                'cancelled during the rescue dump — nothing was written to flash',
              );
            }
            log.log('');
            log.log('rescue dump downloaded; continuing to the write', 'ok');
            log.log('');
          } else {
            log.log('rescue dump skipped at your request', 'warn');
          }

          /* The analysis can go stale between preparing and writing — a
           * disconnect during the rescue dump drops it, and that dump runs for
           * minutes. `state` was captured when the run started, so re-check the
           * live one: a payload is only valid for the camera whose Key A built
           * it. This is the original's guard at the top of writeFirmware(),
           * which checked a module global that a disconnect nulled. */
          if (stateRef.current !== state || preparedRef.current !== ready) {
            throw new SeekError(
              'flash/refused',
              'the device analysis went stale before the write — read the device info again ' +
                'and re-pick your image. Nothing was written.',
            );
          }

          await writeFirmware(ctx, state, prep);

          /* The banks have swapped roles and the written slot is now Key-B
           * encrypted, so everything read before the commit is stale. Force a
           * re-read rather than letting a second write run off it. */
          dropAnalysis(null);

          log.log('');
          log.log('NOW UNPLUG AND REPLUG THE CAMERA.', 'warn');
          log.log(
            'Proven so far: the payload streamed, the camera accepted its checksum, and the ' +
              'commit returned no error. NOT proven: that the bootloader will select this slot, ' +
              'or that the image runs. The bank switch only takes effect on a real power cycle, ' +
              'so replug and press "Read device info" — the running version it reports is the ' +
              'only thing that settles it.',
            'detail',
          );
          log.progress(
            1,
            1,
            'Written. Unplug and replug, then re-read — the reported version is the real answer.',
          );
        } catch (error) {
          const failure = asOptionsFailure(error);
          if (failure !== null) onOptionsFailure(failure);
          if (flashInvalidatesAnalysis(error)) dropAnalysis(null);
          if (error instanceof CancelledError) {
            flashReporter.log(`cancelled: ${error.message}`, 'warn');
            flashReporter.setStatus('Cancelled — see the log above.');
          } else {
            flashReporter.log(`ERROR: ${errorMessage(error)}`, 'error');
            flashReporter.setStatus('Failed — see the log above.');
          }
        } finally {
          if (transport !== null) await transport.close();
          flashReporter.flush();
        }
      }),
    [device, dropAnalysis, flashReporter, form, onOptionsFailure, profileFor, runner],
  );

  const cancelInfo = useCallback((): void => {
    runner.cancel();
    infoReporter.setStatus('Cancelling ...');
  }, [infoReporter, runner]);

  const cancelWrite = useCallback((): void => {
    runner.cancel();
    flashReporter.setStatus(
      'Cancelling — the write stops before the commit if it has not run yet ...',
    );
    flashReporter.log('cancel requested', 'warn');
  }, [flashReporter, runner]);

  const canWrite = canWriteNow({
    hasDevice: device.device !== null,
    busy: runner.busy,
    hasImage: prepared !== null,
    state: deviceState,
  });

  return useMemo(
    () => ({
      infoReporter,
      flashReporter,
      deviceState,
      prepared,
      readingInfo: runner.active === INFO_PANEL_ID,
      writing: runner.active === FLASH_PANEL_ID,
      canWrite,
      readInfo,
      pickImage,
      write,
      cancelInfo,
      cancelWrite,
    }),
    [
      infoReporter,
      flashReporter,
      deviceState,
      prepared,
      runner.active,
      canWrite,
      readInfo,
      pickImage,
      write,
      cancelInfo,
      cancelWrite,
    ],
  );
}

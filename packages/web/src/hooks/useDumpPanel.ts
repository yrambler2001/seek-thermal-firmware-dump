/**
 * The read-only runs: "Start dump" and "Dump all selectors", for both the
 * modern selector map and the legacy authenticated one.
 *
 * The original had `runDump` and `runOldDump` as two near-identical functions
 * and a `runSweep(kind)` that branched on a string. Core unified all of that
 * behind one pair of workflows parameterised by the firmware profile, so this
 * hook is the same code twice over with a different `profileId`.
 *
 * Cancelling is not a failure. Core stops the selector loop and still returns a
 * complete result — the partial image, a manifest that records which windows
 * ran, and a README — so the archive is built and downloaded either way. That
 * is what the Cancel button has promised since the original page: "will save
 * whatever has been read so far".
 */

import { useCallback, useMemo } from 'react';
import {
  CancelledError,
  SeekDevice,
  errorMessage,
  getProfile,
  isoStamp,
  runDump,
  runSweep,
  type ProfileId,
  type WorkflowContext,
} from '@seek-fw/core';
import { downloadArchive, mib } from '../lib/download';
import { logHint } from '../lib/hints';
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

export type DumpMode = 'dump' | 'sweep';

export interface DumpPanelParams {
  readonly id: string;
  readonly runner: Runner;
  readonly device: DeviceHandle;
  readonly form: OptionsForm;
  readonly profileId: ProfileId;
  /** `seek_flash4m_` or `seek_flash4m_legacy_`, as the original named them. */
  readonly dirPrefix: string;
  readonly sweepPrefix: string;
  readonly onOptionsFailure: (failure: OptionsFailure | null) => void;
}

export interface DumpPanelApi {
  readonly reporter: ReporterHandle;
  readonly running: boolean;
  start: (mode: DumpMode) => Promise<void>;
  cancel: () => void;
}

/** The original's cancel copy for these two panels. */
const CANCELLING = 'Cancelling — will save whatever has been read so far ...';

export function useDumpPanel(params: DumpPanelParams): DumpPanelApi {
  const { id, runner, device, form, profileId, dirPrefix, sweepPrefix, onOptionsFailure } = params;
  const reporter = useReporter('Idle.');
  const running = runner.active === id;

  const execute = useCallback(
    async (mode: DumpMode, signal: AbortSignal): Promise<void> => {
      const options = readOptions(form);
      const profile = getProfile(profileId);
      const transport = device.makeTransport({
        recipient: options.recipient,
        onWarning: (message) => {
          reporter.reporter.log(message, 'warn');
        },
      });
      const client = new SeekDevice(transport, { reporter: reporter.reporter, signal });
      const ctx: WorkflowContext = {
        device: client,
        profile,
        detection: null,
        reporter: reporter.reporter,
        signal,
      };
      const dumpOptions = {
        chunk: options.chunk,
        gapFill: options.gapFill,
        retries: options.retries,
        retryDelayMs: options.retryDelayMs,
        decrypt: options.decrypt,
      };
      const dirName = `${mode === 'sweep' ? sweepPrefix : dirPrefix}${isoStamp()}`;

      try {
        await transport.open();
        const result =
          mode === 'sweep' ? await runSweep(ctx, dumpOptions) : await runDump(ctx, dumpOptions);

        reporter.setStatus('Building archive ...');
        await yieldToUi();
        const archive = downloadArchive(dirName, result.artifacts);
        reporter.reporter.log('');
        reporter.reporter.log(
          `downloaded ${archive.fileName} — ${String(archive.fileCount)} files, ` +
            `${mib(archive.bytes)} MiB`,
          'ok',
        );

        /* The original's exact closing line, including the "(cancelled)" the
         * partial archive earns. */
        const partial = result.cancelled ? ' (cancelled)' : '';
        if ('selectorsArmed' in result) {
          const [first, last] = profile.sweepRange;
          reporter.reporter.progress(
            1,
            1,
            `Done — ${String(result.selectorsArmed)}/${String(last - first + 1)} selectors armed, ` +
              `${String(result.selectorsWithData)} with data${partial}. Check your downloads.`,
          );
        } else {
          reporter.reporter.progress(
            1,
            1,
            `Done — ${String(result.windowsRead)}/${String(result.windowsExpected)} windows read` +
              `${partial}. Check your downloads.`,
          );
        }
      } finally {
        await transport.close();
      }
    },
    [device, dirPrefix, form, profileId, reporter, sweepPrefix],
  );

  const start = useCallback(
    (mode: DumpMode): Promise<void> =>
      runner.start(id, async (signal) => {
        reporter.reset('Starting ...');
        onOptionsFailure(null);
        try {
          await execute(mode, signal);
        } catch (error) {
          const failure = asOptionsFailure(error);
          if (failure !== null) onOptionsFailure(failure);
          /* A dump no longer throws on cancel, but anything deeper still can. */
          if (error instanceof CancelledError) {
            reporter.log('cancelled — nothing was packaged', 'warn');
            reporter.setStatus('Cancelled.');
            return;
          }
          reporter.log(`ERROR: ${errorMessage(error)}`, 'error');
          logHint(reporter.log, error);
          reporter.setStatus('Failed — see the log above.');
        } finally {
          reporter.flush();
        }
      }),
    [execute, id, onOptionsFailure, reporter, runner],
  );

  const cancel = useCallback((): void => {
    runner.cancel();
    reporter.setStatus(CANCELLING);
    reporter.log('cancel requested', 'warn');
  }, [reporter, runner]);

  return useMemo(() => ({ reporter, running, start, cancel }), [reporter, running, start, cancel]);
}

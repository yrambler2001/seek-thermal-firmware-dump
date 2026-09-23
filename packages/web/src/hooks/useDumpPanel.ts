/**
 * The read-only runs: "Start dump" and "Dump all selectors".
 *
 * The camera says which family it is. A run with `choice: 'auto'` asks it
 * first (`chooseActingProfile` → core's `identifyCamera`: the version, then —
 * only when that build can be read — one plain arm, one token arm and one read)
 * and dumps under the family that answers point to, with that build's own
 * selector table (`planForDevice`). The original page had the user pick
 * instead: `runDump` for the post-2018 map and `runOldDump` for the locked
 * 2014-2017 line, as two buttons. A panel with a hand-picked `choice` is the
 * expert override; it skips the questions and nothing else — the workflow
 * still reads the version and refuses a camera that does not name its build or
 * predates the dump protocol, whichever family was picked.
 *
 * A REFUSAL IS SHOWN, NOT JUST LOGGED. "The camera would not say which build it
 * runs" and "this build has no read command" are answers the user has to act
 * on, and they end the run before anything is read, so the panel keeps them in
 * `refusal` for the view to put in front of the user.
 *
 * Cancelling is not a failure. Core stops the selector loop and still returns a
 * complete result — the partial image, a manifest that records which windows
 * ran, and a README — so the archive is built and downloaded either way. That
 * is what the Cancel button has promised since the original page: "will save
 * whatever has been read so far".
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  CancelledError,
  SeekDevice,
  errorMessage,
  isoStamp,
  runDump,
  runSweep,
  type WorkflowContext,
} from '@seek-fw/core';
import { downloadArchive, mib } from '../lib/download';
import { logHint } from '../lib/hints';
import {
  chooseActingProfile,
  refusalOf,
  type ActingProfile,
  type ProfileChoice,
  type Refusal,
} from '../lib/identify';
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
  /** 'auto' asks the camera; a profile id is the expert override. */
  readonly choice: ProfileChoice;
  /** `seek_flash4m_`, as the original named the archive. */
  readonly dirPrefix: string;
  readonly sweepPrefix: string;
  readonly onOptionsFailure: (failure: OptionsFailure | null) => void;
}

export interface DumpPanelApi {
  readonly reporter: ReporterHandle;
  readonly running: boolean;
  /** What the last run acted under, once that was settled; null before, or after a refusal. */
  readonly acting: ActingProfile | null;
  /** Why the last run was refused before it read anything, or null. */
  readonly refusal: Refusal | null;
  start: (mode: DumpMode) => Promise<void>;
  cancel: () => void;
}

/** The original's cancel copy for these panels. */
const CANCELLING = 'Cancelling — will save whatever has been read so far ...';

export function useDumpPanel(params: DumpPanelParams): DumpPanelApi {
  const { id, runner, device, form, choice, dirPrefix, sweepPrefix, onOptionsFailure } = params;
  const reporter = useReporter('Idle.');
  const running = runner.active === id;
  const [acting, setActing] = useState<ActingProfile | null>(null);
  const [refusal, setRefusal] = useState<Refusal | null>(null);

  /* What one camera said is not what the next one will: a connect, a
   * disconnect or a swap drops it, as the flash view drops its analysis. */
  useEffect(() => {
    setActing(null);
    setRefusal(null);
  }, [device.generation]);

  const execute = useCallback(
    async (mode: DumpMode, signal: AbortSignal): Promise<void> => {
      const options = readOptions(form);
      const transport = device.makeTransport({
        recipient: options.recipient,
        onWarning: (message) => {
          reporter.reporter.log(message, 'warn');
        },
      });
      const client = new SeekDevice(transport, { reporter: reporter.reporter, signal });
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
        const chosen = await chooseActingProfile(client, choice, mode, (text, level) => {
          reporter.reporter.log(text, level);
        });
        setActing(chosen);
        const ctx: WorkflowContext = {
          device: client,
          profile: chosen.profile,
          detection: chosen.detection,
          reporter: reporter.reporter,
          signal,
        };
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
          const [first, last] = chosen.profile.sweepRange;
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
    [choice, device, dirPrefix, form, reporter, sweepPrefix],
  );

  const start = useCallback(
    (mode: DumpMode): Promise<void> =>
      runner.start(id, async (signal) => {
        reporter.reset('Starting ...');
        onOptionsFailure(null);
        setActing(null);
        setRefusal(null);
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
          const refused = refusalOf(error);
          if (refused !== null) {
            setActing(null);
            setRefusal(refused);
          }
          reporter.log(`ERROR: ${errorMessage(error)}`, 'error');
          logHint(reporter.log, error);
          reporter.setStatus(
            refused === null
              ? 'Failed — see the log above.'
              : 'Refused — nothing was read. See the message above the log.',
          );
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

  return useMemo(
    () => ({ reporter, running, acting, refusal, start, cancel }),
    [reporter, running, acting, refusal, start, cancel],
  );
}

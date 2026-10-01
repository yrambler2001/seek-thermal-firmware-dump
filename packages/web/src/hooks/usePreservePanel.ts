/**
 * The preserve wizard's state machine: one runner task per STEP (never per
 * run), a fresh transport per attempt through the opener ladder, per-step
 * reporters, and a run file rebuilt and downloaded after every completed
 * step — because the run file is the run's only memory.
 *
 * The invariants, and where they live:
 *  - Core's `runPreserveStep` enforces the run's own gates before anything
 *    touches the camera; `canRunStep` mirrors them so the buttons enable
 *    exactly what core will accept, and the past-commit rows explain
 *    themselves loudly.
 *  - The opener ladder retries the session open for about a minute, because
 *    after the drain step's reset (and the restore's) the camera is silent
 *    for roughly ten seconds while it boots. That silence is progress text
 *    ("camera rebooting…"), never an error.
 *  - The transport is built fresh per attempt and closed in `finally`, the
 *    same discipline `useFlashPanel` holds; a camera that re-enumerates
 *    mid-step stops the step (the generation guard below) rather than
 *    continuing against a device that may be a different unit.
 *  - Nothing touches browser storage. `state` + checkpoints live in memory,
 *    and their one durable copy is the downloaded run ZIP.
 *  - A FAILED step is recorded into the run state (core's
 *    `recordStepFailure`); a CANCELLED one is not — an interrupted run's
 *    previous checkpoint stands and a resume re-runs the step from the top.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CancelledError,
  SeekDevice,
  hexUp,
  sha256hex,
  type SessionOpener,
  type WebUsbTransport,
} from '@seek-fw/core';
import { SeekError, errorMessage } from '@seek-fw/core';
import { downloadBytes } from '../lib/download';
import { logHint } from '../lib/hints';
import { readOptions, type OptionsForm } from '../lib/options';
import {
  buildPatchSummary,
  createPreserveRun,
  isCancelledStep,
  plainLoader,
  recordStepFailure,
  runPreserveStep,
} from '../lib/preserve/client';
import { canRunStep, gateReason } from '../lib/preserve/gating';
import { buildRunFile, parseRunFile } from '../lib/preserve/run-file';
import {
  CHECKPOINT_FILES,
  PRESERVE_STEPS,
  RUN_STATE_FILE,
  stepMeta,
  type CheckpointName,
  type PreservePatchPlan,
  type PreserveRunState,
  type PreserveStepId,
} from '../lib/preserve/types';
import { useReporter, type ReporterHandle } from './useReporter';
import type { DeviceHandle } from './useDevice';
import type { Runner } from './useRunner';

export const PLAN_PANEL_ID = 'preserve:plan';
export const LOAD_PANEL_ID = 'preserve:load';
export const STEP_PANEL_PREFIX = 'preserve:step:';

/** The opener ladder: ~60 attempts, 1 s apart — the CLI's post-reset shape. */
export const OPEN_ATTEMPTS = 60;

export function stepPanelId(step: PreserveStepId): string {
  return `${STEP_PANEL_PREFIX}${step}`;
}

export interface PreservePlanView {
  readonly state: PreserveRunState;
  readonly patch: PreservePatchPlan;
  readonly fileName: string;
}

export interface RunFileSave {
  readonly runId: string;
  /** The last completed step the file carries, or 'created' for a fresh one. */
  readonly afterStep: PreserveStepId | 'created' | 'loaded' | 'manual';
  readonly at: string;
  readonly bytes: number;
}

export interface PreservePanelParams {
  readonly runner: Runner;
  readonly device: DeviceHandle;
  readonly form: OptionsForm;
}

export interface PreservePanelApi {
  readonly planReporter: ReporterHandle;
  readonly loadReporter: ReporterHandle;
  readonly stepReporters: Readonly<Record<PreserveStepId, ReporterHandle>>;
  /** The offline plan, between picking the image and confirming it. */
  readonly plan: PreservePlanView | null;
  /** The live run state — set on confirm, or on resume. */
  readonly state: PreserveRunState | null;
  readonly confirmed: boolean;
  /** The run's factory plaintext is attached (picked, or re-picked). */
  readonly hasImage: boolean;
  /** A run with work left but no image attached needs the re-pick. */
  readonly resumeNeedsImage: boolean;
  readonly hasCheckpoint: (name: CheckpointName) => boolean;
  readonly activeStep: PreserveStepId | null;
  readonly planning: boolean;
  readonly loading: boolean;
  readonly lastSave: RunFileSave | null;
  pickImage: (file: File) => Promise<void>;
  confirmPlan: () => void;
  dismissPlan: () => void;
  loadRunFile: (file: File) => Promise<void>;
  runStep: (step: PreserveStepId) => Promise<void>;
  cancel: () => void;
  saveAgain: () => void;
}

function lastCompletedStep(state: PreserveRunState): PreserveStepId | 'created' {
  let last: PreserveStepId | 'created' = 'created';
  for (const meta of PRESERVE_STEPS) {
    if (state.steps[meta.id]?.status === 'done') last = meta.id;
  }
  return last;
}

function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const tick = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(tick);
        resolve();
      },
      { once: true },
    );
  });
}

export function usePreservePanel(params: PreservePanelParams): PreservePanelApi {
  const { runner, device, form } = params;

  const planReporter = useReporter('No image chosen.');
  const loadReporter = useReporter('No run file chosen.');
  /* Six fixed hook calls, one per step — each step's bar, status and log live
   * in its own RunPanel for the whole life of the wizard. */
  const stepReporters: Readonly<Record<PreserveStepId, ReporterHandle>> = {
    backup: useReporter('Not run yet.'),
    patch: useReporter('Not run yet.'),
    commit: useReporter('Not run yet.'),
    drain: useReporter('Not run yet.'),
    restore: useReporter('Not run yet.'),
    verify: useReporter('Not run yet.'),
  };
  const reportersRef = useRef(stepReporters);
  reportersRef.current = stepReporters;

  const [plan, setPlan] = useState<PreservePlanView | null>(null);
  const [state, setState] = useState<PreserveRunState | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [hasImage, setHasImage] = useState(false);
  const [lastSave, setLastSave] = useState<RunFileSave | null>(null);

  const stateRef = useRef<PreserveRunState | null>(null);
  const checkpoints = useRef<Map<CheckpointName, Uint8Array>>(new Map());
  const extra = useRef<Map<string, Uint8Array>>(new Map());
  const plain = useRef<{ bytes: Uint8Array; fileName: string } | null>(null);

  const applyState = useCallback((next: PreserveRunState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const hasCheckpoint = useCallback((name: CheckpointName): boolean => {
    return checkpoints.current.has(name);
  }, []);

  /* ---- the run file ---------------------------------------------------- */

  const saveRunFile = useCallback((): void => {
    const current = stateRef.current;
    if (current === null) return;
    const zip = buildRunFile(current, checkpoints.current, extra.current);
    downloadBytes(zip, `preserve-run-${current.runId}.zip`, 'application/zip');
    setLastSave({
      runId: current.runId,
      afterStep: lastCompletedStep(current),
      at: new Date().toISOString(),
      bytes: zip.length,
    });
  }, []);

  /* ---- the session opener ladder --------------------------------------- */

  const makeOpener = useCallback(
    (
      rep: ReporterHandle,
      signal: AbortSignal,
    ): { opener: SessionOpener; closeAll: () => Promise<void> } => {
      const opened: WebUsbTransport[] = [];
      const closeAll = async (): Promise<void> => {
        for (const transport of opened.splice(0)) {
          try {
            await transport.close();
          } catch {
            /* the device is gone; the close is best-effort */
          }
        }
      };
      const opener: SessionOpener = {
        open: async () => {
          const options = readOptions(form);
          let lastError: unknown = null;
          for (let attempt = 0; attempt < OPEN_ATTEMPTS; attempt++) {
            if (signal.aborted) throw new CancelledError('cancelled while opening the camera');
            try {
              const transport = device.makeTransport({
                recipient: options.recipient,
                onWarning: (message) => {
                  rep.log(message, 'warn');
                },
              });
              opened.push(transport);
              const client = new SeekDevice(transport, { reporter: rep.reporter, signal });
              await transport.open();
              return client;
            } catch (error) {
              lastError = error;
              if (attempt === 0) {
                rep.log(
                  `camera did not open (${errorMessage(error)}) — retrying for up to ` +
                    `${String(OPEN_ATTEMPTS)} s; a camera that has just been reset is ` +
                    'silent for about ten seconds while it boots',
                  'warn',
                );
                rep.setStatus('Camera rebooting — waiting for it to come back …');
              }
            }
            await waitMs(1000, signal);
          }
          throw new Error(
            `the camera did not come back after ${String(OPEN_ATTEMPTS)} s of retrying: ` +
              `${errorMessage(lastError)} — replug it and run the step again`,
          );
        },
        close: closeAll,
      };
      return { opener, closeAll };
    },
    [device, form],
  );

  /* ---- generation guard ------------------------------------------------ */

  const generation = useRef(device.generation);
  useEffect(() => {
    if (generation.current === device.generation) return;
    generation.current = device.generation;
    const active = runner.active;
    if (active?.startsWith(STEP_PANEL_PREFIX) !== true) return;
    runner.cancel();
    const step = active.slice(STEP_PANEL_PREFIX.length);
    const rep = reportersRef.current[step as PreserveStepId];
    rep.log('the camera changed on the bus — stopping the step', 'warn');
    rep.setStatus('Stopped — the camera changed. Check it, then run the step again.');
  }, [device.generation, runner]);

  /* ---- pick the image (plan, or re-attach to a resumed run) ------------ */

  const pickImage = useCallback(
    (file: File): Promise<void> =>
      runner.start(PLAN_PANEL_ID, async () => {
        const rep = planReporter;
        rep.reset('Reading image ...');
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          const current = stateRef.current;
          if (current === null) {
            const created = await createPreserveRun(bytes);
            const summary = await buildPatchSummary(created.patch);
            plain.current = { bytes, fileName: file.name };
            setHasImage(true);
            setPlan({ state: created.state, patch: summary, fileName: file.name });
            rep.reporter.log(`${file.name} — ${String(bytes.length)} B`, 'detail');
            rep.reporter.log(
              `firmware ${created.state.expectedVersion}, sha256 ${created.state.imageSha256}`,
              'detail',
            );
            rep.reporter.log(
              `${String(summary.sites.length)} patch sites, rebalance word ` +
                `${hexUp(summary.rebalanceWord)}, ${String(summary.chunkCount)} chunks staged`,
              'detail',
            );
            rep.reporter.log('nothing has been sent to any camera', 'detail');
            rep.reporter.progress(1, 1, 'Plan ready — read it, then press "Create the run file".');
          } else {
            const sha = await sha256hex(bytes);
            if (sha !== current.imageSha256) {
              throw new SeekError(
                'pipeline/refused',
                `this file hashes ${sha}, but the run was created from ` +
                  `${current.imageSha256} — a run belongs to one image`,
              );
            }
            plain.current = { bytes, fileName: file.name };
            setHasImage(true);
            rep.reporter.log(`${file.name} — sha256 matches the run`, 'ok');
            rep.reporter.progress(1, 1, 'Image re-attached — the gated steps can run again.');
          }
        } catch (error) {
          rep.log(`cannot use this file: ${errorMessage(error)}`, 'error');
          logHint(rep.log, error);
          rep.setStatus('Rejected — see the log above.');
        } finally {
          rep.flush();
        }
      }),
    [planReporter, runner],
  );

  const confirmPlan = useCallback((): void => {
    if (plan === null) return;
    applyState(plan.state);
    setConfirmed(true);
    setPlan(null);
    /* The run file exists from the first moment, so a run abandoned before
     * step one still has its plan on disk. */
    saveRunFile();
  }, [applyState, plan, saveRunFile]);

  const dismissPlan = useCallback((): void => {
    setPlan(null);
  }, []);

  /* ---- resume from a run file ------------------------------------------ */

  const loadRunFile = useCallback(
    (file: File): Promise<void> =>
      runner.start(LOAD_PANEL_ID, async () => {
        const rep = loadReporter;
        rep.reset('Reading run file ...');
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          rep.reporter.log(`${file.name} — ${String(bytes.length)} B`, 'detail');
          const parsed = parseRunFile(bytes);
          checkpoints.current = new Map(parsed.checkpoints);
          extra.current = new Map(parsed.extra);
          plain.current = null;
          setHasImage(false);
          setPlan(null);
          applyState(parsed.state);
          setConfirmed(true);
          for (const meta of PRESERVE_STEPS) {
            const record = parsed.state.steps[meta.id];
            const stepRep = stepReporters[meta.id];
            if (record === undefined) stepRep.reset('Not run yet.');
            else if (record.status === 'done') {
              stepRep.reset('Done earlier — loaded from the run file.');
            } else stepRep.reset(`Failed earlier: ${record.error ?? 'unknown reason'}`);
          }
          rep.reporter.log(
            `run ${parsed.state.runId} — created ${parsed.state.createdAt}, firmware ` +
              parsed.state.expectedVersion,
            'detail',
          );
          rep.reporter.log(
            `checkpoints loaded: ${[...parsed.checkpoints.keys()].join(', ') || 'none yet'}`,
            'detail',
          );
          if (
            parsed.state.nextStep !== 'done' &&
            ['backup', 'patch', 'commit'].includes(parsed.state.nextStep)
          ) {
            rep.reporter.log(
              'the next step reads the factory plaintext the run was created from — pick the ' +
                'firmware image again (the plan section) before running it',
              'warn',
            );
          }
          rep.reporter.progress(
            1,
            1,
            `Resumed at ${parsed.state.nextStep}. The step list picks up from there.`,
          );
          setLastSave({
            runId: parsed.state.runId,
            afterStep: 'loaded',
            at: new Date().toISOString(),
            bytes: bytes.length,
          });
        } catch (error) {
          rep.log(`cannot resume from this file: ${errorMessage(error)}`, 'error');
          logHint(rep.log, error);
          rep.setStatus('Not resumed — see the log above.');
        } finally {
          rep.flush();
        }
      }),
    [applyState, loadReporter, runner, stepReporters],
  );

  /* ---- run one step ----------------------------------------------------- */

  const runStep = useCallback(
    (step: PreserveStepId): Promise<void> =>
      runner.start(stepPanelId(step), async (signal) => {
        const rep = stepReporters[step];
        rep.reset('Running ...');
        const current = stateRef.current;
        if (current === null) {
          rep.log('no run is active — create one or resume one first', 'error');
          rep.setStatus('No run.');
          return;
        }
        const gate = canRunStep({
          state: current,
          step,
          has: hasCheckpoint,
          hasPlain: plain.current !== null,
        });
        if (!gate.ok) {
          rep.log(`refused: this step ${gateReason(gate) ?? 'cannot run'}`, 'error');
          rep.setStatus('Refused — the step list above says what is missing.');
          return;
        }
        const load = plainLoader(checkpoints.current, extra.current, plain.current);
        const { opener, closeAll } = makeOpener(rep, signal);
        try {
          const outcome = await runPreserveStep(step, opener, current, load, rep.reporter, signal);
          for (const artifact of outcome.artifacts) {
            if ((CHECKPOINT_FILES as readonly string[]).includes(artifact.name)) {
              checkpoints.current.set(artifact.name as CheckpointName, artifact.data);
            } else if (artifact.name !== RUN_STATE_FILE) {
              extra.current.set(artifact.name, artifact.data);
            }
          }
          applyState(outcome.state);
          saveRunFile();
          rep.reporter.progress(
            1,
            1,
            `${stepMeta(step).label} — done. The run file in your downloads is up to date.`,
          );
        } catch (error) {
          if (!isCancelledStep(error)) {
            rep.log(`ERROR: ${errorMessage(error)}`, 'error');
            logHint(rep.log, error);
            rep.setStatus('Failed — see the log above.');
            /* A failed step is a fact about the run: record it so a resume
             * sees it, and refresh the file. A CANCELLED step is not
             * recorded — the previous checkpoint stands (core's rule). */
            applyState(recordStepFailure(current, step, error));
            saveRunFile();
          } else {
            rep.log('cancelled', 'warn');
            rep.setStatus('Cancelled — the run file still says where the run stopped.');
          }
        } finally {
          await closeAll();
          rep.flush();
        }
      }),
    [applyState, hasCheckpoint, makeOpener, runner, saveRunFile, stepReporters],
  );

  const cancel = useCallback((): void => {
    runner.cancel();
    const active = runner.active;
    if (active?.startsWith(STEP_PANEL_PREFIX) === true) {
      const rep = reportersRef.current[active.slice(STEP_PANEL_PREFIX.length) as PreserveStepId];
      rep.setStatus('Cancelling ...');
    }
  }, [runner]);

  const saveAgain = useCallback((): void => {
    saveRunFile();
  }, [saveRunFile]);

  const resumeNeedsImage = state !== null && state.nextStep !== 'done' && !hasImage;

  return useMemo(
    () => ({
      planReporter,
      loadReporter,
      stepReporters,
      plan,
      state,
      confirmed,
      hasImage,
      resumeNeedsImage,
      hasCheckpoint,
      activeStep:
        runner.active?.startsWith(STEP_PANEL_PREFIX) === true
          ? (runner.active.slice(STEP_PANEL_PREFIX.length) as PreserveStepId)
          : null,
      planning: runner.active === PLAN_PANEL_ID,
      loading: runner.active === LOAD_PANEL_ID,
      lastSave,
      pickImage,
      confirmPlan,
      dismissPlan,
      loadRunFile,
      runStep,
      cancel,
      saveAgain,
    }),
    [
      plan,
      planReporter,
      loadReporter,
      stepReporters,
      state,
      confirmed,
      hasImage,
      resumeNeedsImage,
      hasCheckpoint,
      runner.active,
      lastSave,
      pickImage,
      confirmPlan,
      dismissPlan,
      loadRunFile,
      runStep,
      cancel,
      saveAgain,
    ],
  );
}

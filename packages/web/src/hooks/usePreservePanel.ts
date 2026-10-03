/**
 * The preserve wizard's state machine: one runner task per PHASE (each phase
 * runs its core steps back-to-back in that task), a fresh transport per
 * attempt through the opener ladder, per-phase reporters, and a run file
 * rebuilt and downloaded after every completed phase — because the run file
 * is the run's only memory.
 *
 * The invariants, and where they live:
 *  - Core's `runPreserveStep` enforces the run's own gates before anything
 *    touches the camera; `canRunPhase` mirrors them at phase granularity so
 *    the buttons enable exactly what core will accept, and the past-commit
 *    rows explain themselves loudly.
 *  - The opener ladder retries the session open for about a minute, because
 *    after the drain step's reset (and the restore's) the camera is silent
 *    for roughly ten seconds while it boots. That silence is progress text
 *    ("camera rebooting…"), never an error.
 *  - The transport is built fresh per attempt and closed in `finally`, the
 *    same discipline `useFlashPanel` holds.
 *  - THE RESET IS NOT A SWAP. The phases that reset the camera (② and ③)
 *    expect it to drop off the bus and re-enumerate — same vid/pid
 *    289d:0010; this camera has no USB serial string, so vid/pid plus the
 *    active run context is the discriminator. During such a phase a
 *    disconnect does NOT cancel: the opener ladder rides through the boot
 *    silence, `useDevice` re-adopts the re-enumerated device on its own
 *    connect event (no user gesture — the permission carries), and the phase
 *    continues. A device that appears with no drop before it, or more than
 *    one authorized camera answering `getDevices()` when the reconnect
 *    lands, is a swap — the run stops loudly. A true swap that slips past
 *    anyway is caught downstream: every later session re-checks the firmware
 *    version against the run's, and the restore re-checks the bank against
 *    the backup's detection.
 *  - Nothing touches browser storage. `state` + checkpoints live in memory,
 *    and their one durable copy is the downloaded run ZIP. The zip is
 *    written after every phase — and also when a phase FAILS or is
 *    cancelled, because a phase's steps record their checkpoints as they
 *    finish, and a mid-phase death must not take a recorded commit with it.
 *  - A FAILED step is recorded into the run state (core's
 *    `recordStepFailure`); a CANCELLED one is not — an interrupted run's
 *    previous checkpoint stands and a resume re-runs the step from the top.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CancelledError,
  SeekDevice,
  SEEK_VENDOR_ID,
  type SessionOpener,
  type WebUsbTransport,
} from '@seek-fw/core';
import { errorMessage } from '@seek-fw/core';
import { downloadBytes } from '../lib/download';
import { logHint } from '../lib/hints';
import { readOptions, type OptionsForm } from '../lib/options';
import { getWebUsb } from '../lib/webusb';
import {
  artifactLoader,
  createPreserveRun,
  isCancelledStep,
  recordStepFailure,
  runPreserveStep,
} from '../lib/preserve/client';
import { canRunPhase, gateReason } from '../lib/preserve/gating';
import { buildRunFile, parseRunFile } from '../lib/preserve/run-file';
import {
  CHECKPOINT_FILES,
  PRESERVE_PHASES,
  RESETS_CAMERA,
  RUN_STATE_FILE,
  phaseMeta,
  stepMeta,
  type CheckpointName,
  type PreservePhaseId,
  type PreserveRunState,
  type PreserveStepId,
} from '../lib/preserve/types';
import { useReporter, type ReporterHandle } from './useReporter';
import type { DeviceHandle } from './useDevice';
import type { Runner } from './useRunner';

export const LOAD_PANEL_ID = 'preserve:load';
export const PHASE_PANEL_PREFIX = 'preserve:phase:';

/** The opener ladder: ~60 attempts, 1 s apart — the CLI's post-reset shape. */
export const OPEN_ATTEMPTS = 60;

export function phasePanelId(phase: PreservePhaseId): string {
  return `${PHASE_PANEL_PREFIX}${phase}`;
}

export function phaseOfPanelId(id: string | null): PreservePhaseId | null {
  if (id?.startsWith(PHASE_PANEL_PREFIX) !== true) return null;
  const name = id.slice(PHASE_PANEL_PREFIX.length);
  return PRESERVE_PHASES.some((meta) => meta.id === name) ? (name as PreservePhaseId) : null;
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

export interface PreservePhaseRunOptions {
  /** The explicit past-commit jump, armed through the danger dialog. */
  readonly allowJump?: boolean;
  /**
   * The power-cycle assertion core's backup retry gate waits for: the row's
   * "I power-cycled the camera" control arms it after a failed backup, and
   * the press itself is the assertion — core cannot observe a power cycle.
   */
  readonly powerCycled?: boolean;
}

export interface PreservePanelApi {
  readonly loadReporter: ReporterHandle;
  readonly phaseReporters: Readonly<Record<PreservePhaseId, ReporterHandle>>;
  /** The live run state — set when phase ① creates the run, or on resume. */
  readonly state: PreserveRunState | null;
  readonly hasCheckpoint: (name: CheckpointName) => boolean;
  readonly activePhase: PreservePhaseId | null;
  readonly loading: boolean;
  readonly lastSave: RunFileSave | null;
  runPhase: (phase: PreservePhaseId, options?: PreservePhaseRunOptions) => Promise<void>;
  cancel: () => void;
  saveAgain: () => void;
  loadRunFile: (file: File) => Promise<void>;
}

function lastCompletedStep(state: PreserveRunState): PreserveStepId | 'created' {
  let last: PreserveStepId | 'created' = 'created';
  for (const meta of PRESERVE_PHASES) {
    for (const id of meta.steps) {
      if (state.steps[id]?.status === 'done') last = id;
    }
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

  const loadReporter = useReporter('No run file chosen.');
  /* Three fixed hook calls, one per phase — each phase's bar, status and log
   * live in its own RunPanel for the whole life of the wizard. */
  const phaseReporters: Readonly<Record<PreservePhaseId, ReporterHandle>> = {
    'read-build': useReporter('Not run yet.'),
    'patch-dump': useReporter('Not run yet.'),
    'restore-verify': useReporter('Not run yet.'),
  };
  const reportersRef = useRef(phaseReporters);
  reportersRef.current = phaseReporters;

  const [state, setState] = useState<PreserveRunState | null>(null);
  const [lastSave, setLastSave] = useState<RunFileSave | null>(null);

  const stateRef = useRef<PreserveRunState | null>(null);
  const checkpoints = useRef<Map<CheckpointName, Uint8Array>>(new Map());
  const extra = useRef<Map<string, Uint8Array>>(new Map());

  const applyState = useCallback((next: PreserveRunState): void => {
    stateRef.current = next;
    setState(next);
  }, []);

  const hasCheckpoint = useCallback((name: CheckpointName): boolean => {
    return checkpoints.current.has(name);
  }, []);

  /* ---- the run file ---------------------------------------------------- */

  const saveRunFile = useCallback((after: RunFileSave['afterStep']): void => {
    const current = stateRef.current;
    if (current === null) return;
    const zip = buildRunFile(current, checkpoints.current, extra.current);
    downloadBytes(zip, `preserve-run-${current.runId}.zip`, 'application/zip');
    setLastSave({
      runId: current.runId,
      afterStep: after,
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
              /* makeTransport reads the LIVE device, so an attempt that
               * lands after the reset's re-enumeration opens the camera
               * that came back, not the object that dropped. */
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
              /* A missed `connect` event must not strand the run: the camera
               * re-enumerates while the page holds nothing, and getDevices()
               * finds it without any event or gesture. */
              if (device.device === null) {
                await device.reattach();
              }
            }
            await waitMs(1000, signal);
          }
          throw new Error(
            `the camera did not come back after ${String(OPEN_ATTEMPTS)} s of retrying: ` +
              `${errorMessage(lastError)} — replug it and run the phase again`,
          );
        },
        close: closeAll,
      };
      return { opener, closeAll };
    },
    [device, form],
  );

  /* ---- the generation guard: the reset is not a swap -------------------- */

  const generation = useRef(device.generation);
  /* Set when the current phase saw its camera leave, so the reconnect that
   * follows can be recognised as the reset's re-enumeration. */
  const sawDisconnect = useRef(false);

  const stopForSwap = useCallback(
    (rep: ReporterHandle, why: string): void => {
      runner.cancel();
      sawDisconnect.current = false;
      rep.log(`${why} — stopping the phase (the camera may be a different unit)`, 'warn');
      rep.setStatus('Stopped — the camera changed. Check it, then run the phase again.');
    },
    [runner],
  );

  useEffect(() => {
    if (generation.current === device.generation) return;
    generation.current = device.generation;
    const phase = phaseOfPanelId(runner.active);
    if (phase === null) {
      sawDisconnect.current = false;
      return;
    }
    const rep = reportersRef.current[phase];

    if (device.device === null) {
      /* A device LEFT. On a phase that resets the camera this is the reset
       * itself — the opener ladder is already riding through the boot
       * silence, and the reconnect below re-adopts the unit. Anywhere else
       * it is an unplugged camera: stop. */
      if (RESETS_CAMERA.has(phase)) {
        sawDisconnect.current = true;
        rep.reporter.log(
          'the camera left the bus — the reset was expected; waiting for it to re-enumerate',
          'detail',
        );
        rep.setStatus('Camera rebooting — waiting for it to come back …');
        return;
      }
      stopForSwap(rep, 'the camera left the bus mid-phase');
      return;
    }

    /* A device ARRIVED. It is only the reset's re-enumeration when this
     * phase saw the drop first; a camera appearing with the seat still
     * filled (or refilled out of nowhere) is a second unit on the bus. */
    if (!RESETS_CAMERA.has(phase) || !sawDisconnect.current) {
      stopForSwap(rep, 'a camera appeared on the bus mid-phase');
      return;
    }
    sawDisconnect.current = false;
    /* THE COUNT CHECK: vid/pid is all the identity this camera offers, so
     * with more than one authorized camera on the bus, WHICH one came back
     * cannot be told apart — stop, and let the steps' own version/bank
     * gates be the backstop against anything that slipped through. */
    void (async () => {
      try {
        const usb = getWebUsb();
        if (usb !== null) {
          const known = await usb.getDevices();
          const seekUnits = known.filter((candidate) => candidate.vendorId === SEEK_VENDOR_ID);
          if (seekUnits.length > 1) {
            stopForSwap(
              rep,
              `${String(seekUnits.length)} authorized cameras answered when the camera ` +
                're-enumerated — the one that came back cannot be told apart',
            );
            return;
          }
        }
      } catch {
        /* an advisory check; the steps' gates are the real backstop */
      }
      rep.reporter.log('the camera re-enumerated — adopting it and continuing the phase', 'ok');
      rep.setStatus('Camera back — continuing …');
    })();
  }, [device, runner, stopForSwap]);

  /* ---- run one phase ---------------------------------------------------- */

  const runPhase = useCallback(
    (phase: PreservePhaseId, options: PreservePhaseRunOptions = {}): Promise<void> =>
      runner.start(phasePanelId(phase), async (signal) => {
        const rep = phaseReporters[phase];
        const meta = phaseMeta(phase);
        sawDisconnect.current = false;
        rep.reset(meta.resetsCamera ? 'Running — the camera will reset mid-phase …' : 'Running …');
        const allowJump = options.allowJump === true;

        let current = stateRef.current;
        if (current === null) {
          if (phase !== 'read-build') {
            rep.log('no run is active — the first phase creates the run', 'error');
            rep.setStatus('No run.');
            return;
          }
          try {
            /* The chunk the form holds is the drain's ask size, as the
             * CLI's global --chunk is. Core's default (64) is the ask
             * measured exact on silicon. */
            const opts = readOptions(form);
            const created = await createPreserveRun({ drainChunk: opts.chunk });
            current = created.state;
            applyState(current);
            rep.reporter.log(`run ${current.runId} created`, 'detail');
            rep.reporter.log(
              'the image will be read from the camera’s own active slot — there is no ' +
                'image file to pick anywhere in this wizard',
              'detail',
            );
          } catch (error) {
            rep.log(`cannot create the run: ${errorMessage(error)}`, 'error');
            logHint(rep.log, error);
            rep.setStatus('Not created — see the log above.');
            return;
          }
        }

        const gate = canRunPhase({ state: current, phase, has: hasCheckpoint });
        /* The power-cycle assertion the row's re-run control armed satisfies
         * the gate's one power-cycle gap — core's own retry gate takes the
         * same flag, so the panel must not refuse what core will accept. */
        const powerCycleArmed = gate.needsPowerCycle && options.powerCycled === true;
        if (!gate.ok && !(gate.jumpable && allowJump) && !powerCycleArmed) {
          rep.log(`refused: this phase ${gateReason(gate) ?? 'cannot run'}`, 'error');
          rep.setStatus('Refused — the phase list above says what is missing.');
          return;
        }
        if (allowJump && gate.jumpable) {
          rep.reporter.log(
            'JUMP past the unrecorded commit, on your assertion that the writes landed ' +
              'without their checkpoints — the steps’ own version and bank checks still run',
            'warn',
          );
        }

        const load = artifactLoader(checkpoints.current, extra.current);
        const { opener, closeAll } = makeOpener(rep, signal);
        let stepInFlight: PreserveStepId | null = null;
        try {
          for (const step of meta.steps) {
            if (current.steps[step]?.status === 'done') {
              rep.reporter.log(`${stepMeta(step).label} — already done, skipping`, 'detail');
              continue;
            }
            if (allowJump && step === 'commit' && current.steps.commit?.status === 'failed') {
              rep.reporter.log(
                'JUMP: the commit is not replayed — an attempt is on record and the bank ' +
                  'was read as already patched; continuing at the drain',
                'warn',
              );
              continue;
            }
            stepInFlight = step;
            const outcome = await runPreserveStep(
              step,
              opener,
              current,
              load,
              rep.reporter,
              signal,
              {
                ...(allowJump ? { allowJump: true } : {}),
                ...(options.powerCycled === true ? { powerCycled: true } : {}),
              },
            );
            stepInFlight = null;
            for (const artifact of outcome.artifacts) {
              if ((CHECKPOINT_FILES as readonly string[]).includes(artifact.name)) {
                checkpoints.current.set(artifact.name as CheckpointName, artifact.data);
              } else if (artifact.name !== RUN_STATE_FILE) {
                extra.current.set(artifact.name, artifact.data);
              }
            }
            current = outcome.state;
            applyState(current);
            rep.reporter.log(`${stepMeta(step).label} — done`, 'ok');
          }
          saveRunFile(lastCompletedStep(current));
          rep.reporter.progress(
            1,
            1,
            `${meta.label} — done. The run file in your downloads is up to date.`,
          );
        } catch (error) {
          if (!isCancelledStep(error)) {
            rep.log(`ERROR: ${errorMessage(error)}`, 'error');
            logHint(rep.log, error);
            rep.setStatus('Failed — see the log above.');
            /* A failed STEP is a fact about the run: record it so a resume
             * sees it, and refresh the file. A CANCELLED step is not
             * recorded — the previous checkpoint stands (core's rule). The
             * steps that DID finish inside this phase keep their records
             * either way, so the file names them. */
            if (stepInFlight !== null) {
              current = recordStepFailure(current, stepInFlight, error);
              applyState(current);
            }
            saveRunFile(lastCompletedStep(current));
          } else {
            rep.log('cancelled', 'warn');
            rep.setStatus('Cancelled — the run file still says where the run stopped.');
            /* The steps that finished before the cancel are recorded in
             * memory; put them in the file too, so closing the tab here
             * does not take a recorded commit with it. */
            saveRunFile(lastCompletedStep(current));
          }
        } finally {
          await closeAll();
          rep.flush();
        }
      }),
    [applyState, form, hasCheckpoint, makeOpener, phaseReporters, runner, saveRunFile],
  );

  /* ---- resume from a run file ------------------------------------------ */

  const loadRunFile = useCallback(
    (file: File): Promise<void> =>
      runner.start(LOAD_PANEL_ID, async () => {
        const rep = loadReporter;
        rep.reset('Reading run file …');
        try {
          const bytes = new Uint8Array(await file.arrayBuffer());
          rep.reporter.log(`${file.name} — ${String(bytes.length)} B`, 'detail');
          const parsed = parseRunFile(bytes);
          checkpoints.current = new Map(parsed.checkpoints);
          extra.current = new Map(parsed.extra);
          applyState(parsed.state);
          for (const meta of PRESERVE_PHASES) {
            const phaseRep = phaseReporters[meta.id];
            const records = meta.steps.map((id) => parsed.state.steps[id]);
            if (records.every((record) => record?.status === 'done')) {
              phaseRep.reset('Done earlier — loaded from the run file.');
            } else if (records.some((record) => record?.status === 'failed')) {
              const failed = records.find((record) => record?.status === 'failed');
              phaseRep.reset(`Failed earlier: ${failed?.error ?? 'unknown reason'}`);
            } else {
              phaseRep.reset('Not run yet.');
            }
          }
          rep.reporter.log(
            'run ' +
              parsed.state.runId +
              ' — created ' +
              parsed.state.createdAt +
              ', schema version ' +
              String(parsed.state.version),
            'detail',
          );
          if (parsed.state.expectedVersion !== undefined) {
            rep.reporter.log(`firmware ${parsed.state.expectedVersion}`, 'detail');
          }
          rep.reporter.log(
            parsed.state.imageSource === 'device'
              ? 'the factory plaintext derives from the camera’s own active slot — the run ' +
                  'file carries it; nothing else is needed'
              : 'the run predates the self-sourcing schema; its steps work off the artifacts ' +
                  'the file carries',
            'detail',
          );
          rep.reporter.log(
            `checkpoints loaded: ${[...parsed.checkpoints.keys()].join(', ') || 'none yet'}`,
            'detail',
          );
          rep.reporter.progress(
            1,
            1,
            `Resumed at ${parsed.state.nextStep}. The phase list picks up from there.`,
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
    [applyState, loadReporter, phaseReporters, runner],
  );

  const cancel = useCallback((): void => {
    runner.cancel();
    const phase = phaseOfPanelId(runner.active);
    if (phase !== null) phaseReporters[phase].setStatus('Cancelling …');
  }, [phaseReporters, runner]);

  const saveAgain = useCallback((): void => {
    const current = stateRef.current;
    if (current === null) return;
    saveRunFile(lastCompletedStep(current));
  }, [saveRunFile]);

  return useMemo(
    () => ({
      loadReporter,
      phaseReporters,
      state,
      hasCheckpoint,
      activePhase: phaseOfPanelId(runner.active),
      loading: runner.active === LOAD_PANEL_ID,
      lastSave,
      runPhase,
      cancel,
      saveAgain,
      loadRunFile,
    }),
    [
      loadReporter,
      phaseReporters,
      state,
      hasCheckpoint,
      runner.active,
      lastSave,
      runPhase,
      cancel,
      saveAgain,
      loadRunFile,
    ],
  );
}

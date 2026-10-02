/**
 * `seek-fw preserve` — the full-flash preservation pipeline for the v1
 * locked line (Compact 1.0.0.0 / 1.2.0.0 / 1.3.0.0), run as SIX RESUMABLE
 * STEPS with a checkpoint written after every one.
 *
 * THE HONEST RISK, STATED WHERE THE OPERATOR IS. The commit and restore steps
 * write the ACTIVE boot slot over the wire. On real hardware an interrupted
 * write there has NO bootable fallback: the other banks hold whatever they
 * hold, the recovery slot is not written by this pipeline, and a power loss
 * mid-commit is unrecoverable without an SPI programmer. The stepwise shape is
 * the CLI's share of the mitigation, and it exists for one measured reason:
 * the old write-at-the-end flow reached disk only after the whole run, so a
 * crash after the commit lost the restore source with the process. Now the
 * backup — and the standard dump archive built from it, the pre-flash dump of
 * every region the stock plan can read — is on disk BEFORE anything
 * write-shaped can possibly run, and every later step checkpoints behind it.
 *
 * THE IMAGE IS THE CAMERA'S OWN. There is no image argument anywhere: the
 * backup step reads the active slot's image TWICE, requires the two reads to
 * agree byte for byte, derives the factory plaintext from that capture
 * (identity on the 2014 plain chain; the build family's keystream solver on a
 * cipher family), and gates the derived image before anything is trusted —
 * the version cross-check against the camera's own report, the build table's
 * detect hooks and before-bytes (an already-patched bank refuses here). The
 * derived image is a run artifact, so `--resume` never needs any external
 * file.
 *
 * The commands:
 *
 *   seek-fw preserve [--out dir]           a full run; checkpoint after every
 *                                          step (preserve_run.json + files)
 *   seek-fw preserve --resume <dir>        continue from state.nextStep —
 *                                          no image, no other file
 *   seek-fw preserve --resume <dir> --from-step <id>  start at a chosen step
 *   seek-fw preserve --print-state <dir>   the run state, next step, and
 *                                          whether the checkpoint files
 *                                          still match what was recorded
 *
 * The steps refuse to run on a torn run directory (a gate per step, in core),
 * the commit step reads the bank back before it writes (a landed commit is
 * never replayed), and a Ctrl-C leaves the previous checkpoint standing — the
 * interrupted step is simply re-run on the next --resume.
 */

import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  CancelledError,
  PRESERVE_STEP_IDS,
  PRESERVE_RUN_STATE_FILE,
  createPreserveRun,
  hexUp,
  isPreserveStepId,
  recordStepFailure,
  runPreserveStep,
  type PreserveArtifactLoader,
  type PreserveRunState,
  type PreserveStepId,
  type SessionOpener,
} from '@seek-fw/core';
import type { CommandContext, CommandResult } from '../cli.js';
import { CliError } from '../errors.js';
import {
  artifactInventory,
  loadRunState,
  saveRunState,
  writeRunArtifact,
} from '../preserve-store.js';
import { openSession, type Session } from './shared.js';

/** The artifacts land here when --out is not given. */
const DEFAULT_OUT = 'preserve-run';

/** The staged-form line of the plan print, in plain words. */
function describeStagedForm(form: 'plain' | 'xor-ks0' | 'xor-ks0-ksD'): string {
  switch (form) {
    case 'plain':
      return 'plain — the 2014 banks hold the image as stored; the wire payload is the conjugated capture';
    case 'xor-ks0':
      return 'staged = patched plain XOR keystream(key block 0) — the 2016 two-keystream cipher';
    case 'xor-ks0-ksD':
      return 'staged = patched plain XOR keystream(block 0) XOR keystream(block 1) — the FF build two-stream form';
  }
}

/** The restore line of the plan print: can the run put the bank back? */
function describeRestoreForm(form: 'capture-verbatim' | 'factory-staged' | 'none'): string {
  switch (form) {
    case 'capture-verbatim':
      return 'the backup capture, staged verbatim (the plaintext banks hold the image)';
    case 'factory-staged':
      return 'the factory image in the staged form (the commit transform reproduces the slot)';
    case 'none':
      return (
        'REFUSED on this build — no staged form of the factory image passes the running ' +
        'app’s own acceptance while transforming back to the original slot bytes ' +
        '(accept1 reads sum(P ^ ksD); the factory carries 0xB7AB9D17 there, not 0xFFFF). ' +
        'The run ends with the delivered dump in hand and the patch in place.'
      );
  }
}

/** The drain line of the plan print: what this build's drain may promise.
 *  On a build whose capability carries per-build facts (the 0.x line's wire-88
 *  reader, the 0.7.0.7 rotation, the mode-2 hazard ordering) the note rides
 *  along — those lines are the honest capability statement, and the plan print
 *  is where an operator reads it before confirming the run. */
function describeCapability(capability: {
  wholePart: boolean;
  losslessReadUnit: number;
  maxPerArmReach?: number;
  rotation?: { readonly walk: string; readonly measuredBase: number };
  modeTwoHazardSites?: readonly number[];
  note: string;
}): string {
  if (capability.wholePart) {
    const perBuild =
      capability.rotation !== undefined || capability.modeTwoHazardSites !== undefined
        ? ` — ${capability.note}`
        : '';
    return (
      `whole part: yes — one widened-window arm; lossless read unit ` +
      `${String(capability.losslessReadUnit)} B${perBuild}`
    );
  }
  return `REFUSED on this build — ${capability.note}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A cancelled run is an interrupt (exit 130, previous checkpoint stands), not
 *  a failed step — both shapes the run can arrive in are recognised here. */
function isCancellation(error: unknown): boolean {
  return (
    error instanceof CancelledError || (error instanceof CliError && error.code === 'cancelled')
  );
}

async function readImageOrNull(path: string): Promise<Uint8Array | null> {
  try {
    const buffer = await readFile(path);
    return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  } catch {
    return null;
  }
}

export async function preserveCommand(ctx: CommandContext): Promise<CommandResult> {
  if (ctx.options.printState !== null)
    return printStateCommand(ctx, resolve(ctx.options.printState));

  if (ctx.options.resume !== null && ctx.options.out !== null) {
    throw new CliError(
      `--resume names the run directory (${ctx.options.resume}) and --out would move it — ` +
        'pass one, not both',
      { code: 'cli/usage' },
    );
  }
  if (ctx.options.fromStep !== null && ctx.options.resume === null) {
    throw new CliError('--from-step needs --resume <dir>: it starts inside an existing run', {
      code: 'cli/usage',
      hint: 'Run `seek-fw preserve --print-state <dir>` first to see where that run stands.',
    });
  }

  return ctx.options.resume !== null
    ? resumeCommand(ctx, resolve(ctx.options.resume))
    : freshCommand(ctx, resolve(ctx.options.out ?? DEFAULT_OUT));
}

/* ==================================================================== *
 * a fresh run
 * ==================================================================== */

async function freshCommand(ctx: CommandContext, outDir: string): Promise<CommandResult> {
  /* Nobody to ask: same rule as flash, checked before the camera opens. */
  if (!ctx.options.yes && !ctx.io.stdinIsTty) {
    throw new CliError(
      'refusing to run the preservation pipeline without confirmation: stdin is not a ' +
        'terminal, so there is nobody to ask',
      {
        code: 'flash/refused',
        hint:
          'This pipeline WRITES the active boot slot (the commit and restore steps). Pass ' +
          '--yes to confirm non-interactively after reading the plan on a terminal.',
      },
    );
  }

  /* The run is created empty and self-sources: the backup step derives the
   * image from the camera and records the build it finds. The detailed plan
   * prints the moment it exists — after the patch step, before anything
   * write-shaped runs — and an interactive run confirms again there. */
  const created = await createPreserveRun({
    /* The global --chunk, where the drain step is given one; the default
     * (READ_CHUNK, 64) is the ask measured exact on silicon (TESTING.md
     * sec. 28.3). */
    ...(ctx.options.chunk === null ? {} : { drainChunk: ctx.options.chunk }),
  });

  const say = (text: string): void => {
    ctx.reporter.write(text);
  };

  say('');
  say('preserve plan — self-sourced from the camera');
  say('  image source       read from the camera’s active slot, two agreeing reads');
  say('  build              detected from the derived image after the backup step; the');
  say('                     full plan (patch sites, commit route, restore, drain) prints');
  say('                     then, before anything write-shaped runs');
  say('  steps              backup -> patch -> commit -> drain -> restore -> verify');
  say('  run directory      each step checkpoints there; the backup (and the standard dump');
  say('                     archive built from it) is on disk BEFORE anything is written');
  say('  RISK               commit and restore write a BOOT slot. On hardware an');
  say('                     interrupted write there has no bootable fallback (an SPI');
  say('                     programmer is the only way back).');
  say(`  interrupted?       seek-fw preserve --resume ${outDir}`);
  say('');

  if (!ctx.options.yes) {
    const confirmed = await ctx.io.confirm(
      'Back this camera up (read-only), derive the patch from its own flash, and show the ' +
        'plan before anything is written? The commit afterwards WILL write the active boot ' +
        'slot. [y/N] ',
    );
    if (!confirmed) {
      throw new CliError('aborted at the confirmation prompt — nothing was written', {
        code: 'flash/refused',
      });
    }
  } else {
    ctx.reporter.log('--yes given: skipping the confirmation', 'warn');
  }

  if (await stateExists(outDir)) {
    throw new CliError(
      `${outDir} already holds a ${PRESERVE_RUN_STATE_FILE} — refusing to overwrite a run. ` +
        `Resume it with --resume ${outDir}, or pass --out with a fresh directory.`,
      { code: 'preserve/state' },
    );
  }

  /* The initial checkpoint lands BEFORE the first step: a crash during the
   * backup itself still leaves a resumable run. */
  await saveRunState(outDir, created.state);
  const finalState = await runSteps(ctx, outDir, created.state, {
    onPlanReady: (state) => confirmDerivedPlan(ctx, outDir, state),
  });

  return runResult(ctx, outDir, finalState);
}

/** The detailed plan, printed from the state the backup and patch steps
 *  recorded — the first moment the build's facts exist. An interactive run
 *  confirms here, at the last gate before the first write; --yes just prints. */
async function confirmDerivedPlan(
  ctx: CommandContext,
  outDir: string,
  state: PreserveRunState,
): Promise<void> {
  const patch = state.patch;
  const say = (text: string): void => {
    ctx.reporter.write(text);
  };

  say('');
  say(`preserve plan — derived from the camera (run ${state.runId})`);
  say('  image source       read from the camera’s active slot, two agreeing reads');
  if (state.slotReadShas !== undefined)
    say(`                     (sha256 ${state.slotReadShas[0]})`);
  say(
    `  build              ${state.buildLabel ?? state.buildId ?? state.buildFamily ?? '?'} ` +
      `(${state.buildId ?? '?'}, family ${state.buildFamily ?? '?'})`,
  );
  say(
    `  image version      ${state.expectedVersion ?? '?'} (${String(patch?.stagedLength ?? 0)} B)`,
  );
  say(`  patch sites        ${String(patch?.sites.length ?? 0)} instruction edit(s)`);
  for (const site of patch?.sites ?? []) {
    say(`    ${hexUp(site.offset)}  ${site.name}`);
  }
  if (patch !== undefined) {
    say(`  rebalance word     ${hexUp(patch.rebalanceWord)} at 0x00000238`);
    say(
      `  bytes that move    ${String(patch.diffCount ?? 0)} on the part, all inside the ` +
        (state.route === 'recovery-only' ? 'recovery bank' : 'active bank'),
    );
  }
  if (state.stagedForm !== undefined)
    say(`  staged form        ${describeStagedForm(state.stagedForm)}`);
  if (state.routeNote !== null && state.routeNote !== undefined) {
    say(`  commit route       ${state.routeNote}`);
  }
  if (state.restoreForm !== undefined)
    say(`  restore            ${describeRestoreForm(state.restoreForm)}`);
  if (state.capability !== undefined)
    say(`  drain              ${describeCapability(state.capability)}`);
  say(
    `  next write         the commit step, into the ${
      state.route === 'recovery-only' ? 'RECOVERY' : 'ACTIVE'
    } bank`,
  );
  say(`  run directory      ${outDir}`);
  say('');

  if (ctx.options.yes) return;
  const confirmed = await ctx.io.confirm(
    `Proceed to the commit — the first write, into the ` +
      `${state.route === 'recovery-only' ? 'RECOVERY' : 'ACTIVE'} boot bank of this camera ` +
      `(${state.expectedVersion ?? '?'})? [y/N] `,
  );
  if (!confirmed) {
    throw new CliError(
      'aborted at the plan prompt — nothing was written; the backup and the derived plan are ' +
        `checkpointed in ${outDir} (resume with --resume ${outDir}, or delete the directory)`,
      { code: 'flash/refused' },
    );
  }
}

/* ==================================================================== *
 * resuming a run
 * ==================================================================== */

async function resumeCommand(ctx: CommandContext, runDir: string): Promise<CommandResult> {
  if (!ctx.options.yes && !ctx.io.stdinIsTty) {
    throw new CliError(
      'refusing to resume a preservation run without confirmation: stdin is not a terminal, ' +
        'so there is nobody to ask',
      {
        code: 'flash/refused',
        hint:
          'Resuming can WRITE the active boot slot (the commit and restore steps). Pass --yes ' +
          'to confirm non-interactively.',
      },
    );
  }

  /* The flag is validated before the run directory is even read: a typo in
   * --from-step is a usage error, not a missing-file error. */
  let fromStep: PreserveStepId | null = null;
  if (ctx.options.fromStep !== null) {
    if (!isPreserveStepId(ctx.options.fromStep)) {
      throw new CliError(
        `--from-step '${ctx.options.fromStep}' is not a step; the steps are ` +
          PRESERVE_STEP_IDS.join(', '),
        { code: 'cli/usage' },
      );
    }
    fromStep = ctx.options.fromStep;
  }

  /* No image is passed and none is needed: the run directory carries the
   * derived factory plaintext (the backup step wrote it there), and the steps
   * refuse with the remedy when a checkpoint file is missing. */
  const state = await loadRunState(runDir);

  if (state.nextStep === 'done') {
    ctx.reporter.log(`run ${state.runId} is already done — nothing to resume`, 'warn');
    return runResult(ctx, runDir, state);
  }
  let start: PreserveStepId = state.nextStep;
  if (fromStep !== null) start = fromStep;

  /* THE LOUD WARN. A forward jump skips steps this run never completed; past
   * the commit it asserts the camera is in the patched state, which is the
   * one assertion this tool will not make quietly. */
  if (start !== state.nextStep) {
    const skipped = PRESERVE_STEP_IDS.slice(
      PRESERVE_STEP_IDS.indexOf(state.nextStep),
      PRESERVE_STEP_IDS.indexOf(start),
    );
    if (skipped.length > 0) {
      ctx.reporter.log(
        `WARNING: jumping from ${state.nextStep} to ${start}, skipping: ` + skipped.join(', '),
        'warn',
      );
    }
  }
  if (
    PRESERVE_STEP_IDS.indexOf(start) > PRESERVE_STEP_IDS.indexOf('commit') &&
    state.steps.commit?.status !== 'done'
  ) {
    ctx.reporter.log(
      'WARNING: this jump goes past an INCOMPLETE commit — the camera is expected to be in ' +
        'the PATCHED state (the commit may have landed without its checkpoint being written). ' +
        'The jump is granted because you asked for it explicitly; the protections that remain ' +
        "are the steps' own: the restore detects an already-original bank, and the verify " +
        'refuses any diff against the backup. If the camera is NOT patched, stop and re-run ' +
        'the commit instead (--resume without --from-step) — its pre-check reads the bank ' +
        'before writing.',
      'warn',
    );
  }

  ctx.reporter.log(
    `resuming run ${state.runId} (${state.expectedVersion ?? 'image not derived yet'}) at ${start}` +
      (ctx.options.fromStep === null ? '' : ' (--from-step)'),
    'detail',
  );
  const finalState = await runSteps(
    ctx,
    runDir,
    {
      ...state,
      nextStep: start,
      /* An explicit --chunk on a resume overrides the recorded drain ask size. */
      ...(ctx.options.chunk === null ? {} : { drainChunk: ctx.options.chunk }),
    },
    /* An explicit --from-step is the one loud way a jump past an incomplete
     * write step is granted; core relaxes only the ordering gates, never the
     * file gates, and the wire-side pre-checks stay in the steps. */
    { allowJump: fromStep !== null },
  );
  return runResult(ctx, runDir, finalState);
}

/* ==================================================================== *
 * the step loop — checkpoint after every step
 * ==================================================================== */

async function stateExists(runDir: string): Promise<boolean> {
  try {
    await stat(`${runDir}/${PRESERVE_RUN_STATE_FILE}`);
    return true;
  } catch {
    return false;
  }
}

async function runSteps(
  ctx: CommandContext,
  runDir: string,
  initialState: PreserveRunState,
  options: {
    readonly allowJump?: boolean;
    /** Called once, after the step that first records the patch summary —
     *  the first moment the derived plan exists (and still before anything
     *  write-shaped runs). */
    readonly onPlanReady?: (state: PreserveRunState) => Promise<void>;
  } = {},
): Promise<PreserveRunState> {
  /* A fresh session per step boundary. After a wire-89 the camera
   * re-enumerates, so open() retries until the camera is back (or the run is
   * cancelled) — 60 attempts, 1 s apart, covers a full boot of silence. */
  let current: Session | null = null;
  const opener: SessionOpener = {
    open: async () => {
      for (let attempt = 0; ; attempt++) {
        /* Core's own cancellation type: describeError maps it to exit 130,
         * the same code a SIGINT mid-transfer takes. */
        if (ctx.signal.aborted) throw new CancelledError();
        try {
          current = await openSession(ctx);
          return current.device;
        } catch (error) {
          if (attempt >= 60) {
            throw new CliError(
              `the camera did not come back after ${String(attempt + 1)} attempts — ` +
                'replug it and re-run the phase that failed. Nothing more was written. ' +
                `Last error: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
          await sleep(1000);
        }
      }
    },
    close: async () => {
      const session = current;
      current = null;
      await session?.close();
    },
  };

  /* Every checkpoint — the derived factory plaintext included — is a run
   * directory file; core sha-checks each against the backup step's record. */
  const loadArtifact: PreserveArtifactLoader = (name) => readImageOrNull(`${runDir}/${name}`);

  let state = initialState;
  let planned = false;
  while (state.nextStep !== 'done') {
    const step: PreserveStepId = state.nextStep;
    ctx.reporter.log(`— ${step} —`, 'info');
    let outcome;
    try {
      outcome = await runPreserveStep(
        step,
        opener,
        state,
        loadArtifact,
        ctx.reporter,
        ctx.signal,
        options.allowJump === true ? { allowJump: true } : {},
      );
    } catch (error) {
      if (isCancellation(error)) throw error;
      /* The failure is checkpointed; --print-state reports it, and the step
       * can be re-run (a `failed` record never blocks). */
      state = recordStepFailure(state, step, error);
      await saveRunState(runDir, state);
      ctx.reporter.log(
        `${step} failed: ${error instanceof Error ? error.message : String(error)} — ` +
          `recorded in ${runDir}/${PRESERVE_RUN_STATE_FILE}; ` +
          'the previous checkpoint stands. Fix the cause and resume.',
        'error',
      );
      throw error;
    }
    /* Artifacts first, state second: a crash in between leaves the state
     * behind the files, which a resume catches up from. */
    for (const artifact of outcome.artifacts) {
      const file = await writeRunArtifact(runDir, artifact);
      ctx.reporter.log(`wrote ${file}`, 'detail');
    }
    state = outcome.state;
    await saveRunState(runDir, state);
    if (!planned && state.patch !== undefined) {
      planned = true;
      if (options.onPlanReady !== undefined) await options.onPlanReady(state);
    }
  }
  return state;
}

/* ==================================================================== *
 * the results
 * ==================================================================== */

function runResult(ctx: CommandContext, runDir: string, state: PreserveRunState): CommandResult {
  const stepIds = PRESERVE_STEP_IDS.filter((id) => state.steps[id] !== undefined);
  if (ctx.human) {
    for (const id of stepIds) {
      const record = state.steps[id];
      const mark = record?.status === 'done' ? 'ok' : 'FAILED';
      ctx.out(`${id} ${mark}: ${record?.notes ?? record?.error ?? ''}`);
    }
    ctx.out(`run ${state.runId}: next step ${state.nextStep}`);
    ctx.out(`run directory: ${runDir}`);
  }
  return {
    image: {
      source: state.imageSource ?? 'user-file',
      version: state.expectedVersion ?? null,
      sha256: state.imageSha256 ?? null,
    },
    run: {
      id: state.runId,
      directory: runDir,
      nextStep: state.nextStep,
      createdAt: state.createdAt,
    },
    detection:
      state.detection === undefined
        ? null
        : {
            cfg0: state.detection.cfg0,
            blank: state.detection.blank,
            bankAddress: state.detection.bankAddress,
            verdict: state.detection.verdict,
          },
    patch: state.patch ?? null,
    steps: Object.fromEntries(stepIds.map((id) => [id, state.steps[id]])),
    verify: state.verify ?? null,
    sha256: {
      image: state.imageSha256 ?? null,
      slotReads: state.slotReadShas === undefined ? null : [...state.slotReadShas],
      rawDump: state.rawDumpSha256 ?? null,
      deliveredDump: state.deliveredSha256 ?? null,
    },
    output: { directory: runDir, record: `${runDir}/${PRESERVE_RUN_STATE_FILE}` },
  };
}

/* ==================================================================== *
 * --print-state
 * ==================================================================== */

async function printStateCommand(ctx: CommandContext, runDir: string): Promise<CommandResult> {
  const state = await loadRunState(runDir);
  const inventory = await artifactInventory(runDir, state);

  if (ctx.human) {
    const say = (text: string): void => {
      ctx.reporter.write(text);
    };
    say(`preserve run ${state.runId}`);
    say(`  directory          ${runDir}`);
    say(`  created            ${state.createdAt}`);
    say(`  schema version     ${String(state.version)}`);
    say(
      state.imageSource === 'device'
        ? '  image source       the camera’s active slot (two agreeing reads)'
        : '  image source       a file the run was started with (version-1 schema)',
    );
    if (state.imageSha256 !== undefined) say(`  image sha256       ${state.imageSha256}`);
    if (state.slotReadShas !== undefined) {
      say(`  slot reads         ${state.slotReadShas[0]}`);
      say(`                     ${state.slotReadShas[1]}`);
    }
    say(`  expected version   ${state.expectedVersion ?? '(not derived yet)'}`);
    say(
      `  build              ${state.buildId ?? state.buildFamily ?? '(not derived yet)'}${
        state.buildFamily === undefined ? '' : ` (family ${state.buildFamily}`
      }${state.stagedForm === undefined ? '' : `, staged ${state.stagedForm}`}${
        state.buildFamily === undefined ? '' : ')'
      }`,
    );
    if (state.capability !== undefined) {
      say(`  drain              ${describeCapability(state.capability)}`);
    }
    say(`  next step          ${state.nextStep}`);
    for (const id of PRESERVE_STEP_IDS) {
      const record = state.steps[id];
      if (record === undefined) {
        say(`  ${id.padEnd(8)} not run yet`);
        continue;
      }
      say(
        `  ${id.padEnd(8)} ${record.status}${record.error === undefined ? '' : `: ${record.error}`}`,
      );
      if (record.notes !== undefined) say(`           ${record.notes}`);
    }
    if (state.rawDumpSha256 !== undefined) say(`  raw dump sha256    ${state.rawDumpSha256}`);
    if (state.deliveredSha256 !== undefined) {
      say(`  delivered sha256   ${state.deliveredSha256}`);
    }
    if (inventory.length > 0) {
      say('  checkpoint files');
      for (const entry of inventory) {
        const verdict = !entry.present ? 'MISSING' : entry.shaMatches === false ? 'CHANGED' : 'ok';
        say(`    ${verdict.padEnd(8)} ${entry.name}`);
      }
    }
  }
  return {
    run: {
      id: state.runId,
      directory: runDir,
      nextStep: state.nextStep,
      createdAt: state.createdAt,
    },
    state,
    inventory,
  };
}

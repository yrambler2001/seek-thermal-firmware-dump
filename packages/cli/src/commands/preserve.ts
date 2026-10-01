/**
 * `seek-fw preserve <image>` — the full-flash preservation pipeline for the v1
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
 * The commands:
 *
 *   seek-fw preserve <image> [--out dir]   a full run; checkpoint after every
 *                                          step (preserve_run.json + files)
 *   seek-fw preserve --resume <dir> [image]  continue from state.nextStep
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
import { basename, resolve } from 'node:path';

import {
  CancelledError,
  PRESERVE_PLAIN_NAME,
  PRESERVE_STEP_IDS,
  PRESERVE_RUN_STATE_FILE,
  createPreserveRun,
  hexUp,
  isPreserveStepId,
  parseImageHeader,
  recordStepFailure,
  runPreserveStep,
  sha256hex,
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
        'app\u2019s own acceptance while transforming back to the original slot bytes ' +
        '(accept1 reads sum(P ^ ksD); the factory carries 0xB7AB9D17 there, not 0xFFFF). ' +
        'The run ends with the delivered dump in hand and the patch in place.'
      );
  }
}

/** The drain line of the plan print: what this build's drain may promise. */
function describeCapability(capability: {
  wholePart: boolean;
  losslessReadUnit: number;
  maxPerArmReach?: number;
  note: string;
}): string {
  if (capability.wholePart) {
    return (
      `whole part: yes — one widened-window arm; lossless read unit ` +
      `${String(capability.losslessReadUnit)} B`
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
  const imagePath = ctx.file;
  if (imagePath === null) {
    throw new CliError('preserve needs a decrypted firmware image argument', {
      code: 'cli/usage',
    });
  }

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

  const fileName = basename(imagePath);
  const image = await readImageOrNull(imagePath);
  if (image === null) {
    throw new CliError(`could not read ${imagePath}`, { code: 'cli/no-input' });
  }

  /* The expected version comes FROM the image: the patch is derived from one
   * build's bytes, and the camera must report that build before anything is
   * sent. The builder also refuses an image that does not carry the 2014
   * update machinery, so a wrong file fails here, on the desk. */
  const header = parseImageHeader(image);
  if (header === null) {
    throw new CliError(
      `${fileName} does not parse as a decrypted Seek firmware image (no header at 0x200)`,
      { code: 'image/malformed' },
    );
  }
  const created = await createPreserveRun(image, {
    /* The global --chunk, where the drain step is given one; the emulator
     * suite drains at 64 asks, hardware keeps the 512 default. */
    ...(ctx.options.chunk === null ? {} : { drainChunk: ctx.options.chunk }),
  });
  const patch = created.patch;
  const say = (text: string): void => {
    ctx.reporter.write(text);
  };

  say('');
  say(`preserve plan — ${fileName}`);
  say(`  build              ${patch.label} (${patch.buildId}, family ${patch.family})`);
  say(`  image version      ${created.state.expectedVersion} (${String(image.length)} B)`);
  say(`  patch sites        ${String(patch.sites.length)} instruction edit(s)`);
  for (const site of patch.sites) {
    say(`    ${hexUp(site.offset)}  ${site.what}`);
  }
  say(`  rebalance word     ${hexUp(patch.rebalanceWord)} at 0x00000238`);
  say(
    `  bytes that move    ${String(patch.diffOffsets.length)} on the part, all inside the ` +
      (patch.route === 'recovery-only' ? 'recovery bank' : 'active bank'),
  );
  say(`  staged form        ${describeStagedForm(patch.stagedForm)}`);
  if (patch.routeNote !== null) say(`  commit route       ${patch.routeNote}`);
  say(`  restore            ${describeRestoreForm(patch.restoreForm)}`);
  say(`  drain              ${describeCapability(patch.capability)}`);
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
      `Back this camera up, patch the ${patch.route === 'recovery-only' ? 'RECOVERY' : 'ACTIVE'} ` +
        `slot in place, dump the whole part${
          patch.capability.wholePart ? '' : ' (NOT on this build — the drain will refuse)'
        }, and restore it (${created.state.expectedVersion})? [y/N] `,
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
  const finalState = await runSteps(ctx, outDir, created.state, image);

  return runResult(ctx, outDir, finalState, fileName);
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

  const state = await loadRunState(runDir);

  /* An image that was passed is checked BEFORE anything else about the run is
   * interpreted: a wrong file is refused even on a run that is already done,
   * because "nothing to resume" must never read as "this image is fine". */
  let image: Uint8Array | null = null;
  if (ctx.file !== null) {
    image = await readImageOrNull(ctx.file);
    if (image === null) throw new CliError(`could not read ${ctx.file}`, { code: 'cli/no-input' });
    const sha = await sha256hex(image);
    if (sha !== state.imageSha256) {
      throw new CliError(
        `${ctx.file} is not the image this run was created from (sha256 ${sha}, the run ` +
          `records ${state.imageSha256}) — resume with the same file the run started with`,
        { code: 'preserve/state' },
      );
    }
  }

  if (state.nextStep === 'done') {
    ctx.reporter.log(`run ${state.runId} is already done — nothing to resume`, 'warn');
    return runResult(ctx, runDir, state, ctx.file === null ? null : basename(ctx.file));
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

  /* The image (already sha-checked above) is needed only by the steps that
   * rebuild the patch — and by the restore of a cipher-family run, whose
   * staged-form restore payload is derived from the factory plaintext. */
  const needsPlain =
    start === 'patch' ||
    start === 'commit' ||
    (start === 'restore' && state.stagedForm !== undefined && state.stagedForm !== 'plain');
  if (image === null && needsPlain) {
    throw new CliError(
      `resuming at ${start} needs the factory plaintext the patch derives from — pass the ` +
        'image path: seek-fw preserve <image> --resume <dir>',
      { code: 'cli/usage' },
    );
  }

  ctx.reporter.log(
    `resuming run ${state.runId} (${state.expectedVersion}) at ${start}` +
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
    image,
    /* An explicit --from-step is the one loud way a jump past an incomplete
     * write step is granted; core relaxes only the ordering gates, never the
     * file gates, and the wire-side pre-checks stay in the steps. */
    fromStep !== null,
  );
  return runResult(ctx, runDir, finalState, ctx.file === null ? null : basename(ctx.file));
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
  image: Uint8Array | null,
  allowJump = false,
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

  /* The factory plaintext arrives by this callback, never from the run
   * directory; core checks its sha against the state on every load. */
  const loadArtifact: PreserveArtifactLoader = async (name) => {
    if (name === PRESERVE_PLAIN_NAME) return image;
    return readImageOrNull(`${runDir}/${name}`);
  };

  let state = initialState;
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
        allowJump ? { allowJump: true } : {},
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
  }
  return state;
}

/* ==================================================================== *
 * the results
 * ==================================================================== */

function runResult(
  ctx: CommandContext,
  runDir: string,
  state: PreserveRunState,
  fileName: string | null,
): CommandResult {
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
    image:
      fileName === null
        ? null
        : { file: fileName, version: state.expectedVersion, sha256: state.imageSha256 },
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
      image: state.imageSha256,
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
    say(`  image sha256       ${state.imageSha256}`);
    say(`  expected version   ${state.expectedVersion}`);
    say(
      `  build              ${state.buildId ?? state.buildFamily} (family ` +
        `${state.buildFamily}${state.stagedForm === undefined ? '' : `, staged ${state.stagedForm}`})`,
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

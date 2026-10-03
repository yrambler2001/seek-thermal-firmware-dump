/**
 * The preservation pipeline as SIX RESUMABLE STEPS.
 *
 * `pipeline.ts` runs the whole operation in one call with cross-phase state in
 * locals — right for a process that stays alive, wrong for everything else: a
 * run that dies after the commit takes the restore source with it if the
 * backup only reaches disk at the end. This module splits the same operation
 * at the joints a crash actually leaves behind, so each step ends with
 * everything it produced in the caller's hands:
 *
 *   backup  — the 31 stock windows, the active-bank capture read TWICE under
 *             the serve budget (the sweep's own row at the bank address, then
 *             ONE fresh arm — the active slot is served exactly twice per
 *             boot) with the verified-arm ladder on both reads (a swallowed
 *             arm is re-armed once; garbage twice refuses with the power-cycle
 *             remedy; two plausible reads that differ stay a refusal), the
 *             factory plaintext DERIVED from that capture (`solve.ts`:
 *             identity on the plain chain, the family's keystream solver on a
 *             cipher family), the whole gate set run on the derived image, and
 *             the standard dump archive (decrypted slots, reports, manifest)
 *             built offline from the assembled backup. Read-only. THIS is the
 *             user's pre-flash dump of every region the stock plan can read,
 *             and it is handed over before anything write-shaped can possibly
 *             run. A failed backup re-runs only past a power-cycle
 *             acknowledgement (`powerCycled`), because a retry against the
 *             same boot reads a spent reader.
 *   patch   — offline, no device: buildV1Patch from the factory plaintext,
 *             refusing on every before-byte gate, and the patched image.
 *   commit  — the conjugated in-place patch into the active bank, staged
 *             image-length-only, committed on a session that NEVER resets
 *             (its post-commit flash state is the ground truth). Requires the
 *             backup files to be loadable, and reads the bank back BEFORE
 *             writing: a bank that already holds the patch is refused with
 *             "jump to drain", a bank that changed any other way is refused
 *             outright. Not replayed blind.
 *   drain   — the wire-89 reset on its own first session, then the whole
 *             4 MiB through the widened window, DRAIN FIRST on its own single
 *             arm (the per-arm budget is consumed in asks; anything read
 *             before the drain shortens its reach — TESTING.md sec. 23.3).
 *   restore — the original bank content staged back verbatim, then a reset.
 *             A bank that already holds the original (a previous restore
 *             landed) is detected and marked done instead of rewritten.
 *   verify  — a fresh boot, the 31 windows re-read, 0 differing bytes against
 *             the backup, and the run's final numbers.
 *
 * ---- the contract ---------------------------------------------------------
 *
 * Core never touches the filesystem. Each step RETURNS its bytes as
 * `Artifact[]`; the caller (CLI, web runner) persists them and rewrites the
 * run state after every step. Resume hands the state back in together with a
 * `loadArtifact(name)` callback that serves the checkpoint files — the backup
 * windows, the bank capture, the derived factory plaintext — from wherever
 * the caller keeps them. A step that cannot load what an earlier step
 * produced refuses with the reason, so `--from-step` cannot silently run
 * against a torn run directory. Every artifact a step produces — the derived
 * factory plaintext included — rides in that set, so a resumed run needs no
 * file the camera did not produce.
 *
 * The state document is the whole cross-step world: everything a later step
 * needs (the detection, the patch summary, the sha256 of every artifact a
 * step produced) lives in it, so a resumed process rebuilds nothing from
 * guesses. It is JSON-shaped by construction:
 * `JSON.parse(JSON.stringify(state))` round-trips it — exactly how the CLI
 * persists it.
 * ==================================================================== */

import {
  buildOfflineDecryptManifest,
  makeOfflineDecryptReadme,
  manifestToJson,
} from '../archive/index.js';
import { bytesToHex, equalBytes, hexToBytes, hexUp, isoStamp, sha256hex, utf8 } from '../bytes.js';
import { CancelledError, SeekError } from '../errors.js';
import type { Artifact, Reporter } from '../events.js';
import { HEADER_OFFSET, HEADER_SIZE, IMAGE_MAGIC, parseImageHeader } from '../image/header.js';
import { FLASH_BASE, FLASH_SIZE } from '../profiles/modern-4x.js';
import { legacyReaderOp } from '../profiles/legacy-auth.js';
import { getProfile } from '../profiles/registry.js';
import type { WindowEntry } from '../profiles/types.js';
import type { SeekDevice } from '../protocol/client.js';
import { decryptDump } from '../workflows/decrypt.js';
import { profileInfoOf } from '../workflows/types.js';
import {
  PostResetWedgeError,
  PROBE_OFFSET,
  READ_CHUNK,
  STAGE_CHUNK,
  backupSlice,
  backupWindows,
  commitToBank,
  detectActiveSlotFromHead,
  drainExact,
  drainWholePart,
  isWireStall,
  openProbedSession,
  postProcessDump,
  probeWidenedWindow,
  readVersion,
  resetDevice,
  rotatedDrainBase,
  unrotateDump,
  verifyAgainstBackup,
  type BackupResult,
  type SessionOpener,
  type WindowBytes,
} from './pipeline.js';
import {
  buildV1Patch,
  conjugateCapture,
  preWideningRefusal,
  stagedAcceptanceSum,
  stagedFormOf,
  type CommitRouteId,
  type DrainCapability,
  type PreserveFamilyId,
  type RestoreFormId,
  type StagedFormId,
  type V1Patch,
} from './patch.js';
import { solvePlainFromCapture } from './solve.js';
import {
  BACKUP_WINDOW_COUNT,
  BANKS,
  BOOT_CONFIG_BYTES,
  WINDOW_BYTES,
  bankWindow,
  doubleReadWindows,
  preservationWindows,
  spentReaderRefusal,
  type BankKey,
  type SlotDetection,
} from './windows.js';

/* ==================================================================== *
 * the run state — the checkpoint document
 * ==================================================================== */

/** The six steps, in run order. */
export type PreserveStepId = 'backup' | 'patch' | 'commit' | 'drain' | 'restore' | 'verify';

export const PRESERVE_STEP_IDS: readonly PreserveStepId[] = [
  'backup',
  'patch',
  'commit',
  'drain',
  'restore',
  'verify',
];

export function isPreserveStepId(value: string): value is PreserveStepId {
  return (PRESERVE_STEP_IDS as readonly string[]).includes(value);
}

/** The step that follows `step`; the run is `done` after verify. */
export function nextStepAfter(step: PreserveStepId): PreserveStepId | 'done' {
  const next = PRESERVE_STEP_IDS[PRESERVE_STEP_IDS.indexOf(step) + 1];
  return next ?? 'done';
}

/** One step's checkpoint record. `failed` keeps the error text, and the step
 *  can be re-run — unlike a `done` one, which refuses. */
export interface PreserveStepRecord {
  readonly status: 'done' | 'failed';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: string;
  readonly notes?: string;
  /** sha256 of every artifact the step emitted, by artifact name — what a
   *  later step (and `--print-state`) checks the run directory against. */
  readonly artifactShas?: Record<string, string>;
  /** Set on a FAILED backup record: the camera must be power-cycled before
   *  this step re-runs (a retry against the same boot can serve stale or
   *  blank window bytes — the 2026-10-02 incident). `describeStepGate`
   *  refuses a backup re-run until the caller asserts the power cycle
   *  (`powerCycled`), which core itself cannot observe. */
  readonly powerCycleRequired?: boolean;
}

/** The patch summary, as the run state carries it after the patch step. */
export interface PreservePatchSummary {
  readonly sites: {
    readonly name: string;
    readonly offset: number;
    readonly before: number[];
    readonly after: number[];
  }[];
  readonly rebalanceWord: number;
  readonly stagedLength: number;
  readonly chunkCount: number;
  readonly patchedSha256: string;
  /** How many bytes the patched image differs from the factory one in — the
   *  part's whole enumerated change, rebalance word included. Absent in a
   *  version-1 run directory's summary (readers may ignore). */
  readonly diffCount?: number;
}

export interface PreserveRunState {
  /** 2 — the current schema: the run derives its factory plaintext from the
   *  camera itself (`imageSource: 'device'`). 1 — the older schema, where the
   *  caller handed over a plaintext file; version-1 run directories still
   *  load (their artifact set is identical — when they carry the derived
   *  plaintext artifact, every step works), and every field below means the
   *  same thing in both. */
  version: 1 | 2;
  /** Timestamped (`preserve-2026-10-01T09-30-00Z`); names nothing on disk. */
  runId: string;
  /** The cipher/acceptance family the detected build belongs to. Undefined
   *  until the backup step derives the image from the camera. */
  buildFamily?: PreserveFamilyId;
  /** The factory plaintext sha the patch derives from — the sha of the
   *  DERIVED image artifact (`PRESERVE_PLAIN_NAME`). Undefined until the
   *  backup step derives it. */
  imageSha256?: string;
  /** The version the camera reported at the backup, which the derived
   *  image's own header agreed with. Every later step requires the camera to
   *  still report it. */
  expectedVersion?: string;
  createdAt: string;
  nextStep: PreserveStepId | 'done';
  steps: Partial<Record<PreserveStepId, PreserveStepRecord>>;
  /** Where the factory plaintext came from. A version-2 run always derives
   *  it from the camera's active slot — there is no manual plaintext-image
   *  selection anywhere. Absent in version-1 run directories (their
   *  plaintext arrived from the caller). */
  imageSource?: 'device';
  /** The two independent reads of the active slot, as sha256s — the capture's
   *  trust anchor, recorded by the backup step once the reads agree. */
  slotReadShas?: readonly [string, string];
  /** The slot verdict, after backup. */
  detection?: SlotDetection;
  /** The patch summary, after patch. */
  patch?: PreservePatchSummary;
  /** The dump shas, after drain. */
  rawDumpSha256?: string;
  deliveredSha256?: string;
  /* ---- additive extensions (readers may ignore) --------------------------- */
  /** The detected build's id in the patch table (`compact-1.3.0.8-8hz`, ...). */
  buildId?: string;
  /** The detected build's display name, as the plan print shows it. */
  buildLabel?: string;
  /** How the wire-80 staged bytes relate to the patched plaintext. */
  stagedForm?: StagedFormId;
  /** How (and whether) the restore step can put the original bank back
   *  through the running app's own commit path ('none' on the FF build). */
  restoreForm?: RestoreFormId;
  /** Which bank the patch may be committed into (`recovery-only` for the
   *  1.3.0.8-FF build). */
  route?: CommitRouteId;
  /** Why, as text a person can act on (the recovery-slot bootloader fact). */
  routeNote?: string | null;
  /** What the drain step may promise on this build, as measured. */
  capability?: DrainCapability;
  /** The wire-79 read size the drain asks for, in bytes. Default READ_CHUNK
   *  (64 — one EP0 packet, the ask measured exact on silicon, TESTING.md
   *  sec. 28.3); the emulator suites pass 64 explicitly. */
  drainChunk?: number;
  /** The bank's expected as-booted image prefix (plain XOR keystream), hex,
   *  when the slot key is known — the strongest pre-write capture gate. */
  expectedSlotPrefix?: string;
  /** The verify step's outcome, after verify. */
  verify?: { diffBytes: number; windowsRead: number; badWindows: number[] };
  /** Post-reset retry attempts for the drain and verify ladders. */
  postResetAttempts?: number;
}

/* ==================================================================== *
 * the artifact names
 * ==================================================================== */

export const PRESERVE_BACKUP_FILE = 'preserve_backup_windows.bin';
export const PRESERVE_BANK_CAPTURE_FILE = 'preserve_bank_capture.bin';
export const PRESERVE_PATCHED_FILE = 'preserve_patch_plain_patched.bin';
export const PRESERVE_DUMP_POSTWRITE_FILE = 'preserve_dump_postwrite.bin';
export const PRESERVE_DUMP_ORIGINAL_FILE = 'preserve_dump_original.bin';

/** The run state document a checkpointing caller rewrites after every step. */
export const PRESERVE_RUN_STATE_FILE = 'preserve_run.json';

/** The manifest and README of the dump archive the backup step emits. */
export const PRESERVE_DUMP_MANIFEST_FILE = 'manifest.json';
export const PRESERVE_DUMP_README_FILE = 'README.md';

/**
 * The name the factory plaintext (the DERIVED image the patch is built from)
 * travels under: an artifact the BACKUP step emits, the caller persists, and
 * `loadArtifact` serves back to every later step that rebuilds the patch or
 * the restore payload. Since the image always derives from the camera itself,
 * the run directory (or run zip) carries it — `--resume` never needs any
 * external file. Version-1 run directories predate this: their plaintext was
 * the caller's own file, so resuming one at a patch-building step needs that
 * file copied into the directory under this name.
 */
export const PRESERVE_PLAIN_NAME = 'preserve_image_plain.bin';

/** Serves one checkpoint artifact by name, or null when the caller does not
 *  have it — which a step that needs it turns into a refusal, never a gap. */
export type PreserveArtifactLoader = (name: string) => Promise<Uint8Array | null>;

/* ==================================================================== *
 * creating a run (offline)
 * ==================================================================== */

export interface CreatePreserveRunOptions {
  /** Default: `preserve-<isoStamp>`. */
  readonly runId?: string;
  /** Injectable clock for the timestamps, so tests are reproducible. */
  readonly now?: () => Date;
  readonly drainChunk?: number;
  readonly expectedSlotPrefix?: Uint8Array;
  readonly postResetAttempts?: number;
}

export interface CreatedPreserveRun {
  readonly state: PreserveRunState;
}

/**
 * Create a run state. Offline: no device, no filesystem — the caller chooses
 * where the run lives and writes `state` out as `preserve_run.json` BEFORE
 * the first step, so even a crash during the backup leaves a resumable run.
 *
 * There is NO image argument and nothing to detect yet: the factory
 * plaintext always derives from the camera itself (the backup step reads the
 * active slot twice, requires agreement, solves the family's cipher, and
 * records the build it finds — `runBackupStep`). The run this creates is a
 * shell whose build fields fill in when the backup completes; the desk
 * refusal a wrong image used to earn happens on the wire instead, at the
 * backup step's gates, before anything write-shaped runs.
 */
export function createPreserveRun(
  options: CreatePreserveRunOptions = {},
): Promise<CreatedPreserveRun> {
  /* The Promise shape is kept on purpose: every caller (CLI, web runner,
   * tests) awaits this entry point, and the sibling front ends are being
   * rebuilt against it as an async call. */
  const now = options.now ?? ((): Date => new Date());
  const state: PreserveRunState = {
    version: 2,
    runId: options.runId ?? `preserve-${isoStamp(now())}`,
    createdAt: now().toISOString(),
    nextStep: 'backup',
    steps: {},
    imageSource: 'device',
    ...(options.drainChunk === undefined ? {} : { drainChunk: options.drainChunk }),
    ...(options.expectedSlotPrefix === undefined
      ? {}
      : { expectedSlotPrefix: bytesToHex(options.expectedSlotPrefix) }),
    ...(options.postResetAttempts === undefined
      ? {}
      : { postResetAttempts: options.postResetAttempts }),
  };
  return Promise.resolve({ state });
}

/* ==================================================================== *
 * the gates — what each step requires, as text a person can act on
 * ==================================================================== */

async function loadCheckpoint(
  state: PreserveRunState,
  loadArtifact: PreserveArtifactLoader,
  name: string,
  step: PreserveStepId,
): Promise<Uint8Array> {
  const bytes = await loadArtifact(name);
  if (bytes === null) {
    throw new SeekError(
      'pipeline/refused',
      `the ${step} step needs ${name} in the run directory and it is not there — the step ` +
        'that produced it must run first (or the file must be put back into this run ' +
        'directory) before this one can',
    );
  }
  const recorded = state.steps.backup?.artifactShas?.[name];
  if (recorded !== undefined) {
    const actual = await sha256hex(bytes);
    if (actual !== recorded) {
      throw new SeekError(
        'pipeline/refused',
        `${name} changed since the backup step recorded it (recorded sha256 ${recorded}, the ` +
          'file is ' +
          `${actual}) — a checkpoint file must not be edited underneath a run`,
      );
    }
  }
  return bytes;
}

/**
 * The factory plaintext, as the backup step derived it: a run artifact, served
 * by `loadArtifact` and sha-checked against the backup step's record by
 * `loadCheckpoint`. There is no other source — a run directory without the
 * artifact refuses, with the remedy (version-1 run directories kept their
 * plaintext outside; the file goes back under this name).
 */
async function loadPlain(
  state: PreserveRunState,
  loadArtifact: PreserveArtifactLoader,
): Promise<Uint8Array> {
  if ((await loadArtifact(PRESERVE_PLAIN_NAME)) === null) {
    throw new SeekError(
      'pipeline/refused',
      `this step needs the factory plaintext the patch derives from (the run artifact ` +
        `'${PRESERVE_PLAIN_NAME}') and the run directory does not hold it — the backup step ` +
        'writes it there, derived from the camera’s own active slot; put the file back ' +
        'from your copy of the run zip. A version-1 run (the older schema) took it from the ' +
        'file the run was started with: copy that image into the run directory under this name.',
    );
  }
  return loadCheckpoint(state, loadArtifact, PRESERVE_PLAIN_NAME, 'backup');
}

const isDone = (state: PreserveRunState, id: PreserveStepId): boolean =>
  state.steps[id]?.status === 'done';

/**
 * The bank the camera actually boots, for a recovery-only build. The FF
 * build's raw word sum is the 0xFFFF sentinel, which the 2014 bootloader
 * rejects at slots A/B — it boots the recovery bank 0x14070000 UNCHECKED
 * (measured on the wire: the factory chimera with a blank record runs from
 * recovery; doc 35.3.3). The cfg-derived detection names A for a blank
 * record, which for this build names a bank that can never run — so the
 * detection is re-pointed at recovery, and every step (capture, commit,
 * swap-back, restore) acts on the bank that truly runs. An explicit record
 * naming recovery behaves the same; a record naming B cannot boot this
 * build at all, and `routeRefusal` refuses the write.
 */
function effectiveDetection(state: PreserveRunState, detection: SlotDetection): SlotDetection {
  if (state.route !== 'recovery-only') return detection;
  const recovery = BANKS.find((b) => b.key === 'r');
  if (recovery === undefined) return detection;
  return {
    ...detection,
    blank: false,
    cfg0: 2,
    bank: 'r',
    bankAddress: recovery.address,
    bankMode: recovery.mode,
    verdict:
      'the 0xFFFF-sum build: slots A/B are rejected by the bootloader and the recovery ' +
      `bank ${recovery.address.toString(16)} boots unchecked — the running bank is ` +
      'recovery (doc 35.3)',
  };
}

/**
 * The route refusal, shared by the three steps that would touch the patch's
 * bank: a build whose route is recovery-only must never be written into a
 * slot the bootloader would reject at boot. Recovery itself — the bank the
 * route names — passes.
 */
function routeRefusal(state: PreserveRunState): string | null {
  if (state.route !== 'recovery-only') return null;
  if (state.detection?.bank === 'r') return null;
  const bank = state.detection?.bank ?? '(no detection)';
  return (
    `this build's patch boots from the RECOVERY slot only (mode 9): ${state.routeNote ?? ''} — ` +
    `the backup's detection named bank ${bank}, and the bootloader would not boot the ` +
    'patch from there, so the run refuses'
  );
}

/**
 * Why `step` cannot run against `state` right now, or null when it can.
 *
 * The run's rule, in gate order: the available regions are dumped and
 * persisted (backup) before the patch is built; the patch summary exists
 * before anything write-shaped; the commit exists before anything that reads
 * the patched part; and the restore exists before the verify that proves it.
 * A step that is already `done` always refuses — re-running a completed step
 * is never what a resume wants.
 *
 * `options.allowJump` relaxes exactly the three ORDERING gates past the
 * commit (drain/restore without a completed commit, verify without a
 * completed restore) — nothing else. The operator who jumps explicitly is
 * asserting the writes landed without their checkpoints; the artifact and
 * file gates stay absolute (a jump cannot fabricate a restore source), the
 * commit step's own gates never relax, and the wire stays protected by the
 * step-level checks that remain (the commit pre-check, the restore
 * already-original detection, verify's 0-diff proof). Both front ends gate
 * the override behind their loudest interaction — the CLI's `--from-step`
 * with its WARNING line, the web's danger dialog.
 *
 * `options.powerCycled` is the same shape of honesty on the backup's retry:
 * a FAILED backup record re-runs only past an explicit assertion that the
 * camera was power-cycled since the failure. Core cannot observe a power
 * cycle — the flag is an assertion by the front end (the CLI asks on a
 * terminal, or `--yes` asserts it), and the gate's text says so.
 */
export async function describeStepGate(
  step: PreserveStepId,
  state: PreserveRunState,
  loadArtifact: PreserveArtifactLoader,
  options: { readonly allowJump?: boolean; readonly powerCycled?: boolean } = {},
): Promise<string | null> {
  if (state.nextStep === 'done') {
    return `this run is done — every step completed (run ${state.runId})`;
  }
  const mine = state.steps[step];
  if (mine?.status === 'done') {
    return (
      `${step} is already done in this run (finished ${mine.finishedAt ?? 'at an unknown time'})` +
      ` — resume continues at ${state.nextStep}`
    );
  }

  const jump = options.allowJump === true;
  const doneSteps = PRESERVE_STEP_IDS.filter((id) => isDone(state, id));
  switch (step) {
    case 'backup': {
      if (doneSteps.length > 0) {
        return (
          'the backup cannot re-run: this run has already completed ' +
          `${doneSteps.join(', ')} and its next step is ${state.nextStep} — use --resume`
        );
      }
      /* THE RETRY GATE: a failed backup re-runs only past the power-cycle
       * acknowledgement. The camera's window reader is budgeted per boot, and
       * the incident this gate exists for is a backup attempt + retry
       * back-to-back with no reset — the second pass served stale and blank
       * descriptor bytes. */
      if (
        state.steps.backup?.status === 'failed' &&
        state.steps.backup.powerCycleRequired === true &&
        options.powerCycled !== true
      ) {
        return (
          'the previous backup attempt failed, and the camera must be POWER-CYCLED before ' +
          'this step re-runs — a retry against the same boot can serve stale or blank window ' +
          'bytes (measured: a retried backup served the bootloader vector’s initial-SP word ' +
          'into the boot-config read). Power-cycle the camera (unplug and replug it, or use ' +
          'its power switch), then re-run `preserve --resume <run-directory>`. Core cannot ' +
          'observe the power cycle — the acknowledgement is an assertion by the front end ' +
          '(the CLI asks on a terminal; --yes asserts it). The recorded failure: ' +
          (state.steps.backup.error ?? '(no error text)')
        );
      }
      return null;
    }
    case 'patch': {
      if (!isDone(state, 'backup')) {
        return (
          'patch runs after the backup: the run takes the dump of every region the stock plan ' +
          'can read and persists it BEFORE anything else happens — that backup is the only ' +
          'copy of this camera. Run the backup step first.'
        );
      }
      return null;
    }
    case 'commit': {
      if (!isDone(state, 'backup')) return 'commit runs after the backup (see the patch step)';
      if (!isDone(state, 'patch')) {
        return 'commit runs after the patch step, which records what it stages';
      }
      if (state.detection === undefined) {
        return 'commit needs the slot detection the backup step recorded, and the state has none';
      }
      const route = routeRefusal(state);
      if (route !== null) return route;
      const missing: string[] = [];
      for (const name of [PRESERVE_BACKUP_FILE, PRESERVE_BANK_CAPTURE_FILE]) {
        if ((await loadArtifact(name)) === null) missing.push(name);
      }
      if (missing.length > 0) {
        return (
          'commit requires the backup files in the run directory and they are missing: ' +
          `${missing.join(', ')} — without them a commit has no restore source, so it refuses`
        );
      }
      return null;
    }
    case 'drain': {
      if (!isDone(state, 'commit') && !jump) {
        return (
          'drain reads the PATCHED part through the widened window, and this run has no ' +
          'completed commit — the drain would stall on a stock camera. Run (or resume at) ' +
          'the commit first, or jump explicitly (allowJump) if the commit landed without ' +
          'its checkpoint.'
        );
      }
      if (state.detection === undefined) {
        return 'drain needs the slot detection the backup step recorded, and the state has none';
      }
      /* The capability table, consulted where it bites: a build with no
       * whole-part drain gets the documented reason, not a stall on the wire
       * (the 1.0.3.2 builds' EP0 sessions die at ~64-81 KB). */
      if (state.capability !== undefined && !state.capability.wholePart) {
        return (
          `the drain step refuses on ${state.buildId ?? state.buildFamily ?? 'the detected build'}: ` +
          state.capability.note
        );
      }
      /* THE MODE-2 HAZARD ORDERING: on the builds whose factory mode-2 row
       * arms *(0x14000000), the nop that makes the arm safe is part of the
       * patch — the drain arms mode 2 only after the reset into the PATCHED
       * image, and this gate holds the run state to that order: the recorded
       * patch summary must carry the hazard site, or the arm is refused
       * before it can fault the camera. */
      const hazardSites = state.capability?.modeTwoHazardSites;
      if (hazardSites !== undefined && hazardSites.length > 0) {
        const recorded = new Set((state.patch?.sites ?? []).map((site) => site.offset));
        const missing = hazardSites.filter((offset) => !recorded.has(offset));
        if (missing.length > 0) {
          return (
            `the drain step refuses on ${state.buildId ?? state.buildFamily ?? 'the detected build'}: ` +
            'arming mode 2 on this build’s UNPATCHED image faults the camera — the factory ' +
            'mode-2 row loads the word stored AT 0x14000000 (the bootloader vector’s initial ' +
            'SP, not a flash window) and an armed read walks off SRAM (measured on the ' +
            'emulator: 32 KiB served, then the guest faulted; FW-V1 doc 36.3.1). The nop that ' +
            'makes the arm safe is patch site ' +
            missing.map((offset) => hexUp(offset)).join(', ') +
            ', and it is NOT among the patch sites this run recorded — run the patch step (and ' +
            'land the commit) before any mode-2 arm.'
          );
        }
      }
      const route = routeRefusal(state);
      if (route !== null) return route;
      if ((await loadArtifact(PRESERVE_BANK_CAPTURE_FILE)) === null) {
        return (
          `drain needs ${PRESERVE_BANK_CAPTURE_FILE} (the delivered dump is post-processed ` +
          'with it) and it is not in the run directory'
        );
      }
      return null;
    }
    case 'restore': {
      if (!isDone(state, 'commit') && !jump) {
        return (
          'restore puts the original bank back over the patch, and this run has no completed ' +
          'commit — there is nothing it can be reverting. Run (or resume at) the commit ' +
          'first, or jump explicitly (allowJump) to restore an already-patched camera.'
        );
      }
      if (state.detection === undefined) {
        return 'restore needs the slot detection the backup step recorded, and the state has none';
      }
      const route = routeRefusal(state);
      if (route !== null) return route;
      if (state.patch === undefined) {
        return 'restore needs the patch summary (for the staged length) — run the patch step first';
      }
      if (state.restoreForm === 'none') {
        return (
          `the restore step refuses on ${
            state.buildId ?? state.buildFamily ?? 'the detected build'
          }: no staged form ` +
          'of the factory image passes the running app\u2019s own acceptance while ' +
          'transforming back to the original slot bytes \u2014 accept1 reads sum(P ^ ksD), ' +
          'the factory image carries 0xB7AB9D17 there (measured), not the 0xFFFF the app ' +
          'demands. This run ends with the delivered dump in hand and the patch in place; ' +
          'the original content can only go back with a full-flash programmer.'
        );
      }
      /* A cipher family's restore stages the FACTORY image in the build's
       * staged form (the commit's own transform turns it back into the
       * original slot bytes) — so it needs the derived plaintext, which the
       * 'plain' families never do (they stage the capture verbatim). */
      if (state.stagedForm !== undefined && state.stagedForm !== 'plain') {
        if ((await loadArtifact(PRESERVE_PLAIN_NAME)) === null) {
          return (
            `restore stages the original image in this build's staged form ` +
            `(${state.stagedForm}), which is derived from the factory plaintext — and the run ` +
            `directory does not hold ${PRESERVE_PLAIN_NAME} (the backup step wrote it there, ` +
            'derived from the camera’s own active slot). Put the file back from your copy ' +
            'of the run zip.'
          );
        }
      }
      if ((await loadArtifact(PRESERVE_BANK_CAPTURE_FILE)) === null) {
        return (
          `restore needs ${PRESERVE_BANK_CAPTURE_FILE} (it stages that capture verbatim) and ` +
          'it is not in the run directory'
        );
      }
      return null;
    }
    case 'verify': {
      if (!isDone(state, 'restore') && !jump) {
        return (
          'verify compares a fresh boot against the backup, and this run has no completed ' +
          'restore — a patched bank would show as diffs. Run (or resume at) the restore ' +
          'first, or jump explicitly (allowJump) if the restore landed without its checkpoint.'
        );
      }
      if ((await loadArtifact(PRESERVE_BACKUP_FILE)) === null) {
        return (
          `verify needs ${PRESERVE_BACKUP_FILE} (the comparison's reference) and it is not in ` +
          'the run directory'
        );
      }
      return null;
    }
  }
}

/* ==================================================================== *
 * running one step
 * ==================================================================== */

export interface PreserveStepOutcome {
  /** The updated state — a new object; the input is never mutated. Persist it
   *  after writing the artifacts. */
  readonly state: PreserveRunState;
  /** Everything the step produced, in the order it produced it. The caller
   *  writes these (atomically) and then the state. */
  readonly artifacts: readonly Artifact[];
}

/**
 * Run one step of a preservation run.
 *
 * Every failure is a thrown error — `SeekError` with code `pipeline/refused`
 * for the gates and the proofs. A checkpointing caller persists the failed
 * step with `recordStepFailure` before exiting; a `CancelledError` is never
 * recorded: an interrupted run's previous checkpoint stands, and a resume
 * re-runs the step from the top.
 */
export async function runPreserveStep(
  step: PreserveStepId,
  opener: SessionOpener,
  state: PreserveRunState,
  loadArtifact: PreserveArtifactLoader,
  reporter: Reporter,
  signal?: AbortSignal,
  options: { readonly allowJump?: boolean; readonly powerCycled?: boolean } = {},
): Promise<PreserveStepOutcome> {
  const refusal = await describeStepGate(step, state, loadArtifact, options);
  if (refusal !== null) throw new SeekError('pipeline/refused', refusal);

  const startedAt = new Date().toISOString();
  const fresh: PreserveRunState = { ...state, steps: { ...state.steps } };
  switch (step) {
    case 'backup':
      return runBackupStep(fresh, opener, reporter, signal, startedAt);
    case 'patch':
      return runPatchStep(fresh, loadArtifact, reporter, signal, startedAt);
    case 'commit':
      return runCommitStep(fresh, opener, loadArtifact, reporter, signal, startedAt);
    case 'drain':
      return runDrainStep(fresh, opener, loadArtifact, reporter, signal, startedAt);
    case 'restore':
      return runRestoreStep(fresh, opener, loadArtifact, reporter, signal, startedAt);
    case 'verify':
      return runVerifyStep(fresh, opener, loadArtifact, reporter, signal, startedAt);
  }
}

/**
 * The failed-step record a checkpointing caller persists when a step threw.
 * (A cancellation is NOT recorded — an interrupted run's previous checkpoint
 * stands.) A failed BACKUP record carries `powerCycleRequired`: the retry
 * gate refuses its re-run until the front end asserts the camera was
 * power-cycled, because a retry against the same boot is exactly how the
 * 2026-10-02 incident turned a refused backup into a stale-byte second pass.
 */
export function recordStepFailure(
  state: PreserveRunState,
  step: PreserveStepId,
  error: unknown,
): PreserveRunState {
  const previous = state.steps[step];
  return {
    ...state,
    steps: {
      ...state.steps,
      [step]: {
        ...(previous?.status === 'failed' ? previous : {}),
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date().toISOString(),
        ...(step === 'backup' ? { powerCycleRequired: true } : {}),
      },
    },
  };
}

/* ---- shared step plumbing ---------------------------------------------- */

function assertLive(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CancelledError();
}

async function gateVersion(device: SeekDevice, state: PreserveRunState): Promise<string> {
  const version = await readVersion(device);
  if (state.expectedVersion === undefined) {
    fail('the run state carries no expected version — the backup step has not derived the image');
  }
  if (version !== state.expectedVersion) {
    throw new SeekError(
      'pipeline/refused',
      `the camera reports firmware ${version}, want ${state.expectedVersion} — the patch is ` +
        "derived from one build's bytes and must not be sent to another",
    );
  }
  applyReaderOp(device, version);
  return version;
}

/**
 * Point the session's window reads at the build's reader wire. The version
 * read itself (0x4E) is version-agnostic and always runs first; everything
 * that reads a WINDOW on this generation reads through `device.windowReadOp`,
 * and the 0.7.x builds answer on wire 88, not 79 (their method table puts the
 * read handler in 0x4F's setter column and 0x4F stalls for every request
 * length — measured, FW-V1 doc 36 sec. 36.5.0). Applied at EVERY session
 * open, before the first window read: the backup step from the version it
 * just read, every later step from the version the state pins.
 */
function applyReaderOp(device: SeekDevice, version: string | null | undefined): void {
  device.windowReadOp = legacyReaderOp(version ?? null);
}

function expectedPrefixOf(state: PreserveRunState): Uint8Array | undefined {
  return state.expectedSlotPrefix === undefined ? undefined : hexToBytes(state.expectedSlotPrefix);
}

function fail(message: string): never {
  throw new SeekError('pipeline/refused', message);
}

function stepRecord(
  startedAt: string,
  notes: string,
  shas: ReadonlyMap<string, string>,
): PreserveStepRecord {
  const artifactShas: Record<string, string> = {};
  for (const [name, sha] of shas) artifactShas[name] = sha;
  return {
    status: 'done',
    startedAt,
    finishedAt: new Date().toISOString(),
    notes,
    artifactShas,
  };
}

async function shasOf(artifacts: readonly Artifact[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const artifact of artifacts) out.set(artifact.name, await sha256hex(artifact.data));
  return out;
}

function named(name: string, data: Uint8Array): Artifact {
  return { name, data };
}

/** Opens a session, runs the body, and always closes — the shape every
 *  device-touching step shares. */
async function withSession<T>(
  opener: SessionOpener,
  body: (device: SeekDevice) => Promise<T>,
): Promise<T> {
  const device = await opener.open();
  try {
    return await body(device);
  } finally {
    await opener.close(device);
  }
}

/* ==================================================================== *
 * backup — the 31 windows, the capture, and the pre-flash dump archive
 * ==================================================================== */

/** The backup, assembled at its flash addresses into a whole-part image (the
 *  unreachable windows stay 0xFF — the archive's manifest says the real
 *  coverage). */
export function assembleBackupImage(byAddress: ReadonlyMap<number, Uint8Array>): Uint8Array {
  const image = new Uint8Array(FLASH_SIZE).fill(0xff);
  for (const [address, bytes] of byAddress) image.set(bytes, address - FLASH_BASE);
  return image;
}

/** A `BackupResult` rebuilt from an assembled backup image — what the verify
 *  step compares against when the windows themselves were never in memory. */
export function backupResultFromImage(image: Uint8Array): BackupResult {
  if (image.length !== FLASH_SIZE) {
    fail(`the backup image is ${String(image.length)} B, want ${String(FLASH_SIZE)}`);
  }
  const windows: WindowBytes[] = [];
  const byAddress = new Map<number, Uint8Array>();
  for (const entry of preservationWindows()) {
    const at = entry.address - FLASH_BASE;
    const bytes = image.slice(at, at + WINDOW_BYTES);
    windows.push({ mode: entry.subcmd, address: entry.address, bytes });
    byAddress.set(entry.address, bytes);
  }
  return { windows, byAddress, bytes: windows.length * WINDOW_BYTES };
}

/* ==================================================================== *
 * backup — the 31 windows, the double-read capture, the derived image
 * ==================================================================== */

/** One arm of the double read: arm `entry` and serve the whole 64 KiB through
 *  the drain path. A stall here is the dead-reader wire answer; the caller's
 *  segment machinery reboots and retries, so a stall surfacing from here has
 *  already exhausted its boots. */
async function armAndDrainSlot(
  device: SeekDevice,
  entry: WindowEntry,
  label: string,
  signal: AbortSignal | undefined,
): Promise<Uint8Array> {
  await device.armWindow(entry);
  try {
    return await drainExact(device, WINDOW_BYTES, label, {
      chunk: READ_CHUNK,
      retries: 3,
      timeoutMs: 20000,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (isWireStall(error)) {
      throw new SeekError(
        'pipeline/refused',
        spentReaderRefusal(
          `${label} stalled at ${error instanceof Error ? error.message : String(error)}`,
        ),
        { cause: error },
      );
    }
    throw error;
  }
}

/**
 * The expectation a slot read is sanity-checked against (the verified-arm
 * ladder): every family on this line stores the image header VERBATIM at
 * 0x200 — the cipher's cleartext window, the solver's own first step — so a
 * real read parses with the image magic. A read that fails this is garbage
 * (a swallowed arm serves blank or stale descriptor bytes — the 2026-10-02
 * probe: a mode-3 read served blank while the immediately-following mode-7
 * read served correctly), and the ladder re-arms ONCE, never loops.
 */
function slotReadIsPlausible(read: Uint8Array): boolean {
  const header = parseImageHeader(read);
  return header !== null && header.magic === IMAGE_MAGIC;
}

/** The spent-reader signature of a garbage slot read, for the refusal text;
 *  a read carrying no known signature is described by its header failure. */
function slotGarbageNoun(read: Uint8Array): string {
  return spentReaderSignature(read) ?? 'no image header parses at 0x200';
}

/**
 * The spent-reader signatures a capture can carry, checked before any
 * candidate is derived. On the real Compact the window reader is budgeted per
 * boot (emulator: the cursor resets per re-arm — the gap that hid this), so a
 * camera whose reads arrive after the budget is spent serves BLANK bytes or
 * STALE DESCRIPTOR bytes, and no solver can read an image out of either. The
 * shapes, from the 2026-10-02 incident: an all-0xFF capture; a header window
 * that is 0xFF-fill so no magic can be read; and the bootloader vector's own
 * first words (initial SP 0x10018000, reset address in the bootloader block
 * 0x1400xxxx — the REAL bootloader block starts exactly so, and a real bank
 * image never does: its SP word is its own, e.g. 0x10008000) served through a
 * descriptor still pointing at the boot block. Returns the signature text, or
 * null when the capture does not carry one of these shapes.
 */
export function spentReaderSignature(capture: Uint8Array): string | null {
  let allBlank = true;
  for (const byte of capture) {
    if (byte !== 0xff) {
      allBlank = false;
      break;
    }
  }
  if (allBlank) return 'every byte of the capture is 0xFF (an all-blank read)';
  if (capture.length >= 8) {
    const dv = new DataView(capture.buffer, capture.byteOffset, capture.byteLength);
    const word0 = dv.getUint32(0, true);
    const word1 = dv.getUint32(4, true);
    if (word0 === 0x10018000 && word1 >>> 16 === 0x1400) {
      return (
        `the capture’s first words are ${hexUp(word0)} / ${hexUp(word1 & ~1)} — the ` +
        'bootloader vector’s own initial SP and reset address served through a stale reader ' +
        'descriptor, not the bank’s image'
      );
    }
  }
  let headerFill = true;
  for (let i = HEADER_OFFSET; i < HEADER_OFFSET + HEADER_SIZE; i++) {
    if (capture[i] !== 0xff) {
      headerFill = false;
      break;
    }
  }
  if (headerFill) {
    return (
      'the capture’s header window (0x200..0x240) is 0xFF-fill — no image magic can be read ' +
      'from it'
    );
  }
  return null;
}

/**
 * The factory plaintext, derived from the agreed capture — the ruling's whole
 * mechanism, in one function. The candidate order is fixed: the identity
 * solve first (the 2014 chain's banks hold the image as-is), then each cipher
 * family's solver in table order. EVERY candidate is pushed through the full
 * gate set on the DERIVED image before it is trusted — the version
 * cross-check against the camera's own report, then `buildV1Patch` (the build
 * table's detect hooks, the before-byte site gates — which refuse an
 * already-patched bank — and the family word-sum/acceptance rule). The first
 * candidate that passes all of them IS the factory plaintext; a capture for
 * which none passes refuses the run, and nothing is recorded, let alone
 * written.
 */
function deriveFactoryImage(
  capture: Uint8Array,
  cameraVersion: string,
): { plain: Uint8Array; patch: V1Patch; method: string } {
  const attempts: { plain: Uint8Array; method: string }[] = [];
  const reasons: string[] = [];
  /* The spent-reader check comes FIRST: a capture carrying one of those
   * shapes is a reader state, not an image, and the refusal must say the one
   * thing that un-blocks the camera before any cipher talk. */
  const spent = spentReaderSignature(capture);
  for (const family of ['v1-2014', 'v1-2014-ff', 'compact-2016'] as const) {
    const solved = solvePlainFromCapture(family, capture);
    if (solved.ok) attempts.push({ plain: solved.plain, method: solved.method });
    else reasons.push(solved.reason);
  }
  for (const attempt of attempts) {
    /* The version cross-check, FIRST of the gates: the camera's own report is
     * the one external fact here, and the derived image must agree with it. */
    const says = parseImageHeader(attempt.plain)?.versionStr;
    if (says !== undefined && says !== cameraVersion) {
      reasons.push(`the camera reports ${cameraVersion} but the active slot's image says ${says}`);
      continue;
    }
    try {
      return { plain: attempt.plain, patch: buildV1Patch(attempt.plain), method: attempt.method };
    } catch (error) {
      reasons.push(
        `the ${attempt.method} candidate failed its build gates: ` +
          (error instanceof Error ? error.message : String(error)),
      );
    }
  }
  if (spent !== null) {
    fail(
      spentReaderRefusal(
        `${spent} — no factory plaintext can be derived from these bytes. Every candidate was ` +
          `tried:\n  - ${reasons.join('\n  - ')}`,
      ),
    );
  }
  fail(
    'the two agreeing reads of the active slot do not yield the factory plaintext, and the ' +
      'run refuses rather than write over a slot it cannot read. Every candidate was tried:\n  - ' +
      reasons.join('\n  - '),
  );
}

/** One capture-and-derive pass, against the bank `detection` names: the
 *  double read under the serve budget (the sweep's row + ONE fresh arm — the
 *  active slot is served exactly twice per boot), the verified-arm ladder on
 *  those reads, the expected-prefix gate (when the slot key is known), and
 *  the derivation with its gate set. The FF route's re-point runs this twice —
 *  the first pass names the build, the second captures the bank that runs. */
async function captureAndDerive(
  opener: SessionOpener,
  byAddress: ReadonlyMap<number, Uint8Array>,
  detection: SlotDetection,
  version: string,
  expectedPrefix: Uint8Array | undefined,
  reporter: Reporter,
  signal: AbortSignal | undefined,
): Promise<{
  detection: SlotDetection;
  capture: Uint8Array;
  slotReadShas: readonly [string, string];
  readModes: readonly [number, number];
  byAddress: ReadonlyMap<number, Uint8Array>;
  serveNote: string;
  derived: ReturnType<typeof deriveFactoryImage>;
}> {
  const sweepRow = byAddress.get(detection.bankAddress);
  if (sweepRow === undefined) {
    fail(
      `the backup does not hold the active bank ` +
        `${detection.bankAddress.toString(16)} — the stock windows cannot serve it`,
    );
  }
  const [bankEntry, planEntry] = doubleReadWindows(detection.bank);

  /* THE ACTIVE SLOT'S SECOND READ, one admitted boot of its own: a full
   * 64 KiB drain completes the window (which poisons the reader for the rest
   * of that boot — TESTING.md sec. 34), so the segment ends with the wire
   * reboot. The FIRST read is the sweep's own captured row at the bank
   * address, served on its own boot. */
  const readBankOnFreshBoot = async (label: string): Promise<Uint8Array> => {
    const { device } = await openProbedSession(opener, reporter, signal, label, (d) => {
      applyReaderOp(d, version);
    });
    try {
      return await armAndDrainSlot(device, bankEntry, label, signal);
    } finally {
      /* No eager reset: the next segment's probe detects the poisoned boot
       * and reboots by command itself. */
      await opener.close(device);
    }
  };

  const fresh = await readBankOnFreshBoot(
    `the active slot’s fresh-boot read (the bank window, mode ${String(bankEntry.subcmd)})`,
  );
  const freshMode = bankEntry.subcmd;

  /* THE VERIFIED-ARM LADDER on the slot reads. `sweepRow` is the first read
   * (the sweep's own boot); `fresh` is the second (its own admitted boot).
   * Both are sanity-checked against the header expectation; a garbage read is
   * re-read ONCE ON A FRESH BOOT (a re-arm on the same boot would serve the
   * completion poison's blank); two plausible reads that differ stay a
   * refusal — the byte-agreement rule is the trust anchor. */
  let capture = sweepRow;
  let verifiedSecond: Uint8Array = fresh;
  let serveNote = 'both reads agree';
  if (!slotReadIsPlausible(sweepRow)) {
    if (!slotReadIsPlausible(fresh)) {
      /* Both boots served garbage. One more admitted boot for the sweep row's
       * side: the sweep's own boot may have been the swallowed one. */
      const rescued = await readBankOnFreshBoot(
        'the active slot’s re-read after two garbage reads (the bank window)',
      );
      if (!slotReadIsPlausible(rescued)) {
        fail(
          spentReaderRefusal(
            `the active slot’s reads served garbage on three boots (${slotGarbageNoun(sweepRow)}; ` +
              `${slotGarbageNoun(fresh)}; then ${slotGarbageNoun(rescued)})`,
          ),
        );
      }
      capture = rescued;
      verifiedSecond = rescued;
      serveNote =
        'the sweep’s row and the fresh-boot read both served garbage — a third boot’s read ' +
        'is the capture, and the archive’s row is repaired to it';
    } else {
      /* The flip: the sweep's boot was swallowed and the fresh boot reads a
       * real image — the re-read is the capture, and the archive's row is
       * repaired to it so the run directory stays self-consistent. */
      capture = fresh;
      serveNote =
        'the sweep’s row served garbage and was re-verified — the fresh boot’s read is the ' +
        'capture';
    }
  } else if (!equalBytes(sweepRow, fresh)) {
    const sha1 = await sha256hex(sweepRow);
    const sha2 = await sha256hex(fresh);
    if (!slotReadIsPlausible(fresh)) {
      /* The fresh boot was swallowed: one more admitted boot. */
      const again = await readBankOnFreshBoot(
        'the active slot’s re-read (the fresh boot served garbage)',
      );
      if (equalBytes(again, sweepRow)) {
        verifiedSecond = again;
        serveNote =
          'the fresh boot served garbage and was re-read on another boot — the re-read ' +
          'agrees with the sweep’s row';
      } else if (!slotReadIsPlausible(again)) {
        fail(
          spentReaderRefusal(
            `the active slot’s fresh-boot reads served garbage twice (${slotGarbageNoun(fresh)}; ` +
              `then ${slotGarbageNoun(again)})`,
          ),
        );
      } else {
        fail(
          `the two reads of the active slot disagree (sha256 ${sha1} vs ${sha2}) — a camera ` +
            'that cannot serve its own slot twice in a row is not a camera to write to; the ' +
            'capture is the restore source and the patch’s derivation input',
        );
      }
    } else {
      fail(
        `the two reads of the active slot disagree (sha256 ${sha1} vs ${sha2}) — a camera ` +
          'that cannot serve its own slot twice in a row is not a camera to write to; the ' +
          'capture is the restore source and the patch’s derivation input',
      );
    }
  }

  const slotReadShas: readonly [string, string] = [
    await sha256hex(sweepRow),
    await sha256hex(verifiedSecond),
  ];
  reporter.log(
    `the active slot served on two admitted boots (the sweep’s own boot, mode ` +
      `${String(planEntry.subcmd)}, + one fresh boot of the bank window, mode ` +
      `${String(freshMode)}): ${serveNote} (sha256 ${slotReadShas[1]})`,
    'detail',
  );
  /* The archive's row at the bank address is the verified capture when the
   * sweep's own row was the swallowed one — the assembled backup must agree
   * with the capture the run derives from and verify compares against. */
  const archiveRows: ReadonlyMap<number, Uint8Array> =
    capture === sweepRow ? byAddress : new Map(byAddress).set(detection.bankAddress, capture);

  /* The strongest keyless gate that survives, when the slot key is known
   * (the emulator's donor): the capture must be the factory image as the
   * cipher stores it. */
  if (
    expectedPrefix !== undefined &&
    !equalBytes(capture.subarray(0, expectedPrefix.length), expectedPrefix)
  ) {
    fail(
      'the active slot does not hold the factory image as this build’s cipher stores it ' +
        '(the expected image prefix does not match the capture) — refusing before anything ' +
        'is recorded, let alone written',
    );
  }

  const derived = deriveFactoryImage(capture, version);
  reporter.log(
    `the factory plaintext derived from the capture: ${derived.method} ` +
      `(${String(derived.plain.length)} B, sha256 ${await sha256hex(derived.plain)}); ` +
      `build ${derived.patch.buildId} (family ${derived.patch.family})`,
    'detail',
  );
  return {
    detection,
    capture,
    slotReadShas,
    readModes: [planEntry.subcmd, freshMode] as const,
    byAddress: archiveRows,
    serveNote,
    derived,
  };
}

async function runBackupStep(
  state: PreserveRunState,
  opener: SessionOpener,
  reporter: Reporter,
  signal: AbortSignal | undefined,
  startedAt: string,
): Promise<PreserveStepOutcome> {
  const expectedPrefix = expectedPrefixOf(state);

  /* THE VERSION GATE, its own small-read session: GetFirmwareInfo is not the
   * window reader and answers on any boot. No gate yet — the camera's own
   * report is the version the run expects from here on. The derived image's
   * header must agree with it (below). */
  const version = await withSession(opener, async (device) => {
    assertLive(signal);
    const v = await readVersion(device);
    /* THE GENERATION GATE, before a single window read: the 2014 builds older
     * than 0.7.0.7 are outside the widening route (doc 36.7, measured) and
     * this run refuses with that evidence instead of reading anything. */
    const tooOld = preWideningRefusal(v);
    if (tooOld !== null) fail(tooOld);
    return v;
  });
  /* THE SWEEP + CAPTURE: one admitted boot per window (each segment's probe
   * read IS the boot-config record), the capture on its own admitted boot —
   * and each completing read ends with the wire reboot that clears the reader
   * poison (TESTING.md sec. 34). */
  const read = await (async (): Promise<{
    version: string;
    detection: SlotDetection;
    capture: Uint8Array;
    slotReadShas: readonly [string, string];
    readModes: readonly [number, number];
    serveNote: string;
    derived: ReturnType<typeof deriveFactoryImage>;
    repointed: boolean;
    assembled: Uint8Array;
  }> => {
  reporter.log(`camera reports firmware ${version}`, 'detail');
  const prepareReader = (device: SeekDevice): void => {
    applyReaderOp(device, version);
  };

  /* THE SWEEP: one admitted boot per window, each segment's probe read IS the
   * boot-config record, and each completing read ends with the wire reboot
   * that clears the reader poison (TESTING.md sec. 34). */
  const backup = await backupWindows(opener, reporter, READ_CHUNK, signal, prepareReader);
  const byAddress = backup.byAddress;
  const cfgRow = byAddress.get(0x14010000);
  if (cfgRow === undefined) fail('the backup does not hold the boot-config block');
  const detection = effectiveDetection(
    state,
    detectActiveSlotFromHead(cfgRow.subarray(0, BOOT_CONFIG_BYTES)),
  );
  reporter.log(`slot: ${detection.verdict}`, 'detail');

  let didRepoint = false;
  let read2 = await captureAndDerive(
    opener,
    byAddress,
    detection,
    version,
    expectedPrefix,
    reporter,
    signal,
  );
  /* The archive rows may have been repaired by the verified-arm ladder (a
   * swallowed sweep row is replaced by the verified capture). */
  let archiveRows: ReadonlyMap<number, Uint8Array> = read2.byAddress;
  /* THE RECOVERY RE-POINT, IN-STEP. A build whose route is recovery-only
   * (the FF build) cannot run from the cfg-named bank: the 2014 bootloader
   * rejects its 0xFFFF-sum image at slots A/B and boots the recovery bank
   * UNCHECKED (doc 35.3) — so the bank that truly runs is recovery, and
   * the capture that matters is recovery's. The route is only KNOWN once a
   * capture has been derived, so the first pass may derive from the
   * cfg-named bank; if it names a recovery-only route, the detection is
   * re-pointed and the bank that runs is captured and derived in full. */
  if (read2.derived.patch.route === 'recovery-only' && read2.detection.bank !== 'r') {
    const repointed = effectiveDetection({ ...state, route: 'recovery-only' }, detection);
    reporter.log(`slot re-pointed: ${repointed.verdict}`, 'detail');
    read2 = await captureAndDerive(
      opener,
      archiveRows,
      repointed,
      version,
      expectedPrefix,
      reporter,
      signal,
    );
    archiveRows = read2.byAddress;
    didRepoint = true;
  }
  return {
    version,
    detection: read2.detection,
    capture: read2.capture,
    slotReadShas: read2.slotReadShas,
    readModes: read2.readModes,
    serveNote: read2.serveNote,
    derived: read2.derived,
    repointed: didRepoint,
    assembled: assembleBackupImage(archiveRows),
  };
  })();

  /* THE PRE-FLASH DUMP ARCHIVE, offline from the assembled backup: the same
   * decrypt/report path the `decrypt` command runs on a dump file — the
   * camera is not read twice for it. */
  const archive = await decryptDump(
    read.assembled,
    'preserve_backup',
    {
      dumpPath: `${state.runId}/${PRESERVE_BACKUP_FILE}`,
      ...(signal === undefined ? {} : { signal }),
    },
    reporter,
  );
  const profile = archive.detection?.best.profile ?? getProfile('generic');
  const manifest = buildOfflineDecryptManifest({
    producer:
      'seek-thermal-firmware-dump (preserve backup step: the offline decrypt of the assembled ' +
      'stock windows — the pre-flash dump of every region the stock plan can read)',
    startedAt,
    finishedAt: new Date().toISOString(),
    source: {
      fileName: PRESERVE_BACKUP_FILE,
      size: read.assembled.length,
      sha256: await sha256hex(read.assembled),
    },
    flashBase: profile.memory.flashBase,
    decryption: archive.summary,
    profile: profileInfoOf(profile, archive.detection),
  });

  /* The run's checkpoint files — the derived factory plaintext among them,
   * so a resume never needs an external image — then the archive as it came. */
  const artifacts: Artifact[] = [
    named(PRESERVE_BACKUP_FILE, read.assembled),
    named(PRESERVE_BANK_CAPTURE_FILE, read.capture),
    named(PRESERVE_PLAIN_NAME, read.derived.plain),
    ...archive.artifacts.map((a) => named(a.name, a.data)),
    named(PRESERVE_DUMP_MANIFEST_FILE, utf8(manifestToJson(manifest))),
    named(PRESERVE_DUMP_README_FILE, utf8(makeOfflineDecryptReadme(manifest))),
  ];
  const shas = await shasOf(artifacts);
  const patch = read.derived.patch;
  const nextState: PreserveRunState = {
    ...state,
    /* The run's build facts, recorded by the step that derived them. */
    buildFamily: patch.family,
    imageSha256: shas.get(PRESERVE_PLAIN_NAME) ?? '',
    expectedVersion: read.version,
    slotReadShas: read.slotReadShas,
    buildId: patch.buildId,
    buildLabel: patch.label,
    stagedForm: patch.stagedForm,
    restoreForm: patch.restoreForm,
    route: patch.route,
    routeNote: patch.routeNote,
    capability: patch.capability,
    detection: read.detection,
    nextStep: nextStepAfter('backup'),
    steps: {
      ...state.steps,
      backup: stepRecord(
        startedAt,
        `${String(BACKUP_WINDOW_COUNT)} windows (${String(
          BACKUP_WINDOW_COUNT * WINDOW_BYTES,
        )} B) backed up; ${read.detection.verdict}; the active slot served twice (the sweep’s ` +
          `plan-window row, mode ${String(read.readModes[0])}, + one fresh arm of the bank ` +
          `window, mode ${String(read.readModes[1])}), ${read.serveNote} ` +
          `(sha256 ${read.slotReadShas[1]}); ` +
          'the factory plaintext derived from the ' +
          `capture (${read.derived.method}, ${String(read.derived.plain.length)} B) and gated; ` +
          `build ${patch.buildId}` +
          (read.repointed
            ? '; the capture re-pointed at the recovery bank (the build boots recovery unchecked)'
            : '') +
          `; dump archive: ${String(archive.slots.length)} slot(s) decrypted`,
        shas,
      ),
    },
  };
  return { state: nextState, artifacts };
}

/* ==================================================================== *
 * patch — offline, no device
 * ==================================================================== */

async function runPatchStep(
  state: PreserveRunState,
  loadArtifact: PreserveArtifactLoader,
  reporter: Reporter,
  signal: AbortSignal | undefined,
  startedAt: string,
): Promise<PreserveStepOutcome> {
  assertLive(signal);
  const plain = await loadPlain(state, loadArtifact);
  const patch = buildV1Patch(plain); /* the before-byte gates refuse here */

  const patchedSha = await sha256hex(patch.patched);
  const summary: PreservePatchSummary = {
    sites: patch.sites.map((site) => ({
      name: site.what.split(' (')[0] ?? site.what,
      offset: site.offset,
      before: [...site.before],
      after: [...site.after],
    })),
    rebalanceWord: patch.rebalanceWord,
    stagedLength: plain.length,
    chunkCount: Math.ceil(plain.length / STAGE_CHUNK),
    patchedSha256: patchedSha,
    diffCount: patch.diffOffsets.length,
  };
  const artifacts: Artifact[] = [named(PRESERVE_PATCHED_FILE, patch.patched)];
  const shas = await shasOf(artifacts);
  reporter.log(
    `patch built: ${String(summary.sites.length)} instruction site(s), ` +
      `${String(patch.diffOffsets.length)} byte(s) move on the part, ` +
      `${String(summary.chunkCount)} staging chunk(s)`,
    'detail',
  );

  const nextState: PreserveRunState = {
    ...state,
    patch: summary,
    nextStep: nextStepAfter('patch'),
    steps: {
      ...state.steps,
      patch: stepRecord(
        startedAt,
        `patch built offline from the factory plaintext: ` +
          `${String(patch.diffOffsets.length)} byte(s) differ (rebalance word ` +
          `${patch.rebalanceWord.toString(16)}), staged length ${String(summary.stagedLength)} B ` +
          `in ${String(summary.chunkCount)} chunk(s)`,
        shas,
      ),
    },
  };
  return { state: nextState, artifacts };
}

/* ==================================================================== *
 * commit — the in-place patch; never reset, never replayed blind
 * ==================================================================== */

/**
 * How much of the bank's head the pre-checks read, and at what ask size —
 * both measured constraints, not choices.
 *
 * THE ASK SIZE: 64 B, the shape where serve == ask on this reader (TESTING.md
 * sec. 23.3). At a 512-ask the RE-ARMED bank window serves short (~192-256 B)
 * while its cursor advances by the full ask, so the delivered stream is
 * SPARSE — measured on the emulator: live vs capture heads byte-identical for
 * 24 B, divergent within the first 1 KiB, and a 47,768 B sequential read
 * stalled permanently at 28,544 B. At a 64-ask serve == ask always, and
 * sixteen asks deliver a contiguous, byte-accurate 1 KiB.
 *
 * THE LENGTH: 1 KiB is ENOUGH — the rebalance word at 0x238 (568) is among
 * the patch bytes, 0 on the factory image (buildV1Patch refuses a busy
 * rebalance word) and the nonzero rebalance on the patched one — so the head
 * alone distinguishes original from patched, which is the only question the
 * pre-checks exist to answer. The instruction-site bytes (0x3C1C..0x3DC7) lie
 * beyond it and are NOT checked live.
 */
const BANK_HEAD_BYTES = 0x400;
const BANK_HEAD_ASK = 64;

async function readBankHead(device: SeekDevice, bank: BankKey, label: string): Promise<Uint8Array> {
  await device.armWindow(bankWindow(bank));
  return drainExact(device, BANK_HEAD_BYTES, label, {
    chunk: BANK_HEAD_ASK,
    retries: 3,
    timeoutMs: 20000,
  });
}

async function runCommitStep(
  state: PreserveRunState,
  opener: SessionOpener,
  loadArtifact: PreserveArtifactLoader,
  reporter: Reporter,
  signal: AbortSignal | undefined,
  startedAt: string,
): Promise<PreserveStepOutcome> {
  const plain = await loadPlain(state, loadArtifact);
  const patch = buildV1Patch(plain);
  const capture = await loadCheckpoint(state, loadArtifact, PRESERVE_BANK_CAPTURE_FILE, 'backup');
  /* The gate checked the windows file's presence; loading verifies its sha. */
  await loadCheckpoint(state, loadArtifact, PRESERVE_BACKUP_FILE, 'backup');
  const detection = state.detection;
  if (detection === undefined) fail('the run state carries no slot detection');
  /* THE CAPTURE IS ALREADY ANCHORED: the backup step read it twice, required
   * byte agreement, and derived the plaintext this patch is built from THROUGH
   * it — and `loadCheckpoint` just proved the file still is those bytes. The
   * wire-side protection that remains at write time is the bank head
   * pre-check below, against the capture and the patched expectation. */
  /* THE STAGED PAYLOAD, per family. On the plaintext 2014 banks it is the
   * conjugated capture (the keystream is zero, so the conjugation is its own
   * identity). On the cipher families the wire-80 bytes are the STAGED form
   * of the PATCHED PLAINTEXT — the commit's own two-stream transform, not the
   * host, produces the slot bytes — and the conjugated capture is what the
   * bank is expected to hold AFTER the write (the pre-check below). */
  const payload =
    patch.stagedForm === 'plain'
      ? conjugateCapture(capture, patch)
      : stagedFormOf(patch, patch.patched);
  if (patch.family === 'v1-2014-ff' && stagedAcceptanceSum(patch, payload) !== 0xffff) {
    fail(
      'the staged payload does not satisfy the FF build collapsed acceptance ' +
        '(sum(staged ^ ks0) must be 0xFFFF) — refusing to stage a payload the app would ' +
        'reject after the erase',
    );
  }
  /* What the bank will hold once the commit lands, in every family: the
   * capture with the plaintext diff folded through — the keystream cancels. */
  const patchedSlot = conjugateCapture(capture, patch);

  /* The commit session is ADMITTED like every read session (the mode-3 probe
   * first — a boot that comes up page-shifted or unreadable is rebooted by
   * command before anything is staged), and NO reset is sent after: the
   * session's post-commit flash state is the ground truth, and the wire-89
   * belongs to the drain step's own first session. The probe is a window
   * read, so it runs on the run's reader wire: it comes BEFORE the version
   * gate that would otherwise set it, and on a 0.7.x build wire 79 stalls. */
  const commit = await (async () => {
    const { device } = await openProbedSession(
      opener,
      reporter,
      signal,
      'the commit session',
      (d) => {
        applyReaderOp(d, state.expectedVersion);
      },
    );
    try {
      assertLive(signal);
      const version = await gateVersion(device, state);
      reporter.log(`camera reports firmware ${version}`, 'detail');

      /* THE PRE-COMMIT READ-BACK (one ask at the bank's head): what is in the
       * bank RIGHT NOW decides what may be written. A crash between the commit
       * transfer and its checkpoint leaves this run at nextStep `commit`;
       * re-running it must never stage a second commit blind. The head carries
       * the rebalance word (0x238), which is 0 on the original and the nonzero
       * rebalance on the patched bytes — enough to tell the two apart. The
       * comparison is against SLOT bytes (what the reader serves): the patched
       * expectation is the conjugated capture, which is the payload itself on
       * the plaintext families. */
      const live = await readBankHead(
        device,
        detection.bank,
        'commit pre-check (the active bank head as it lies)',
      );
      if (equalBytes(live, patchedSlot.subarray(0, BANK_HEAD_BYTES))) {
        fail(
          'the active bank already holds the patched bytes — the commit landed in a previous ' +
            'attempt and must not be replayed. Resume at the drain step (--resume), which ' +
            'boots the patched image and continues from there.',
        );
      }
      if (!equalBytes(live, capture.subarray(0, BANK_HEAD_BYTES))) {
        fail(
          'the active bank head changed since the backup (it holds neither the original capture ' +
            'nor the patched bytes) — refusing to write over an unknown bank state. Head hex: ' +
            `live ${bytesToHex(live, 24)} vs capture ${bytesToHex(capture.subarray(0, 24))}`,
        );
      }

      return await commitToBank(device, detection.bank, payload, {
        label: 'preserve commit',
        reporter,
        ...(signal === undefined ? {} : { signal }),
      });
    } finally {
      await opener.close(device);
    }
  })();

  const nextState: PreserveRunState = {
    ...state,
    nextStep: nextStepAfter('commit'),
    steps: {
      ...state.steps,
      commit: {
        status: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        notes:
          `${String(commit.chunks)} chunks staged (${String(payload.length)} B, image length ` +
          `only), commit status ${commit.status.toString(16)}, sum16 ` +
          `${commit.sum16.toString(16)}; the bank was read back and verified against the ` +
          'backup before writing; no reset sent in this session',
      },
    },
  };
  return { state: nextState, artifacts: [] };
}

/* ==================================================================== *
 * drain — reset, then the whole part on its own single arm
 * ==================================================================== */

async function runDrainStep(
  state: PreserveRunState,
  opener: SessionOpener,
  loadArtifact: PreserveArtifactLoader,
  reporter: Reporter,
  signal: AbortSignal | undefined,
  startedAt: string,
): Promise<PreserveStepOutcome> {
  const capture = await loadCheckpoint(state, loadArtifact, PRESERVE_BANK_CAPTURE_FILE, 'backup');
  const detection = state.detection;
  if (detection === undefined) fail('the run state carries no slot detection');

  /* THE ROTATION, resolved BEFORE anything touches the camera: on the 0.7.0.7
   * the widened mode-2 window serves the part from the A/B slot the
   * active-slot word does NOT name (measured slot B 0x14060000 on the donor's
   * blank record; doc 36.10 item 3), so the served bytes fold back through the
   * NOR's own alias decode. The window's probe expectation and the delivered
   * dump both read at layout addresses, so the base is resolved here — and a
   * detection whose base this walk cannot name (recovery) refuses before the
   * reset, not after it. */
  let rotationBase: number | null = null;
  if (state.capability?.rotation !== undefined) {
    rotationBase = rotatedDrainBase(detection);
    reporter.log(
      `the widened window serves the part rotated from ${hexUp(rotationBase, 8)} — ` +
        'the drain will unrotate before delivery',
      'detail',
    );
  }

  /* The reset, ONCE, on its own first session: after it the camera boots the
   * patched image, and the session that sent it holds the reset's own
   * orphaned URB. Nothing else reads before the drain — the reader's per-arm
   * budget is consumed in asks (TESTING.md sec. 23.3). */
  await withSession(opener, async (device) => {
    assertLive(signal);
    const version = await gateVersion(device, state);
    reporter.log(
      `camera reports firmware ${version}; resetting so it boots the patched image`,
      'detail',
    );
    await resetDevice(device);
  });

  const attempts = state.postResetAttempts ?? 2;
  let rawDump: Uint8Array | null = null;
  let lastError = 'not attempted';
  for (let n = 1; n <= attempts && rawDump === null; n++) {
    const device = await opener.open();
    /* No version read happens on an attempt session (the reset session gates
     * it); the reader op comes from the state's pinned version. */
    applyReaderOp(device, state.expectedVersion);
    try {
      rawDump = await drainWholePart(device, reporter, {
        chunk: state.drainChunk ?? READ_CHUNK,
        ...(signal === undefined ? {} : { signal }),
      });
      /* THE PAGE-SHIFT CHECK (TESTING.md sec. 34): a page-shifted boot serves
       * the widened window one 64 KiB page up, so the dump would start with
       * the boot-config block's `00 00 00 00` instead of a vector's segment
       * SP (the bootloader's 0x10018000 unrotated, the image's 0x10008000
       * rotated). No legitimate part image starts with four zero bytes. The
       * bias re-rolls per boot, so the camera is rebooted by command and the
       * attempt loop takes another boot. */
      if (
        rawDump[0] === 0 &&
        rawDump[1] === 0 &&
        rawDump[2] === 0 &&
        rawDump[3] === 0
      ) {
        reporter.log(
          'the drain came back one page high (a page-shifted boot — the dump starts with the ' +
            'boot-config block, not a vector) — rebooting by command and taking another boot',
          'warn',
        );
        await resetDevice(device).catch(() => undefined);
        rawDump = null;
        lastError = 'page-shifted boot (rebooting for another)';
        continue;
      }
      /* Advisory, AFTER the drain and on what budget remains: the full
       * 4 MiB completion is the liveness proof; the probe only comments on
       * the budget and can stall without meaning anything is wrong. */
      try {
        const backupImage = await loadArtifact(PRESERVE_BACKUP_FILE);
        if (backupImage !== null) {
          /* The window offset PROBE_OFFSET reads LAYOUT address
           * (rotationBase ?? FLASH_BASE) + PROBE_OFFSET, so the expectation
           * is cut there — the rotated build compares against the rotated
           * address's true bytes, exactly as the ip4 rotated compare did. */
          const probeFlash = (rotationBase ?? FLASH_BASE) + PROBE_OFFSET - READ_CHUNK - FLASH_BASE;
          const probeBytes = backupSlice(
            backupResultFromImage(backupImage),
            probeFlash,
            READ_CHUNK,
          );
          const probe = await probeWidenedWindow(device, probeBytes);
          reporter.log(`drain probe, ${probe.detail}`, probe.live ? 'detail' : 'warn');
        }
      } catch {
        reporter.log('drain probe skipped (the drain already proves the widened window)', 'detail');
      }
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      lastError = `attempt ${String(n)}: ${error instanceof Error ? error.message : String(error)}`;
      reporter.log(`drain attempt failed: ${lastError}`, 'warn');
    } finally {
      await opener.close(device);
    }
  }
  if (rawDump === null) {
    throw new PostResetWedgeError(
      'the commit landed but the post-reset read window never came up — the doc 33 sec. 11.6 ' +
        'same-server wedge. The commit is NOT replayed; re-run the drain step against a ' +
        `fresh session/server booted from the committed state. Last attempt: ${lastError}`,
      { step: 'drain', lastError },
    );
  }

  /* The served bytes become the part in LAYOUT order here: the post-write
   * artifact is the state the commits produced (the same invariant every
   * build's run carries), and the delivered dump swaps the active bank back
   * from the backup on top of it. */
  const layout = rotationBase === null ? rawDump : unrotateDump(rawDump, rotationBase);
  const delivered = postProcessDump(layout, detection.bankAddress, capture);
  const artifacts: Artifact[] = [
    named(PRESERVE_DUMP_POSTWRITE_FILE, layout),
    named(PRESERVE_DUMP_ORIGINAL_FILE, delivered),
  ];
  const shas = await shasOf(artifacts);
  const rawSha = shas.get(PRESERVE_DUMP_POSTWRITE_FILE) ?? '';
  const deliveredSha = shas.get(PRESERVE_DUMP_ORIGINAL_FILE) ?? '';
  const servedNote =
    rotationBase === null
      ? `raw dump ${String(rawDump.length)} B (sha256 ${rawSha})`
      : `served dump ${String(rawDump.length)} B rotated from ${hexUp(rotationBase, 8)} ` +
        `(sha256 ${await sha256hex(rawDump)}), unrotated to layout order (sha256 ${rawSha})`;
  const nextState: PreserveRunState = {
    ...state,
    rawDumpSha256: rawSha,
    deliveredSha256: deliveredSha,
    nextStep: nextStepAfter('drain'),
    steps: {
      ...state.steps,
      drain: stepRecord(
        startedAt,
        `${servedNote}; delivered dump (the active bank swapped back from the backup) ` +
          `sha256 ${deliveredSha}`,
        shas,
      ),
    },
  };
  return { state: nextState, artifacts };
}

/* ==================================================================== *
 * restore — the original bank back, then a reset
 * ==================================================================== */

async function runRestoreStep(
  state: PreserveRunState,
  opener: SessionOpener,
  loadArtifact: PreserveArtifactLoader,
  reporter: Reporter,
  signal: AbortSignal | undefined,
  startedAt: string,
): Promise<PreserveStepOutcome> {
  const capture = await loadCheckpoint(state, loadArtifact, PRESERVE_BANK_CAPTURE_FILE, 'backup');
  const detection = state.detection;
  if (detection === undefined) fail('the run state carries no slot detection');
  const stagedLength = state.patch?.stagedLength;
  if (stagedLength === undefined) fail('the run state carries no patch summary (staged length)');
  if (capture.length < stagedLength) fail('the bank capture is shorter than the staged length');
  /* The bank's ORIGINAL content, as the reader serves it (slot bytes) — the
   * pre-check compares against this, and the 'plain' families stage it back
   * verbatim. */
  const original = capture.subarray(0, stagedLength);
  /* A cipher family stages the FACTORY image in the build's staged form: the
   * commit's own two-stream transform turns it back into the original slot
   * bytes. Staging the slot bytes themselves would fail the app's acceptance
   * (they are not a valid staged form). */
  let payload = original;
  if (state.stagedForm !== undefined && state.stagedForm !== 'plain') {
    const plain = await loadPlain(state, loadArtifact);
    payload = stagedFormOf(buildV1Patch(plain), plain);
  }

  /* The restore session is ADMITTED like every read session. After a drain
   * the patched reader's position sits at its 4 MiB limit, which the arm's
   * halfword reset cannot clear, so every read stalls (TESTING.md sec.
   * 35.4) — unless the patch carries the arm tail's cursor reset (sec. 36),
   * when the probe reads on the drain's own boot. The probe's
   * reboot-and-retry loop was meant to clear the stall by command, but on
   * silicon it has not: four wire reboots in a row with no disconnect
   * between them (the reboot never took). The web wizard therefore asks for
   * a replug after a drain on a patch without the reset (TESTING.md secs.
   * 28.4, 35, 36). The loop stays (it is free when it works, and a resumed
   * run may not have replugged); its refusal names the power cycle. */
  const restored = await (async () => {
    const { device, cfgHead } = await openProbedSession(
      opener,
      reporter,
      signal,
      'the restore session',
      (d) => {
        /* The probe is a window read: the run's reader wire, as at commit. */
        applyReaderOp(d, state.expectedVersion);
      },
    );
    try {
      assertLive(signal);
      const version = await gateVersion(device, state);
      reporter.log(`camera reports firmware ${version}`, 'detail');

      const now = effectiveDetection(state, detectActiveSlotFromHead(cfgHead));
      if (now.bank !== detection.bank || now.bankAddress !== detection.bankAddress) {
        fail(
          `the active slot changed between the backup (${detection.bankAddress.toString(16)}) ` +
            `and now (${now.bankAddress.toString(16)}) — refusing to restore over a different ` +
            'bank than the one this run patched',
        );
      }

      /* Head read (see BANK_HEAD_BYTES): the rebalance word at 0x238 is 0 on
       * the original and the nonzero rebalance on the patched bytes. */
      const live = await readBankHead(
        device,
        detection.bank,
        'restore pre-check (the active bank head as it lies)',
      );
      if (equalBytes(live, original.subarray(0, BANK_HEAD_BYTES))) {
        /* A previous restore landed and its checkpoint did not: the recovery is
         * to mark the step done, not to erase and reprogram the same bytes. */
        reporter.log(
          'restore: the bank already holds the original content — nothing to stage',
          'detail',
        );
        return false;
      }
      reporter.log(
        'restore: the bank holds something other than the original content — staging the backup ' +
          'over it (the backup is the authority this run restores from)',
        'detail',
      );
      await commitToBank(device, detection.bank, payload, {
        label: 'preserve restore',
        reporter,
        ...(signal === undefined ? {} : { signal }),
      });
      await resetDevice(device);
      return true;
    } finally {
      await opener.close(device);
    }
  })();

  const notes = restored
    ? `original bank content staged back (${String(payload.length)} B${
        payload === original
          ? ', the capture verbatim'
          : `, the ${state.stagedForm ?? ''} staged form`
      }) and committed; reset sent`
    : 'the bank already held the original content (a previous restore landed) — nothing ' +
      'staged, no reset sent';
  const nextState: PreserveRunState = {
    ...state,
    nextStep: nextStepAfter('restore'),
    steps: {
      ...state.steps,
      restore: { status: 'done', startedAt, finishedAt: new Date().toISOString(), notes },
    },
  };
  return { state: nextState, artifacts: [] };
}

/* ==================================================================== *
 * verify — a fresh boot, 31 windows, 0 diffs
 * ==================================================================== */

async function runVerifyStep(
  state: PreserveRunState,
  opener: SessionOpener,
  loadArtifact: PreserveArtifactLoader,
  reporter: Reporter,
  signal: AbortSignal | undefined,
  startedAt: string,
): Promise<PreserveStepOutcome> {
  const backupImage = await loadCheckpoint(state, loadArtifact, PRESERVE_BACKUP_FILE, 'backup');
  const backup = backupResultFromImage(backupImage);

  const attempts = state.postResetAttempts ?? 2;
  let last: Awaited<ReturnType<typeof verifyAgainstBackup>> | null = null;
  for (let n = 1; n <= attempts; n++) {
    /* One admitted boot per window — the sweep's own discipline; the reader
     * op comes from the state's pinned version, as in every step after the
     * backup. */
    const read = await verifyAgainstBackup(opener, backup, reporter, READ_CHUNK, signal, (d) => {
      applyReaderOp(d, state.expectedVersion);
    });
    last = read;
    if (read.badWindows.length === 0) break;
  }
  const result = last ?? { diffBytes: -1, windowsRead: 0, badWindows: [] as number[] };
  if (result.diffBytes !== 0 || result.badWindows.length > 0) {
    fail(
      `the verify read ${String(result.diffBytes)} differing byte(s) over ` +
        `${String(result.windowsRead)}/${String(BACKUP_WINDOW_COUNT)} windows` +
        (result.badWindows.length > 0 ? ` (short windows: ${result.badWindows.join(',')})` : '') +
        ' — the part does not re-read byte-identical to the backup',
    );
  }

  const nextState: PreserveRunState = {
    ...state,
    verify: {
      diffBytes: result.diffBytes,
      windowsRead: result.windowsRead,
      badWindows: [...result.badWindows],
    },
    nextStep: nextStepAfter('verify'),
    steps: {
      ...state.steps,
      verify: {
        status: 'done',
        startedAt,
        finishedAt: new Date().toISOString(),
        notes:
          `a fresh boot re-read ${String(result.windowsRead)}/` +
          `${String(BACKUP_WINDOW_COUNT)} windows at ${String(result.diffBytes)} differing ` +
          "byte(s) — the camera's flash is byte-identical to the backup",
      },
    },
  };
  return { state: nextState, artifacts: [] };
}

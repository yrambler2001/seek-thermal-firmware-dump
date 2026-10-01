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
 *   backup  — the 31 stock windows, the active-bank capture, and the standard
 *             dump archive (decrypted slots, reports, manifest) built offline
 *             from the assembled backup. Read-only. THIS is the user's
 *             pre-flash dump of every region the stock plan can read, and it
 *             is handed over before anything write-shaped can possibly run.
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
 * windows, the bank capture, the factory plaintext — from wherever the caller
 * keeps them. A step that cannot load what an earlier step produced refuses
 * with the reason, so `--from-step` cannot silently run against a torn run
 * directory.
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
import { bytesToHex, equalBytes, hexToBytes, isoStamp, sha256hex, utf8 } from '../bytes.js';
import { CancelledError, SeekError } from '../errors.js';
import type { Artifact, Reporter } from '../events.js';
import { parseImageHeader } from '../image/header.js';
import { FLASH_BASE, FLASH_SIZE } from '../profiles/modern-4x.js';
import { getProfile } from '../profiles/registry.js';
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
  detectActiveSlot,
  drainExact,
  drainWholePart,
  postProcessDump,
  probeWidenedWindow,
  readVersion,
  resetDevice,
  verifyAgainstBackup,
  type BackupResult,
  type SessionOpener,
  type WindowBytes,
} from './pipeline.js';
import {
  V1_2014_PATCH_SITES,
  buildV1Patch,
  conjugateCapture,
  verifyCapture,
  type V1Patch,
} from './patch.js';
import {
  BACKUP_WINDOW_COUNT,
  WINDOW_BYTES,
  bankWindow,
  preservationWindows,
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
}

export interface PreserveRunState {
  version: 1;
  /** Timestamped (`preserve-2026-10-01T09-30-00Z`); names nothing on disk. */
  runId: string;
  buildFamily: 'v1-2014';
  /** The factory plaintext sha the patch derives from — what a resumed image
   *  file is checked against before anything runs. */
  imageSha256: string;
  expectedVersion: string;
  createdAt: string;
  nextStep: PreserveStepId | 'done';
  steps: Partial<Record<PreserveStepId, PreserveStepRecord>>;
  /** The slot verdict, after backup. */
  detection?: SlotDetection;
  /** The patch summary, after patch. */
  patch?: PreservePatchSummary;
  /** The dump shas, after drain. */
  rawDumpSha256?: string;
  deliveredSha256?: string;
  /* ---- additive extensions (still version 1; readers may ignore) --------- */
  /** The wire-79 read size the drain asks for, in bytes. Default READ_CHUNK
   *  (512 — the hardware default); the emulator suite drains at 64 asks. */
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
 * The name the factory plaintext arrives under, via `loadArtifact`. It is NOT
 * a run-directory file: the CLI serves it from the positional image path (its
 * sha256 is checked against `state.imageSha256` on every load), and a web
 * runner serves it from memory. Nothing in the run directory has to hold it.
 */
export const PRESERVE_PLAIN_NAME = 'preserve_image_plain.bin';

/** Serves one checkpoint artifact by name, or null when the caller does not
 *  have it — which a step that needs it turns into a refusal, never a gap. */
export type PreserveArtifactLoader = (name: string) => Promise<Uint8Array | null>;

/* ==================================================================== *
 * creating a run (offline)
 * ==================================================================== */

export interface CreatePreserveRunOptions {
  /** The version the camera must report. Default: the image header's own. */
  readonly expectedVersion?: string;
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
  /** The patch the run will stage — built here so a wrong image fails on the
   *  desk, before any run directory exists. */
  readonly patch: V1Patch;
}

/**
 * Create a run state from the factory plaintext. Offline: no device, no
 * filesystem — the caller chooses where the run lives and writes `state` out
 * as `preserve_run.json` BEFORE the first step, so even a crash during the
 * backup leaves a resumable run.
 *
 * Throws (SeekError `pipeline/refused`) when the image does not carry the v1
 * 2014 update machinery, is not word-sum balanced, or has no header to derive
 * the expected version from and none was given.
 */
export async function createPreserveRun(
  plain: Uint8Array,
  options: CreatePreserveRunOptions = {},
): Promise<CreatedPreserveRun> {
  const patch = buildV1Patch(plain); /* refuses before anything is derived */
  const version = options.expectedVersion ?? parseImageHeader(plain)?.versionStr ?? null;
  if (version === null) {
    throw new SeekError(
      'pipeline/refused',
      'the image does not parse as a decrypted Seek firmware image (no header at 0x200) — ' +
        'pass expectedVersion explicitly to run against it anyway',
    );
  }
  const now = options.now ?? ((): Date => new Date());
  const state: PreserveRunState = {
    version: 1,
    runId: options.runId ?? `preserve-${isoStamp(now())}`,
    buildFamily: 'v1-2014',
    imageSha256: await sha256hex(plain),
    expectedVersion: version,
    createdAt: now().toISOString(),
    nextStep: 'backup',
    steps: {},
    ...(options.drainChunk === undefined ? {} : { drainChunk: options.drainChunk }),
    ...(options.expectedSlotPrefix === undefined
      ? {}
      : { expectedSlotPrefix: bytesToHex(options.expectedSlotPrefix) }),
    ...(options.postResetAttempts === undefined
      ? {}
      : { postResetAttempts: options.postResetAttempts }),
  };
  return { state, patch };
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

async function loadPlain(
  state: PreserveRunState,
  loadArtifact: PreserveArtifactLoader,
): Promise<Uint8Array> {
  const plain = await loadArtifact(PRESERVE_PLAIN_NAME);
  if (plain === null) {
    throw new SeekError(
      'pipeline/refused',
      `this step needs the factory plaintext the patch derives from (loadArtifact ` +
        `'${PRESERVE_PLAIN_NAME}') and the caller did not supply it — pass the image path to ` +
        'the CLI, or the bytes to the runner',
    );
  }
  const actual = await sha256hex(plain);
  if (actual !== state.imageSha256) {
    throw new SeekError(
      'pipeline/refused',
      `the image is not the one this run was created from (sha256 ${actual}, want ` +
        `${state.imageSha256}) — the patch is derived from one build's bytes and must not be ` +
        'rebuilt from another',
    );
  }
  return plain;
}

const isDone = (state: PreserveRunState, id: PreserveStepId): boolean =>
  state.steps[id]?.status === 'done';

/**
 * Why `step` cannot run against `state` right now, or null when it can.
 *
 * The run's rule, in gate order: the available regions are dumped and
 * persisted (backup) before the patch is built; the patch summary exists
 * before anything write-shaped; the commit exists before anything that reads
 * the patched part; and the restore exists before the verify that proves it.
 * A step that is already `done` always refuses — re-running a completed step
 * is never what a resume wants.
 */
export async function describeStepGate(
  step: PreserveStepId,
  state: PreserveRunState,
  loadArtifact: PreserveArtifactLoader,
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

  const doneSteps = PRESERVE_STEP_IDS.filter((id) => isDone(state, id));
  switch (step) {
    case 'backup': {
      if (doneSteps.length > 0) {
        return (
          'the backup cannot re-run: this run has already completed ' +
          `${doneSteps.join(', ')} and its next step is ${state.nextStep} — use --resume`
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
      if (!isDone(state, 'commit')) {
        return (
          'drain reads the PATCHED part through the widened window, and this run has no ' +
          'completed commit — the drain would stall on a stock camera. Run (or resume at) ' +
          'the commit first.'
        );
      }
      if (state.detection === undefined) {
        return 'drain needs the slot detection the backup step recorded, and the state has none';
      }
      if ((await loadArtifact(PRESERVE_BANK_CAPTURE_FILE)) === null) {
        return (
          `drain needs ${PRESERVE_BANK_CAPTURE_FILE} (the delivered dump is post-processed ` +
          'with it) and it is not in the run directory'
        );
      }
      return null;
    }
    case 'restore': {
      if (!isDone(state, 'commit')) {
        return (
          'restore puts the original bank back over the patch, and this run has no completed ' +
          'commit — there is nothing it can be reverting. Run (or resume at) the commit first.'
        );
      }
      if (state.detection === undefined) {
        return 'restore needs the slot detection the backup step recorded, and the state has none';
      }
      if (state.patch === undefined) {
        return 'restore needs the patch summary (for the staged length) — run the patch step first';
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
      if (!isDone(state, 'restore')) {
        return (
          'verify compares a fresh boot against the backup, and this run has no completed ' +
          'restore — a patched bank would show as diffs. Run (or resume at) the restore first.'
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
): Promise<PreserveStepOutcome> {
  const refusal = await describeStepGate(step, state, loadArtifact);
  if (refusal !== null) throw new SeekError('pipeline/refused', refusal);

  const startedAt = new Date().toISOString();
  const fresh: PreserveRunState = { ...state, steps: { ...state.steps } };
  switch (step) {
    case 'backup':
      return runBackupStep(fresh, opener, loadArtifact, reporter, signal, startedAt);
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
 * stands.)
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
  if (version !== state.expectedVersion) {
    throw new SeekError(
      'pipeline/refused',
      `the camera reports firmware ${version}, want ${state.expectedVersion} — the patch is ` +
        "derived from one build's bytes and must not be sent to another",
    );
  }
  return version;
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

async function runBackupStep(
  state: PreserveRunState,
  opener: SessionOpener,
  loadArtifact: PreserveArtifactLoader,
  reporter: Reporter,
  signal: AbortSignal | undefined,
  startedAt: string,
): Promise<PreserveStepOutcome> {
  const plain = await loadPlain(state, loadArtifact);
  const expectedPrefix = expectedPrefixOf(state);

  const read = await withSession(opener, async (device) => {
    assertLive(signal);
    const version = await gateVersion(device, state);
    reporter.log(`camera reports firmware ${version}`, 'detail');

    const backup = await backupWindows(device, reporter, READ_CHUNK, signal);
    const detection = await detectActiveSlot(device);
    reporter.log(`slot: ${detection.verdict}`, 'detail');
    const captured = backup.byAddress.get(detection.bankAddress);
    if (captured === undefined) {
      fail(
        `the backup does not hold the active bank ` +
          `${detection.bankAddress.toString(16)} — the stock windows cannot serve it`,
      );
    }
    const capture = new Uint8Array(captured);
    const check = verifyCapture(capture, plain, expectedPrefix);
    if (!check.ok) {
      fail(
        `the bank capture does not match the factory image: ${check.reason ?? 'unknown'} — ` +
          'refusing before anything is recorded, let alone written',
      );
    }
    return { detection, capture, assembled: assembleBackupImage(backup.byAddress) };
  });

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

  /* The run's two checkpoint files first, then the archive as it came. */
  const artifacts: Artifact[] = [
    named(PRESERVE_BACKUP_FILE, read.assembled),
    named(PRESERVE_BANK_CAPTURE_FILE, read.capture),
    ...archive.artifacts.map((a) => named(a.name, a.data)),
    named(PRESERVE_DUMP_MANIFEST_FILE, utf8(manifestToJson(manifest))),
    named(PRESERVE_DUMP_README_FILE, utf8(makeOfflineDecryptReadme(manifest))),
  ];
  const shas = await shasOf(artifacts);
  const form =
    expectedPrefix === undefined ? 'the keyless verbatim-header window' : 'the expected prefix';
  const nextState: PreserveRunState = {
    ...state,
    detection: read.detection,
    nextStep: nextStepAfter('backup'),
    steps: {
      ...state.steps,
      backup: stepRecord(
        startedAt,
        `${String(BACKUP_WINDOW_COUNT)} windows (${String(
          BACKUP_WINDOW_COUNT * WINDOW_BYTES,
        )} B) backed up; ${read.detection.verdict}; bank capture verified against the factory ` +
          `image through ${form}; dump archive: ${String(archive.slots.length)} slot(s) decrypted`,
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
    sites: V1_2014_PATCH_SITES.map((site) => ({
      name: site.what.split(' (')[0] ?? site.what,
      offset: site.offset,
      before: [...site.before],
      after: [...site.after],
    })),
    rebalanceWord: patch.rebalanceWord,
    stagedLength: plain.length,
    chunkCount: Math.ceil(plain.length / STAGE_CHUNK),
    patchedSha256: patchedSha,
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

/** The bank's first `length` bytes, as the stock window serves them. */
async function readBankPrefix(
  device: SeekDevice,
  bank: BankKey,
  length: number,
  label: string,
): Promise<Uint8Array> {
  await device.armWindow(bankWindow(bank));
  return drainExact(device, length, label, { retries: 3, timeoutMs: 20000 });
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
  const expectedPrefix = expectedPrefixOf(state);

  const check = verifyCapture(capture, plain, expectedPrefix);
  if (!check.ok) {
    fail(
      'the backed-up bank capture does not match the factory image: ' +
        `${check.reason ?? 'unknown'} — the restore source is not trustworthy`,
    );
  }
  const payload = conjugateCapture(capture, patch);

  const commit = await withSession(opener, async (device) => {
    assertLive(signal);
    const version = await gateVersion(device, state);
    reporter.log(`camera reports firmware ${version}`, 'detail');

    /* THE PRE-COMMIT READ-BACK: what is in the bank RIGHT NOW decides what
     * may be written. A crash between the commit transfer and its checkpoint
     * leaves this run at nextStep `commit`; re-running it must never stage a
     * second commit blind. */
    const live = await readBankPrefix(
      device,
      detection.bank,
      plain.length,
      'commit pre-check (the active bank as it lies)',
    );
    if (equalBytes(live, payload)) {
      fail(
        'the active bank already holds the patched bytes — the commit landed in a previous ' +
          'attempt and must not be replayed. Resume at the drain step (--resume), which ' +
          'boots the patched image and continues from there.',
      );
    }
    if (!equalBytes(live, capture.subarray(0, plain.length))) {
      fail(
        'the active bank changed since the backup (it holds neither the original capture nor ' +
          'the patched bytes) — refusing to write over an unknown bank state',
      );
    }

    const done = await commitToBank(device, detection.bank, payload, {
      label: 'preserve commit',
      reporter,
      ...(signal === undefined ? {} : { signal }),
    });
    /* NO reset in this session: its post-commit flash state is the ground
     * truth, and the wire-89 belongs to the drain step's own first session. */
    return done;
  });

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
    try {
      rawDump = await drainWholePart(device, reporter, {
        chunk: state.drainChunk ?? READ_CHUNK,
        ...(signal === undefined ? {} : { signal }),
      });
      /* Advisory, AFTER the drain and on what budget remains: the full
       * 4 MiB completion is the liveness proof; the probe only comments on
       * the budget and can stall without meaning anything is wrong. */
      try {
        const backupImage = await loadArtifact(PRESERVE_BACKUP_FILE);
        if (backupImage !== null) {
          const probeBytes = backupSlice(
            backupResultFromImage(backupImage),
            PROBE_OFFSET - READ_CHUNK,
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

  const delivered = postProcessDump(rawDump, detection.bankAddress, capture);
  const artifacts: Artifact[] = [
    named(PRESERVE_DUMP_POSTWRITE_FILE, rawDump),
    named(PRESERVE_DUMP_ORIGINAL_FILE, delivered),
  ];
  const shas = await shasOf(artifacts);
  const rawSha = shas.get(PRESERVE_DUMP_POSTWRITE_FILE) ?? '';
  const deliveredSha = shas.get(PRESERVE_DUMP_ORIGINAL_FILE) ?? '';
  const nextState: PreserveRunState = {
    ...state,
    rawDumpSha256: rawSha,
    deliveredSha256: deliveredSha,
    nextStep: nextStepAfter('drain'),
    steps: {
      ...state.steps,
      drain: stepRecord(
        startedAt,
        `raw dump ${String(rawDump.length)} B (sha256 ${rawSha}); delivered dump (the active ` +
          `bank swapped back from the backup) sha256 ${deliveredSha}`,
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
  const original = capture.subarray(0, stagedLength);

  const restored = await withSession(opener, async (device) => {
    assertLive(signal);
    const version = await gateVersion(device, state);
    reporter.log(`camera reports firmware ${version}`, 'detail');

    const now = await detectActiveSlot(device);
    if (now.bank !== detection.bank || now.bankAddress !== detection.bankAddress) {
      fail(
        `the active slot changed between the backup (${detection.bankAddress.toString(16)}) ` +
          `and now (${now.bankAddress.toString(16)}) — refusing to restore over a different ` +
          'bank than the one this run patched',
      );
    }

    const live = await readBankPrefix(
      device,
      detection.bank,
      stagedLength,
      'restore pre-check (the active bank as it lies)',
    );
    if (equalBytes(live, original)) {
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
    await commitToBank(device, detection.bank, original, {
      label: 'preserve restore',
      reporter,
      ...(signal === undefined ? {} : { signal }),
    });
    await resetDevice(device);
    return true;
  });

  const notes = restored
    ? `original bank content staged verbatim (${String(stagedLength)} B) and committed; reset sent`
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
    const read = await withSession(opener, (device) => {
      assertLive(signal);
      return verifyAgainstBackup(device, backup, reporter, READ_CHUNK, signal);
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

/**
 * The preserve wizard: three phases, each one runner task that runs its core
 * steps back-to-back, each completed phase re-issuing the downloadable run
 * file. The image is never picked — phase ① reads it from the camera's own
 * active slot and the plan prints from what the camera produced. Everything
 * risky is doubled: the gates refuse before the button lights, the writes
 * (the ② commit, the ③ restore) and any past-commit jump open a modal first,
 * and the phases that reset the camera treat the mid-phase disconnect as the
 * reset working, not as a device swap.
 */

import { useState, type ReactElement } from 'react';
import {
  Archive,
  Circle,
  CircleCheck,
  CircleX,
  Loader2,
  Lock,
  Play,
  Save,
  ShieldAlert,
} from 'lucide-react';
import { hexUp } from '@seek-fw/core';
import { Prose } from '@/components/Prose';
import { RunPanel } from '@/components/RunPanel';
import { Section } from '@/components/Section';
import { Alert } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { KeyValue } from '@/components/KeyValue';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from '@/components/ui/table';
import { Toolbar } from '@/components/ui/toolbar';
import { canRunPhase, gateReason } from '@/lib/preserve/gating';
import {
  PRESERVE_PHASES,
  RESETS_CAMERA,
  WRITES_FLASH,
  phaseMeta,
  stepMeta,
  type PreservePhaseId,
  type PreserveRunState,
  type PreserveStepId,
} from '@/lib/preserve/types';
import type { PreservePanelApi } from '@/hooks/usePreservePanel';

const RUN_ACCEPT = '.zip,application/zip';

function bytesHex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

/* ---- the plan lines, in words (the CLI's plan print, web-shaped) -------- */

type StagedForm = NonNullable<PreserveRunState['stagedForm']>;
type RestoreForm = NonNullable<PreserveRunState['restoreForm']>;
type DrainCapability = NonNullable<PreserveRunState['capability']>;

function stagedFormLine(form: StagedForm): string {
  switch (form) {
    case 'plain':
      return 'plain — the bank holds the image as stored; the wire payload is the conjugated capture';
    case 'xor-ks0':
      return 'patched plain XOR keystream (block 0) — the two-keystream cipher form';
    case 'xor-ks0-ksD':
      return 'patched plain XOR keystream (block 0) XOR keystream (block 1) — the FF build form';
  }
}

function restoreFormLine(form: RestoreForm): string {
  switch (form) {
    case 'capture-verbatim':
      return 'the backup capture, staged verbatim';
    case 'factory-staged':
      return 'the factory image in the staged form — the commit transform reproduces the slot bytes';
    case 'none':
      return (
        'REFUSED on this build — no staged form transforms back to the original slot bytes; ' +
        'the run ends with the delivered dump and the patch in place'
      );
  }
}

function capabilityLine(capability: DrainCapability): string {
  if (capability.wholePart) {
    return `whole part: yes — one widened-window arm, lossless read unit ${String(
      capability.losslessReadUnit,
    )} B`;
  }
  return `REFUSED on this build — ${capability.note}`;
}

export interface PreserveViewProps {
  readonly preserve: PreservePanelApi;
  readonly connected: boolean;
  readonly busy: boolean;
}

interface ConfirmRequest {
  readonly phase: PreservePhaseId;
  readonly jump: boolean;
}

export function PreserveView({ preserve, connected, busy }: PreserveViewProps): ReactElement {
  const [confirming, setConfirming] = useState<ConfirmRequest | null>(null);
  const { state } = preserve;
  const bankLine =
    state?.detection === undefined
      ? null
      : `bank ${state.detection.bank} at ${hexUp(state.detection.bankAddress, 8)}`;

  /* The loud case: the commit is not on record while the run stands past the
   * phase that would make it — so the phases that concern the patched part
   * are shut (or jump-only), and the list has to say WHY at length. The
   * likeliest cause is an interrupted commit on an already-patched camera;
   * the recovery is the commit step's own pre-check or, explicitly, the
   * jump. */
  const pastCommitLoud =
    state !== null &&
    state.nextStep !== 'done' &&
    state.steps.commit?.status !== 'done' &&
    (state.steps.backup?.status === 'done' || state.steps.patch?.status === 'done');

  return (
    <>
      <Section
        id="preserve-how"
        title="Preserve the firmware — and put the camera back"
        icon={<Archive />}
        description="Three phases. The image is read from the camera's own active slot — there is no firmware file to pick anywhere; a run belongs to one camera and derives everything from it."
      >
        <Alert tone="err">
          <p>
            <strong>This wizard writes the camera&apos;s ACTIVE boot slot.</strong> The commit
            (phase ②) and restore (phase ③) erase and reprogram the 64 KiB bank the camera is booted
            from. An interrupted write there has no bootable fallback — recovery needs an SPI
            programmer or SWD/J-Link. Run it on mains power, and keep every run file this page gives
            you.
          </p>
        </Alert>
        <Prose>
          <p>
            Each phase runs its steps back-to-back in one go and ends with the run file in your
            downloads — the run&apos;s only memory; keep the latest one. Phase ② and phase ③ RESET
            the camera mid-phase: it stays silent for roughly ten seconds while it boots, then
            re-enumerates as the same unit (vid/pid {hexUp(0x289d, 4)}:{hexUp(0x10, 4)}) and the
            wizard picks it up by itself — a slow middle is normal, not a failure. Do not replug
            anything during a phase, and do not let the machine sleep.
          </p>
        </Prose>
      </Section>

      <Section
        id="preserve-phases"
        tone="danger"
        title="The three phases"
        icon={<ShieldAlert />}
        aside={
          <Badge tone="err">
            <Archive />
            Writes to flash
          </Badge>
        }
        description={
          state === null
            ? 'Connect the camera, then start at phase ① — it creates the run and reads everything from it.'
            : `Run ${state.runId}${
                state.expectedVersion === undefined ? '' : ` — firmware ${state.expectedVersion}`
              }. Each completed phase updates the run file below.`
        }
      >
        {pastCommitLoud && (
          <Alert tone="err">
            <p>
              <strong>
                The commit is not on record for this run, so the phases past it are shut.
              </strong>{' '}
              The camera may already be running the patched image (an interrupted commit) or may not
              (the commit never started) — the run file cannot prove which. Do not run the dump or
              restore phases against a patched camera without the commit on record; the way forward
              is phase ②, whose commit pre-check reads the bank and refuses a blind replay. Only if
              that pre-check has already refused with <em>already holds the patched bytes</em> does
              the jump apply — and it goes through its own dialog.
            </p>
          </Alert>
        )}

        <ol className="space-y-4">
          {PRESERVE_PHASES.map((meta, index) => (
            <PhaseRow
              key={meta.id}
              index={index}
              meta={meta}
              state={state}
              preserve={preserve}
              connected={connected}
              busy={busy}
              onArm={(jump) => {
                setConfirming({ phase: meta.id, jump });
              }}
            />
          ))}
        </ol>
      </Section>

      <Section
        id="preserve-runfile"
        eyebrow="between phases"
        title="Run file — save, leave, come back"
        icon={<Save />}
        description="The run's only memory. It is rebuilt and downloaded after every completed phase (and after a failed or cancelled one, with the checkpoints it did record); keep the latest one. To resume — or to start at a non-first phase after an issue — load it here and the wizard continues from what it records."
      >
        {state !== null && preserve.lastSave !== null ? (
          <KeyValue
            rows={[
              ['Run', state.runId],
              ['File', `preserve-run-${state.runId}.zip`],
              [
                'Last saved',
                `after ${preserve.lastSave.afterStep} — ${preserve.lastSave.at} (${String(
                  preserve.lastSave.bytes,
                )} B)`,
              ],
              ['Next step', state.nextStep],
            ]}
          />
        ) : (
          <Prose>
            <p>No run is active. Phase ① creates one, or load a run file below.</p>
          </Prose>
        )}

        <Toolbar label="Run file actions">
          <Button
            variant="outline"
            disabled={state === null || busy}
            onClick={() => {
              preserve.saveAgain();
            }}
          >
            <Save />
            Save the run file again
          </Button>
          <Button
            id="preservePickRun"
            variant="default"
            disabled={busy}
            onClick={() => {
              pickRunFile((file) => {
                void preserve.loadRunFile(file);
              });
            }}
          >
            <Archive />
            Load a run file…
          </Button>
        </Toolbar>

        <RunPanel
          id="preserve-load"
          label="Resume"
          progress={preserve.loadReporter.progress}
          lines={preserve.loadReporter.lines}
          trimmed={preserve.loadReporter.trimmed}
        />
      </Section>

      {state !== null && state.nextStep === 'done' && (
        <VerifySummary
          state={state}
          busy={busy}
          onSave={() => {
            preserve.saveAgain();
          }}
        />
      )}

      <PhaseConfirm
        request={confirming}
        bankLine={bankLine}
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={(request) => {
          setConfirming(null);
          void preserve.runPhase(request.phase, request.jump ? { allowJump: true } : {});
        }}
      />
    </>
  );
}

/** Opens the run-file chooser. A hidden input keeps the picker out of the
 *  component tree — the only file this wizard ever reads is a run zip. */
function pickRunFile(onPick: (file: File) => void): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = RUN_ACCEPT;
  input.onchange = () => {
    const file = input.files?.[0];
    if (file !== undefined) onPick(file);
  };
  input.click();
}

/* ---- one phase row ------------------------------------------------------ */

interface PhaseRowProps {
  readonly index: number;
  readonly meta: (typeof PRESERVE_PHASES)[number];
  readonly state: PreserveRunState | null;
  readonly preserve: PreservePanelApi;
  readonly connected: boolean;
  readonly busy: boolean;
  /** Opens the danger dialog; `jump` marks the past-commit variant. */
  readonly onArm: (jump: boolean) => void;
}

function PhaseRow({
  index,
  meta,
  state,
  preserve,
  connected,
  busy,
  onArm,
}: PhaseRowProps): ReactElement {
  const phase = meta.id;
  const gate = canRunPhase({ state, phase, has: preserve.hasCheckpoint });
  const reporter = preserve.phaseReporters[phase];
  const active = preserve.activePhase === phase;
  const reason = gateReason(gate);
  const writes = meta.steps.some((step) => WRITES_FLASH.has(step));
  /* A phase needs the camera when any step it will actually run touches the
   * wire — everything does except a patch step resumed on its own. */
  const startStep = gate.startStep;
  const startIndex = startStep === null ? meta.steps.length : meta.steps.indexOf(startStep);
  const pending = meta.steps.slice(startIndex);
  const needsCamera = pending.some((step) => step !== 'patch');

  const phaseDone = startStep === null;
  const phaseFailed = pending.some((step) => state?.steps[step]?.status === 'failed');

  const run = (jump: boolean): void => {
    if (gate.confirm || jump) onArm(jump);
    else void preserve.runPhase(phase);
  };

  const Icon = active
    ? Loader2
    : phaseDone
      ? CircleCheck
      : phaseFailed
        ? CircleX
        : gate.ok || gate.jumpable
          ? Play
          : Lock;

  return (
    <li className="space-y-3 rounded-lg border border-border/70 bg-sunken/30 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          aria-hidden="true"
          className={
            active
              ? 'size-4 animate-spin text-primary'
              : phaseDone
                ? 'size-4 text-ok'
                : phaseFailed
                  ? 'size-4 text-destructive'
                  : 'size-4 text-muted-foreground'
          }
        />
        <span className="font-mono text-[0.78rem] text-muted-foreground tabular-nums">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="text-[0.95rem] font-semibold">{meta.label}</span>
        {state !== null && state.nextStep !== 'done' && startStep === state.nextStep && (
          <Badge tone="accent">Up next</Badge>
        )}
        {writes && (
          <Badge tone="err">
            <Archive />
            Writes to flash
          </Badge>
        )}
        {RESETS_CAMERA.has(phase) && <Badge tone="neutral">resets the camera mid-phase</Badge>}
        {phaseDone && <Badge tone="ok">done</Badge>}
        {phaseFailed && <Badge tone="err">failed — run it again</Badge>}
        <span className="ms-auto flex gap-2">
          {active ? (
            <Button variant="ghost" onClick={preserve.cancel}>
              Cancel
            </Button>
          ) : (
            <>
              {gate.ok && gate.jumpable && (
                <Button
                  variant="destructive"
                  disabled={busy || (needsCamera && !connected)}
                  onClick={() => {
                    onArm(true);
                  }}
                >
                  Skip the commit — start at the drain
                </Button>
              )}
              <Button
                variant={writes || gate.jumpable ? 'destructive' : 'outline'}
                disabled={!gate.ok && !gate.jumpable ? true : busy || (needsCamera && !connected)}
                onClick={() => {
                  run(gate.jumpable && !gate.ok);
                }}
              >
                {gate.jumpable && !gate.ok ? 'Run past the unrecorded commit' : 'Run phase'}
              </Button>
            </>
          )}
        </span>
      </div>

      <p className="text-[0.82rem] text-muted-foreground">{meta.description}</p>

      <StepChips steps={meta.steps} state={state} />

      {reason !== null && <p className="text-[0.78rem] text-warn">This phase {reason}.</p>}
      {gate.pastCommit && (
        <p className="text-[0.78rem] font-medium text-warn">
          Concerns the patched part while the commit is not on record — the camera may already be
          patched. See the warning at the top of this list.
        </p>
      )}
      {phase === 'restore-verify' &&
        gate.ok &&
        state !== null &&
        state.steps.commit?.status === 'done' &&
        state.steps.drain?.status !== 'done' && (
          <p className="text-[0.78rem] text-warn">
            The drain has not run — this phase restores the camera without delivering the whole-part
            dump. Run phase ② first unless the dump does not matter to you.
          </p>
        )}
      {active && writes && (
        <p className="text-[0.82rem] font-semibold text-destructive">
          Do not unplug the camera, and do not let the machine sleep, until this phase finishes.
        </p>
      )}

      {phase === 'read-build' && state?.patch !== undefined && <PlanFromState state={state} />}
      {phase === 'restore-verify' && <VerifyVerdict state={state} />}

      <RunPanel
        id={`preserve-phase-${phase}`}
        label={meta.label}
        tone={writes ? 'danger' : 'default'}
        progress={reporter.progress}
        lines={reporter.lines}
        trimmed={reporter.trimmed}
      />
    </li>
  );
}

/** The phase's core steps, each with its own status from the run state. */
function StepChips({
  steps,
  state,
}: {
  readonly steps: readonly PreserveStepId[];
  readonly state: PreserveRunState | null;
}): ReactElement {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {steps.map((step) => {
        const record = state?.steps[step];
        const Icon =
          record?.status === 'done' ? CircleCheck : record?.status === 'failed' ? CircleX : Circle;
        return (
          <li key={step} className="flex items-center gap-1.5 text-[0.8rem]">
            <Icon
              aria-hidden="true"
              className={
                record?.status === 'done'
                  ? 'size-3.5 text-ok'
                  : record?.status === 'failed'
                    ? 'size-3.5 text-destructive'
                    : 'size-3.5 text-muted-foreground'
              }
            />
            {stepMeta(step).label}
          </li>
        );
      })}
    </ul>
  );
}

/* ---- the plan, printed from what the camera produced -------------------- */

function PlanFromState({ state }: { readonly state: PreserveRunState }): ReactElement {
  const patch = state.patch;
  if (patch === undefined) {
    return <></>;
  }
  return (
    <div className="space-y-3 rounded-lg border border-border/70 bg-background/60 p-3">
      <p className="text-[0.82rem] font-semibold">The plan, from the camera&apos;s own bytes</p>
      <KeyValue
        rows={[
          [
            'Image source',
            state.slotReadShas === undefined
              ? 'the camera’s active slot'
              : `the camera’s active slot, two agreeing reads (sha256 ${state.slotReadShas[0]})`,
          ],
          [
            'Build',
            `${state.buildLabel ?? state.buildId ?? '?'} — family ${state.buildFamily ?? '?'}`,
          ],
          ['Firmware version', state.expectedVersion ?? '?'],
          ['Factory plaintext sha256', state.imageSha256 ?? '?'],
          ['Patched sha256', patch.patchedSha256],
          ...(patch.diffCount === undefined
            ? []
            : [['Bytes that move on the part', String(patch.diffCount)] as const]),
          [
            'Staged length',
            `${String(patch.stagedLength)} B in ${String(patch.chunkCount)} chunks`,
          ],
          ['Rebalance word', hexUp(patch.rebalanceWord)],
          ...(state.stagedForm === undefined
            ? []
            : [['Staged form', stagedFormLine(state.stagedForm)] as const]),
          ...(state.route === 'recovery-only' && state.routeNote != null
            ? ([['Commit route', state.routeNote]] as const)
            : []),
          ...(state.restoreForm === undefined
            ? []
            : [['Restore', restoreFormLine(state.restoreForm)] as const]),
          ...(state.capability === undefined
            ? []
            : [['Drain', capabilityLine(state.capability)] as const]),
        ]}
      />
      <Table>
        <TableCaption>The exact bytes the patch moves</TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead className="w-[40%]">Site</TableHead>
            <TableHead>Offset</TableHead>
            <TableHead>Before</TableHead>
            <TableHead>After</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {patch.sites.map((site) => (
            <TableRow key={site.offset}>
              <TableRowHeader>{site.name}</TableRowHeader>
              <TableCell label="Offset">
                <code>{hexUp(site.offset)}</code>
              </TableCell>
              <TableCell label="Before">
                <code>{bytesHex(site.before)}</code>
              </TableCell>
              <TableCell label="After">
                <code>{bytesHex(site.after)}</code>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <Prose>
        <p>
          On the part these bytes land as the XOR-difference against the bank capture (the keystream
          cancels), so the camera&apos;s decrypted image changes by exactly this diff and nothing
          else. Nothing is written until phase ② runs.
        </p>
      </Prose>
    </div>
  );
}

/* ---- phase ③'s tail: the verify verdict, unmistakably -------------------- */

function VerifyVerdict({
  state,
}: {
  readonly state: PreserveRunState | null;
}): ReactElement | null {
  if (state === null) return null;
  const verify = state.verify;
  if (verify !== undefined) {
    return (
      <Alert tone="ok">
        <p>
          <strong>VERIFY: MATCH.</strong> A fresh boot re-read {String(verify.windowsRead)}/31
          windows at {String(verify.diffBytes)} differing byte(s)
          {verify.badWindows.length > 0 ? ` (short windows: ${verify.badWindows.join(',')})` : ''} —
          the camera&apos;s flash is byte-identical to the backup taken before the first write.
        </p>
      </Alert>
    );
  }
  const failed = state.steps.verify;
  if (failed?.status === 'failed') {
    return (
      <Alert tone="err">
        <p>
          <strong>VERIFY: NO MATCH.</strong> The re-read found differences against the backup —{' '}
          {failed.error ?? 'unknown reason'}
        </p>
      </Alert>
    );
  }
  return null;
}

/* ---- the danger dialog -------------------------------------------------- */

interface PhaseConfirmProps {
  readonly request: ConfirmRequest | null;
  readonly bankLine: string | null;
  readonly onConfirm: (request: ConfirmRequest) => void;
  readonly onCancel: () => void;
}

function PhaseConfirm({ request, bankLine, onConfirm, onCancel }: PhaseConfirmProps): ReactElement {
  const label = request === null ? '' : phaseMeta(request.phase).label;
  const writing = request !== null && request.phase === 'patch-dump' && !request.jump;
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent aria-describedby="preserve-confirm-what">
        <AlertDialogTitle>
          {request?.jump === true
            ? `${label} — jump past the unrecorded commit?`
            : `${label} — write to ${bankLine ?? 'the active bank'}?`}
        </AlertDialogTitle>
        <AlertDialogDescription id="preserve-confirm-what" className="space-y-2">
          {request?.jump === true ? (
            <>
              <span className="block">
                THE COMMIT IS NOT ON RECORD for this run, and you are asserting that the writes
                landed without their checkpoints: the phase starts past the commit instead of
                replaying it. The steps&apos; own checks still run — the version read, the bank
                pre-checks — and a wrong guess costs a wasted drain, not a bricked camera.
              </span>
              <span className="block">
                Do not unplug the camera, and do not let the machine sleep, until the phase
                finishes.
              </span>
            </>
          ) : (
            <>
              <span className="block">
                {writing
                  ? 'The commit is the irreversible write: it erases and reprograms the 64 KiB bank the camera is booted from. An interrupted write there has no bootable fallback — recovery needs an SPI programmer or SWD/J-Link. The drain that follows only reads.'
                  : 'This restores the original bank content over the active bank — the other write of the run. An interrupted write there has no bootable fallback — recovery needs an SPI programmer or SWD/J-Link.'}
              </span>
              <span className="block">
                Do not unplug the camera, and do not let the machine sleep, until the phase
                finishes. The camera will RESET mid-phase and re-enumerate — the wizard picks it up
                by itself.
              </span>
            </>
          )}
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (request !== null) onConfirm(request);
            }}
          >
            {request?.jump === true ? 'Yes — jump past the commit' : 'Yes — write to the camera'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/* ---- the final screen --------------------------------------------------- */

interface VerifySummaryProps {
  readonly state: PreserveRunState;
  readonly busy: boolean;
  readonly onSave: () => void;
}

function VerifySummary({ state, busy, onSave }: VerifySummaryProps): ReactElement {
  const match = state.deliveredSha256 === state.imageSha256;
  return (
    <Section
      id="preserve-done"
      tone="ok"
      title="Run complete — the proof"
      icon={<CircleCheck />}
      description="The delivered image is the camera's original flash content with nothing left behind; the raw dump is the part as the commit left it."
    >
      <KeyValue
        rows={[
          [
            'Delivered image',
            <>
              {state.deliveredSha256 ?? 'not produced'}
              {state.deliveredSha256 !== undefined && (
                <Badge tone={match ? 'ok' : 'err'}>
                  {match ? 'matches the as-booted image' : 'DOES NOT match the as-booted image'}
                </Badge>
              )}
            </>,
          ],
          ['As-booted image (read from the camera)', state.imageSha256 ?? 'not produced'],
          [
            'Raw post-commit part',
            <>
              {state.rawDumpSha256 ?? 'not produced'}
              {state.rawDumpSha256 !== undefined && (
                <Badge tone="neutral">recorded, not expected to match the image</Badge>
              )}
            </>,
          ],
          [
            'Verify',
            state.verify === undefined
              ? (state.steps.verify?.notes ?? null)
              : `${String(state.verify.windowsRead)}/31 windows re-read at ` +
                `${String(state.verify.diffBytes)} differing byte(s)` +
                (state.verify.badWindows.length > 0
                  ? ` (short windows: ${state.verify.badWindows.join(',')})`
                  : ''),
          ],
        ]}
      />
      <Toolbar label="Archive actions">
        <Button variant="default" disabled={busy} onClick={onSave}>
          <Save />
          Download the full archive (run file)
        </Button>
      </Toolbar>
    </Section>
  );
}

/**
 * The preserve wizard: pick the image, read the plan, then walk six gated
 * steps — each one a runner task of its own, each completed step re-issuing
 * the downloadable run file. Everything risky is doubled: the gates refuse
 * before the button lights, and the writes (commit, restore) and any step
 * that acts past an unrecorded commit open a modal first.
 */

import { useState, type ReactElement } from 'react';
import {
  Archive,
  ArchiveRestore,
  Circle,
  CircleCheck,
  CircleX,
  FileUp,
  Loader2,
  Lock,
  Save,
} from 'lucide-react';
import { hexUp } from '@seek-fw/core';
import { FilePickerButton } from '@/components/FilePickerButton';
import { Prose } from '@/components/Prose';
import { Readiness } from '@/components/Readiness';
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
import { canRunStep, gateReason } from '@/lib/preserve/gating';
import {
  PRESERVE_STEPS,
  WRITES_FLASH,
  type PreserveRunState,
  type PreserveStepId,
} from '@/lib/preserve/types';
import type { PreservePanelApi } from '@/hooks/usePreservePanel';

const IMAGE_ACCEPT = '.bin,.img,.rom,application/octet-stream';
const RUN_ACCEPT = '.zip,application/zip';

function bytesHex(bytes: readonly number[]): string {
  return bytes.map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
}

export interface PreserveViewProps {
  readonly preserve: PreservePanelApi;
  readonly connected: boolean;
  readonly busy: boolean;
}

export function PreserveView({ preserve, connected, busy }: PreserveViewProps): ReactElement {
  const [confirming, setConfirming] = useState<PreserveStepId | null>(null);
  const { state, plan } = preserve;
  const bankLine =
    state?.detection === undefined
      ? null
      : `bank ${state.detection.bank} at ${hexUp(state.detection.bankAddress, 8)}`;

  /* The loud case: the commit is not on record, so every step that concerns
   * the patched part is shut — and the list has to say WHY at length, because
   * the likeliest cause is an interrupted commit on an already-patched
   * camera. The recovery is the commit step's own pre-check: run (or resume
   * at) the commit. */
  const pastCommitLoud =
    state !== null &&
    state.nextStep !== 'done' &&
    state.steps.commit?.status !== 'done' &&
    PRESERVE_STEPS.some(
      (meta) => meta.id === 'drain' || meta.id === 'restore' || meta.id === 'verify',
    );

  return (
    <>
      <Section
        id="preserve-plan"
        step="1"
        title="Pick the firmware image"
        icon={<FileUp />}
        description="The decrypted factory plaintext of the build the camera runs — the same kind of file the decrypt view writes. The plan is built offline; no camera is touched until a step runs."
      >
        <Alert tone="err">
          <p>
            <strong>This wizard writes the camera&apos;s ACTIVE boot slot.</strong> The commit and
            restore steps erase and reprogram the 64 KiB bank the camera is booted from. An
            interrupted write there has no bootable fallback — recovery needs an SPI programmer or
            SWD/J-Link. Run it on mains power, and keep every run file this page gives you.
          </p>
        </Alert>

        <Toolbar label="Image actions">
          <FilePickerButton
            id="preservePickImage"
            variant="default"
            icon={<FileUp />}
            label="Choose plaintext image…"
            accept={IMAGE_ACCEPT}
            disabled={busy}
            onPick={(file) => {
              void preserve.pickImage(file);
            }}
          />
          {preserve.resumeNeedsImage && (
            <FilePickerButton
              id="preservePickImageResume"
              variant="outline"
              icon={<FileUp />}
              label="Re-attach the run's image…"
              accept={IMAGE_ACCEPT}
              disabled={busy}
              onPick={(file) => {
                void preserve.pickImage(file);
              }}
            />
          )}
        </Toolbar>

        <RunPanel
          id="preserve-plan"
          label="Plan"
          progress={preserve.planReporter.progress}
          lines={preserve.planReporter.lines}
          trimmed={preserve.planReporter.trimmed}
        />

        {plan !== null && <PatchPlan plan={plan} />}

        {plan !== null && (
          <Toolbar label="Plan actions">
            <Button
              variant="default"
              disabled={busy}
              onClick={() => {
                preserve.confirmPlan();
              }}
            >
              <Archive />
              Create the run file
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                preserve.dismissPlan();
              }}
            >
              Discard the plan
            </Button>
          </Toolbar>
        )}
      </Section>

      {state !== null && (
        <Section
          id="preserve-camera"
          step="2"
          title="Camera"
          icon={<ArchiveRestore />}
          description="Connect the camera above, then walk the steps. The run: "
        >
          <Readiness
            steps={[
              { label: 'Run created', done: true },
              {
                label: "Run's image attached",
                done: preserve.hasImage || state.steps.patch?.status === 'done',
                blocked: preserve.resumeNeedsImage,
              },
              { label: 'Camera connected', done: connected },
            ]}
          />
          <Prose>
            <p>
              A fresh USB session is opened for each step and closed when it ends. The drain step
              resets the camera so it boots the patched image, and after a reset the camera is
              silent for roughly ten seconds — the wizard says <em>camera rebooting…</em> and
              retries by itself; a slow first open is normal, not a failure. Do not replug during
              the commit or restore steps.
            </p>
          </Prose>
        </Section>
      )}

      {state !== null && (
        <Section
          id="preserve-steps"
          step="3"
          tone="danger"
          title="The six steps"
          icon={<Archive />}
          aside={
            <Badge tone="err">
              <Archive />
              Writes to flash
            </Badge>
          }
          description={`Run ${state.runId} — firmware ${state.expectedVersion}. Each completed step updates the run file below.`}
        >
          {pastCommitLoud && (
            <Alert tone="err">
              <p>
                <strong>
                  The commit is not on record for this run, so the steps past it are shut.
                </strong>{' '}
                The camera may already be running the patched image (an interrupted commit) or may
                not (the commit never started) — the run file cannot prove which. Do not run the
                drain or restore steps against a patched camera without the commit on record; the
                way forward is the commit step, whose pre-check reads the bank and refuses a blind
                replay. Run (or resume at) the commit.
              </p>
            </Alert>
          )}

          <ol className="space-y-3">
            {PRESERVE_STEPS.map((meta, index) => (
              <StepRow
                key={meta.id}
                index={index}
                meta={meta}
                state={state}
                preserve={preserve}
                connected={connected}
                busy={busy}
                onArm={() => {
                  setConfirming(meta.id);
                }}
              />
            ))}
          </ol>
        </Section>
      )}

      <Section
        id="preserve-runfile"
        eyebrow="between steps"
        title="Run file — save, leave, come back"
        icon={<Save />}
        description="The run's only memory. It is rebuilt and downloaded after every completed step; keep the latest one. To resume — or to start at a non-first step after an issue — load it here and the wizard continues from what it records."
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
            <p>No run is active. Create one above, or load a run file below.</p>
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
          <FilePickerButton
            id="preservePickRun"
            variant="default"
            icon={<ArchiveRestore />}
            label="Load a run file…"
            accept={RUN_ACCEPT}
            disabled={busy}
            onPick={(file) => {
              void preserve.loadRunFile(file);
            }}
          />
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

      <StepConfirm
        step={confirming}
        bankLine={bankLine}
        onCancel={() => {
          setConfirming(null);
        }}
        onConfirm={() => {
          const step = confirming;
          setConfirming(null);
          if (step !== null) void preserve.runStep(step);
        }}
      />
    </>
  );
}

/* ---- one row of the step list ----------------------------------------- */

interface StepRowProps {
  readonly index: number;
  readonly meta: (typeof PRESERVE_STEPS)[number];
  readonly state: PreserveRunState;
  readonly preserve: PreservePanelApi;
  readonly connected: boolean;
  readonly busy: boolean;
  /** Opens the danger dialog. Only armed steps (writes, past-commit) reach it. */
  readonly onArm: () => void;
}

function StepRow({
  index,
  meta,
  state,
  preserve,
  connected,
  busy,
  onArm,
}: StepRowProps): ReactElement {
  const step = meta.id;
  const gate = canRunStep({
    state,
    step,
    has: preserve.hasCheckpoint,
    hasPlain: preserve.hasImage,
  });
  const record = state.steps[step];
  const reporter = preserve.stepReporters[step];
  const active = preserve.activeStep === step;
  const writes = WRITES_FLASH.has(step);
  const offline = step === 'patch';
  const reason = gateReason(gate);
  const needsDialog = gate.confirm;

  const Icon = active
    ? Loader2
    : record?.status === 'done'
      ? CircleCheck
      : record?.status === 'failed'
        ? CircleX
        : gate.ok
          ? Circle
          : Lock;

  return (
    <li className="space-y-2 rounded-lg border border-border/70 bg-sunken/30 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Icon
          aria-hidden="true"
          className={
            active
              ? 'size-4 animate-spin text-primary'
              : record?.status === 'done'
                ? 'size-4 text-ok'
                : record?.status === 'failed'
                  ? 'size-4 text-destructive'
                  : 'size-4 text-muted-foreground'
          }
        />
        <span className="font-mono text-[0.78rem] text-muted-foreground tabular-nums">
          {String(index + 1).padStart(2, '0')}
        </span>
        <span className="text-[0.9rem] font-semibold">{meta.label}</span>
        {state.nextStep === step && <Badge tone="accent">Up next</Badge>}
        {writes && (
          <Badge tone="err">
            <Archive />
            Writes to flash
          </Badge>
        )}
        {record?.status === 'failed' && <Badge tone="err">failed — run it again</Badge>}
        <span className="ms-auto">
          {active ? (
            <Button variant="ghost" onClick={preserve.cancel}>
              Cancel
            </Button>
          ) : (
            <Button
              variant={writes ? 'destructive' : 'outline'}
              disabled={!gate.ok || busy || (!offline && !connected)}
              onClick={needsDialog ? onArm : () => void preserve.runStep(step)}
            >
              {offline ? 'Run offline' : 'Run step'}
            </Button>
          )}
        </span>
      </div>

      <p className="text-[0.82rem] text-muted-foreground">{meta.description}</p>

      {reason !== null && <p className="text-[0.78rem] text-warn">This step {reason}.</p>}
      {gate.pastCommit && (
        <p className="text-[0.78rem] font-medium text-warn">
          Concerns the patched part while the commit is not on record — the camera may already be
          patched. See the warning at the top of this list.
        </p>
      )}
      {record?.status === 'failed' && record.error !== undefined && (
        <p className="font-mono text-[0.76rem] text-destructive [overflow-wrap:anywhere]">
          {record.error}
        </p>
      )}
      {active && writes && (
        <p className="text-[0.82rem] font-semibold text-destructive">
          Do not unplug the camera, and do not let the machine sleep, until this step finishes.
        </p>
      )}

      <RunPanel
        id={`preserve-${step}`}
        label={meta.label}
        tone={writes ? 'danger' : 'default'}
        progress={reporter.progress}
        lines={reporter.lines}
        trimmed={reporter.trimmed}
      />
    </li>
  );
}

/* ---- the patch plan ---------------------------------------------------- */

interface PatchPlanProps {
  readonly plan: NonNullable<PreservePanelApi['plan']>;
}

function PatchPlan({ plan }: PatchPlanProps): ReactElement {
  const { patch, state, fileName } = plan;
  return (
    <div className="space-y-3">
      <KeyValue
        rows={[
          ['Image', fileName],
          ['Firmware version', state.expectedVersion],
          ['Image sha256', state.imageSha256],
          ['Patched sha256', patch.patchedSha256],
          [
            'Staged length',
            `${String(patch.stagedLength)} B in ${String(patch.chunkCount)} chunks`,
          ],
          ['Rebalance word', hexUp(patch.rebalanceWord)],
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
          else. Nothing is written until a step runs.
        </p>
      </Prose>
    </div>
  );
}

/* ---- the danger dialog -------------------------------------------------- */

interface StepConfirmProps {
  readonly step: PreserveStepId | null;
  readonly bankLine: string | null;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

function StepConfirm({ step, bankLine, onConfirm, onCancel }: StepConfirmProps): ReactElement {
  const label = step === null ? '' : (PRESERVE_STEPS.find((meta) => meta.id === step)?.label ?? '');
  return (
    <AlertDialog
      open={step !== null}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <AlertDialogContent aria-describedby="preserve-confirm-what">
        <AlertDialogTitle>
          {`${label} — write to ${bankLine ?? 'the active bank'}?`}
        </AlertDialogTitle>
        <AlertDialogDescription id="preserve-confirm-what" className="space-y-2">
          <span className="block">
            This erases and reprograms the 64 KiB bank the camera is booted from. An interrupted
            write there has no bootable fallback — recovery needs an SPI programmer or SWD/J-Link.
          </span>
          <span className="block">
            Do not unplug the camera, and do not let the machine sleep, until the step finishes.
          </span>
        </AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Yes — write to the camera</AlertDialogAction>
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
          ['As-booted image (the run’s input)', state.imageSha256],
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

/**
 * The wizard on the page: the step list renders the shared gates, the
 * past-commit warning is loud, the write steps and the past-commit steps go
 * through the dialog, and the read steps run straight from the click.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PreserveView } from './PreserveView';
import type { PreservePanelApi, PreservePlanView, RunFileSave } from '@/hooks/usePreservePanel';
import { useReporter, type ReporterHandle } from '@/hooks/useReporter';
import type { CheckpointName, PreserveRunState, PreserveStepId } from '@/lib/preserve/types';
import { buttonByText, render, renderHook } from '@/test-helpers';

function eightReporters(): readonly ReporterHandle[] {
  const { result } = renderHook(() => Array.from({ length: 8 }, () => useReporter()));
  return result.current;
}

function runState(
  steps: Partial<Record<PreserveStepId, 'done' | 'failed'>> = {},
): PreserveRunState {
  const step = (status: 'done' | 'failed' | undefined) =>
    status === undefined ? undefined : { status };
  const detection = steps.backup === 'done';
  return {
    version: 1,
    runId: 'preserve-render-test',
    buildFamily: 'v1-2014',
    imageSha256: 'a'.repeat(64),
    expectedVersion: '1.3.0.0',
    createdAt: '2026-10-01T00:00:00Z',
    nextStep: 'backup',
    patch: {
      sites: [],
      rebalanceWord: 0x30006240,
      stagedLength: 0x4000,
      chunkCount: 256,
      patchedSha256: 'b'.repeat(64),
    },
    ...(detection
      ? {
          detection: {
            cfgHex: 'ff',
            cfg0: 0,
            blank: true,
            bank: 'a',
            bankAddress: 0x14050000,
            bankMode: 7,
            verdict: 'blank -> bank A',
          },
        }
      : {}),
    steps: {
      backup: step(steps.backup),
      patch: step(steps.patch),
      commit: step(steps.commit),
      drain: step(steps.drain),
      restore: step(steps.restore),
      verify: step(steps.verify),
    },
  } as unknown as PreserveRunState;
}

const HAS_CAPTURE = (name: string): boolean =>
  name === 'preserve_bank_capture.bin' || name === 'preserve_backup_windows.bin';

interface Scenario {
  readonly state: PreserveRunState | null;
  readonly plan?: PreservePlanView | null;
  readonly connected: boolean;
  readonly busy?: boolean;
  readonly has?: (name: string) => boolean;
  readonly hasImage?: boolean;
  readonly activeStep?: PreserveStepId | null;
  readonly lastSave?: RunFileSave | null;
  readonly resumeNeedsImage?: boolean;
}

function preserveStub(scenario: Scenario, ran: PreserveStepId[]): PreservePanelApi {
  const reps = eightReporters();
  const [plan, load, backup, patch, commit, drain, restore, verify] = reps;
  return {
    planReporter: plan!,
    loadReporter: load!,
    stepReporters: {
      backup: backup!,
      patch: patch!,
      commit: commit!,
      drain: drain!,
      restore: restore!,
      verify: verify!,
    },
    plan: scenario.plan ?? null,
    state: scenario.state,
    confirmed: scenario.state !== null,
    hasImage: scenario.hasImage !== false,
    resumeNeedsImage: scenario.resumeNeedsImage === true,
    hasCheckpoint: (name: CheckpointName): boolean => (scenario.has ?? HAS_CAPTURE)(name),
    activeStep: scenario.activeStep ?? null,
    planning: false,
    loading: false,
    lastSave: scenario.lastSave ?? null,
    pickImage: (): Promise<void> => Promise.resolve(),
    confirmPlan: () => undefined,
    dismissPlan: () => undefined,
    loadRunFile: (): Promise<void> => Promise.resolve(),
    runStep: (step: PreserveStepId): Promise<void> => {
      ran.push(step);
      return Promise.resolve();
    },
    cancel: () => undefined,
    saveAgain: () => undefined,
  };
}

function renderPreserve(scenario: Scenario, ran: PreserveStepId[] = []) {
  return render(
    <PreserveView
      preserve={preserveStub(scenario, ran)}
      connected={scenario.connected}
      busy={scenario.busy === true}
    />,
  );
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('[role="alertdialog"]')) node.remove();
});

describe('PreserveView', () => {
  it('before a run exists there is an image picker and a resume picker, but no steps', () => {
    const { container, unmount } = renderPreserve({ state: null, connected: false });

    expect(buttonByText(container, 'Choose plaintext image…')).toBeTruthy();
    expect(buttonByText(container, 'Load a run file…')).toBeTruthy();
    expect(buttonByText(container, 'Save the run file again').disabled).toBe(true);
    expect(container.textContent).not.toContain('Up next');
    /* The honest risk is on the page before anything else is. */
    expect(container.textContent).toContain('ACTIVE boot slot');
    unmount();
  });

  it('a fresh run lists all six steps, gated; reads warn about the unrecorded commit', () => {
    const { container, unmount } = renderPreserve({
      state: runState(),
      connected: true,
    });

    /* Five "Run step" buttons (the patch row reads "Run offline"); on a
     * fresh run core's order arms exactly one of them — the backup. */
    const buttons = [...container.querySelectorAll('button')]
      .filter((button) => button.textContent.trim() === 'Run step')
      .map((button) => button.disabled);
    expect(buttons).toHaveLength(5);
    expect(buttons.filter((disabled) => !disabled)).toHaveLength(1);
    expect(buttons.filter((disabled) => disabled)).toHaveLength(4);

    expect(container.textContent).toContain('The commit is not on record');
    expect(container.textContent).toContain('Up next');
    unmount();
  });

  it('a write step runs from its dialog, and cancelling runs nothing', () => {
    const ran: PreserveStepId[] = [];
    const state = runState({ backup: 'done', patch: 'done' });
    const view = renderPreserve({ state, connected: true, has: HAS_CAPTURE }, ran);

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();

    /* The commit row is the armed write: its button opens the dialog. */
    const row = [...view.container.querySelectorAll('li')].find((node) =>
      node.textContent.includes('Commit the patch'),
    );
    const commitButton = [...(row?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent.trim() === 'Run step',
    );
    expect(commitButton?.disabled).toBe(false);
    act(() => {
      commitButton?.click();
    });
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('write to bank a at 0x14050000');
    act(() => {
      const cancel = [...(dialog?.querySelectorAll('button') ?? [])].find(
        (button) => button.textContent.trim() === 'Cancel',
      );
      cancel?.click();
    });
    expect(ran).toEqual([]);
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();

    act(() => {
      commitButton?.click();
    });
    act(() => {
      const confirm = [
        ...(document.body.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? []),
      ].find((button) => button.textContent.trim() === 'Yes — write to the camera');
      confirm?.click();
    });
    expect(ran).toEqual(['commit']);
    view.unmount();
  });

  it('a read step past the commit is refused, loudly, on the page', () => {
    const ran: PreserveStepId[] = [];
    const view = renderPreserve({ state: runState(), connected: true, has: HAS_CAPTURE }, ran);

    expect(view.container.textContent).toContain(
      'The commit is not on record for this run, so the steps past it are shut',
    );
    const row = [...view.container.querySelectorAll('li')].find((node) =>
      node.textContent.includes('Dump the whole part'),
    );
    const drainButton = [...(row?.querySelectorAll('button') ?? [])].find(
      (button) => button.textContent.trim() === 'Run step',
    );
    expect(drainButton?.disabled).toBe(true);
    expect(row?.textContent).toContain('the camera may already be patched');
    expect(ran).toEqual([]);
    view.unmount();
  });

  it('a resumed run without the image shows the re-attach picker and the note', () => {
    const { container, unmount } = renderPreserve({
      state: runState({ backup: 'done' }),
      connected: false,
      resumeNeedsImage: true,
      has: () => false,
    });

    expect(buttonByText(container, "Re-attach the run's image…")).toBeTruthy();
    expect(container.textContent).toContain("Run's image attached");
    /* No camera: even the gated steps stay dark. */
    for (const button of [...container.querySelectorAll('button')].filter(
      (node) => node.textContent.trim() === 'Run step',
    )) {
      expect(button.disabled).toBe(true);
    }
    unmount();
  });

  it('a finished run shows the sha pairs and the archive download', () => {
    const full = {
      ...runState({
        backup: 'done',
        patch: 'done',
        commit: 'done',
        drain: 'done',
        restore: 'done',
        verify: 'done',
      }),
      nextStep: 'done',
      deliveredSha256: 'a'.repeat(64),
      rawDumpSha256: 'c'.repeat(64),
    } as unknown as PreserveRunState;
    const { container, unmount } = renderPreserve({ state: full, connected: true });

    expect(container.textContent).toContain('matches the as-booted image');
    expect(container.textContent).toContain('Raw post-commit part');
    expect(buttonByText(container, 'Download the full archive (run file)')).toBeTruthy();
    unmount();
  });
});

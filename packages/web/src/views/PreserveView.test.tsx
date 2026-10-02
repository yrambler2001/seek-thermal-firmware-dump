/**
 * The wizard on the page: three phases, the image picked NOWHERE (the plan
 * prints from what the camera produced), the commit behind its danger
 * dialog, the past-commit jump behind its own, and the verify verdict shown
 * unmistakably on the last row.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PreserveView } from './PreserveView';
import type {
  PreservePanelApi,
  PreservePhaseRunOptions,
  RunFileSave,
} from '@/hooks/usePreservePanel';
import { useReporter, type ReporterHandle } from '@/hooks/useReporter';
import type {
  CheckpointName,
  PreservePhaseId,
  PreserveRunState,
  PreserveStepId,
} from '@/lib/preserve/types';
import { buttonByText, render, renderHook } from '@/test-helpers';

function fourReporters(): readonly ReporterHandle[] {
  const { result } = renderHook(() => Array.from({ length: 4 }, () => useReporter()));
  return result.current;
}

function runState(
  steps: Partial<Record<PreserveStepId, 'done' | 'failed'>> = {},
  extra: Partial<PreserveRunState> = {},
): PreserveRunState {
  const step = (status: 'done' | 'failed' | undefined) =>
    status === undefined ? undefined : { status };
  const detection = steps.backup === 'done';
  return {
    version: 2,
    runId: 'preserve-render-test',
    imageSource: 'device',
    slotReadShas: ['4'.repeat(64), '5'.repeat(64)],
    buildFamily: 'v1-2014',
    buildId: 'compact-1.3.0.8-8hz',
    buildLabel: 'Compact 1.3.0.8 (8 Hz)',
    imageSha256: 'a'.repeat(64),
    expectedVersion: '1.3.0.8',
    createdAt: '2026-10-01T00:00:00Z',
    nextStep: 'backup',
    stagedForm: 'plain',
    restoreForm: 'capture-verbatim',
    route: 'active-bank',
    patch: {
      sites: [{ name: 'mov.w', offset: 0x3db4, before: [1, 2, 3, 4], after: [5, 6, 7, 8] }],
      rebalanceWord: 0x30006240,
      stagedLength: 0x4000,
      chunkCount: 256,
      patchedSha256: 'b'.repeat(64),
      diffCount: 10,
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
    ...extra,
  } as unknown as PreserveRunState;
}

const HAS_ALL = (_name: CheckpointName): boolean => true;

interface Scenario {
  readonly state: PreserveRunState | null;
  readonly connected: boolean;
  readonly busy?: boolean;
  readonly has?: (name: CheckpointName) => boolean;
  readonly activePhase?: PreservePhaseId | null;
  readonly lastSave?: RunFileSave | null;
}

function preserveStub(scenario: Scenario, ran: [PreservePhaseId, PreservePhaseRunOptions][]) {
  const reps = fourReporters();
  const [load, first, second, third] = reps;
  return {
    loadReporter: load!,
    phaseReporters: { 'read-build': first!, 'patch-dump': second!, 'restore-verify': third! },
    state: scenario.state,
    hasCheckpoint: (name: CheckpointName): boolean => (scenario.has ?? HAS_ALL)(name),
    activePhase: scenario.activePhase ?? null,
    loading: false,
    lastSave: scenario.lastSave ?? null,
    runPhase: (phase: PreservePhaseId, options: PreservePhaseRunOptions = {}): Promise<void> => {
      ran.push([phase, options]);
      return Promise.resolve();
    },
    cancel: () => undefined,
    saveAgain: () => undefined,
    loadRunFile: (): Promise<void> => Promise.resolve(),
  } satisfies PreservePanelApi;
}

function renderPreserve(
  scenario: Scenario,
  ran: [PreservePhaseId, PreservePhaseRunOptions][] = [],
) {
  return render(
    <PreserveView
      preserve={preserveStub(scenario, ran)}
      connected={scenario.connected}
      busy={scenario.busy === true}
    />,
  );
}

function phaseRow(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll('li')].find((node) =>
    node.textContent.includes(label),
  );
  if (row === undefined) throw new Error(`no phase row labelled ${label}`);
  return row;
}

function runButton(row: HTMLElement): HTMLButtonElement {
  const match = [...row.querySelectorAll('button')].find((button) =>
    ['Run phase', 'Run past the unrecorded commit'].includes(button.textContent.trim()),
  );
  if (match === undefined) throw new Error(`no run button on ${row.textContent.slice(0, 40)}`);
  return match;
}

function dialogButton(text: string): HTMLButtonElement | undefined {
  return [
    ...(document.body.querySelector('[role="alertdialog"]')?.querySelectorAll('button') ?? []),
  ].find((button) => button.textContent.trim() === text);
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('[role="alertdialog"]')) node.remove();
});

describe('PreserveView', () => {
  it('the image picker is gone — the wizard never asks for a firmware file', () => {
    const { container, unmount } = renderPreserve({ state: null, connected: false });
    expect(container.textContent).not.toContain('Choose plaintext image');
    expect(container.textContent).not.toContain('Re-attach');
    expect(container.textContent).toContain('no firmware file to pick');
    expect(container.textContent).toContain('ACTIVE boot slot');
    unmount();
  });

  it('before a run: phase ① creates it, the later phases are dark, the resume picker is there', () => {
    const { container, unmount } = renderPreserve({ state: null, connected: true });
    expect(runButton(phaseRow(container, 'Read & build')).disabled).toBe(false);
    expect(runButton(phaseRow(container, 'Patch & dump')).disabled).toBe(true);
    expect(runButton(phaseRow(container, 'Restore & verify')).disabled).toBe(true);
    expect(buttonByText(container, 'Load a run file…')).toBeTruthy();
    expect(buttonByText(container, 'Save the run file again').disabled).toBe(true);
    unmount();
  });

  it('a fresh run shows no past-commit alarm — the run is merely in its normal order', () => {
    const { container, unmount } = renderPreserve({ state: runState(), connected: true });
    expect(container.textContent).not.toContain('The commit is not on record');
    expect(phaseRow(container, 'Read & build').textContent).toContain('Up next');
    unmount();
  });

  it('phase ② runs from its dialog, which names the commit as the irreversible write', () => {
    const ran: [PreservePhaseId, PreservePhaseRunOptions][] = [];
    const state = runState({ backup: 'done', patch: 'done' }, { nextStep: 'commit' });
    const view = renderPreserve({ state, connected: true }, ran);

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    const row = phaseRow(view.container, 'Patch & dump');
    expect(row.textContent).toContain('Up next');
    act(() => {
      runButton(row).click();
    });
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('write to bank a at 0x14050000');
    expect(dialog?.textContent).toContain('The commit is the irreversible write');
    act(() => {
      dialogButton('Cancel')?.click();
    });
    expect(ran).toEqual([]);
    act(() => {
      runButton(row).click();
    });
    act(() => {
      dialogButton('Yes — write to the camera')?.click();
    });
    expect(ran).toEqual([['patch-dump', {}]]);
    view.unmount();
  });

  it('phase ③ without a recorded commit is jump-only, loud, and behind its own dialog', () => {
    const ran: [PreservePhaseId, PreservePhaseRunOptions][] = [];
    const state = runState({ backup: 'done', patch: 'done' }, { nextStep: 'commit' });
    const view = renderPreserve({ state, connected: true }, ran);

    expect(view.container.textContent).toContain(
      'The commit is not on record for this run, so the phases past it are shut',
    );
    const row = phaseRow(view.container, 'Restore & verify');
    expect(row.textContent).toContain('the camera may already be patched');
    const button = runButton(row);
    expect(button.textContent.trim()).toBe('Run past the unrecorded commit');
    expect(button.disabled).toBe(false);
    act(() => {
      button.click();
    });
    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('THE COMMIT IS NOT ON RECORD');
    expect(dialog?.textContent).toContain('jump past the unrecorded commit');
    act(() => {
      dialogButton('Yes — jump past the commit')?.click();
    });
    expect(ran).toEqual([['restore-verify', { allowJump: true }]]);
    view.unmount();
  });

  it('a failed commit offers the re-run AND the jump past it', () => {
    const ran: [PreservePhaseId, PreservePhaseRunOptions][] = [];
    const state = runState(
      { backup: 'done', patch: 'done', commit: 'failed' },
      { nextStep: 'commit' },
    );
    const view = renderPreserve({ state, connected: true }, ran);

    const row = phaseRow(view.container, 'Patch & dump');
    const skip = [...row.querySelectorAll('button')].find((button) =>
      button.textContent.includes('Skip the commit'),
    );
    expect(skip).toBeTruthy();
    expect(skip?.disabled).toBe(false);
    act(() => {
      skip?.click();
    });
    expect(document.body.querySelector('[role="alertdialog"]')?.textContent).toContain(
      'THE COMMIT IS NOT ON RECORD',
    );
    act(() => {
      dialogButton('Yes — jump past the commit')?.click();
    });
    expect(ran).toEqual([['patch-dump', { allowJump: true }]]);
    view.unmount();
  });

  it('the plan prints from what the camera produced — build, two agreeing reads, the diff', () => {
    const { container, unmount } = renderPreserve({
      state: runState({ backup: 'done', patch: 'done' }, { nextStep: 'commit' }),
      connected: true,
    });
    const row = phaseRow(container, 'Read & build');
    expect(row.textContent).toContain('Compact 1.3.0.8 (8 Hz)');
    expect(row.textContent).toContain('two agreeing reads');
    expect(row.textContent).toContain('Bytes that move on the part');
    expect(row.textContent).toContain('mov.w');
    unmount();
  });

  it('the verify verdict is unmistakable, both ways', () => {
    const matched = runState(
      { backup: 'done', patch: 'done', commit: 'done', drain: 'done', restore: 'done' },
      {
        nextStep: 'verify',
        verify: { diffBytes: 0, windowsRead: 31, badWindows: [] },
      },
    );
    const okView = renderPreserve({ state: matched, connected: true });
    expect(phaseRow(okView.container, 'Restore & verify').textContent).toContain('VERIFY: MATCH');
    okView.unmount();

    const mismatched = runState(
      {
        backup: 'done',
        patch: 'done',
        commit: 'done',
        drain: 'done',
        restore: 'done',
        verify: 'failed',
      },
      {
        nextStep: 'done',
        steps: {},
      },
    );
    /* The failed verify's recorded error carries the differing count. */
    const state = {
      ...mismatched,
      nextStep: 'verify',
      steps: {
        backup: { status: 'done' },
        patch: { status: 'done' },
        commit: { status: 'done' },
        drain: { status: 'done' },
        restore: { status: 'done' },
        verify: {
          status: 'failed',
          error: 'the verify read 4096 differing byte(s) over 31/31 windows',
        },
      },
    } as unknown as PreserveRunState;
    const badView = renderPreserve({ state, connected: true });
    const row = phaseRow(badView.container, 'Restore & verify');
    expect(row.textContent).toContain('VERIFY: NO MATCH');
    expect(row.textContent).toContain('4096 differing byte(s)');
    badView.unmount();
  });

  it('a finished run shows the sha pairs and the archive download', () => {
    const full = runState(
      {
        backup: 'done',
        patch: 'done',
        commit: 'done',
        drain: 'done',
        restore: 'done',
        verify: 'done',
      },
      {
        nextStep: 'done',
        deliveredSha256: 'a'.repeat(64),
        rawDumpSha256: 'c'.repeat(64),
        verify: { diffBytes: 0, windowsRead: 31, badWindows: [] },
      },
    );
    const { container, unmount } = renderPreserve({ state: full, connected: true });
    expect(container.textContent).toContain('matches the as-booted image');
    expect(container.textContent).toContain('Raw post-commit part');
    expect(buttonByText(container, 'Download the full archive (run file)')).toBeTruthy();
    unmount();
  });
});

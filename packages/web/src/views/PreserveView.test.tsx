/**
 * The wizard on the page: three phases as numbered steps, the image picked
 * NOWHERE (the plan prints from what the camera produced), the commit behind
 * its confirmation dialog, the past-commit jump behind its own, the verify
 * verdict shown unmistakably on the last step — and the run's expected
 * hand-offs (the Connect pick, the replug) asked for calmly, not in red.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { PreserveView } from './PreserveView';
import type {
  DeliveredCheck,
  PreservePanelApi,
  PreservePhaseRunOptions,
  PreservePrompt,
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
  readonly prompt?: PreservePrompt | null;
  readonly lastSave?: RunFileSave | null;
  readonly deliveredCheck?: DeliveredCheck | null;
  readonly onConnect?: () => void;
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
    prompt: scenario.prompt ?? null,
    loading: false,
    lastSave: scenario.lastSave ?? null,
    deliveredCheck: scenario.deliveredCheck ?? null,
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
      {...(scenario.onConnect === undefined ? {} : { onConnect: scenario.onConnect })}
    />,
  );
}

/** A phase's own numbered step: the section its heading labels. */
function phaseRow(container: HTMLElement, label: string): HTMLElement {
  const row = [...container.querySelectorAll('section')].find(
    (node) => node.querySelector('h2')?.textContent.trim() === label,
  );
  if (row === undefined) throw new Error(`no phase step titled ${label}`);
  return row;
}

function runButton(row: HTMLElement): HTMLButtonElement {
  const match = [...row.querySelectorAll('button')].find((button) =>
    /^(Start |Try |Run past the unrecorded commit$)/.test(button.textContent.trim()),
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
    expect(container.textContent).toContain('Steps 03 and 04 write to the camera');
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
    expect(dialog?.textContent).toContain('writes a small patch into the firmware block');
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

  it('right after step 02 nothing is alarming — step 04 just waits for step 03', () => {
    const state = runState({ backup: 'done', patch: 'done' }, { nextStep: 'commit' });
    const { container, unmount } = renderPreserve({ state, connected: true });
    expect(container.textContent).not.toContain('The commit is not on record');
    const row = phaseRow(container, 'Restore & verify');
    expect(row.textContent).toContain('Available after step 03 (Patch & dump)');
    expect(row.textContent).not.toContain('already be patched');
    expect(runButton(row).textContent.trim()).toBe('Start restore & verify');
    expect(runButton(row).disabled).toBe(true);
    unmount();
  });

  it('phase ③ after a FAILED commit is jump-only, loud, and behind its own dialog', () => {
    const ran: [PreservePhaseId, PreservePhaseRunOptions][] = [];
    const state = runState(
      { backup: 'done', patch: 'done', commit: 'failed' },
      { nextStep: 'commit' },
    );
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
    /* A finished step says so, and says nothing about being "not ready". */
    expect(row.textContent).toContain('Done');
    expect(row.textContent).not.toContain('Not ready');
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
    expect(phaseRow(okView.container, 'Restore & verify').textContent).toContain(
      'Verified — a perfect match',
    );
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
    expect(row.textContent).toContain('The check found differences');
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
    const { container, unmount } = renderPreserve({
      state: full,
      connected: true,
      deliveredCheck: { blocksCompared: 31, differing: [], onlyInFullDump: [0x14000000] },
    });
    /* The complete image is held against the backup — the comparison that can
     * actually match — never against the one-slot firmware image's sha. */
    expect(container.textContent).toContain('matches the backup on all 31 blocks');
    expect(container.textContent).not.toContain('DOES NOT match');
    expect(container.textContent).toContain('Only in the full dump');
    expect(container.textContent).toContain('0x14000000');
    expect(container.textContent).toContain('Raw post-commit part');
    expect(buttonByText(container, 'Download the full archive (run file)')).toBeTruthy();
    unmount();
  });
  it('the Connect pick after a restart is the user’s turn — a blue ask with its own Connect button, never red', () => {
    let connects = 0;
    const state = runState(
      { backup: 'done', patch: 'done', commit: 'done' },
      { nextStep: 'drain' },
    );
    const { container, unmount } = renderPreserve({
      state,
      connected: false,
      busy: true,
      activePhase: 'patch-dump',
      prompt: { phase: 'patch-dump', kind: 'reconnect' },
      onConnect: () => {
        connects += 1;
      },
    });
    const row = phaseRow(container, 'Patch & dump');
    expect(row.textContent).toContain('Your turn: press Connect device and pick the camera');
    expect(row.textContent).toContain('restarted, as planned');
    const ask = row.querySelector('[data-slot="alert"]');
    expect(ask?.className).toContain('border-l-primary');
    expect(ask?.className).not.toContain('destructive');
    /* The ask's own button works while the phase holds the run lock. */
    const connect = buttonByText(row, 'Connect device');
    expect(connect.disabled).toBe(false);
    act(() => {
      connect.click();
    });
    expect(connects).toBe(1);
    /* Only the phase that waits shows it. */
    expect(phaseRow(container, 'Read & build').textContent).not.toContain('Your turn');
    unmount();
  });

  it('the replug a pre-fix patch owes is asked the same calm way', () => {
    const state = runState(
      { backup: 'done', patch: 'done', commit: 'done', drain: 'done' },
      { nextStep: 'restore' },
    );
    const { container, unmount } = renderPreserve({
      state,
      connected: true,
      prompt: { phase: 'patch-dump', kind: 'replug-before-restore' },
      onConnect: () => undefined,
    });
    const row = phaseRow(container, 'Patch & dump');
    expect(row.textContent).toContain('Before step 04: unplug the camera, plug it back in');
    expect(row.querySelector('[data-slot="alert"]')?.className).toContain('border-l-primary');
    unmount();
  });

  it('a backup that needs a power cycle asks for the replug, and its continue button carries the assertion', () => {
    const ran: [PreservePhaseId, PreservePhaseRunOptions][] = [];
    const state = runState({}, {
      nextStep: 'backup',
      steps: { backup: { status: 'failed', powerCycleRequired: true } },
    } as unknown as Partial<PreserveRunState>);
    const { container, unmount } = renderPreserve({ state, connected: true }, ran);
    const row = phaseRow(container, 'Read & build');
    expect(row.textContent).toContain('Your turn: unplug the camera, plug it back in');
    expect(runButton(row).disabled).toBe(true);
    const go = buttonByText(row, 'I replugged it — continue read & build');
    expect(go.className).not.toContain('destructive');
    act(() => {
      go.click();
    });
    expect(ran).toEqual([['read-build', { powerCycled: true }]]);
    unmount();
  });

  it('no step reads as alarming before anything has gone wrong — no red buttons, borders or badges', () => {
    const { container, unmount } = renderPreserve({ state: runState(), connected: true });
    for (const label of ['Read & build', 'Patch & dump', 'Restore & verify']) {
      const row = phaseRow(container, label);
      expect(row.innerHTML).not.toContain('destructive');
    }
    unmount();
  });
  it('a complete image that differs from the backup says where, in red', () => {
    const full = runState(
      {
        backup: 'done',
        patch: 'done',
        commit: 'done',
        drain: 'done',
        restore: 'done',
        verify: 'done',
      },
      { nextStep: 'done', deliveredSha256: 'a'.repeat(64) },
    );
    const { container, unmount } = renderPreserve({
      state: full,
      connected: true,
      deliveredCheck: { blocksCompared: 31, differing: [0x14020000], onlyInFullDump: [] },
    });
    expect(container.textContent).toContain(
      'differs from the backup in 1 of 31 blocks: 0x14020000',
    );
    unmount();
  });
});

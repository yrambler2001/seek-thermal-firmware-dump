/**
 * One render test per view: the controls are on the page, they are real
 * controls, and the single destructive one stays shut until all four of its
 * preconditions hold.
 *
 * The gate is not stubbed here. `canWriteNow` — the same function the app
 * wires up — decides `canWrite` for each row of the matrix, so this walks the
 * gate through the rendered button rather than around it.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { DumpView } from './DumpView';
import { FlashView } from './FlashView';
import { canWriteNow, type FlashPanelApi, type PreparedImage } from '@/hooks/useFlashPanel';
import type { DumpPanelApi } from '@/hooks/useDumpPanel';
import type { OfflineDecryptApi } from '@/hooks/useOfflineDecrypt';
import { useReporter, type ReporterHandle } from '@/hooks/useReporter';
import { DEFAULT_OPTIONS_FORM } from '@/lib/options';
import type { DeviceState } from '@seek-fw/core';
import { fakeDeviceState, fakePreparedFlash } from '@/test-fixtures';
import { buttonByText, render, renderHook } from '@/test-helpers';

function reporters(count: number): readonly ReporterHandle[] {
  const { result } = renderHook(() => Array.from({ length: count }, () => useReporter()));
  return result.current;
}

function dumpStub(reporter: ReporterHandle): DumpPanelApi {
  return { reporter, running: false, start: () => Promise.resolve(), cancel: () => undefined };
}

function offlineStub(reporter: ReporterHandle): OfflineDecryptApi {
  return {
    reporter,
    running: false,
    detection: null,
    decryptFile: () => Promise.resolve(),
    cancel: () => undefined,
  };
}

interface Scenario {
  readonly connected: boolean;
  readonly busy: boolean;
  readonly state: DeviceState | null;
  readonly prepared: PreparedImage | null;
}

function flashStub(scenario: Scenario, pair: readonly ReporterHandle[]): FlashPanelApi {
  return {
    infoReporter: pair[0]!,
    flashReporter: pair[1]!,
    deviceState: scenario.state,
    prepared: scenario.prepared,
    readingInfo: false,
    writing: false,
    canWrite: canWriteNow({
      hasDevice: scenario.connected,
      busy: scenario.busy,
      hasImage: scenario.prepared !== null,
      state: scenario.state,
    }),
    readInfo: () => Promise.resolve(),
    pickImage: () => Promise.resolve(),
    write: () => Promise.resolve(),
    cancelInfo: () => undefined,
    cancelWrite: () => undefined,
  };
}

function renderFlash(scenario: Scenario) {
  const pair = reporters(2);
  return render(
    <FlashView
      flash={flashStub(scenario, pair)}
      connected={scenario.connected}
      busy={scenario.busy}
      profileChoice="auto"
      onProfileChoice={() => undefined}
    />,
  );
}

afterEach(() => {
  for (const node of document.body.querySelectorAll('[role="alertdialog"]')) node.remove();
});

describe('DumpView', () => {
  it('puts every read control and the read options on the page', () => {
    const [a, b, c] = reporters(3);
    const { container, unmount } = render(
      <DumpView
        dump={dumpStub(a!)}
        legacy={dumpStub(b!)}
        offline={offlineStub(c!)}
        connected={false}
        busy={false}
        options={DEFAULT_OPTIONS_FORM}
        onOptionsChange={() => undefined}
        optionsInvalidField={null}
        optionsErrorMessage={null}
      />,
    );

    for (const label of [
      'Start dump',
      'Dump all selectors (0x00–0xFF)',
      'Dump legacy firmware',
      'Choose dump file…',
    ]) {
      expect(buttonByText(container, label), label).toBeTruthy();
    }

    /* Device work is shut without a device; the offline decryptor never is. */
    expect(buttonByText(container, 'Start dump').disabled).toBe(true);
    expect(buttonByText(container, 'Dump legacy firmware').disabled).toBe(true);
    expect(buttonByText(container, 'Choose dump file…').disabled).toBe(false);

    for (const id of [
      'optChunk',
      'optGapFill',
      'optRetries',
      'optRetryDelay',
      'optRecipient',
      'optDecrypt',
    ]) {
      expect(container.querySelector(`#${id}`), id).toBeTruthy();
      expect(container.querySelector(`label[for="${id}"]`), `label for ${id}`).toBeTruthy();
    }

    /* Three runs, three consoles. */
    expect(container.querySelectorAll('[role="progressbar"]').length).toBe(3);
    /* Nothing here writes, so nothing here is destructive. */
    expect(container.querySelector('[role="alertdialog"]')).toBeNull();
    unmount();
  });
});

describe('FlashView', () => {
  it('puts the read, pick and write controls on the page', () => {
    const { container, unmount } = renderFlash({
      connected: true,
      busy: false,
      state: null,
      prepared: null,
    });

    expect(buttonByText(container, 'Read device info')).toBeTruthy();
    expect(buttonByText(container, 'Choose plaintext image…')).toBeTruthy();
    expect(buttonByText(container, 'Write to camera')).toBeTruthy();
    expect(container.querySelector('#optDumpFirst')).toBeTruthy();
    expect(container.querySelector('label[for="optDumpFirst"]')).toBeTruthy();
    expect(container.querySelector('#profileChoice')).toBeTruthy();
    expect(container.querySelector('label[for="profileChoice"]')).toBeTruthy();
    unmount();
  });

  it('keeps the write control shut until a camera is read AND an image is prepared', async () => {
    const state = await fakeDeviceState();
    const flashable = { ...state, canFlash: true } as DeviceState;
    const prepared: PreparedImage = { prep: fakePreparedFlash(), sha256: 'a'.repeat(64) };

    const rows: readonly (Scenario & { readonly want: boolean })[] = [
      { connected: false, busy: false, state: null, prepared: null, want: false },
      { connected: true, busy: false, state: null, prepared: null, want: false },
      { connected: true, busy: false, state: flashable, prepared: null, want: false },
      { connected: true, busy: false, state: null, prepared, want: false },
      { connected: false, busy: false, state: flashable, prepared, want: false },
      { connected: true, busy: true, state: flashable, prepared, want: false },
      { connected: true, busy: false, state, prepared, want: false },
      { connected: true, busy: false, state: flashable, prepared, want: true },
    ];

    for (const row of rows) {
      const { container, unmount } = renderFlash(row);
      const button = buttonByText(container, 'Write to camera');
      expect(
        button.disabled,
        JSON.stringify({ ...row, state: row.state !== null, prepared: row.prepared !== null }),
      ).toBe(!row.want);
      /* Nothing is confirmed just by rendering. */
      expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
      unmount();
    }
  }, 30_000);

  it('only ever reaches a write through the confirmation modal', async () => {
    const state = await fakeDeviceState();
    const flashable = { ...state, canFlash: true } as DeviceState;
    const prepared: PreparedImage = { prep: fakePreparedFlash(), sha256: 'a'.repeat(64) };

    const { container, unmount } = renderFlash({
      connected: true,
      busy: false,
      state: flashable,
      prepared,
    });

    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    act(() => {
      buttonByText(container, 'Write to camera').click();
    });

    const dialog = document.body.querySelector('[role="alertdialog"]');
    expect(dialog).toBeTruthy();
    expect(dialog?.textContent).toContain('Write ');

    /* Escape backs all the way out again. */
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    unmount();
  }, 30_000);

  it('opens nothing when there is no prepared image to confirm', () => {
    const { container, unmount } = renderFlash({
      connected: true,
      busy: false,
      state: null,
      prepared: null,
    });
    act(() => {
      buttonByText(container, 'Write to camera').click();
    });
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    unmount();
  });
});

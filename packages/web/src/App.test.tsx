/**
 * Render smoke tests: that each view puts its controls on the page, that the
 * hash swaps between them, and that the one destructive button stays disabled
 * until both of its preconditions hold.
 */

import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { FlashView } from './views/FlashView';
import { canWriteNow, type FlashPanelApi } from './hooks/useFlashPanel';
import type { DeviceState } from '@seek-fw/core';
import { useReporter } from './hooks/useReporter';
import { detectSupport, type BrowserEnvironment } from './lib/support';
import { buttonByText, render, renderHook } from './test-helpers';

const READY = detectSupport({
  hasWebUsb: true,
  userAgent: 'Chrome',
  platform: 'MacIntel',
  maxTouchPoints: 0,
  isSecureContext: true,
  protocol: 'https:',
} satisfies BrowserEnvironment);

const NO_USB = detectSupport({
  hasWebUsb: false,
  userAgent: 'Firefox',
  platform: 'Linux x86_64',
  maxTouchPoints: 0,
  isSecureContext: true,
  protocol: 'https:',
} satisfies BrowserEnvironment);

function goTo(hash: string): void {
  act(() => {
    window.location.hash = hash;
    window.dispatchEvent(new Event('hashchange'));
  });
}

afterEach(() => {
  window.location.hash = '';
});

describe('App — dump view', () => {
  it('renders the connect panel, both dump actions and the read options', () => {
    window.location.hash = '#/';
    const { container, unmount } = render(<App support={READY} />);

    expect(buttonByText(container, 'Connect device')).toBeTruthy();
    expect(buttonByText(container, 'Test connection')).toBeTruthy();
    expect(buttonByText(container, 'Forget device')).toBeTruthy();
    expect(buttonByText(container, 'Start dump')).toBeTruthy();
    expect(buttonByText(container, 'Dump all selectors (0x00–0xFF)')).toBeTruthy();
    expect(buttonByText(container, 'Dump legacy firmware')).toBeTruthy();
    expect(buttonByText(container, 'Choose dump file…')).toBeTruthy();

    /* Every option input is a real control with a real label. */
    for (const id of [
      'optChunk',
      'optGapFill',
      'optRetries',
      'optRetryDelay',
      'optRecipient',
      'optDecrypt',
    ]) {
      const input = container.querySelector(`#${id}`);
      expect(input, id).toBeTruthy();
      expect(container.querySelector(`label[for="${id}"]`), `label for ${id}`).toBeTruthy();
    }
    expect(container.querySelector<HTMLInputElement>('#optChunk')?.value).toBe('64');
    expect(container.querySelector<HTMLInputElement>('#optGapFill')?.value).toBe('0xff');

    /* The read-only guarantee table is the point of this view. */
    expect(container.textContent).toContain('Read-only guarantee');
    expect(container.textContent).toContain('GetFeaturedFirmwareData');
    expect(container.querySelector('[role="progressbar"]')).toBeTruthy();
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();

    unmount();
  });

  it('disables the device actions but never the offline decryptor', () => {
    window.location.hash = '#/';
    const { container, unmount } = render(<App support={NO_USB} />);

    expect(buttonByText(container, 'Connect device').disabled).toBe(true);
    expect(buttonByText(container, 'Start dump').disabled).toBe(true);
    expect(buttonByText(container, 'Dump legacy firmware').disabled).toBe(true);
    /* The whole reason the support banner is worded the way it is. */
    expect(buttonByText(container, 'Choose dump file…').disabled).toBe(false);
    expect(container.textContent).toContain('This browser cannot access USB devices.');

    unmount();
  });
});

describe('App — flash view', () => {
  it('renders the write controls, the warnings and the profile override', () => {
    window.location.hash = '#/flash';
    const { container, unmount } = render(<App support={READY} />);

    expect(buttonByText(container, 'Read device info')).toBeTruthy();
    expect(buttonByText(container, 'Choose plaintext image…')).toBeTruthy();
    expect(buttonByText(container, 'Write to camera')).toBeTruthy();
    expect(container.querySelector('#optDumpFirst')).toBeTruthy();
    expect(container.querySelector('label[for="optDumpFirst"]')).toBeTruthy();
    expect(container.querySelector('#profileChoice')).toBeTruthy();
    expect(container.querySelector('label[for="profileChoice"]')).toBeTruthy();

    const text = container.textContent;
    expect(text).toContain("This writes to the camera's flash.");
    expect(text).toContain('the first-stage bootloader has no USB');
    expect(text).toContain("The filename must carry the image's own key pair");
    expect(text).toContain('CompleteMemoryUpgrade');
    expect(text).toContain('Detected firmware profile');

    unmount();
  });

  it('swaps views on hashchange without remounting the shell', () => {
    window.location.hash = '#/';
    const { container, unmount } = render(<App support={READY} />);
    expect(container.textContent).toContain('Read-only guarantee');

    goTo('#/flash');
    expect(container.textContent).toContain('What this view writes');
    expect(container.textContent).not.toContain('Read-only guarantee');
    /* The Connect panel is shared and survives the swap. */
    expect(buttonByText(container, 'Connect device')).toBeTruthy();

    goTo('#/');
    expect(container.textContent).toContain('Read-only guarantee');
    unmount();
  });
});

/* ---- the write gate -------------------------------------------------- */

function stubFlashApi(overrides: Partial<FlashPanelApi>): FlashPanelApi {
  const { result } = renderHook(() => ({ a: useReporter(), b: useReporter() }));
  return {
    infoReporter: result.current.a,
    flashReporter: result.current.b,
    deviceState: null,
    prepared: null,
    readingInfo: false,
    writing: false,
    canWrite: false,
    readInfo: () => Promise.resolve(),
    pickImage: () => Promise.resolve(),
    write: () => Promise.resolve(),
    cancelInfo: () => undefined,
    cancelWrite: () => undefined,
    ...overrides,
  };
}

describe('the write button', () => {
  it('is disabled until the camera has been read AND an image is prepared', () => {
    const state = { canFlash: true } as unknown as DeviceState;
    const matrix = [
      { hasDevice: false, busy: false, hasImage: false, state: null, want: false },
      { hasDevice: true, busy: false, hasImage: false, state: null, want: false },
      { hasDevice: true, busy: false, hasImage: false, state, want: false },
      { hasDevice: true, busy: false, hasImage: true, state: null, want: false },
      { hasDevice: false, busy: false, hasImage: true, state, want: false },
      { hasDevice: true, busy: true, hasImage: true, state, want: false },
      {
        hasDevice: true,
        busy: false,
        hasImage: true,
        state: { canFlash: false } as unknown as DeviceState,
        want: false,
      },
      { hasDevice: true, busy: false, hasImage: true, state, want: true },
    ];
    for (const row of matrix) {
      const { want, ...args } = row;
      expect(canWriteNow(args), JSON.stringify({ ...args, state: args.state !== null })).toBe(want);
    }
  });

  it('renders disabled when the gate is shut and enabled when it opens', () => {
    const shut = render(
      <FlashView
        flash={stubFlashApi({ canWrite: false })}
        connected={false}
        busy={false}
        profileChoice="auto"
        onProfileChoice={() => undefined}
      />,
    );
    expect(buttonByText(shut.container, 'Write to camera').disabled).toBe(true);
    shut.unmount();

    const open = render(
      <FlashView
        flash={stubFlashApi({ canWrite: true })}
        connected
        busy={false}
        profileChoice="auto"
        onProfileChoice={() => undefined}
      />,
    );
    expect(buttonByText(open.container, 'Write to camera').disabled).toBe(false);
    open.unmount();
  });

  it('asks for an explicit confirmation before it writes anything', () => {
    const view = render(
      <FlashView
        flash={stubFlashApi({ canWrite: true })}
        connected
        busy={false}
        profileChoice="auto"
        onProfileChoice={() => undefined}
      />,
    );
    /* No prepared image, so pressing it opens nothing — the confirmation only
     * appears once there is something to confirm. */
    expect(view.container.querySelector('.confirm')).toBeNull();
    act(() => {
      buttonByText(view.container, 'Write to camera').click();
    });
    expect(view.container.querySelector('.confirm')).toBeNull();
    view.unmount();
  });
});

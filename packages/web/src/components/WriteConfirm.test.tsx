/**
 * The only destructive control in the tool.
 *
 * What is pinned here is not the styling: it is that the confirmation is a
 * real modal, that it says the original's words, that focus starts on Cancel,
 * that Escape backs out, and that confirming takes one deliberate press and
 * fires exactly once.
 */

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WriteConfirm } from './WriteConfirm';
import { buttonByText, render } from '../test-helpers';

function setup(options: { rekeyRisk?: boolean; open?: boolean } = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const handle = render(
    <WriteConfirm
      open={options.open ?? true}
      fileName="fw_decrypted_14010000.bin"
      targetName="slot B"
      targetAddress="0x14030000"
      rekeyRisk={options.rekeyRisk ?? false}
      bootedName="slot A"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { ...handle, onConfirm, onCancel };
}

function dialog(): HTMLElement {
  const node = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  if (node === null) throw new Error('no alert dialog is open');
  return node;
}

function pressEscape(): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('WriteConfirm', () => {
  it('stays out of the document until it is opened', () => {
    const { unmount } = setup({ open: false });
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    unmount();
  });

  it('opens as a modal labelled by its own heading', () => {
    const { container, unmount } = setup();
    const node = dialog();

    /* Modal, in the way Radix expresses it: the rest of the document is
     * hidden from assistive technology and ringed by focus guards. */
    expect(container.getAttribute('aria-hidden')).toBe('true');
    expect(document.body.querySelectorAll('[data-radix-focus-guard]').length).toBeGreaterThan(0);

    const labelledBy = node.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const heading = document.getElementById(labelledBy ?? '');
    expect(heading?.textContent).toBe('Write fw_decrypted_14010000.bin to slot B at 0x14030000?');

    /* Described by the paragraph that says what the write does. */
    const describedBy = node.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent).toContain(
      'This erases a 64 KiB block',
    );
    unmount();
  });

  it('carries the original warning word for word', () => {
    const { unmount } = setup();
    const text = dialog().textContent;
    expect(text).toContain(
      "This erases a 64 KiB block of the camera's flash and repoints its boot config.",
    );
    expect(text).toContain(
      'If the image does not run, the camera cannot be recovered over USB — only with SWD/J-Link ' +
        'or an SPI programmer.',
    );
    unmount();
  });

  it('adds the re-key warning only when the camera is in that state', () => {
    const safe = setup();
    expect(dialog().textContent).not.toContain('WARNING: this camera stores upgrades');
    safe.unmount();

    const risky = setup({ rekeyRisk: true });
    expect(dialog().textContent).toContain(
      'WARNING: this camera stores upgrades under a key its bootloader does not know, so this ' +
        'slot will be skipped at boot and the camera will keep running slot A.',
    );
    risky.unmount();
  });

  it('lands focus on Cancel, never on the confirm', () => {
    const { unmount } = setup();
    const cancel = buttonByText(document.body, 'Cancel');
    const confirm = buttonByText(document.body, 'Yes — write to camera');

    expect(document.activeElement).toBe(cancel);
    expect(document.activeElement).not.toBe(confirm);
    unmount();
  });

  it('cannot be confirmed by keyboard without deliberately moving focus', () => {
    const { onConfirm, onCancel, unmount } = setup();

    /* Enter or Space on the focused control is what a held key reaches. That
     * control is Cancel, so the camera is never written. */
    act(() => {
      (document.activeElement as HTMLElement | null)?.click();
    });
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('backs out on Escape without writing', () => {
    const { onConfirm, onCancel, unmount } = setup();
    pressEscape();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();
    unmount();
  });

  it('writes exactly once on the explicit confirm, and reports no cancel', () => {
    const { onConfirm, onCancel, unmount } = setup();
    act(() => {
      buttonByText(document.body, 'Yes — write to camera').click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    unmount();
  });

  it('traps focus inside the dialog', () => {
    const outside = document.createElement('button');
    outside.textContent = 'outside';
    document.body.appendChild(outside);

    const { unmount } = setup();
    act(() => {
      outside.focus();
    });
    /* The focus scope pulls it straight back in. */
    expect(dialog().contains(document.activeElement)).toBe(true);

    unmount();
    outside.remove();
  });
});

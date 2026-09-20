/**
 * The only destructive control in the tool. The original used
 * `window.confirm()`; this checks that the same words reach the page, that
 * they name the file and the slot, and that nothing happens without a second,
 * explicit press.
 */

import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { WriteConfirm } from './WriteConfirm';
import { buttonByText, render } from '../test-helpers';

function setup(rekeyRisk: boolean) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const handle = render(
    <WriteConfirm
      fileName="fw_decrypted_14010000.bin"
      targetName="slot B"
      targetAddress="0x14030000"
      rekeyRisk={rekeyRisk}
      bootedName="slot A"
      onConfirm={onConfirm}
      onCancel={onCancel}
    />,
  );
  return { ...handle, onConfirm, onCancel };
}

describe('WriteConfirm', () => {
  it('names the file and the target slot, and carries the original warning', () => {
    const { container, unmount } = setup(false);
    const text = container.textContent;
    expect(text).toContain('Write fw_decrypted_14010000.bin to slot B at 0x14030000?');
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
    const safe = setup(false);
    expect(safe.container.textContent).not.toContain('WARNING: this camera stores upgrades');
    safe.unmount();

    const risky = setup(true);
    expect(risky.container.textContent).toContain(
      'WARNING: this camera stores upgrades under a key its bootloader does not know, so this ' +
        'slot will be skipped at boot and the camera will keep running slot A.',
    );
    risky.unmount();
  });

  it('is a labelled group that takes focus, with Cancel listed first', () => {
    const { container, unmount } = setup(false);
    const group = container.querySelector('.confirm');
    expect(group?.getAttribute('role')).toBe('group');
    expect(group?.getAttribute('aria-labelledby')).toBe('write-confirm-heading');
    expect(container.querySelector('#write-confirm-heading')).toBeTruthy();
    expect(document.activeElement).toBe(group);

    const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent.trim());
    expect(buttons).toEqual(['Cancel', 'Yes — write to camera']);
    unmount();
  });

  it('only writes on the explicit confirm, and Escape backs out', () => {
    const { container, onConfirm, onCancel, unmount } = setup(false);

    act(() => {
      buttonByText(container, 'Cancel').click();
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => {
      container
        .querySelector('.confirm')
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onCancel).toHaveBeenCalledTimes(2);
    expect(onConfirm).not.toHaveBeenCalled();

    act(() => {
      buttonByText(container, 'Yes — write to camera').click();
    });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    unmount();
  });
});

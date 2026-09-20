/**
 * The two things `@testing-library/react` would have given us, in twenty lines
 * of `react-dom/client` + `act`. Adding the library for this would be a
 * dependency for a convenience, and the hooks here are the interesting part —
 * they are tested directly rather than through rendered markup.
 */

import { act, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

export interface HookHandle<T> {
  readonly result: { current: T };
  unmount: () => void;
}

export function renderHook<T>(hook: () => T): HookHandle<T> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const result = { current: undefined as T };

  function Probe(): null {
    result.current = hook();
    return null;
  }

  act(() => {
    root.render(<Probe />);
  });

  return {
    result,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

export interface RenderHandle {
  readonly container: HTMLElement;
  unmount: () => void;
}

export function render(element: ReactElement): RenderHandle {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return {
    container,
    unmount: () => {
      act(() => {
        root.unmount();
      });
      container.remove();
    },
  };
}

/** Every `<button>` in `container`, by its trimmed text. */
export function buttonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const match = [...container.querySelectorAll('button')].find(
    (button) => button.textContent.trim() === text,
  );
  if (match === undefined) {
    const available = [...container.querySelectorAll('button')]
      .map((button) => button.textContent.trim())
      .join(' | ');
    throw new Error(`no button labelled "${text}". Found: ${available}`);
  }
  return match;
}

/** Polls `predicate`, letting timers and microtasks run between attempts. */
export async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });
  }
}

/**
 * The original's `yieldToUi`. A macrotask, not a microtask: awaiting a resolved
 * promise does not let the browser paint, so a `setTimeout(0)` is what actually
 * gives the progress bar a chance to move between two long synchronous steps.
 */
export function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, 0);
  });
}

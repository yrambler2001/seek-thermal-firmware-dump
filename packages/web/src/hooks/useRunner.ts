/**
 * Mutual exclusion for the long operations, and the one `AbortController` a
 * Cancel button flips.
 *
 * The original had a page-global `running` flag plus a `cancelRequested`
 * boolean that every loop polled. This is the same rule — one operation at a
 * time, across both views — expressed as a signal the workflows already accept.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

export interface Runner {
  /** Id of the panel currently running something, or null. */
  readonly active: string | null;
  readonly busy: boolean;
  /** Cancel has been pressed and the run has not finished unwinding yet. */
  readonly cancelling: boolean;
  /** Runs `task` unless something else is already running. */
  start: (id: string, task: (signal: AbortSignal) => Promise<void>) => Promise<void>;
  cancel: () => void;
}

export function useRunner(): Runner {
  const [active, setActive] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const activeRef = useRef<string | null>(null);

  const start = useCallback(
    async (id: string, task: (signal: AbortSignal) => Promise<void>): Promise<void> => {
      if (activeRef.current !== null) return;
      activeRef.current = id;
      const ownController = new AbortController();
      controller.current = ownController;
      setActive(id);
      setCancelling(false);
      try {
        await task(ownController.signal);
      } finally {
        activeRef.current = null;
        controller.current = null;
        setActive(null);
        setCancelling(false);
      }
    },
    [],
  );

  const cancel = useCallback((): void => {
    if (controller.current === null) return;
    setCancelling(true);
    controller.current.abort();
  }, []);

  /* A run holds the USB interface and may be part-way through a flash write;
   * closing the tab under it is worth a confirmation, as it was originally. */
  useEffect(() => {
    if (active === null) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, [active]);

  return useMemo(
    () => ({ active, busy: active !== null, cancelling, start, cancel }),
    [active, cancelling, start, cancel],
  );
}

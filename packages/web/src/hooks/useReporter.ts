/**
 * Core's `Reporter` as React state.
 *
 * A whole-flash dump reports one progress event per control-IN chunk — 64
 * bytes at a time over 4 MiB is sixty-odd thousand events — and one log line
 * per window, retry and decrypted slot. A `setState` per event would spend the
 * entire run re-rendering and the progress bar would never move.
 *
 * So every event lands in a mutable buffer and a single timer drains it. The
 * interval is the original page's 60 ms repaint throttle, and the one rule it
 * had is kept: a progress event that reaches the total is applied immediately,
 * so the bar always finishes at 100% however the timing falls.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Artifact, LogLevel, Reporter } from '@seek-fw/core';

/** The original's repaint throttle, in milliseconds. */
export const FLUSH_INTERVAL_MS = 60;

/** Lines kept in state. A sweep of all 256 selectors is chatty; past this the
 *  oldest lines are dropped and counted rather than growing without bound. */
export const MAX_LOG_LINES = 4000;

export interface LogLine {
  readonly seq: number;
  readonly level: LogLevel;
  readonly text: string;
}

export interface ProgressState {
  readonly done: number;
  readonly total: number;
  readonly text: string;
}

export interface ReporterHandle {
  /** Stable across renders, so it can be handed to a workflow once. */
  readonly reporter: Reporter;
  readonly lines: readonly LogLine[];
  readonly progress: ProgressState;
  readonly artifacts: readonly Artifact[];
  /** How many log lines were dropped off the front of the buffer. */
  readonly trimmed: number;
  /** Clears the log, the artifacts and the bar, and sets the status line. */
  reset: (statusText: string) => void;
  /** A line written by the UI itself rather than by a workflow. */
  log: (text: string, level?: LogLevel) => void;
  setStatus: (text: string) => void;
  /** Drains the buffer now. Used before a run reports its final outcome. */
  flush: () => void;
  /**
   * Every artifact reported so far, read straight out of the buffer rather
   * than out of state. A cancelled dump has to package what it has from inside
   * the `catch`, which is one render too early to see it in `artifacts`.
   */
  collected: () => readonly Artifact[];
}

interface Buffer {
  lines: LogLine[];
  artifacts: Artifact[];
  progress: ProgressState | null;
}

function emptyBuffer(): Buffer {
  return { lines: [], artifacts: [], progress: null };
}

export function percent(progress: ProgressState): number {
  if (progress.total <= 0) return 0;
  return Math.min(100, (progress.done / progress.total) * 100);
}

export function useReporter(initialStatus = 'Idle.'): ReporterHandle {
  const [lines, setLines] = useState<readonly LogLine[]>([]);
  const [artifacts, setArtifacts] = useState<readonly Artifact[]>([]);
  const [trimmed, setTrimmed] = useState(0);
  const [progress, setProgress] = useState<ProgressState>({
    done: 0,
    total: 0,
    text: initialStatus,
  });

  /* The authoritative copies. State mirrors them so React re-renders, but the
   * appends themselves never run inside a state updater — an updater has to
   * stay pure, and under StrictMode it runs twice. */
  const lineStore = useRef<LogLine[]>([]);
  const artifactStore = useRef<Artifact[]>([]);
  const buffer = useRef<Buffer>(emptyBuffer());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  /* The last status line anyone set. `Reporter.progress` omits its `text`
   * argument on every chunk — that is how core moves the bar without
   * retitling — so the title has to survive both the flush that empties the
   * buffer and the render that follows it. */
  const statusText = useRef(initialStatus);

  const flush = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const pending = buffer.current;
    buffer.current = emptyBuffer();

    if (pending.lines.length > 0) {
      let next = lineStore.current.concat(pending.lines);
      let dropped = 0;
      if (next.length > MAX_LOG_LINES) {
        dropped = next.length - MAX_LOG_LINES;
        next = next.slice(dropped);
      }
      lineStore.current = next;
      setLines(next);
      if (dropped > 0) setTrimmed((count) => count + dropped);
    }
    if (pending.artifacts.length > 0) {
      const next = artifactStore.current.concat(pending.artifacts);
      artifactStore.current = next;
      setArtifacts(next);
    }
    if (pending.progress !== null) setProgress(pending.progress);
  }, []);

  const schedule = useCallback((): void => {
    if (timer.current !== null) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      flush();
    }, FLUSH_INTERVAL_MS);
  }, [flush]);

  const pushLine = useCallback(
    (text: string, level: LogLevel): void => {
      seq.current += 1;
      buffer.current.lines.push({ seq: seq.current, level, text });
      schedule();
    },
    [schedule],
  );

  const reporter = useMemo<Reporter>(
    () => ({
      log: (message, level) => {
        pushLine(message, level ?? 'info');
      },
      progress: (done, total, text) => {
        if (text !== undefined) statusText.current = text;
        buffer.current.progress = { done, total, text: statusText.current };
        /* The one event that must never be swallowed by the throttle. */
        if (total > 0 && done >= total) flush();
        else schedule();
      },
      artifact: (artifact) => {
        buffer.current.artifacts.push(artifact);
        schedule();
      },
    }),
    [flush, pushLine, schedule],
  );

  const setStatus = useCallback((text: string): void => {
    statusText.current = text;
    const previous = buffer.current.progress;
    if (previous !== null) buffer.current.progress = { ...previous, text };
    setProgress((current) => ({ ...current, text }));
  }, []);

  const reset = useCallback((text: string): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    buffer.current = emptyBuffer();
    lineStore.current = [];
    artifactStore.current = [];
    seq.current = 0;
    statusText.current = text;
    setLines([]);
    setArtifacts([]);
    setTrimmed(0);
    setProgress({ done: 0, total: 0, text });
  }, []);

  const log = useCallback(
    (text: string, level: LogLevel = 'info'): void => {
      pushLine(text, level);
      flush();
    },
    [flush, pushLine],
  );

  const collected = useCallback((): readonly Artifact[] => {
    flush();
    return artifactStore.current;
  }, [flush]);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  return useMemo(
    () => ({
      reporter,
      lines,
      progress,
      artifacts,
      trimmed,
      reset,
      log,
      setStatus,
      flush,
      collected,
    }),
    [reporter, lines, progress, artifacts, trimmed, reset, log, setStatus, flush, collected],
  );
}

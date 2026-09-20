/**
 * The bar / status line / log triplet that every long operation in the original
 * page had five copies of (`#bar`..`#bar5`, `#status`..`#status5`,
 * `#log`..`#log5`). One component, five instances.
 *
 * The accessibility that the original did not have:
 *   - the bar is a real `role="progressbar"` with a value and a text label, so
 *     a screen reader can be asked "how far along is it?";
 *   - the status line is an `aria-live="polite"` region, so progress is
 *     announced without stealing focus;
 *   - the log is `role="log"`, which assistive technology already understands
 *     as an append-only transcript.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import type { LogLevel } from '@seek-fw/core';
import { percent, type LogLine, type ProgressState } from '../hooks/useReporter';

const LEVEL_CLASS: Readonly<Record<LogLevel, string>> = {
  info: '',
  ok: 'l-ok',
  warn: 'l-warn',
  error: 'l-err',
  detail: 'l-dim',
};

export interface RunPanelProps {
  /** Used to tie the bar and the log to their labels. */
  readonly id: string;
  readonly label: string;
  readonly progress: ProgressState;
  readonly lines: readonly LogLine[];
  readonly trimmed: number;
}

export function RunPanel({ id, label, progress, lines, trimmed }: RunPanelProps): ReactElement {
  const logRef = useRef<HTMLDivElement | null>(null);
  const value = percent(progress);

  /* Follow the tail, the way the original's `log()` did. */
  useEffect(() => {
    const node = logRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [lines]);

  return (
    <>
      <div
        className="bar"
        role="progressbar"
        aria-label={`${label} progress`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
        aria-valuetext={progress.text}
      >
        <div className="fill" style={{ width: `${value.toFixed(2)}%` }} />
      </div>
      <div className="status" id={`${id}-status`} role="status" aria-live="polite">
        {progress.text}
      </div>
      {lines.length > 0 && (
        <div
          className="log"
          id={`${id}-log`}
          ref={logRef}
          role="log"
          aria-label={`${label} log`}
          tabIndex={0}
        >
          {trimmed > 0 && (
            <div className="l-dim">{`… ${String(trimmed)} earlier line(s) trimmed`}</div>
          )}
          {lines.map((line) => (
            <div key={line.seq} className={LEVEL_CLASS[line.level]}>
              {line.text === '' ? ' ' : line.text}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

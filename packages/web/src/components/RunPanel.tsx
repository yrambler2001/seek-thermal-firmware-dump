/**
 * The bar / status line / log triplet that every long operation in the
 * original page had five copies of (`#bar`..`#bar5`, `#status`..`#status5`,
 * `#log`..`#log5`). One component, five instances.
 *
 * The accessibility the original did not have, kept intact through the
 * redesign:
 *   - the bar is a real `role="progressbar"` with a value and a text label
 *     (Radix's Progress supplies the role and the value attributes), so a
 *     screen reader can be asked "how far along is it?";
 *   - the status line is an `aria-live="polite"` region, so progress is
 *     announced without stealing focus;
 *   - the log is `role="log"`, which assistive technology already understands
 *     as an append-only transcript, and is focusable so it can be scrolled by
 *     keyboard.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import { ScrollText, SquareActivity } from 'lucide-react';
import type { LogLevel } from '@seek-fw/core';
import { percent, type LogLine, type ProgressState } from '@/hooks/useReporter';
import { Progress } from './ui/progress';
import { cn } from '@/lib/utils';

/** The four log levels are the only four status colours in the tool. */
const LEVEL_CLASS: Readonly<Record<LogLevel, string>> = {
  info: 'text-foreground/85',
  ok: 'text-ok',
  warn: 'text-warn',
  error: 'text-destructive',
  detail: 'text-muted-foreground',
};

export interface RunPanelProps {
  /** Used to tie the bar and the log to their labels. */
  readonly id: string;
  readonly label: string;
  readonly progress: ProgressState;
  readonly lines: readonly LogLine[];
  readonly trimmed: number;
  /** The write panel's bar is red. Nothing else's is. */
  readonly tone?: 'default' | 'danger';
}

export function RunPanel({
  id,
  label,
  progress,
  lines,
  trimmed,
  tone = 'default',
}: RunPanelProps): ReactElement {
  const logRef = useRef<HTMLDivElement | null>(null);
  const value = percent(progress);

  /* Follow the tail, the way the original's `log()` did. */
  useEffect(() => {
    const node = logRef.current;
    if (node !== null) node.scrollTop = node.scrollHeight;
  }, [lines]);

  return (
    <div className="overflow-hidden rounded-lg border border-border/80 bg-sunken/50">
      <div className="flex items-center gap-2 border-b border-border/70 px-3 py-1.5">
        <SquareActivity
          aria-hidden="true"
          className={cn('size-3.5', tone === 'danger' ? 'text-destructive' : 'text-primary')}
        />
        <span className="text-[0.68rem] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {label}
        </span>
        <span className="ms-auto font-mono text-[0.72rem] text-muted-foreground tabular-nums">
          {`${value.toFixed(0)}%`}
        </span>
      </div>

      <div className="space-y-1.5 px-3 pt-2.5 pb-2">
        <Progress value={value} label={`${label} progress`} valueText={progress.text} tone={tone} />
        <div
          className="text-[0.82rem] text-muted-foreground [overflow-wrap:anywhere]"
          id={`${id}-status`}
          role="status"
          aria-live="polite"
        >
          {progress.text}
        </div>
      </div>

      {lines.length > 0 && (
        <div
          className="scrollbar-slim max-h-[22rem] overflow-y-auto border-t border-border/70 bg-sunken px-3 py-2 font-mono text-[0.76rem] leading-[1.5] whitespace-pre-wrap [overflow-wrap:anywhere]"
          id={`${id}-log`}
          ref={logRef}
          role="log"
          aria-label={`${label} log`}
          tabIndex={0}
        >
          {trimmed > 0 && (
            <div className="text-muted-foreground">{`… ${String(trimmed)} earlier line(s) trimmed`}</div>
          )}
          {lines.map((line) => (
            <div key={line.seq} className={LEVEL_CLASS[line.level]}>
              {line.text === '' ? ' ' : line.text}
            </div>
          ))}
        </div>
      )}

      {lines.length > 0 && (
        <div className="flex items-center gap-1.5 border-t border-border/70 px-3 py-1 text-[0.68rem] text-muted-foreground">
          <ScrollText aria-hidden="true" className="size-3" />
          {`${String(lines.length)} line${lines.length === 1 ? '' : 's'}`}
        </div>
      )}
    </div>
  );
}

/**
 * Core's `Reporter`, rendered to a terminal.
 *
 * The contract core asks for is three methods; everything interesting is in
 * how they land on a screen versus in a pipe:
 *
 *   - a dump reports progress thousands of times, so a TTY gets ONE line that
 *     is redrawn in place and a pipe gets a throttled plain line — never one
 *     line per chunk, which is what turns a CI log into 60 000 lines of bar;
 *   - the bar lives on stderr even when the log lives on stdout, so that
 *     `seek-fw info --json | jq` sees only JSON. Interleaving the two means
 *     erasing the bar before each log line and redrawing it afterwards;
 *   - `--quiet` silences both, and `detail` lines are for `--verbose` only.
 */

import type { Artifact, LogLevel, Reporter } from '@seek-fw/core';
import { paint, type Style } from './ansi.js';
import type { Sink } from './sink.js';

const LEVEL_STYLE: Record<LogLevel, Style> = {
  info: 'none',
  ok: 'green',
  warn: 'yellow',
  error: 'red',
  detail: 'dim',
};

/** Redraw interval on a TTY. Fast enough to look live, slow enough to be free. */
const TTY_REDRAW_MS = 80;
/** Line interval when the destination is a pipe. */
const PIPE_LINE_MS = 2000;
/** ... and additionally at every multiple of this many percent. */
const PIPE_LINE_STEP_PCT = 10;

export interface ReporterOptions {
  /** Where log lines go: stdout normally, stderr under `--json`. */
  readonly log: Sink;
  /** Where the progress bar goes. Always stderr. */
  readonly progress: Sink;
  readonly color: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  /** Injectable clock, so throttling is testable without waiting. */
  readonly now?: () => number;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit] ?? 'B'}`;
}

/**
 * Progress is usually in bytes, but the decrypt stage counts slots — so a
 * small total is shown as a plain count instead of "0 B / 4 B", which reads
 * like a broken byte counter.
 */
function amount(done: number, total: number): string {
  if (total <= 0) return formatBytes(done);
  if (total < 4096) return `${String(done)} / ${String(total)}`;
  return `${formatBytes(done)} / ${formatBytes(total)}`;
}

function bar(fraction: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(fraction * width)));
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

/**
 * A terminal `Reporter`. Also remembers every artifact a run produced, so a
 * cancelled dump can still be written out — the artifacts arrive through this
 * interface as each one is finalised, exactly as they do in the web UI.
 */
export class TerminalReporter implements Reporter {
  readonly artifacts: Artifact[] = [];

  private readonly logSink: Sink;
  private readonly progressSink: Sink;
  private readonly color: boolean;
  private readonly quiet: boolean;
  private readonly verbose: boolean;
  private readonly clock: () => number;

  private barVisible = false;
  private lastDrawAt = 0;
  private lastPctLine = -1;
  private lastText = '';

  constructor(options: ReporterOptions) {
    this.logSink = options.log;
    this.progressSink = options.progress;
    this.color = options.color;
    this.quiet = options.quiet;
    this.verbose = options.verbose;
    this.clock = options.now ?? ((): number => Date.now());
  }

  log(message: string, level: LogLevel = 'info'): void {
    if (this.quiet) return;
    if (level === 'detail' && !this.verbose) return;
    this.clearBar();
    /* No prefix of our own: core's lines are the product of careful wording
     * ("NOW UNPLUG AND REPLUG THE CAMERA."), and a decorated copy is not the
     * same warning. Colour carries the level; the words carry the meaning. */
    this.logSink.write(`${paint(message, LEVEL_STYLE[level], this.color)}\n`);
  }

  progress(done: number, total: number, text?: string): void {
    if (this.quiet) return;
    if (text !== undefined) this.lastText = text;
    const now = this.clock();
    const complete = total > 0 && done >= total;

    if (this.progressSink.isTty) {
      if (!complete && now - this.lastDrawAt < TTY_REDRAW_MS) return;
      this.lastDrawAt = now;
      this.drawBar(done, total);
      return;
    }

    const pct = total > 0 ? Math.floor((done / total) * 100) : -1;
    const step = pct < 0 ? -1 : Math.floor(pct / PIPE_LINE_STEP_PCT);
    const due = now - this.lastDrawAt >= PIPE_LINE_MS || step !== this.lastPctLine || complete;
    if (!due) return;
    this.lastDrawAt = now;
    this.lastPctLine = step;
    this.progressSink.write(`${this.plainLine(done, total)}\n`);
  }

  artifact(artifact: Artifact): void {
    this.artifacts.push(artifact);
    this.log(`  + ${artifact.name} (${formatBytes(artifact.data.length)})`, 'detail');
  }

  /** Erases the bar for good. Called before the final human or JSON output. */
  finish(): void {
    this.clearBar();
  }

  /** Writes a line to the log sink with no level decoration. */
  write(text: string): void {
    this.clearBar();
    this.logSink.write(text.endsWith('\n') ? text : `${text}\n`);
  }

  private plainLine(done: number, total: number): string {
    const pct = total > 0 ? `${String(Math.floor((done / total) * 100))}%` : '...';
    const text = this.lastText === '' ? '' : ` ${this.lastText}`;
    return `progress: ${pct} (${amount(done, total)})${text}`;
  }

  private drawBar(done: number, total: number): void {
    const columns = this.progressSink.columns ?? 80;
    const fraction = total > 0 ? Math.min(1, done / total) : 0;
    const pct = total > 0 ? `${String(Math.floor(fraction * 100)).padStart(3, ' ')}%` : '  --';
    const head = `${bar(fraction, 24)} ${pct}  ${amount(done, total)}`;
    const tail = this.lastText === '' ? '' : `  ${this.lastText}`;
    const line = `${head}${tail}`.slice(0, Math.max(10, columns - 1));
    this.progressSink.write(`\r\u001B[2K${paint(line, 'dim', this.color)}`);
    this.barVisible = true;
  }

  private clearBar(): void {
    if (!this.barVisible) return;
    this.barVisible = false;
    if (this.progressSink.isTty) this.progressSink.write('\r\u001B[2K');
    else this.progressSink.write('\n');
  }
}

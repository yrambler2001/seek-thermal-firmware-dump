/** Severity of a line written to a run log. Maps to CSS classes in the web UI
 *  and to colours in the CLI. */
export type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'detail';

export interface LogEvent {
  readonly type: 'log';
  readonly level: LogLevel;
  readonly message: string;
}

export interface ProgressEvent {
  readonly type: 'progress';
  /** Units completed. Same unit as `total` (usually bytes). */
  readonly done: number;
  /** Total units, or 0 when indeterminate. */
  readonly total: number;
  /** Human-readable status line. Omitted to update the bar without retitling. */
  readonly text?: string;
}

/** A file produced by a workflow, ready to be zipped, downloaded or written to disk. */
export interface Artifact {
  /** POSIX-style path relative to the output directory. */
  readonly name: string;
  readonly data: Uint8Array;
}

export interface ArtifactEvent {
  readonly type: 'artifact';
  readonly artifact: Artifact;
}

export type RunEvent = LogEvent | ProgressEvent | ArtifactEvent;

/**
 * Sink a workflow reports through. Both the React app and the CLI implement
 * this; nothing in core knows which one it is talking to.
 */
export interface Reporter {
  log(message: string, level?: LogLevel): void;
  progress(done: number, total: number, text?: string): void;
  /** Called as soon as each artifact is final, so a consumer may stream it. */
  artifact(artifact: Artifact): void;
}

/** Reporter that discards everything. Useful in tests and for headless calls. */
export const silentReporter: Reporter = {
  log: () => undefined,
  progress: () => undefined,
  artifact: () => undefined,
};

/** Wraps a Reporter so every log line is prefixed. */
export function prefixed(inner: Reporter, prefix: string): Reporter {
  return {
    log: (message, level) => {
      inner.log(`${prefix}${message}`, level);
    },
    progress: (done, total, text) => {
      inner.progress(done, total, text);
    },
    artifact: (artifact) => {
      inner.artifact(artifact);
    },
  };
}

/** Collects every event, for tests and for buffered consumers. */
export function collectingReporter(): Reporter & { readonly events: RunEvent[] } {
  const events: RunEvent[] = [];
  return {
    events,
    log: (message, level = 'info') => {
      events.push({ type: 'log', level, message });
    },
    progress: (done, total, text) => {
      events.push(
        text === undefined
          ? { type: 'progress', done, total }
          : { type: 'progress', done, total, text },
      );
    },
    artifact: (artifact) => {
      events.push({ type: 'artifact', artifact });
    },
  };
}

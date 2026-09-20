/** Severity of a line written to a run log. Maps to CSS classes in the web UI
 *  and to colours in the CLI. */
export type LogLevel = 'info' | 'ok' | 'warn' | 'error' | 'detail';

export interface LogEvent {
  readonly type: 'log';
  readonly level: LogLevel;
  readonly message: string;
}

/**
 * What `done` and `total` count. A dump reports bytes and the decrypt stage
 * reports slots, so without this a renderer formatting "4 B / 4 B" is wrong
 * half the time. Defaults to `bytes`, which is what most of a run reports.
 */
export type ProgressUnit = 'bytes' | 'items';

export interface ProgressEvent {
  readonly type: 'progress';
  /** Units completed, counted in `unit`. */
  readonly done: number;
  /** Total units, or 0 when indeterminate. */
  readonly total: number;
  /** Human-readable status line. Omitted to update the bar without retitling. */
  readonly text?: string;
  readonly unit?: ProgressUnit;
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
  progress(done: number, total: number, text?: string, unit?: ProgressUnit): void;
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
    progress: (done, total, text, unit) => {
      inner.progress(done, total, text, unit);
    },
    artifact: (artifact) => {
      inner.artifact(artifact);
    },
  };
}

/**
 * Wraps a Reporter so every log line's level is rewritten by `map`. Returning
 * `null` drops the line entirely.
 *
 * This exists because severity is a property of the message, but whether a
 * given severity should be *shown* is a property of the front end and of what
 * it is doing. The flash path is the case that forced it: core emits the
 * post-commit "the bootloader may still refuse this slot" explanation at
 * `detail`, which a CLI would normally hide behind `--verbose` — and that is
 * precisely the warning a user must not miss.
 */
export function withLevelMap(
  inner: Reporter,
  map: (level: LogLevel, message: string) => LogLevel | null,
): Reporter {
  return {
    log: (message, level = 'info') => {
      const mapped = map(level, message);
      if (mapped !== null) inner.log(message, mapped);
    },
    progress: (done, total, text, unit) => {
      inner.progress(done, total, text, unit);
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
    progress: (done, total, text, unit) => {
      /* Optional fields are omitted rather than set to undefined, so a consumer
       * spreading the event cannot clobber a retained status line with a hole. */
      events.push({
        type: 'progress',
        done,
        total,
        ...(text === undefined ? {} : { text }),
        ...(unit === undefined ? {} : { unit }),
      });
    },
    artifact: (artifact) => {
      events.push({ type: 'artifact', artifact });
    },
  };
}

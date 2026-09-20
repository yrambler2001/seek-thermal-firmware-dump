/**
 * Ctrl-C, and the two things `process.on('SIGINT', ...)` alone gets wrong.
 *
 * The first is lifetime: the handler belongs to the RUN, not to the process.
 * Left installed, a Ctrl-C after the work is over still answers "stopping at
 * the next safe point" for a run that has already stopped — so `release()` is
 * called the moment `run` returns and the default signal behaviour comes back.
 *
 * The second is the hard exit. `process.exit` drops whatever stdout has handed
 * to a pipe but not yet drained, and the `--json` document is written in one
 * go at the very end: a second Ctrl-C in that window would deliver half a
 * document to a script that is parsing it. So the quit waits for the stream to
 * drain — and quits anyway on a deadline, because the second Ctrl-C means now.
 */

import { EXIT_CANCELLED } from './errors.js';

export interface SignalTarget {
  on(event: 'SIGINT', handler: () => void): void;
  off(event: 'SIGINT', handler: () => void): void;
}

/** As much of `process.stdout` as the flush-aware exit needs. */
export interface DrainableStream {
  /** Bytes buffered inside the stream that the OS has not taken yet. */
  readonly writableLength: number;
  write(chunk: string, callback: () => void): unknown;
}

/** How long a stuck stdout may delay the second Ctrl-C. */
export const FLUSH_DEADLINE_MS = 2000;

export const FIRST_INTERRUPT =
  '\ninterrupted — stopping at the next safe point and keeping what has already been read ' +
  '(Ctrl-C again to quit immediately)\n';

export const SECOND_INTERRUPT = '\nquitting now\n';

export interface InterruptOptions {
  readonly target: SignalTarget;
  /** The stream whose buffer must not be truncated by the hard exit. */
  readonly stdout: DrainableStream;
  /** Where the two notices go. Always stderr. */
  readonly warn: (text: string) => void;
  /** Asks the run to stop at its next loop boundary. */
  readonly abort: () => void;
  readonly exit: (code: number) => void;
  readonly flushDeadlineMs?: number;
}

export interface InterruptHandle {
  /** Stops listening. Idempotent, so a `finally` can always call it. */
  release(): void;
}

/**
 * Quits once `stream` has nothing left buffered, or after `deadlineMs`,
 * whichever comes first. Exactly one of the two wins.
 */
export function exitWhenFlushed(
  stream: DrainableStream,
  code: number,
  exit: (code: number) => void,
  deadlineMs: number,
): void {
  if (stream.writableLength === 0) {
    exit(code);
    return;
  }
  let done = false;
  const quit = (): void => {
    if (done) return;
    done = true;
    clearTimeout(deadline);
    exit(code);
  };
  const deadline = setTimeout(quit, deadlineMs);
  /* The deadline must not be the reason the process stays alive. */
  deadline.unref();
  /* Write callbacks run in order, so an empty write is a marker for
   * "everything queued before this has reached the OS". */
  stream.write('', quit);
}

/** Installs the SIGINT handler and hands back the way to take it off again. */
export function installInterruptHandler(options: InterruptOptions): InterruptHandle {
  const deadlineMs = options.flushDeadlineMs ?? FLUSH_DEADLINE_MS;
  let interrupts = 0;
  let released = false;

  const handler = (): void => {
    interrupts += 1;
    if (interrupts === 1) {
      options.warn(FIRST_INTERRUPT);
      options.abort();
      return;
    }
    options.warn(SECOND_INTERRUPT);
    exitWhenFlushed(options.stdout, EXIT_CANCELLED, options.exit, deadlineMs);
  };

  options.target.on('SIGINT', handler);
  return {
    release(): void {
      if (released) return;
      released = true;
      options.target.off('SIGINT', handler);
    },
  };
}

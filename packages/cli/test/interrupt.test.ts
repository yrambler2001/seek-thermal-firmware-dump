/**
 * Ctrl-C, without a process.
 *
 * Both of these are failures nobody sees until they matter: a handler that
 * outlives its run answers for a run that is over, and a hard exit that does
 * not wait for stdout hands a script half a JSON document.
 */

import { describe, expect, it } from 'vitest';
import { EXIT_CANCELLED } from '../src/errors.js';
import {
  FIRST_INTERRUPT,
  SECOND_INTERRUPT,
  installInterruptHandler,
  type DrainableStream,
  type SignalTarget,
} from '../src/interrupt.js';

function fakeTarget(): { target: SignalTarget; raise: () => void; listeners: () => number } {
  const handlers = new Set<() => void>();
  return {
    target: {
      on(_event: 'SIGINT', handler: () => void): void {
        handlers.add(handler);
      },
      off(_event: 'SIGINT', handler: () => void): void {
        handlers.delete(handler);
      },
    },
    raise: (): void => {
      for (const handler of [...handlers]) handler();
    },
    listeners: (): number => handlers.size,
  };
}

/** A stdout that holds its bytes until the test lets them go. */
class PendingStream implements DrainableStream {
  writableLength = 0;
  private readonly callbacks: (() => void)[] = [];

  queue(bytes: number): void {
    this.writableLength += bytes;
  }

  write(_chunk: string, callback: () => void): boolean {
    this.callbacks.push(callback);
    return true;
  }

  drain(): void {
    this.writableLength = 0;
    for (const callback of this.callbacks.splice(0)) callback();
  }
}

interface Harness {
  readonly warnings: string[];
  readonly exits: number[];
  aborted: boolean;
}

function install(stream: DrainableStream, flushDeadlineMs = 10_000) {
  const signals = fakeTarget();
  const state: Harness = { warnings: [], exits: [], aborted: false };
  const handle = installInterruptHandler({
    target: signals.target,
    stdout: stream,
    warn: (text) => state.warnings.push(text),
    abort: () => {
      state.aborted = true;
    },
    exit: (code) => state.exits.push(code),
    flushDeadlineMs,
  });
  return { ...signals, state, handle };
}

describe('installInterruptHandler', () => {
  it('asks the run to stop on the first interrupt and quits on the second', () => {
    const stream = new PendingStream();
    const { raise, state } = install(stream);

    raise();
    expect(state.aborted).toBe(true);
    expect(state.warnings).toEqual([FIRST_INTERRUPT]);
    expect(state.exits).toEqual([]);

    raise();
    expect(state.warnings).toEqual([FIRST_INTERRUPT, SECOND_INTERRUPT]);
    expect(state.exits).toEqual([EXIT_CANCELLED]);
  });

  it('waits for a buffered stdout before the hard exit, so a document is never cut', () => {
    const stream = new PendingStream();
    stream.queue(4096); /* a --json document on its way to a pipe */
    const { raise, state } = install(stream);

    raise();
    raise();
    /* The notice is out, but the process is still here. */
    expect(state.warnings).toContain(SECOND_INTERRUPT);
    expect(state.exits).toEqual([]);

    stream.drain();
    expect(state.exits).toEqual([EXIT_CANCELLED]);
  });

  it('quits anyway when stdout never drains', async () => {
    const stream = new PendingStream();
    stream.queue(4096);
    const { raise, state } = install(stream, 5);

    raise();
    raise();
    expect(state.exits).toEqual([]);

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 25);
    });
    expect(state.exits).toEqual([EXIT_CANCELLED]);

    /* And the deadline having fired does not mean a second exit when the
     * stream finally does drain. */
    stream.drain();
    expect(state.exits).toEqual([EXIT_CANCELLED]);
  });

  it('stops listening once released, and can be released twice', () => {
    const stream = new PendingStream();
    const { raise, state, handle, listeners } = install(stream);

    expect(listeners()).toBe(1);
    handle.release();
    handle.release();
    expect(listeners()).toBe(0);

    raise();
    expect(state.warnings).toEqual([]);
    expect(state.aborted).toBe(false);
  });
});

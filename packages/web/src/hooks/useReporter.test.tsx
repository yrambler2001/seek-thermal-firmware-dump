import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '../test-helpers';
import { FLUSH_INTERVAL_MS, MAX_LOG_LINES, percent, useReporter } from './useReporter';

function tick(ms = FLUSH_INTERVAL_MS): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useReporter', () => {
  it('batches log lines instead of rendering one per event', () => {
    const { result, unmount } = renderHook(() => useReporter());

    act(() => {
      for (let i = 0; i < 500; i++) result.current.reporter.log(`line ${String(i)}`, 'detail');
    });
    /* Still buffered: 500 renders is exactly what melts the UI mid-dump. */
    expect(result.current.lines).toHaveLength(0);

    tick();
    expect(result.current.lines).toHaveLength(500);
    expect(result.current.lines[0]?.text).toBe('line 0');
    expect(result.current.lines[499]?.text).toBe('line 499');
    unmount();
  });

  it('preserves severity and order across a batch', () => {
    const { result, unmount } = renderHook(() => useReporter());
    act(() => {
      result.current.reporter.log('plain');
      result.current.reporter.log('good', 'ok');
      result.current.reporter.log('careful', 'warn');
      result.current.reporter.log('broken', 'error');
      result.current.reporter.log('aside', 'detail');
    });
    tick();
    expect(result.current.lines.map((line) => [line.text, line.level])).toEqual([
      ['plain', 'info'],
      ['good', 'ok'],
      ['careful', 'warn'],
      ['broken', 'error'],
      ['aside', 'detail'],
    ]);
    unmount();
  });

  it('throttles progress but always lands the final 100%', () => {
    const { result, unmount } = renderHook(() => useReporter('Idle.'));
    expect(result.current.progress).toEqual({ done: 0, total: 0, text: 'Idle.' });

    act(() => {
      result.current.reporter.progress(1, 100, 'reading ...');
      result.current.reporter.progress(2, 100);
      result.current.reporter.progress(3, 100);
    });
    /* Throttled: nothing has reached React yet. */
    expect(result.current.progress.done).toBe(0);

    tick();
    /* Only the newest value is applied — the intermediate ones are dropped,
     * which is the whole point of the buffer. */
    expect(result.current.progress).toEqual({ done: 3, total: 100, text: 'reading ...' });

    act(() => {
      result.current.reporter.progress(50, 100);
    });
    expect(result.current.progress.done).toBe(3);

    /* done >= total bypasses the throttle, with no timer advanced at all. */
    act(() => {
      result.current.reporter.progress(100, 100, 'Done.');
    });
    expect(result.current.progress).toEqual({ done: 100, total: 100, text: 'Done.' });
    unmount();
  });

  it('keeps the last status text when progress omits one', () => {
    const { result, unmount } = renderHook(() => useReporter());
    act(() => {
      result.current.reporter.progress(1, 10, 'reading window 1 ...');
    });
    tick();
    act(() => {
      result.current.reporter.progress(4, 10);
    });
    tick();
    expect(result.current.progress).toEqual({ done: 4, total: 10, text: 'reading window 1 ...' });
    unmount();
  });

  it('collects artifacts and exposes them before the next render', () => {
    const { result, unmount } = renderHook(() => useReporter());
    const artifact = { name: 'windows/addr_14000000.bin', data: new Uint8Array([1, 2, 3]) };
    act(() => {
      result.current.reporter.artifact(artifact);
    });
    /* `collected()` drains the buffer, which is what a cancelled dump needs
     * from inside its catch block. */
    let collected: readonly { name: string }[] = [];
    act(() => {
      collected = result.current.collected();
    });
    expect(collected.map((file) => file.name)).toEqual(['windows/addr_14000000.bin']);
    expect(result.current.artifacts).toHaveLength(1);
    unmount();
  });

  it('trims the oldest lines rather than growing without bound', () => {
    const { result, unmount } = renderHook(() => useReporter());
    act(() => {
      for (let i = 0; i < MAX_LOG_LINES + 25; i++) result.current.reporter.log(String(i));
    });
    tick();
    expect(result.current.lines).toHaveLength(MAX_LOG_LINES);
    expect(result.current.trimmed).toBe(25);
    expect(result.current.lines[0]?.text).toBe('25');
    unmount();
  });

  it('reset clears the log, the artifacts and the bar', () => {
    const { result, unmount } = renderHook(() => useReporter('Idle.'));
    act(() => {
      result.current.reporter.log('something');
      result.current.reporter.progress(5, 5, 'Done.');
    });
    tick();
    expect(result.current.lines).toHaveLength(1);

    act(() => {
      result.current.reset('Starting ...');
    });
    expect(result.current.lines).toHaveLength(0);
    expect(result.current.artifacts).toHaveLength(0);
    expect(result.current.progress).toEqual({ done: 0, total: 0, text: 'Starting ...' });
    unmount();
  });

  it('log() from the UI itself lands immediately', () => {
    const { result, unmount } = renderHook(() => useReporter());
    act(() => {
      result.current.log('selected CompactPRO', 'ok');
    });
    expect(result.current.lines.map((line) => line.text)).toEqual(['selected CompactPRO']);
    unmount();
  });
});

describe('percent', () => {
  it('is zero for an indeterminate bar and clamps at 100', () => {
    expect(percent({ done: 5, total: 0, text: '' })).toBe(0);
    expect(percent({ done: 25, total: 100, text: '' })).toBe(25);
    expect(percent({ done: 400, total: 100, text: '' })).toBe(100);
  });
});

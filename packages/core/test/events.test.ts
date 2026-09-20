import { describe, expect, it } from 'vitest';

import {
  collectingReporter,
  prefixed,
  silentReporter,
  withLevelMap,
  type LogLevel,
  type ProgressEvent,
  type Reporter,
} from '../src/events.js';

const progressEvents = (events: readonly { type: string }[]): ProgressEvent[] =>
  events.filter((e): e is ProgressEvent => e.type === 'progress');

describe('collectingReporter', () => {
  it('records level, order and the omission of optional fields', () => {
    const r = collectingReporter();
    r.log('plain');
    r.log('bad', 'error');
    r.progress(1, 2);
    r.progress(2, 2, 'done', 'items');

    expect(r.events).toEqual([
      { type: 'log', level: 'info', message: 'plain' },
      { type: 'log', level: 'error', message: 'bad' },
      /* no `text` and no `unit` keys at all, so a consumer spreading the event
       * cannot overwrite a retained status line with undefined */
      { type: 'progress', done: 1, total: 2 },
      { type: 'progress', done: 2, total: 2, text: 'done', unit: 'items' },
    ]);
  });
});

describe('prefixed', () => {
  it('prefixes log lines and passes progress through unchanged, unit included', () => {
    const inner = collectingReporter();
    const r = prefixed(inner, 'decrypt: ');
    r.log('scanning', 'detail');
    r.progress(3, 9, 'slot 2', 'items');

    expect(inner.events[0]).toEqual({ type: 'log', level: 'detail', message: 'decrypt: scanning' });
    expect(progressEvents(inner.events)[0]).toEqual({
      type: 'progress',
      done: 3,
      total: 9,
      text: 'slot 2',
      unit: 'items',
    });
  });
});

describe('withLevelMap', () => {
  it('rewrites the level a line is reported at', () => {
    const inner = collectingReporter();
    /* The flash path's case: during a write, `detail` is not noise — core's
     * post-commit "the bootloader may still refuse this slot" explanation must
     * not be hidden behind a verbosity flag. */
    const loud = withLevelMap(inner, (level) => (level === 'detail' ? 'info' : level));
    loud.log('streamed 49152 B', 'detail');
    loud.log('committed', 'ok');

    expect(inner.events).toEqual([
      { type: 'log', level: 'info', message: 'streamed 49152 B' },
      { type: 'log', level: 'ok', message: 'committed' },
    ]);
  });

  it('drops a line when the mapper returns null', () => {
    const inner = collectingReporter();
    const quiet = withLevelMap(inner, (level) => (level === 'detail' ? null : level));
    quiet.log('noise', 'detail');
    quiet.log('kept', 'warn');

    expect(inner.events).toEqual([{ type: 'log', level: 'warn', message: 'kept' }]);
  });

  it('defaults an unlevelled line to info before mapping, and sees the message', () => {
    const seen: [LogLevel, string][] = [];
    const r = withLevelMap(silentReporter, (level, message) => {
      seen.push([level, message]);
      return level;
    });
    r.log('no level given');

    expect(seen).toEqual([['info', 'no level given']]);
  });

  it('forwards progress and artifacts untouched', () => {
    const inner = collectingReporter();
    const r: Reporter = withLevelMap(inner, (level) => level);
    const artifact = { name: 'windows/addr_14030000.bin', data: new Uint8Array([1, 2, 3]) };
    r.progress(4096, 65536, 'reading ...', 'bytes');
    r.artifact(artifact);

    expect(progressEvents(inner.events)[0]).toEqual({
      type: 'progress',
      done: 4096,
      total: 65536,
      text: 'reading ...',
      unit: 'bytes',
    });
    expect(inner.events.at(-1)).toEqual({ type: 'artifact', artifact });
  });
});

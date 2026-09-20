import { describe, expect, it } from 'vitest';
import { DEFAULT_DUMP_OPTIONS, WINDOW_SIZE, resolveDumpOptions } from '@seek-fw/core';
import {
  DEFAULT_OPTIONS_FORM,
  OptionsError,
  parseNum,
  readOptions,
  type OptionsForm,
} from './options';

function form(overrides: Partial<OptionsForm> = {}): OptionsForm {
  return { ...DEFAULT_OPTIONS_FORM, ...overrides };
}

function failure(overrides: Partial<OptionsForm>): OptionsError {
  try {
    readOptions(form(overrides));
  } catch (error) {
    if (error instanceof OptionsError) return error;
    throw error;
  }
  throw new Error('expected readOptions to reject');
}

describe('parseNum', () => {
  it('reads decimal, hex and falls back on anything else', () => {
    expect(parseNum('64', 1)).toBe(64);
    expect(parseNum('0xff', 1)).toBe(255);
    expect(parseNum('0XFF', 1)).toBe(255);
    expect(parseNum('  256  ', 1)).toBe(256);
    expect(parseNum('', 7)).toBe(7);
    expect(parseNum(null, 7)).toBe(7);
    expect(parseNum('nonsense', 7)).toBe(7);
  });
});

describe('readOptions', () => {
  it('accepts the original page defaults', () => {
    expect(readOptions(form())).toEqual({
      chunk: 64,
      gapFill: 0xff,
      retries: 2,
      retryDelayMs: 500,
      decrypt: true,
      recipient: 'auto',
    });
  });

  it("parses the form defaults to exactly core's defaults", () => {
    /* The form holds the original page's `value=` strings and core holds
     * numbers, so nothing but this test stops the two drifting apart. */
    const parsed = readOptions(form());
    expect({
      chunk: parsed.chunk,
      gapFill: parsed.gapFill,
      retries: parsed.retries,
      retryDelayMs: parsed.retryDelayMs,
      decrypt: parsed.decrypt,
    }).toEqual(DEFAULT_DUMP_OPTIONS);
  });

  it('accepts a chunk of exactly one window, and nothing past it', () => {
    /* The ceiling is core's WINDOW_SIZE, not a 65536 written twice. */
    expect(readOptions(form({ chunk: String(WINDOW_SIZE) })).chunk).toBe(WINDOW_SIZE);
    expect(failure({ chunk: String(WINDOW_SIZE + 1) }).field).toBe('chunk');
  });

  it('produces something core also accepts', () => {
    const { chunk, gapFill, retries, retryDelayMs, decrypt } = readOptions(
      form({ chunk: '256', gapFill: '0x00', retries: '0', retryDelay: '0', decrypt: false }),
    );
    expect(resolveDumpOptions({ chunk, gapFill, retries, retryDelayMs, decrypt })).toEqual({
      chunk: 256,
      gapFill: 0,
      retries: 0,
      retryDelayMs: 0,
      decrypt: false,
    });
  });

  it('rejects a chunk outside 1..65536 with the original message', () => {
    expect(failure({ chunk: '99999' }).message).toBe(
      'chunk must be between 1 and 65536, got 99999',
    );
    expect(failure({ chunk: '0' }).message).toBe('chunk must be between 1 and 65536, got 0');
    expect(failure({ chunk: '-4' }).field).toBe('chunk');
  });

  it('rejects a gap-fill wider than one byte with the original message', () => {
    expect(failure({ gapFill: '0x1ff' }).message).toBe('gap-fill must be a single byte, got 0x1ff');
    expect(failure({ gapFill: '0x1ff' }).field).toBe('gapFill');
    expect(failure({ gapFill: '-1' }).message).toBe('gap-fill must be a single byte, got -1');
  });

  it('rejects negative retries with the original message', () => {
    expect(failure({ retries: '-1' }).message).toBe('retries must be zero or more, got -1');
    expect(failure({ retries: '-1' }).field).toBe('retries');
  });

  it('rejects a negative retry delay with the original message', () => {
    expect(failure({ retryDelay: '-50' }).message).toBe(
      'retry delay must be zero or more, got -50',
    );
    expect(failure({ retryDelay: '-50' }).field).toBe('retryDelay');
  });

  it('keeps the raw text in the message, not the parsed number', () => {
    /* "got 0x1ff" is what makes the typo obvious; "got 511" would not. */
    expect(failure({ gapFill: '0x1ff' }).message.endsWith('got 0x1ff')).toBe(true);
  });
});

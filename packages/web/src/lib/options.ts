/**
 * The read-options form, ported from the original page's `readOptions()`.
 *
 * Core has its own `resolveDumpOptions`, and it is the real gate — but it
 * validates numbers, and the form holds strings. This module does what the
 * original did: parse each field the way `parseNum` did, range-check it, and
 * throw with the original's message naming the raw text the user typed. The
 * field name rides along so the UI can point at the input that is wrong.
 */

import { DEFAULT_DUMP_OPTIONS, WINDOW_SIZE, isSeekError } from '@seek-fw/core';

export type RecipientChoice = 'auto' | 'interface' | 'device';

export type OptionField = 'chunk' | 'gapFill' | 'retries' | 'retryDelay';

export interface OptionsForm {
  readonly chunk: string;
  readonly gapFill: string;
  readonly retries: string;
  readonly retryDelay: string;
  readonly recipient: RecipientChoice;
  readonly decrypt: boolean;
}

/** The original page's `value=` attributes, exactly. They are strings
 *  because the form is; `options.test.ts` checks that they parse to core's
 *  `DEFAULT_DUMP_OPTIONS`, so the two cannot drift apart unnoticed. */
export const DEFAULT_OPTIONS_FORM: OptionsForm = {
  chunk: '64',
  gapFill: '0xff',
  retries: '2',
  retryDelay: '500',
  recipient: 'auto',
  decrypt: true,
};

/** Structurally core's `DumpOptions`; kept independent so this stays pure. */
export interface ResolvedDumpOptions {
  readonly chunk: number;
  readonly gapFill: number;
  readonly retries: number;
  readonly retryDelayMs: number;
  readonly decrypt: boolean;
}

export interface ResolvedOptions extends ResolvedDumpOptions {
  readonly recipient: RecipientChoice;
}

export class OptionsError extends Error {
  readonly field: OptionField;

  constructor(field: OptionField, message: string) {
    super(message);
    this.name = 'OptionsError';
    this.field = field;
  }
}

/** What the UI needs to show a rejected option: which input, and why. */
export interface OptionsFailure {
  readonly field: OptionField | null;
  readonly message: string;
}

/** Core's own field names for the same four knobs. */
const CORE_FIELD: Readonly<Record<string, OptionField>> = {
  chunk: 'chunk',
  gapFill: 'gapFill',
  retries: 'retries',
  retryDelayMs: 'retryDelay',
};

/**
 * Turns an unknown throw into an options failure, or null when it is not one.
 *
 * Two sources produce these. `readOptions` below rejects first, with the
 * original page's wording. Core's `resolveDumpOptions` is the backstop, and it
 * names the offending knob in `SeekError.detail.option` — which is read here
 * rather than scraped out of the message, exactly as core intends.
 */
export function asOptionsFailure(error: unknown): OptionsFailure | null {
  if (error instanceof OptionsError) return { field: error.field, message: error.message };
  if (isSeekError(error) && error.code === 'options/invalid') {
    const named = error.detail?.option;
    return {
      field: typeof named === 'string' ? (CORE_FIELD[named] ?? null) : null,
      message: error.message,
    };
  }
  return null;
}

/** The original's `parseNum`: decimal or `0x`-prefixed hex, else the fallback. */
export function parseNum(text: string | null | undefined, fallback: number): number {
  if (text == null || text === '') return fallback;
  const trimmed = text.trim();
  const value =
    trimmed.startsWith('0x') || trimmed.startsWith('0X')
      ? Number.parseInt(trimmed, 16)
      : Number.parseInt(trimmed, 10);
  return Number.isNaN(value) ? fallback : value;
}

/**
 * Validates the form. Throws `OptionsError` carrying the original page's
 * message — including the raw text, which is the part that makes a typo
 * obvious ("got 0x1ff" rather than "got 511").
 */
export function readOptions(form: OptionsForm): ResolvedOptions {
  const chunk = parseNum(form.chunk, DEFAULT_DUMP_OPTIONS.chunk);
  if (!Number.isInteger(chunk) || chunk <= 0 || chunk > WINDOW_SIZE) {
    throw new OptionsError(
      'chunk',
      /* The ceiling is core's window size, not a copy of it: a form that
       * accepted a chunk core rejects would fail in the middle of a run. */
      `chunk must be between 1 and ${String(WINDOW_SIZE)}, got ${form.chunk}`,
    );
  }
  const gapFill = parseNum(form.gapFill, DEFAULT_DUMP_OPTIONS.gapFill);
  if (!Number.isInteger(gapFill) || gapFill < 0 || gapFill > 0xff) {
    throw new OptionsError('gapFill', `gap-fill must be a single byte, got ${form.gapFill}`);
  }
  const retries = parseNum(form.retries, DEFAULT_DUMP_OPTIONS.retries);
  if (!Number.isInteger(retries) || retries < 0) {
    throw new OptionsError('retries', `retries must be zero or more, got ${form.retries}`);
  }
  const retryDelayMs = parseNum(form.retryDelay, DEFAULT_DUMP_OPTIONS.retryDelayMs);
  if (!Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    throw new OptionsError(
      'retryDelay',
      `retry delay must be zero or more, got ${form.retryDelay}`,
    );
  }
  return {
    chunk,
    gapFill,
    retries,
    retryDelayMs,
    decrypt: form.decrypt,
    recipient: form.recipient,
  };
}

/**
 * The whole colour layer: a handful of SGR escapes and one decision about
 * whether to emit them at all.
 *
 * No dependency for this. `chalk` would be 100 KB to wrap eight escape codes
 * that have not changed since 1979.
 */

/** Styles this CLI uses. `none` exists so a caller can stay branch-free. */
export type Style = 'none' | 'bold' | 'dim' | 'red' | 'green' | 'yellow' | 'blue' | 'cyan';

const CODES: Record<Style, readonly [string, string]> = {
  none: ['', ''],
  bold: ['\u001B[1m', '\u001B[22m'],
  dim: ['\u001B[2m', '\u001B[22m'],
  red: ['\u001B[31m', '\u001B[39m'],
  green: ['\u001B[32m', '\u001B[39m'],
  yellow: ['\u001B[33m', '\u001B[39m'],
  blue: ['\u001B[34m', '\u001B[39m'],
  cyan: ['\u001B[36m', '\u001B[39m'],
};

/** Paints `text` when `enabled`, and is the identity function when it is not. */
export function paint(text: string, style: Style, enabled: boolean): string {
  if (!enabled || style === 'none') return text;
  const [on, off] = CODES[style];
  return `${on}${text}${off}`;
}

export interface ColorEnvironment {
  /** `--no-color` was passed. */
  readonly noColorFlag?: boolean;
  /** The destination is a terminal. */
  readonly isTty: boolean;
  /** Process environment, for NO_COLOR / FORCE_COLOR / TERM. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Colour is on only for a TTY that has not been told otherwise.
 *
 * `NO_COLOR` (any value, per no-color.org) and `TERM=dumb` both turn it off;
 * `FORCE_COLOR` turns it on even when stdout is a pipe, which is what CI logs
 * with ANSI rendering want.
 */
export function shouldColor(environment: ColorEnvironment): boolean {
  const env = environment.env ?? {};
  if (environment.noColorFlag === true) return false;
  const { NO_COLOR, TERM, FORCE_COLOR } = env;
  if (NO_COLOR !== undefined && NO_COLOR !== '') return false;
  if (TERM === 'dumb') return false;
  if (FORCE_COLOR !== undefined && FORCE_COLOR !== '' && FORCE_COLOR !== '0') return true;
  return environment.isTty;
}

/** Strips every SGR sequence. Used by the tests and by width measurement. */
export function stripAnsi(text: string): string {
  /* eslint-disable-next-line no-control-regex -- matching control codes is the point */
  return text.replace(/\u001B\[[0-9;]*m/g, '');
}

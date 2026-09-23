/**
 * Error taxonomy. Callers branch on `code`, never on message text — messages are
 * for humans and are expected to change.
 */
export type SeekErrorCode =
  /** A caller passed an option outside its accepted range. */
  | 'options/invalid'
  | 'usb/transfer-failed'
  | 'usb/timeout'
  | 'usb/stalled'
  | 'usb/not-open'
  | 'device/error-code'
  | 'device/mode'
  | 'device/window'
  /**
   * The camera did not report its firmware version, so nothing that could mean
   * something else on another build was sent. See `SAFE_BEFORE_IDENTITY`.
   */
  | 'device/version-unknown'
  | 'image/malformed'
  | 'image/unsupported'
  | 'image/key-table'
  | 'flash/refused'
  | 'flash/commit'
  | 'profile/unsupported'
  | 'cancelled';

export interface SeekErrorOptions extends ErrorOptions {
  /** Device-reported status word, when one is available. */
  readonly deviceCode?: number;
  /** Extra structured context for logs and reports. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

export class SeekError extends Error {
  readonly code: SeekErrorCode;
  readonly deviceCode: number | undefined;
  readonly detail: Readonly<Record<string, unknown>> | undefined;

  constructor(code: SeekErrorCode, message: string, options: SeekErrorOptions = {}) {
    super(message, options);
    this.name = 'SeekError';
    this.code = code;
    this.deviceCode = options.deviceCode;
    this.detail = options.detail;
  }
}

/** Raised when the caller's AbortSignal fires. Never indicates a device fault. */
export class CancelledError extends SeekError {
  constructor(message = 'cancelled') {
    super('cancelled', message);
    this.name = 'CancelledError';
  }
}

export function isSeekError(value: unknown): value is SeekError {
  return value instanceof SeekError;
}

/** Message extraction that never throws, for logging unknown catch values. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

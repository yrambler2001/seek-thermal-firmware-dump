/**
 * The read options. Same six controls, same defaults, same ranges and the same
 * explanatory paragraph as the original's `<details class="opts">`.
 */

import type { ReactElement } from 'react';
import type { OptionField, OptionsForm, RecipientChoice } from '../lib/options';

export interface OptionsDetailsProps {
  readonly value: OptionsForm;
  readonly onChange: (next: OptionsForm) => void;
  readonly disabled: boolean;
  /** The field the last validation failure named, so it can be marked invalid. */
  readonly invalidField: OptionField | null;
  readonly errorMessage: string | null;
}

export function OptionsDetails({
  value,
  onChange,
  disabled,
  invalidField,
  errorMessage,
}: OptionsDetailsProps): ReactElement {
  const invalid = (field: OptionField): boolean => invalidField === field;
  const describedBy = errorMessage === null ? undefined : 'opt-error';

  return (
    <details className="opts">
      <summary>
        <strong>Options</strong> — the defaults are correct; you do not need to change anything
        here.
      </summary>
      <div className="row" style={{ marginTop: '.9rem' }}>
        <div>
          <label htmlFor="optChunk">chunk (control-IN bytes)</label>
          <input
            type="number"
            id="optChunk"
            min={1}
            max={65536}
            step={1}
            value={value.chunk}
            disabled={disabled}
            aria-invalid={invalid('chunk')}
            {...(invalid('chunk') && describedBy !== undefined
              ? { 'aria-describedby': describedBy }
              : {})}
            onChange={(event) => {
              onChange({ ...value, chunk: event.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor="optGapFill">gap-fill byte</label>
          <input
            type="text"
            id="optGapFill"
            inputMode="text"
            value={value.gapFill}
            disabled={disabled}
            aria-invalid={invalid('gapFill')}
            {...(invalid('gapFill') && describedBy !== undefined
              ? { 'aria-describedby': describedBy }
              : {})}
            onChange={(event) => {
              onChange({ ...value, gapFill: event.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor="optRetries">retries per window</label>
          <input
            type="number"
            id="optRetries"
            min={0}
            max={10}
            step={1}
            value={value.retries}
            disabled={disabled}
            aria-invalid={invalid('retries')}
            {...(invalid('retries') && describedBy !== undefined
              ? { 'aria-describedby': describedBy }
              : {})}
            onChange={(event) => {
              onChange({ ...value, retries: event.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor="optRetryDelay">retry delay (ms)</label>
          <input
            type="number"
            id="optRetryDelay"
            min={0}
            max={10000}
            step={50}
            value={value.retryDelay}
            disabled={disabled}
            aria-invalid={invalid('retryDelay')}
            {...(invalid('retryDelay') && describedBy !== undefined
              ? { 'aria-describedby': describedBy }
              : {})}
            onChange={(event) => {
              onChange({ ...value, retryDelay: event.target.value });
            }}
          />
        </div>
        <div>
          <label htmlFor="optRecipient">control transfer recipient</label>
          <select
            id="optRecipient"
            value={value.recipient}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...value, recipient: event.target.value as RecipientChoice });
            }}
          >
            <option value="auto">auto</option>
            <option value="interface">interface (0x41/0xC1)</option>
            <option value="device">device (0x40/0xC0)</option>
          </select>
        </div>
        <div>
          <label htmlFor="optDecrypt">decrypt firmware</label>
          <select
            id="optDecrypt"
            value={value.decrypt ? '1' : '0'}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...value, decrypt: event.target.value === '1' });
            }}
          >
            <option value="1">yes</option>
            <option value="0">no</option>
          </select>
        </div>
      </div>
      {errorMessage !== null && (
        <p className="note l-err" id="opt-error" role="alert" style={{ margin: '.9rem 0 0' }}>
          {errorMessage}
        </p>
      )}
      <p className="note" style={{ margin: '.9rem 0 0' }}>
        <strong>chunk</strong> is the size of each control-IN read. 64 is the EP0 packet size and
        the value that works on every camera tested; raising it to 256 is roughly four times faster,
        and if a camera stalls at that size the page drops back toward 64 on its own and carries on.{' '}
        <strong>gap-fill</strong> is the byte written into the one 64 KiB block USB cannot reach.{' '}
        <strong>recipient</strong> defaults to interface and falls back to device if the browser
        cannot claim interface 0 — the firmware accepts both.
      </p>
    </details>
  );
}

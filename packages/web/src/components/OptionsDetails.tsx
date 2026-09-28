/**
 * The read options. Same six controls, same ids, same defaults, same ranges
 * and the same explanatory paragraph as the original's `<details class="opts">`.
 */

import type { ReactElement } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { Prose } from './Prose';
import { Disclosure } from './ui/disclosure';
import { Field, Input, Select } from './ui/field';
import type { OptionField, OptionsForm, RecipientChoice } from '@/lib/options';

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
  const flag = (
    field: OptionField,
  ): { readonly 'aria-invalid': boolean; readonly 'aria-describedby'?: string } =>
    invalid(field) && describedBy !== undefined
      ? { 'aria-invalid': true, 'aria-describedby': describedBy }
      : { 'aria-invalid': invalid(field) };

  return (
    <Disclosure
      summary={
        <span className="inline-flex items-center gap-2">
          <span className="font-semibold">Options</span>
          <span className="font-normal text-muted-foreground">
            — the defaults are correct; you do not need to change anything here.
          </span>
        </span>
      }
    >
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <Field htmlFor="optChunk" label="chunk (control-IN bytes)">
          <Input
            type="number"
            id="optChunk"
            min={1}
            max={65536}
            step={1}
            value={value.chunk}
            disabled={disabled}
            {...flag('chunk')}
            onChange={(event) => {
              onChange({ ...value, chunk: event.target.value });
            }}
          />
        </Field>
        <Field htmlFor="optGapFill" label="gap-fill byte">
          <Input
            type="text"
            id="optGapFill"
            inputMode="text"
            value={value.gapFill}
            disabled={disabled}
            {...flag('gapFill')}
            onChange={(event) => {
              onChange({ ...value, gapFill: event.target.value });
            }}
          />
        </Field>
        <Field htmlFor="optRetries" label="retries per window">
          <Input
            type="number"
            id="optRetries"
            min={0}
            max={10}
            step={1}
            value={value.retries}
            disabled={disabled}
            {...flag('retries')}
            onChange={(event) => {
              onChange({ ...value, retries: event.target.value });
            }}
          />
        </Field>
        <Field htmlFor="optRetryDelay" label="retry delay (ms)">
          <Input
            type="number"
            id="optRetryDelay"
            min={0}
            max={10000}
            step={50}
            value={value.retryDelay}
            disabled={disabled}
            {...flag('retryDelay')}
            onChange={(event) => {
              onChange({ ...value, retryDelay: event.target.value });
            }}
          />
        </Field>
        <Field htmlFor="optRecipient" label="control transfer recipient">
          <Select
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
          </Select>
        </Field>
        <Field htmlFor="optDecrypt" label="decrypt firmware">
          <Select
            id="optDecrypt"
            value={value.decrypt ? '1' : '0'}
            disabled={disabled}
            onChange={(event) => {
              onChange({ ...value, decrypt: event.target.value === '1' });
            }}
          >
            <option value="1">yes</option>
            <option value="0">no</option>
          </Select>
        </Field>
      </div>

      {errorMessage !== null && (
        <p
          id="opt-error"
          role="alert"
          className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 px-3 py-2 text-[0.85rem] font-medium text-destructive"
        >
          <SlidersHorizontal aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {errorMessage}
        </p>
      )}

      <Prose>
        <p>
          <strong>chunk</strong> is the size of each control-IN read, at most 64: one EP0 packet. A
          longer read can lose a packet to the camera's boot ROM when the camera idles at a low
          clock, so a larger value is read 64 bytes at a time; a smaller one is used as given, and
          if a camera stalls the page drops lower on its own and carries on.{' '}
          <strong>gap-fill</strong> is the byte written into the one 64 KiB block USB cannot reach.{' '}
          <strong>recipient</strong> defaults to interface and falls back to device if the browser
          cannot claim interface 0 — the firmware accepts both.
        </p>
      </Prose>
    </Disclosure>
  );
}

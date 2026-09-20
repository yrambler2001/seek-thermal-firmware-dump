/** The original's `kv()` helper: a `<dl>` that drops empty rows. */

import { Fragment, type ReactElement, type ReactNode } from 'react';

export type KeyValueRow = readonly [label: string, value: ReactNode];

export interface KeyValueProps {
  readonly rows: readonly KeyValueRow[];
}

function isEmpty(value: ReactNode): boolean {
  return value == null || value === '' || value === false;
}

export function KeyValue({ rows }: KeyValueProps): ReactElement {
  return (
    <dl className="kv">
      {rows
        .filter(([, value]) => !isEmpty(value))
        .map(([label, value]) => (
          <Fragment key={label}>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </Fragment>
        ))}
    </dl>
  );
}

/** The original's `kv()` helper: a `<dl>` that drops empty rows. */

import { Fragment, type ReactElement, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type KeyValueRow = readonly [label: string, value: ReactNode];

export interface KeyValueProps {
  readonly rows: readonly KeyValueRow[];
  readonly className?: string | undefined;
}

function isEmpty(value: ReactNode): boolean {
  return value == null || value === '' || value === false;
}

export function KeyValue({ rows, className }: KeyValueProps): ReactElement {
  return (
    <dl
      className={cn(
        'grid grid-cols-1 gap-x-4 gap-y-0.5 text-[0.85rem] sm:grid-cols-[minmax(8.5rem,auto)_1fr]',
        className,
      )}
    >
      {rows
        .filter(([, value]) => !isEmpty(value))
        .map(([label, value]) => (
          <Fragment key={label}>
            <dt className="pt-2 text-[0.68rem] font-semibold tracking-[0.07em] text-muted-foreground uppercase sm:pt-0 sm:text-[0.8rem] sm:tracking-normal sm:normal-case">
              {label}
            </dt>
            <dd className="m-0 font-mono text-[0.82rem] [overflow-wrap:anywhere]">{value}</dd>
          </Fragment>
        ))}
    </dl>
  );
}

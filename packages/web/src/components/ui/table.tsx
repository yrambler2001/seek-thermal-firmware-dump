import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Real tables, with the ARIA roles written out.
 *
 * Below 48rem the stylesheet turns each row into a card, which means
 * `display: block` on the table elements — and that silently strips a table's
 * implicit semantics in every browser. Stating the roles explicitly keeps the
 * grid intact for a screen reader at every width, so the phone layout is a
 * layout change and not a semantic one.
 */
export function Table({ className, children, ...props }: ComponentProps<'table'>): ReactElement {
  return (
    <div className="scrollbar-slim -mx-1 overflow-x-auto px-1">
      <table
        role="table"
        data-slot="table"
        className={cn('table-cards w-full border-collapse text-left text-[0.85rem]', className)}
        {...props}
      >
        {children}
      </table>
    </div>
  );
}

export function TableCaption({ className, ...props }: ComponentProps<'caption'>): ReactElement {
  return <caption className={cn('sr-only', className)} {...props} />;
}

export function TableHeader({ className, ...props }: ComponentProps<'thead'>): ReactElement {
  return <thead role="rowgroup" className={cn('', className)} {...props} />;
}

export function TableBody({ className, ...props }: ComponentProps<'tbody'>): ReactElement {
  return <tbody role="rowgroup" className={cn('', className)} {...props} />;
}

export function TableRow({ className, ...props }: ComponentProps<'tr'>): ReactElement {
  return (
    <tr
      role="row"
      className={cn('border-b border-border/70 last:border-0', className)}
      {...props}
    />
  );
}

export function TableHead({ className, ...props }: ComponentProps<'th'>): ReactElement {
  return (
    <th
      role="columnheader"
      scope="col"
      className={cn(
        'px-2 py-1.5 text-[0.7rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}

export interface TableCellProps extends ComponentProps<'td'> {
  /**
   * Repeated above the value once the row is a card, because the column
   * headers are off-screen at that width. Hidden from assistive technology —
   * the `<th scope="col">` association already says it.
   */
  readonly label?: string | undefined;
  readonly children?: ReactNode;
}

export function TableCell({ className, label, children, ...props }: TableCellProps): ReactElement {
  return (
    <td role="cell" className={cn('px-2 py-1.5 align-top', className)} {...props}>
      {label !== undefined && (
        <span className="cell-label" aria-hidden="true">
          {label}
        </span>
      )}
      {children}
    </td>
  );
}

export function TableRowHeader({ className, ...props }: ComponentProps<'th'>): ReactElement {
  return (
    <th
      role="rowheader"
      scope="row"
      className={cn('px-2 py-1.5 text-left align-top font-semibold', className)}
      {...props}
    />
  );
}

import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

const CONTROL =
  'h-9 w-full rounded-md border border-input bg-card px-2.5 font-mono text-[0.85rem] ' +
  'text-foreground transition-colors placeholder:text-muted-foreground ' +
  'hover:border-muted-foreground/60 disabled:cursor-not-allowed disabled:opacity-50 ' +
  'aria-[invalid=true]:border-destructive aria-[invalid=true]:text-destructive';

export function Input({ className, ...props }: ComponentProps<'input'>): ReactElement {
  return <input data-slot="input" className={cn(CONTROL, className)} {...props} />;
}

/**
 * A native `<select>`, deliberately.
 *
 * A Radix Select is a button with a listbox hung off it, and a `<label for>`
 * cannot point at a button. Every control on this page has a real label, and
 * on the Android phone this tool is often run from, the platform picker beats
 * anything reimplemented in the page.
 */
export function Select({ className, children, ...props }: ComponentProps<'select'>): ReactElement {
  return (
    <div className="relative">
      <select
        data-slot="select"
        className={cn(CONTROL, 'cursor-pointer appearance-none pr-8', className)}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2 text-muted-foreground"
      />
    </div>
  );
}

export function Checkbox({ className, ...props }: ComponentProps<'input'>): ReactElement {
  return (
    <input
      type="checkbox"
      data-slot="checkbox"
      className={cn(
        'mt-0.5 size-4 shrink-0 cursor-pointer accent-primary disabled:cursor-not-allowed ' +
          'disabled:opacity-50',
        className,
      )}
      {...props}
    />
  );
}

export function Label({ className, ...props }: ComponentProps<'label'>): ReactElement {
  return (
    <label
      data-slot="label"
      className={cn(
        'block text-[0.72rem] font-semibold tracking-[0.06em] text-muted-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}

export interface FieldProps {
  /** Ties the label to the control with a real `for`/`id` pair. */
  readonly htmlFor: string;
  readonly label: string;
  readonly className?: string | undefined;
  readonly children: ReactNode;
}

export function Field({ htmlFor, label, className, children }: FieldProps): ReactElement {
  return (
    <div className={cn('min-w-0 space-y-1.5', className)}>
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

import type { ReactElement } from 'react';
import { Progress as ProgressPrimitive } from 'radix-ui';
import { cn } from '@/lib/utils';

export interface ProgressProps {
  /** 0–100. */
  readonly value: number;
  readonly label: string;
  /** What a screen reader reads instead of the bare percentage. */
  readonly valueText: string;
  readonly tone?: 'default' | 'danger';
  readonly className?: string | undefined;
}

/**
 * Radix's Progress, which supplies `role="progressbar"` and the whole
 * `aria-valuemin`/`aria-valuemax`/`aria-valuenow` set; `getValueLabel` becomes
 * `aria-valuetext`, so "43%" is replaced by the status line the run is
 * actually printing.
 */
export function Progress({
  value,
  label,
  valueText,
  tone = 'default',
  className,
}: ProgressProps): ReactElement {
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  return (
    <ProgressPrimitive.Root
      value={clamped}
      max={100}
      getValueLabel={() => valueText}
      aria-label={label}
      className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          'h-full rounded-full transition-[width] duration-150 ease-linear motion-reduce:transition-none',
          tone === 'danger' ? 'bg-destructive-solid' : 'bg-primary-solid',
        )}
        style={{ width: `${String(clamped)}%` }}
      />
    </ProgressPrimitive.Root>
  );
}

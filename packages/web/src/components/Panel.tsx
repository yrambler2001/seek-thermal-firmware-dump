import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** A sub-panel inside a card: the original's `.fwbox`, given a header row. */
export function Panel({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      data-slot="panel"
      className={cn('rounded-lg border border-border/80 bg-sunken/50 p-3 sm:p-3.5', className)}
      {...props}
    />
  );
}

export interface PanelTitleProps {
  readonly icon?: ReactNode;
  readonly aside?: ReactNode;
  readonly className?: string | undefined;
  readonly children: ReactNode;
  readonly id?: string | undefined;
}

export function PanelTitle({
  icon,
  aside,
  className,
  children,
  id,
}: PanelTitleProps): ReactElement {
  return (
    <div className={cn('mb-2.5 flex items-center gap-2', className)}>
      {icon !== undefined && (
        <span className="text-muted-foreground [&_svg]:size-4" aria-hidden="true">
          {icon}
        </span>
      )}
      <h3 id={id} className="text-[0.88rem] font-semibold tracking-tight">
        {children}
      </h3>
      {aside !== undefined && <div className="ml-auto">{aside}</div>}
    </div>
  );
}

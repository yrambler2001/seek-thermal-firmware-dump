import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/utils';

export type ToolbarProps = ComponentProps<'div'> & { readonly label: string };

/**
 * A row of actions. It carries `role="group"` and a label so the actions are
 * announced as one set ("Dump actions, group") rather than as loose buttons
 * scattered through a long document.
 */
export function Toolbar({ className, label, ...props }: ToolbarProps): ReactElement {
  return (
    <div
      role="group"
      aria-label={label}
      data-slot="toolbar"
      className={cn('flex flex-wrap items-center gap-2', className)}
      {...props}
    />
  );
}

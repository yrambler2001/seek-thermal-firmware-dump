import type { ReactElement } from 'react';
import { cn } from '@/lib/utils';

export interface HexBlockProps {
  readonly children: string;
  readonly className?: string | undefined;
  readonly 'aria-label'?: string | undefined;
}

/** Anything that came off the wire, or is pasted into a shell. */
export function HexBlock({ children, className, ...rest }: HexBlockProps): ReactElement {
  return (
    <pre
      className={cn(
        'scrollbar-slim overflow-x-auto rounded-md border border-border/80 bg-sunken px-3 py-2.5 font-mono text-[0.75rem] leading-relaxed',
        className,
      )}
      {...rest}
    >
      {children}
    </pre>
  );
}

import type { ComponentProps, ReactElement } from 'react';
import { cn } from '@/lib/utils';

/**
 * The explanatory voice the whole tool speaks in.
 *
 * Every paragraph of firmware prose on this page is carried over from the
 * original word for word, so the styling lives here in one place rather than
 * as a class on each of the hundred-odd `<p>`s.
 */
export function Prose({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      data-slot="prose"
      className={cn(
        'prose-note space-y-2.5 text-[0.85rem] leading-relaxed text-muted-foreground',
        '[&_em]:text-foreground/90 [&_strong]:font-semibold [&_strong]:text-foreground',
        '[&_li]:my-0.5 [&_ul]:list-disc [&_ul]:pl-5',
        className,
      )}
      {...props}
    />
  );
}

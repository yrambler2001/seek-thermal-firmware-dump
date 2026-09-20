import type { ComponentProps, ReactElement, ReactNode } from 'react';
import { ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DisclosureProps extends Omit<ComponentProps<'details'>, 'title'> {
  readonly summary: ReactNode;
  readonly children: ReactNode;
}

/**
 * A native `<details>`, not an ARIA re-creation of one.
 *
 * Half this page is reference material — the checksum rules, the boot-slot
 * rules, what to do when the camera stops working. Native disclosure keeps
 * that text in the document even while collapsed, so the browser's own
 * find-in-page still reaches it, and it needs no JavaScript to open.
 */
export function Disclosure({
  summary,
  children,
  className,
  ...props
}: DisclosureProps): ReactElement {
  return (
    <details
      className={cn(
        'group rounded-lg border border-border/80 bg-sunken/60 px-3 py-2 open:bg-sunken',
        className,
      )}
      {...props}
    >
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[0.88rem] font-semibold [&::-webkit-details-marker]:hidden">
        <ChevronRight
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90 motion-reduce:transition-none"
        />
        <span className="min-w-0">{summary}</span>
      </summary>
      <div className="prose-note mt-2 space-y-2 pl-6 text-[0.85rem] text-muted-foreground">
        {children}
      </div>
    </details>
  );
}

import type { ComponentProps, ReactElement } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[0.7rem] ' +
    'font-semibold whitespace-nowrap [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-border bg-muted text-muted-foreground',
        accent: 'border-primary/35 bg-primary/10 text-primary',
        ok: 'border-ok/35 bg-ok/10 text-ok',
        warn: 'border-warn/40 bg-warn/12 text-warn',
        err: 'border-destructive/40 bg-destructive/10 text-destructive',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeProps = ComponentProps<'span'> & VariantProps<typeof badgeVariants>;

export function Badge({ className, tone, ...props }: BadgeProps): ReactElement {
  return <span data-slot="badge" className={cn(badgeVariants({ tone }), className)} {...props} />;
}

import type { ComponentProps, ReactElement } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const cardVariants = cva('rounded-xl border bg-card text-card-foreground', {
  variants: {
    tone: {
      default: 'border-border',
      /* The write panel. It should not look like the panels that only read. */
      danger: 'border-destructive/45 bg-card',
      ok: 'border-ok/35',
      /* Side doors: the offline decryptor, the legacy dump. */
      quiet: 'border-dashed border-border bg-transparent',
    },
  },
  defaultVariants: { tone: 'default' },
});

export type CardProps = ComponentProps<'div'> & VariantProps<typeof cardVariants>;

export function Card({ className, tone, ...props }: CardProps): ReactElement {
  return <div data-slot="card" className={cn(cardVariants({ tone }), className)} {...props} />;
}

export function CardHeader({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      data-slot="card-header"
      className={cn('flex flex-wrap items-start gap-x-3 gap-y-1 px-4 pt-4 sm:px-5', className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: ComponentProps<'h2'>): ReactElement {
  return (
    <h2
      data-slot="card-title"
      className={cn('text-[1.02rem] leading-tight font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<'p'>): ReactElement {
  return (
    <p
      data-slot="card-description"
      className={cn('prose-note w-full text-[0.85rem] text-muted-foreground', className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      data-slot="card-content"
      className={cn('px-4 py-4 empty:hidden sm:px-5', className)}
      {...props}
    />
  );
}

export function CardFooter({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      data-slot="card-footer"
      className={cn('rounded-b-xl border-t bg-muted/40 px-4 py-3.5 sm:px-5', className)}
      {...props}
    />
  );
}

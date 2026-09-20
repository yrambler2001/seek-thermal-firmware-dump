import type { ComponentProps, ReactElement } from 'react';
import { CircleCheck, Info, OctagonAlert, TriangleAlert } from 'lucide-react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

export type AlertTone = 'info' | 'ok' | 'warn' | 'err';

const alertVariants = cva(
  'prose-note grid grid-cols-[1.1rem_1fr] items-start gap-x-2.5 gap-y-1 rounded-lg ' +
    'border border-l-[3px] px-3 py-2.5 text-[0.85rem] [&>p]:m-0 [&>ul]:m-0',
  {
    variants: {
      tone: {
        info: 'border-border border-l-primary bg-primary/[0.04] [&>svg]:text-primary',
        ok: 'border-ok/25 border-l-ok bg-ok/[0.06] [&>svg]:text-ok',
        warn: 'border-warn/30 border-l-warn bg-warn/[0.07] [&>svg]:text-warn',
        err: 'border-destructive/30 border-l-destructive bg-destructive/[0.06] [&>svg]:text-destructive',
      },
    },
    defaultVariants: { tone: 'info' },
  },
);

const ICON: Readonly<Record<AlertTone, typeof Info>> = {
  info: Info,
  ok: CircleCheck,
  warn: TriangleAlert,
  err: OctagonAlert,
};

export type AlertProps = ComponentProps<'div'> & VariantProps<typeof alertVariants>;

/**
 * The tone is the meaning, and it is the same four levels the log uses, so a
 * red rail means the same thing wherever it appears.
 */
export function Alert({ className, tone, children, ...props }: AlertProps): ReactElement {
  const Icon = ICON[tone ?? 'info'];
  return (
    <div data-slot="alert" className={cn(alertVariants({ tone }), className)} {...props}>
      <Icon className="mt-[0.2rem] size-[1.05rem] shrink-0" aria-hidden="true" />
      <div className="min-w-0 space-y-1.5">{children}</div>
    </div>
  );
}

import type { ComponentProps, ReactElement } from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

/**
 * Every control in this tool is a real `<button>`. The variants are a
 * vocabulary, not decoration: `default` is the one action a panel is for,
 * `outline` is everything else, and `destructive` is reserved for the single
 * control that erases a camera's flash.
 */
export const buttonVariants = cva(
  'inline-flex shrink-0 cursor-pointer items-center justify-center gap-2 rounded-md ' +
    'text-sm leading-none font-semibold whitespace-nowrap transition-colors select-none ' +
    'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-45 ' +
    '[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary-solid text-primary-foreground hover:bg-primary-solid/88',
        outline: 'border border-input bg-card hover:bg-accent hover:text-accent-foreground',
        ghost: 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
        destructive:
          'bg-destructive-solid text-destructive-foreground hover:bg-destructive-solid/88',
        danger: 'border border-destructive/55 bg-card text-destructive hover:bg-destructive/10',
      },
      size: {
        sm: 'h-8 px-2.5 text-[0.8125rem]',
        default: 'h-9 px-3.5',
        lg: 'h-11 px-5 text-[0.95rem]',
      },
    },
    defaultVariants: { variant: 'outline', size: 'default' },
  },
);

export type ButtonProps = ComponentProps<'button'> & VariantProps<typeof buttonVariants>;

export function Button({ className, variant, size, ...props }: ButtonProps): ReactElement {
  const danger = variant === 'destructive' || variant === 'danger';
  return (
    <button
      type="button"
      data-slot="button"
      {...(danger ? { 'data-tone': 'danger' as const } : {})}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

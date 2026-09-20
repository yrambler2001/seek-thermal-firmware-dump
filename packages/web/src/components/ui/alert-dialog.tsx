import type { ComponentProps, ReactElement } from 'react';
import { AlertDialog as Primitive } from 'radix-ui';
import { cn } from '@/lib/utils';
import { buttonVariants } from './button';

/**
 * Radix's AlertDialog, which is the right primitive for the one irreversible
 * action here: it is `role="alertdialog"`, it traps focus, it closes on
 * Escape, it will not close on a stray outside click, and it puts the initial
 * focus on *Cancel* rather than on the confirm — so a held Enter key can
 * never flash a camera.
 */
export const AlertDialog = Primitive.Root;
export const AlertDialogTrigger = Primitive.Trigger;

export function AlertDialogContent({
  className,
  children,
  ...props
}: ComponentProps<typeof Primitive.Content>): ReactElement {
  return (
    <Primitive.Portal>
      <Primitive.Overlay className="fixed inset-0 z-50 bg-black/55 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=closed]:animate-out data-[state=closed]:fade-out-0" />
      <Primitive.Content
        data-tone="danger"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-[min(34rem,calc(100vw-1.5rem))] ' +
            'max-h-[calc(100dvh-2rem)] -translate-x-1/2 -translate-y-1/2 gap-3 overflow-y-auto ' +
            'rounded-xl border border-destructive/50 bg-popover p-4 text-popover-foreground ' +
            'shadow-2xl sm:p-5 data-[state=open]:animate-in data-[state=open]:fade-in-0 ' +
            'data-[state=open]:zoom-in-95 data-[state=closed]:animate-out ' +
            'data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95',
          className,
        )}
        {...props}
      >
        {children}
      </Primitive.Content>
    </Primitive.Portal>
  );
}

export function AlertDialogTitle({
  className,
  ...props
}: ComponentProps<typeof Primitive.Title>): ReactElement {
  return (
    <Primitive.Title
      className={cn('text-base leading-snug font-semibold tracking-tight', className)}
      {...props}
    />
  );
}

export function AlertDialogDescription({
  className,
  ...props
}: ComponentProps<typeof Primitive.Description>): ReactElement {
  return (
    <Primitive.Description
      className={cn('prose-note text-[0.85rem] text-muted-foreground', className)}
      {...props}
    />
  );
}

export function AlertDialogFooter({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      className={cn('mt-1 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  );
}

export function AlertDialogCancel({
  className,
  ...props
}: ComponentProps<typeof Primitive.Cancel>): ReactElement {
  return (
    <Primitive.Cancel
      className={cn(buttonVariants({ variant: 'outline' }), className)}
      {...props}
    />
  );
}

export function AlertDialogAction({
  className,
  ...props
}: ComponentProps<typeof Primitive.Action>): ReactElement {
  return (
    <Primitive.Action
      className={cn(buttonVariants({ variant: 'destructive' }), className)}
      {...props}
    />
  );
}

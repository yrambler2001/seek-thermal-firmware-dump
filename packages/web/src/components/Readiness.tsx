/**
 * The write gate, drawn.
 *
 * `canWriteNow` needs four things at once and the button simply goes dark
 * when one is missing, which tells you nothing about which one. This is the
 * same four conditions as a checklist, so the greyed-out control explains
 * itself. It is display only — the gate itself lives in `useFlashPanel`.
 */

import type { ReactElement } from 'react';
import { Check, Circle, CircleSlash } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface ReadinessStep {
  readonly label: string;
  readonly done: boolean;
  /** Blocked rather than merely not-done-yet: shown as a stop, not a circle. */
  readonly blocked?: boolean;
}

export interface ReadinessProps {
  readonly steps: readonly ReadinessStep[];
}

export function Readiness({ steps }: ReadinessProps): ReactElement {
  return (
    <ol className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[0.8rem]">
      {steps.map((step) => {
        const Icon = step.blocked === true ? CircleSlash : step.done ? Check : Circle;
        return (
          <li
            key={step.label}
            className={cn(
              'flex items-center gap-1.5',
              step.blocked === true
                ? 'text-destructive'
                : step.done
                  ? 'text-ok'
                  : 'text-muted-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-3.5 shrink-0" />
            <span>{step.label}</span>
            <span className="sr-only">
              {step.blocked === true ? '(blocked)' : step.done ? '(done)' : '(not yet)'}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

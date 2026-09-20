/**
 * The masthead and the view switch.
 *
 * The two views are real URLs (`#/` and `#/flash`), so the switch is two real
 * links carrying `aria-current="page"` — not a tab widget that would make the
 * flash view unlinkable.
 */

import type { ReactElement } from 'react';
import { FlameKindling, Radar, Thermometer } from 'lucide-react';
import { ROUTE_HREF, type Route } from '@/lib/routing';
import { cn } from '@/lib/utils';

export interface AppHeaderProps {
  readonly route: Route;
  readonly connected: boolean;
  readonly canUseUsb: boolean;
}

interface NavItem {
  readonly route: Route;
  readonly label: string;
  readonly icon: ReactElement;
  readonly danger: boolean;
}

const NAV: readonly NavItem[] = [
  { route: 'dump', label: 'Dump & decrypt', icon: <Radar className="size-4" />, danger: false },
  {
    route: 'flash',
    label: 'Firmware & flashing',
    icon: <FlameKindling className="size-4" />,
    danger: true,
  },
];

export function AppHeader({ route, connected, canUseUsb }: AppHeaderProps): ReactElement {
  return (
    <header className="relative isolate border-b border-border/70 bg-card/60">
      <div aria-hidden="true" className="bezel-grid pointer-events-none absolute inset-0 -z-10" />
      <div
        aria-hidden="true"
        className={cn(
          'absolute inset-x-0 top-0 h-0.5',
          route === 'flash' ? 'bg-destructive' : 'bg-primary/70',
        )}
      />
      <div className="mx-auto w-full max-w-[64rem] px-4 pt-5 pb-0 sm:px-6">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span
            aria-hidden="true"
            className="flex size-9 items-center justify-center rounded-lg border border-primary/30 bg-primary/10 text-primary"
          >
            <Thermometer className="size-5" />
          </span>
          <h1 className="text-[1.15rem] leading-tight font-semibold tracking-tight">
            Seek Thermal Firmware Dump
          </h1>
          <span className="ms-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[0.72rem] font-medium text-muted-foreground">
            <span
              aria-hidden="true"
              className={cn(
                'size-1.5 rounded-full',
                connected ? 'bg-ok' : canUseUsb ? 'bg-muted-foreground/60' : 'bg-warn',
              )}
            />
            {connected ? 'Camera selected' : canUseUsb ? 'No camera selected' : 'USB unavailable'}
          </span>
        </div>

        <nav aria-label="Views" className="-mb-px flex gap-1 pt-4">
          {NAV.map((item) => {
            const current = route === item.route;
            return (
              <a
                key={item.route}
                href={ROUTE_HREF[item.route]}
                {...(current ? { 'aria-current': 'page' as const } : {})}
                className={cn(
                  'inline-flex items-center gap-2 rounded-t-lg border border-transparent border-b-transparent px-3 py-2 text-[0.85rem] font-semibold transition-colors',
                  current
                    ? 'border-border border-b-background bg-background text-foreground'
                    : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground',
                  current && item.danger && 'text-destructive',
                  item.danger && !current && 'hover:text-destructive',
                )}
              >
                <span aria-hidden="true" className="[&_svg]:size-4">
                  {item.icon}
                </span>
                {item.label}
              </a>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

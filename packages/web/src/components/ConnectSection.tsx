/** Step 1, shared by both views. Presentational: every action is a prop. */

import type { ReactElement } from 'react';
import { Plug, PlugZap, Unplug, Waypoints } from 'lucide-react';
import { Prose } from './Prose';
import { Section } from './Section';
import { Button } from './ui/button';
import { Toolbar } from './ui/toolbar';
import { cn } from '@/lib/utils';

export interface ConnectSectionProps {
  readonly description: string;
  readonly connected: boolean;
  readonly canUseUsb: boolean;
  readonly canForget: boolean;
  readonly busy: boolean;
  readonly testing: boolean;
  readonly onConnect: () => void;
  readonly onTest: () => void;
  readonly onForget: () => void;
}

export function ConnectSection({
  description,
  connected,
  canUseUsb,
  canForget,
  busy,
  testing,
  onConnect,
  onTest,
  onForget,
}: ConnectSectionProps): ReactElement {
  return (
    <Section id="connect" step="1" title="Connect" icon={<PlugZap />}>
      <Toolbar label="Device actions">
        <Button variant="default" onClick={onConnect} disabled={!canUseUsb || busy}>
          <Plug />
          {connected ? 'Change device' : 'Connect device'}
        </Button>
        <Button onClick={onTest} disabled={!connected || busy || testing}>
          <Waypoints />
          Test connection
        </Button>
        <Button onClick={onForget} disabled={!connected || !canForget || busy}>
          <Unplug />
          Forget device
        </Button>
      </Toolbar>

      <p
        id="device-description"
        aria-live="polite"
        className="flex items-center gap-2 rounded-md border border-border/80 bg-sunken/60 px-3 py-2 font-mono text-[0.82rem]"
      >
        <span
          aria-hidden="true"
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            connected ? 'bg-ok' : 'bg-muted-foreground/50',
          )}
        />
        <span className="min-w-0 [overflow-wrap:anywhere]">{description}</span>
      </p>

      <Prose>
        <p>
          Any Seek Thermal device is offered (USB vendor <code>0x289d</code>) — Compact,
          Compact&nbsp;PRO, Nano and so on. Pick yours in the browser&apos;s device chooser.
        </p>
      </Prose>
    </Section>
  );
}

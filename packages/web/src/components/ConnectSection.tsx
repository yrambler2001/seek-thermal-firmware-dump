/** Step 1, shared by both views. Presentational: every action is a prop. */

import type { ReactElement } from 'react';

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
    <section aria-labelledby="connect-heading">
      <h2 id="connect-heading">1 · Connect</h2>
      <div className="btnrow">
        <button type="button" className="primary" onClick={onConnect} disabled={!canUseUsb || busy}>
          {connected ? 'Change device' : 'Connect device'}
        </button>
        <button type="button" onClick={onTest} disabled={!connected || busy || testing}>
          Test connection
        </button>
        <button type="button" onClick={onForget} disabled={!connected || !canForget || busy}>
          Forget device
        </button>
      </div>
      <p
        className="note"
        id="device-description"
        style={{ margin: '.9rem 0 0' }}
        aria-live="polite"
      >
        {description}
      </p>
      <p className="note" style={{ margin: '.5rem 0 0' }}>
        Any Seek Thermal device is offered (USB vendor <code>0x289d</code>) — Compact, Compact PRO,
        Nano and so on. Pick yours in the browser&apos;s device chooser.
      </p>
    </section>
  );
}

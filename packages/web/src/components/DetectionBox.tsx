/**
 * Which firmware family the evidence pointed at, how strongly, and why.
 *
 * NEW versus the original page, which assumed one family everywhere and
 * silently produced nonsense on any other. Shared by the flash view (evidence
 * from the camera) and the offline decryptor (evidence from the dump file).
 */

import type { ReactElement } from 'react';
import type { DetectionResult } from '@seek-fw/core';
import { Banner } from './Banner';
import { KeyValue, type KeyValueRow } from './KeyValue';

export interface DetectionBoxProps {
  readonly detection: DetectionResult;
  /** The profile actually used, when it differs from the one detected. */
  readonly actingName?: string | undefined;
}

export function DetectionBox({ detection, actingName }: DetectionBoxProps): ReactElement {
  const best = detection.best;
  const rows: readonly KeyValueRow[] = [
    ['Detected', best.profile.name],
    ['Confidence', `${best.score.toFixed(2)} of 1.00`],
    ['Read as', actingName === best.profile.name ? null : (actingName ?? null)],
    ['Summary', best.profile.summary],
  ];

  return (
    <>
      <KeyValue rows={rows} />
      <p className="note" style={{ margin: '.7rem 0 .2rem' }}>
        Why:
      </p>
      <ul className="note" style={{ margin: 0 }}>
        {best.reasons.map((reason) => (
          <li key={reason}>{reason}</li>
        ))}
      </ul>
      {detection.ambiguous && (
        <Banner tone="warn" inset>
          <p>
            <strong>The evidence did not settle which family this is.</strong> Either the winner
            scored no better than the generic fallback, or a runner-up came too close to call. The
            decryption is unaffected — the key is solved out of the ciphertext either way — but the
            profile named in the report, and anything gated on it, is a guess.
          </p>
        </Banner>
      )}
    </>
  );
}

/**
 * What the camera said it is before a run, or why the run was refused.
 *
 * Shown above the transcript because both are answers the user acts on: a
 * detection that looks wrong is the cue for the hand-picked family, and a
 * refusal — no version, or a build with no read command — is the end of the
 * run, with the reason in the toolkit's own words and what to do next.
 */

import type { ReactElement } from 'react';
import { ScanSearch } from 'lucide-react';
import { DetectionBox } from './DetectionBox';
import { KeyValue } from './KeyValue';
import { Panel, PanelTitle } from './Panel';
import { Alert } from './ui/alert';
import type { ActingProfile, Refusal } from '@/lib/identify';

export interface CameraIdentityProps {
  readonly acting: ActingProfile | null;
  readonly refusal: Refusal | null;
}

export function CameraIdentity({ acting, refusal }: CameraIdentityProps): ReactElement | null {
  if (refusal !== null) {
    return (
      <Alert tone="err" role="alert">
        <p>
          <strong>
            {refusal.code === 'device/version-unknown'
              ? 'Not read: the camera did not say which firmware it runs.'
              : 'Not read: this camera cannot be read this way.'}
          </strong>
        </p>
        <p>{refusal.message}</p>
        {refusal.hint !== null && <p>{refusal.hint}</p>}
      </Alert>
    );
  }
  if (acting === null) return null;
  return (
    <Panel>
      <PanelTitle icon={<ScanSearch />}>
        {acting.forced ? 'Firmware family, chosen by hand' : 'Detected camera'}
      </PanelTitle>
      {acting.detection === null ? (
        <KeyValue
          rows={[
            ['Acting as', `${acting.profile.name} (${acting.profile.id})`],
            ['Summary', acting.profile.summary],
          ]}
        />
      ) : (
        <>
          <KeyValue
            className="mb-2"
            rows={[
              [
                'Firmware',
                acting.firmwareVersion === null
                  ? null
                  : `${acting.firmwareVersion}${acting.buildString ? `  ${acting.buildString}` : ''}`,
              ],
            ]}
          />
          <DetectionBox detection={acting.detection} />
        </>
      )}
    </Panel>
  );
}

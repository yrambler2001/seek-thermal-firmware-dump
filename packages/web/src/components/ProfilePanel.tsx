/**
 * The flash view's firmware-family panel: what the camera looks like, and the
 * manual override, because detection is a suggestion and the person holding
 * the camera may know better.
 */

import type { ReactElement } from 'react';
import { listProfiles, type DeviceState } from '@seek-fw/core';
import { DetectionBox } from './DetectionBox';
import type { ProfileChoice } from '../hooks/useFlashPanel';

export interface ProfilePanelProps {
  /** null until a read has happened; the selector still works. */
  readonly state: DeviceState | null;
  readonly choice: ProfileChoice;
  readonly onChange: (choice: ProfileChoice) => void;
  readonly disabled: boolean;
}

export function ProfilePanel({
  state,
  choice,
  onChange,
  disabled,
}: ProfilePanelProps): ReactElement {
  return (
    <div className="fwbox">
      <h3>Detected firmware profile</h3>
      {state === null ? (
        <p className="note flush">
          Nothing detected yet — press <strong>Read device info</strong>. The selector below chooses
          which family the next read acts under.
        </p>
      ) : (
        <DetectionBox detection={state.detection} actingName={state.profile.name} />
      )}

      <div style={{ marginTop: '.9rem' }}>
        <label htmlFor="profileChoice">firmware profile for the next read</label>
        <select
          id="profileChoice"
          value={choice}
          disabled={disabled}
          style={{ width: '18rem' }}
          onChange={(event) => {
            onChange(event.target.value);
          }}
        >
          <option value="auto">auto — use what detection picked</option>
          {listProfiles().map((profile) => (
            <option key={profile.id} value={profile.id}>
              {`${profile.name} (${profile.id})`}
            </option>
          ))}
        </select>
      </div>
      <p className="note last" style={{ marginTop: '.5rem' }}>
        Overriding changes the selector map, the whitening constant and the acceptance sum the next
        read uses. A profile that does not declare flashing keeps the write button disabled however
        the camera answers.
      </p>
    </div>
  );
}

/**
 * The flash view's firmware-family panel: what the camera looks like, and the
 * manual override, because detection is a suggestion and the person holding
 * the camera may know better.
 */

import type { ReactElement } from 'react';
import { ScanSearch } from 'lucide-react';
import { listProfiles, type DeviceState } from '@seek-fw/core';
import { DetectionBox } from './DetectionBox';
import { Panel, PanelTitle } from './Panel';
import { Prose } from './Prose';
import { Field, Select } from './ui/field';
import type { ProfileChoice } from '@/hooks/useFlashPanel';

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
    <Panel>
      <PanelTitle icon={<ScanSearch />}>Detected firmware profile</PanelTitle>
      {state === null ? (
        <Prose>
          <p>
            Nothing detected yet — press <strong>Read device info</strong>. The selector below
            chooses which family the next read acts under.
          </p>
        </Prose>
      ) : (
        <DetectionBox detection={state.detection} actingName={state.profile.name} />
      )}

      <Field
        htmlFor="profileChoice"
        label="firmware profile for the next read"
        className="mt-3.5 max-w-sm"
      >
        <Select
          id="profileChoice"
          value={choice}
          disabled={disabled}
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
        </Select>
      </Field>

      <Prose className="mt-2.5">
        <p>
          Overriding changes the selector map, the whitening constant and the acceptance sum the
          next read uses. A profile that does not declare flashing keeps the write button disabled
          however the camera answers.
        </p>
      </Prose>
    </Panel>
  );
}

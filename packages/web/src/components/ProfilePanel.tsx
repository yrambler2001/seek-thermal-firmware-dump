/**
 * The flash view's firmware-family panel: what the camera said it is, why a
 * read was refused, and the manual override — detection is the default, and
 * the person holding the camera may still know better. The override picks the
 * family; it never skips the version check the read itself makes.
 */

import type { ReactElement } from 'react';
import { ScanSearch } from 'lucide-react';
import { listProfiles, type DeviceState } from '@seek-fw/core';
import { CameraIdentity } from './CameraIdentity';
import { DetectionBox } from './DetectionBox';
import { Panel, PanelTitle } from './Panel';
import { Prose } from './Prose';
import { Field, Select } from './ui/field';
import type { ProfileChoice, Refusal } from '@/lib/identify';

export interface ProfilePanelProps {
  /** null until a read has happened; the selector still works. */
  readonly state: DeviceState | null;
  /** Why the last read was refused, or null. */
  readonly refusal?: Refusal | null;
  readonly choice: ProfileChoice;
  readonly onChange: (choice: ProfileChoice) => void;
  readonly disabled: boolean;
}

export function ProfilePanel({
  state,
  refusal = null,
  choice,
  onChange,
  disabled,
}: ProfilePanelProps): ReactElement {
  return (
    <Panel>
      <PanelTitle icon={<ScanSearch />}>Detected firmware profile</PanelTitle>
      {refusal !== null ? (
        <CameraIdentity acting={null} refusal={refusal} />
      ) : state === null ? (
        <Prose>
          <p>
            Nothing detected yet — press <strong>Read device info</strong>. On <em>auto</em> the
            camera is asked which firmware it runs first, and the read uses that family and that
            build&apos;s own selector table.
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
          <option value="auto">auto — ask the camera (recommended)</option>
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
        <p>
          An override does not skip the safety check: the read still asks the camera for its
          firmware version before anything is armed, and refuses a camera that does not report it,
          or runs a build older than 0.8.0.0, whichever family is chosen.
        </p>
      </Prose>
    </Panel>
  );
}

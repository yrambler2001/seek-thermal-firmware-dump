/**
 * What the camera is running. A direct port of the original's
 * `renderDeviceInfo` and `renderBootWarning`, with the slot list as a real
 * `<table>` with header cells rather than a grid of `<td>`s.
 */

import type { ReactElement } from 'react';
import {
  bootedSlot,
  bytesToHex,
  hexUp,
  targetSlot,
  type DeviceState,
  type SlotState,
} from '@seek-fw/core';
import { Banner } from './Banner';
import { KeyValue, type KeyValueRow } from './KeyValue';

function perDeviceKey(state: DeviceState): string | null {
  const slot = state.deviceKeySlot;
  if (slot === null) return null;
  const blank = slot.every((byte) => byte === 0xff) || slot.every((byte) => byte === 0);
  return blank ? 'not programmed — the camera falls back to Key B' : bytesToHex(slot);
}

function verdict(slot: SlotState): ReactElement {
  if (slot.bootable) return <span className="l-ok">the bootloader can boot this</span>;
  if (!slot.accepts) {
    return (
      <span className="l-err">
        {`fails the acceptance sum (${
          slot.recovered === null ? 'unknown' : hexUp(slot.recovered.checksum)
        })`}
      </span>
    );
  }
  if (!slot.footerOk) return <span className="l-err">no valid CODE footer</span>;
  return <span className="l-err">key unknown to the bootloader — skipped at boot</span>;
}

export interface DeviceInfoPanelProps {
  readonly state: DeviceState;
}

export function DeviceInfoPanel({ state }: DeviceInfoPanelProps): ReactElement {
  const booted = bootedSlot(state);
  const target = targetSlot(state);
  const cfg0Text =
    state.cfg0 === null
      ? null
      : `${hexUp(state.cfg0)} — ${state.profile.boot.describeCfg0(state.cfg0)}`;

  const bootloader =
    state.bootloaderString != null && state.bootloaderString !== ''
      ? `${state.bootloaderString}${
          state.bootloaderVersion != null && state.bootloaderVersion !== ''
            ? `  (${state.bootloaderVersion})`
            : ''
        }`
      : state.bootloaderVersion;

  const running: readonly KeyValueRow[] = [
    ['Version', state.version],
    ['Build', state.buildString],
    ['Bootloader', bootloader],
    ['Platform', state.platform],
    ['Serial', state.serial],
    ['USB link', state.usbSpeed],
    ['Boot config', cfg0Text],
    ['Booted from', booted?.name ?? null],
    ['Upgrade target', target === null ? null : `${target.name} at ${hexUp(target.address)}`],
    ['Per-device key', perDeviceKey(state)],
  ];

  const orphans = state.slots.filter(
    (slot) => slot.present && slot.accepts && slot.footerOk && !slot.bootable,
  );
  const targetIsOrphan = target !== null && orphans.includes(target);

  return (
    <>
      <div className="fwbox">
        <h3>Running firmware</h3>
        <KeyValue rows={running} />
      </div>

      {state.keyTable !== null && (
        <div className="fwbox">
          <h3>Keys read from this camera</h3>
          <KeyValue
            rows={[
              ['Found at', `flash offset ${hexUp(state.keyTable.offset, 6)}`],
              ['Key A', bytesToHex(state.keyTable.keyA)],
              ['Key B', bytesToHex(state.keyTable.keyB)],
            ]}
          />
          <p className="note last">
            Confirmed by matching a slot&apos;s keystream state, recovered from the ciphertext
            itself. Key&nbsp;A is what an upload has to be encrypted with.
          </p>
        </div>
      )}

      <div className="fwbox">
        <h3>Firmware slots</h3>
        <div className="tablewrap">
          <table>
            <caption className="visually-hidden">
              Each firmware slot on this camera, as read and decrypted in the browser
            </caption>
            <thead>
              <tr>
                <th scope="col">Slot</th>
                <th scope="col">Version</th>
                <th scope="col">Size</th>
                <th scope="col">Encryption</th>
                <th scope="col">SHA-256 of plaintext</th>
              </tr>
            </thead>
            <tbody>
              {state.slots.map((slot) => (
                <tr key={slot.key}>
                  <th scope="row">
                    <strong>{slot.name}</strong>
                    <br />
                    <span className="mono note">{hexUp(slot.address)}</span>
                  </th>
                  {slot.present && slot.plainHeader !== null && slot.header !== null ? (
                    <>
                      <td>
                        {slot.plainHeader.versionStr}
                        <br />
                        <span className="note">{`image ${hexUp(slot.header.imageId)}`}</span>
                      </td>
                      <td>
                        {`${String(slot.header.length)} B`}
                        <br />
                        <span className="note">{slot.footer?.model ?? ''}</span>
                      </td>
                      <td>
                        {slot.keyName ?? 'unknown'}
                        <br />
                        {verdict(slot)}
                      </td>
                      <td>
                        <span className="mono note">
                          {slot.sha256 === null ? '' : `${slot.sha256.slice(0, 16)}…`}
                        </span>
                      </td>
                    </>
                  ) : (
                    <>
                      <td colSpan={4}>
                        <span className="l-warn">{slot.reason ?? 'not readable'}</span>
                      </td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="note">
          Each slot was decrypted in the browser by solving for its keystream from its own
          known-zero reset vectors. Decrypting is not the same as booting: the bootloader only ever
          tries {state.storeKey.name} and Key A, so a slot written under any other key checksums
          perfectly and is still skipped. Nothing was written.
        </p>
        {orphans.length > 0 && (
          <Banner tone="err" inset>
            <p>
              <strong>
                {`${orphans.map((slot) => slot.name).join(' and ')}${
                  orphans.length > 1 ? ' hold' : ' holds'
                } a valid firmware image encrypted with a key this camera's bootloader does not know.`}
              </strong>{' '}
              The image is intact and its checksum is correct, but <code>image_try_keys()</code>{' '}
              only tries {state.storeKey.name} and Key A, so the bootloader skips{' '}
              {orphans.length > 1 ? 'them' : 'it'} and boots something else.
            </p>
            {targetIsOrphan && (
              <p>
                That is the slot an upgrade writes. The application running on this camera
                re-encrypts with that unknown key, so{' '}
                <strong>
                  flashing through this page will produce another slot the bootloader cannot boot
                </strong>{' '}
                — the camera will carry on running {booted?.name ?? 'the other slot'}. Writing the
                slot directly with an SPI programmer or over SWD/J-Link is the way round it.
              </p>
            )}
          </Banner>
        )}
      </div>
    </>
  );
}

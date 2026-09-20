/**
 * What the camera is running. A direct port of the original's
 * `renderDeviceInfo` and `renderBootWarning`, with the slot list as a real
 * `<table>` with header cells rather than a grid of `<td>`s — and, below
 * 48rem, as one card per slot without losing those header cells.
 */

import type { ReactElement } from 'react';
import { HardDrive, KeyRound, Microchip } from 'lucide-react';
import {
  bootedSlot,
  bytesToHex,
  hexUp,
  targetSlot,
  type DeviceState,
  type SlotState,
} from '@seek-fw/core';
import { KeyValue, type KeyValueRow } from './KeyValue';
import { Panel, PanelTitle } from './Panel';
import { Prose } from './Prose';
import { Alert } from './ui/alert';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from './ui/table';

function perDeviceKey(state: DeviceState): string | null {
  const slot = state.deviceKeySlot;
  if (slot === null) return null;
  const blank = slot.every((byte) => byte === 0xff) || slot.every((byte) => byte === 0);
  return blank ? 'not programmed — the camera falls back to Key B' : bytesToHex(slot);
}

function verdict(slot: SlotState): ReactElement {
  if (slot.bootable) {
    return <span className="text-ok">the bootloader can boot this</span>;
  }
  if (!slot.accepts) {
    return (
      <span className="text-destructive">
        {`fails the acceptance sum (${
          slot.recovered === null ? 'unknown' : hexUp(slot.recovered.checksum)
        })`}
      </span>
    );
  }
  if (!slot.footerOk) return <span className="text-destructive">no valid CODE footer</span>;
  return <span className="text-destructive">key unknown to the bootloader — skipped at boot</span>;
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
      <Panel>
        <PanelTitle icon={<Microchip />}>Running firmware</PanelTitle>
        <KeyValue rows={running} />
      </Panel>

      {state.keyTable !== null && (
        <Panel>
          <PanelTitle icon={<KeyRound />}>Keys read from this camera</PanelTitle>
          <KeyValue
            rows={[
              ['Found at', `flash offset ${hexUp(state.keyTable.offset, 6)}`],
              ['Key A', bytesToHex(state.keyTable.keyA)],
              ['Key B', bytesToHex(state.keyTable.keyB)],
            ]}
          />
          <Prose className="mt-2.5">
            <p>
              Confirmed by matching a slot&apos;s keystream state, recovered from the ciphertext
              itself. Key&nbsp;A is what an upload has to be encrypted with.
            </p>
          </Prose>
        </Panel>
      )}

      <Panel>
        <PanelTitle icon={<HardDrive />}>Firmware slots</PanelTitle>
        <Table>
          <TableCaption>
            Each firmware slot on this camera, as read and decrypted in the browser
          </TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Slot</TableHead>
              <TableHead>Version</TableHead>
              <TableHead>Size</TableHead>
              <TableHead>Encryption</TableHead>
              <TableHead>SHA-256 of plaintext</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {state.slots.map((slot) => (
              <TableRow key={slot.key}>
                <TableRowHeader className="whitespace-nowrap">
                  <span className="block">{slot.name}</span>
                  <span className="block font-mono text-[0.75rem] font-normal text-muted-foreground">
                    {hexUp(slot.address)}
                  </span>
                </TableRowHeader>
                {slot.present && slot.plainHeader !== null && slot.header !== null ? (
                  <>
                    <TableCell label="Version">
                      {slot.plainHeader.versionStr}
                      <span className="block text-[0.75rem] text-muted-foreground">
                        {`image ${hexUp(slot.header.imageId)}`}
                      </span>
                    </TableCell>
                    <TableCell label="Size">
                      {`${String(slot.header.length)} B`}
                      <span className="block text-[0.75rem] text-muted-foreground">
                        {slot.footer?.model ?? ''}
                      </span>
                    </TableCell>
                    <TableCell label="Encryption">
                      {slot.keyName ?? 'unknown'}
                      <span className="block text-[0.75rem]">{verdict(slot)}</span>
                    </TableCell>
                    <TableCell label="SHA-256 of plaintext">
                      <span className="font-mono text-[0.75rem] text-muted-foreground">
                        {slot.sha256 === null ? '' : `${slot.sha256.slice(0, 16)}…`}
                      </span>
                    </TableCell>
                  </>
                ) : (
                  <TableCell colSpan={4}>
                    <span className="text-warn">{slot.reason ?? 'not readable'}</span>
                  </TableCell>
                )}
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Prose className="mt-3">
          <p>
            Each slot was decrypted in the browser by solving for its keystream from its own
            known-zero reset vectors. Decrypting is not the same as booting: the bootloader only
            ever tries {state.storeKey.name} and Key A, so a slot written under any other key
            checksums perfectly and is still skipped. Nothing was written.
          </p>
        </Prose>

        {orphans.length > 0 && (
          <Alert tone="err" className="mt-3">
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
          </Alert>
        )}
      </Panel>
    </>
  );
}

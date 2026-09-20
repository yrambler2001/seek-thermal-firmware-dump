/**
 * The prepared-write plan: the original's `renderFlashPreview`, `renderKeyNote`
 * and `renderComparison`, carried over paragraph for paragraph.
 *
 * Nothing on this panel has touched the camera. It exists so that the last
 * thing between a $300 camera and an erase is a page of legible facts.
 */

import type { ReactElement } from 'react';
import { FileCheck } from 'lucide-react';
import {
  bytesToHex,
  hexDump,
  hexUp,
  targetSlot,
  type DeviceState,
  type PreparedFlash,
} from '@seek-fw/core';
import { HexBlock } from './HexBlock';
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

export interface FlashPreviewProps {
  readonly state: DeviceState;
  readonly prep: PreparedFlash;
  readonly sha256: string;
}

function KeyNote({ prep }: { readonly prep: PreparedFlash }): ReactElement | null {
  if (prep.keyPatch.changed) {
    return (
      <Prose className="mt-3 text-ok">
        <p>
          The key table at {prep.keyPatch.where} was rewritten to this camera&apos;s Key&nbsp;A and
          Key&nbsp;B, so once this image runs it will encrypt its own upgrades with keys this
          bootloader can read. The acceptance sum below is balanced over the patched image.
        </p>
      </Prose>
    );
  }
  if (prep.carriesMine) return null;
  return (
    <Alert tone="warn" className="mt-3">
      <p>
        <strong>This image does not contain this camera&apos;s key pair.</strong> Either it belongs
        to a different key family, or it derives its key at runtime. It may still boot, but once it
        runs its upgrades will be encrypted with whatever keys it does carry — and if those are not
        this bootloader&apos;s, later flashes will land in slots that cannot be booted. Re-dump the
        image from a camera in this key family to get a filename carrying its keys, and this page
        will retarget them for you.
      </p>
    </Alert>
  );
}

function Comparison({ prep }: { readonly prep: PreparedFlash }): ReactElement {
  if (prep.compare.length === 0) {
    return (
      <Prose className="mt-3 text-ok">
        <p>
          {`Header matches the firmware the camera is running now (${
            prep.runningSlot ?? 'the running slot'
          }) in every field — version, image id, stack pointer, reset vector and size.`}
        </p>
      </Prose>
    );
  }
  return (
    <div className="mt-3 space-y-2">
      <Prose>
        <p>
          <strong>This image is not what the camera is running.</strong> Expected if you meant to
          change firmware — worth a second look if you did not.
        </p>
      </Prose>
      <Table>
        <TableCaption>
          Header fields that differ between the camera and the chosen image
        </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead>Field</TableHead>
            <TableHead>{`On the camera now (${prep.runningSlot ?? 'running slot'})`}</TableHead>
            <TableHead>Your image</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {prep.compare.map((row) => (
            <TableRow key={row.field}>
              <TableRowHeader>{row.field}</TableRowHeader>
              <TableCell
                label={`On the camera now (${prep.runningSlot ?? 'running slot'})`}
                className="font-mono"
              >
                {row.onCamera}
              </TableCell>
              <TableCell label="Your image" className="font-mono">
                {row.inImage}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {prep.layoutMoved && (
        <Prose className="text-warn">
          <p>
            The stack pointer or reset vector moved. Those come from the image&apos;s own vector
            table, so this is a differently linked build — make sure it is a build for this camera.
          </p>
        </Prose>
      )}
    </div>
  );
}

export function FlashPreview({ state, prep, sha256 }: FlashPreviewProps): ReactElement {
  const padding = prep.footerOffset - prep.length;
  const target = targetSlot(state);
  const rows: readonly KeyValueRow[] = [
    ['Source file', `${prep.fileName} — ${String(prep.originalSize)} B`],
    [
      'Target',
      target === null
        ? prep.targetName
        : `${target.name} at ${hexUp(target.address)} (the slot the camera is not running)`,
    ],
    ['Firmware version', `${prep.header.versionStr}  image ${hexUp(prep.header.imageId)}`],
    ['Initial SP / entry', `${hexUp(prep.header.sp)} / ${hexUp(prep.header.entry)}`],
    [
      'header.length',
      `${hexUp(prep.length)}${
        prep.lengthStamped
          ? `  (stamped — was ${hexUp(prep.declaredBefore)})`
          : '  (already correct)'
      }`,
    ],
    [
      'Adjust word @0x238',
      `${hexUp(prep.adjust)}  → acceptance sum ${hexUp(state.profile.cipher.acceptanceSum)}`,
    ],
    [
      'Embedded key table',
      prep.keyPatch.changed
        ? `retargeted at ${prep.keyPatch.where}: ${prep.keyPatch.fromA.slice(0, 8)}…/` +
          `${prep.keyPatch.fromB.slice(0, 8)}… → this camera's ${prep.keyPatch.toA.slice(0, 8)}…/` +
          `${prep.keyPatch.toB.slice(0, 8)}…`
        : `already this camera's keys, at ${prep.keyPatch.where} — left alone`,
    ],
    ['Encrypted with', `Key A ${bytesToHex(prep.keyA)}`],
    [
      'CODE footer',
      prep.footer === null
        ? null
        : `at ${hexUp(prep.footerOffset)}, length ${hexUp(prep.footer.length)}` +
          (prep.footer.model === '' ? '' : `, model ${prep.footer.model}`) +
          (prep.footerFrom === null ? ' (synthesised)' : ` (carried over from ${prep.footerFrom})`),
    ],
    [
      'Bank payload',
      `${String(prep.payload.length)} B = image + ${String(padding)} B of 0xff + 64 B footer`,
    ],
    ['Transfer checksum', hexUp(prep.sum16, 4)],
    ['Payload SHA-256', sha256],
  ];

  return (
    <Panel className="border-primary/30 bg-primary/[0.03]">
      <PanelTitle icon={<FileCheck />}>Ready to write</PanelTitle>

      {prep.rekeyRisk && (
        <Alert tone="err" className="mb-3">
          <p>
            <strong>This write will not be booted.</strong> {prep.targetName} already holds a valid
            image encrypted with a key this camera&apos;s bootloader does not know, which means the
            running application re-encrypts with that key. Your image will be stored the same way
            and skipped at boot, and the camera will carry on running{' '}
            {prep.bootedName ?? 'the other slot'}.
          </p>
          <p>
            Nothing here is damaged by trying — but to actually change what this camera runs you
            need an SPI programmer or SWD/J-Link.
          </p>
        </Alert>
      )}

      <KeyValue rows={rows} />
      <KeyNote prep={prep} />
      <Comparison prep={prep} />

      <Prose className="mt-3">
        <p>First 64 bytes of the payload:</p>
      </Prose>
      <HexBlock className="mt-1.5">{hexDump(prep.payload.subarray(0, 64))}</HexBlock>

      <Prose className="mt-2.5">
        <p>
          Nothing has been sent to the camera yet. <strong>Write to camera</strong> streams this
          payload and commits it.
        </p>
      </Prose>
    </Panel>
  );
}

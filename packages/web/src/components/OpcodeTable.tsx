/** The "Opcode / Name / Dir / Why it is used" table, shared by both views. */

import type { ReactElement } from 'react';
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
import { cn } from '@/lib/utils';

export interface OpcodeRow {
  readonly opcode: string;
  readonly name: string;
  readonly dir: 'IN' | 'OUT';
  readonly why: string;
}

export interface OpcodeTableProps {
  readonly caption: string;
  readonly rows: readonly OpcodeRow[];
}

export function OpcodeTable({ caption, rows }: OpcodeTableProps): ReactElement {
  return (
    <Table>
      <TableCaption>{caption}</TableCaption>
      <TableHeader>
        <TableRow>
          <TableHead className="w-[5.5rem]">Opcode</TableHead>
          <TableHead>Name</TableHead>
          <TableHead className="w-[4rem]">Dir</TableHead>
          <TableHead>Why it is used</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow key={row.opcode}>
            <TableRowHeader className="font-mono font-semibold whitespace-nowrap">
              <span className="cell-label" aria-hidden="true">
                Opcode
              </span>
              {row.opcode}
            </TableRowHeader>
            <TableCell label="Name" className="font-mono">
              {row.name}
            </TableCell>
            <TableCell label="Dir">
              <span
                className={cn(
                  'inline-flex rounded border px-1.5 py-px font-mono text-[0.68rem] font-semibold',
                  row.dir === 'IN'
                    ? 'border-ok/35 bg-ok/10 text-ok'
                    : 'border-warn/40 bg-warn/10 text-warn',
                )}
              >
                {row.dir}
              </span>
            </TableCell>
            <TableCell label="Why it is used" className="text-muted-foreground">
              {row.why}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The dump view's whole vocabulary, verbatim from the original. */
export const READ_ONLY_OPCODES: readonly OpcodeRow[] = [
  { opcode: '0x35', name: 'GetErrorCode', dir: 'IN', why: 'check status after each step' },
  {
    opcode: '0x3c',
    name: 'SetOperationMode',
    dir: 'OUT',
    why: 'only to select mode 0, and only if not already there',
  },
  { opcode: '0x3d', name: 'GetOperationMode', dir: 'IN', why: 'read the current mode' },
  { opcode: '0x4f', name: 'GetFeaturedFirmwareData', dir: 'IN', why: 'the actual flash read' },
  {
    opcode: '0x52',
    name: 'BeginFirmwareUpgrade',
    dir: 'OUT',
    why: 'volatile read-window selector only — it selects which 64 KiB block the next reads return, and writes nothing',
  },
];

/** The five the flash view adds on top, verbatim from the original. */
export const FLASH_OPCODES: readonly OpcodeRow[] = [
  {
    opcode: '0x4e',
    name: 'GetFirmwareInfo',
    dir: 'IN',
    why: 'running version, bootloader string, platform, USB speed, boot-config state',
  },
  {
    opcode: '0x55',
    name: 'SetFirmwareInfoFeatures',
    dir: 'OUT',
    why: 'selects which of the above to return — a selector register, writes no flash',
  },
  {
    opcode: '0x5a',
    name: 'SetRamDataFeatures',
    dir: 'OUT',
    why: 'arms the 248-byte RAM device-id block so the serial can be read',
  },
  {
    opcode: '0x50',
    name: 'SetFeaturedFirmwareData',
    dir: 'OUT',
    why: "streams the payload into the camera's RAM staging buffer, 64 B at a time",
  },
  {
    opcode: '0x51',
    name: 'CompleteMemoryUpgrade',
    dir: 'OUT',
    why: 'the commit — the only command here that erases or programs flash',
  },
];

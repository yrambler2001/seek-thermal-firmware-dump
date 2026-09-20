/** The "Opcode / Name / Dir / Why it is used" table, shared by both views. */

import type { ReactElement } from 'react';

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
    <div className="tablewrap">
      <table>
        <caption className="visually-hidden">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Opcode</th>
            <th scope="col">Name</th>
            <th scope="col">Dir</th>
            <th scope="col">Why it is used</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.opcode}>
              <td className="mono">{row.opcode}</td>
              <td>{row.name}</td>
              <td>{row.dir}</td>
              <td>{row.why}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

/**
 * The read-only view. Every control, warning and explanatory paragraph is the
 * original page's `#dump` view; the only structural change is that the five
 * copies of the bar/status/log markup are now one `<RunPanel>`.
 */

import type { ReactElement } from 'react';
import {
  CircleStop,
  FileKey2,
  FileSearch,
  FolderArchive,
  ListFilter,
  Play,
  Radar,
  ShieldCheck,
  Unlock,
} from 'lucide-react';
import { DetectionBox } from '@/components/DetectionBox';
import { FilePickerButton } from '@/components/FilePickerButton';
import { OpcodeTable, READ_ONLY_OPCODES } from '@/components/OpcodeTable';
import { OptionsDetails } from '@/components/OptionsDetails';
import { Panel, PanelTitle } from '@/components/Panel';
import { PlatformNotes } from '@/components/PlatformNotes';
import { Prose } from '@/components/Prose';
import { RunPanel } from '@/components/RunPanel';
import { Section } from '@/components/Section';
import { Button } from '@/components/ui/button';
import { Disclosure } from '@/components/ui/disclosure';
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  TableRowHeader,
} from '@/components/ui/table';
import { Toolbar } from '@/components/ui/toolbar';
import type { DumpPanelApi } from '@/hooks/useDumpPanel';
import type { OfflineDecryptApi } from '@/hooks/useOfflineDecrypt';
import type { OptionField, OptionsForm } from '@/lib/options';

const DUMP_FILE_ACCEPT = '.bin,.img,.rom,application/octet-stream';

const ARCHIVE: readonly (readonly [string, string])[] = [
  ['flash_4m_usb_partial_gap_ff.bin', 'the assembled 4 MiB flash image'],
  ['windows/*.bin', 'each 64 KiB block exactly as it came off the wire'],
  ['decrypted/*.bin', 'every firmware image slot, decrypted (if a key was found)'],
  ['decrypted/*.txt', 'per-slot report: key, key location, cipher profile, SP, entry, SHA-256'],
  ['manifest.json', 'exact read/gap/decryption metadata'],
  ['README.md', 'what the capture is and what its limits are'],
];

export interface DumpViewProps {
  readonly dump: DumpPanelApi;
  readonly legacy: DumpPanelApi;
  readonly offline: OfflineDecryptApi;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly options: OptionsForm;
  readonly onOptionsChange: (next: OptionsForm) => void;
  readonly optionsInvalidField: OptionField | null;
  readonly optionsErrorMessage: string | null;
}

export function DumpView({
  dump,
  legacy,
  offline,
  connected,
  busy,
  options,
  onOptionsChange,
  optionsInvalidField,
  optionsErrorMessage,
}: DumpViewProps): ReactElement {
  const startDisabled = !connected || busy;

  return (
    <>
      <Section id="dump" step="2" title="Dump" icon={<Radar />}>
        <Toolbar label="Dump actions">
          <Button
            variant="default"
            disabled={startDisabled}
            onClick={() => {
              void dump.start('dump');
            }}
          >
            <Play />
            Start dump
          </Button>
          <Button
            disabled={startDisabled}
            onClick={() => {
              void dump.start('sweep');
            }}
          >
            <ListFilter />
            Dump all selectors (0x00–0xFF)
          </Button>
          <Button variant="ghost" disabled={!dump.running} onClick={dump.cancel}>
            <CircleStop />
            Cancel
          </Button>
        </Toolbar>

        <Prose>
          <p>
            <strong>Start dump</strong> uses the known selector map.{' '}
            <strong>Dump all selectors</strong> instead probes every{' '}
            <code>BeginFirmwareUpgrade</code> selector <code>0x00</code>–<code>0xFF</code> and saves
            whatever each one returns — slower, but it also captures blocks the curated map skips.
            Unmapped selectors simply stall and are recorded.
          </p>
        </Prose>

        <RunPanel
          id="dump"
          label="Dump"
          progress={dump.reporter.progress}
          lines={dump.reporter.lines}
          trimmed={dump.reporter.trimmed}
        />

        <OptionsDetails
          value={options}
          onChange={onOptionsChange}
          disabled={busy}
          invalidField={optionsInvalidField}
          errorMessage={optionsErrorMessage}
        />
      </Section>

      <Section
        id="legacy"
        tone="quiet"
        eyebrow="Optional — for older or locked firmware"
        title="Dump older / locked firmware"
        icon={<Unlock />}
      >
        <Prose>
          <p>
            Older Seek firmware locks the boot, calibration and app-image banks (
            <code>0x14010000</code>–<code>0x14070000</code>) behind an authenticated read channel
            and exposes no selector for the top 2 MiB. On such a unit the normal <em>Start dump</em>{' '}
            above stalls on those banks and returns only a partial, header-less image that will not
            decrypt. This variant speaks the legacy protocol: it unlocks the protected banks with
            the firmware&apos;s own channel-<code>0x12</code> token so their firmware images come
            through — including <code>0x14060000</code> — and marks the blocks the old protocol
            genuinely cannot reach as gaps. It is still <strong>read-only</strong>: the token only
            arms a read window, and nothing is ever written.
          </p>
          <p>
            Needs a connected device (step 1). If the normal dump already reads every window, use
            that instead — this is only for units where it stalls. If windows come back truncated,
            open <em>Options</em> in step 2 and lower <strong>chunk</strong>.
          </p>
          <p>
            One caveat. The unlock token is <strong>build-specific</strong>; the one built in was
            recovered from a Compact PRO (PIR324) unit. On firmware with a different token the
            protected banks just stall and are gap-filled — the same result as the normal dump, and
            still safe. The app images come through <em>encrypted</em> (the key&apos;s boot bank at{' '}
            <code>0x14000000</code> is refused on the 2016-2017 builds, and read with the token on
            the 2014 ones from 0.9.0.2), but that no longer matters: decryption recovers the key
            from each encrypted image itself, so any slot that is actually captured still decrypts
            here.
          </p>
        </Prose>

        <Toolbar label="Legacy dump actions">
          <Button
            variant="default"
            disabled={startDisabled}
            onClick={() => {
              void legacy.start('dump');
            }}
          >
            <Play />
            Dump legacy firmware
          </Button>
          <Button
            disabled={startDisabled}
            onClick={() => {
              void legacy.start('sweep');
            }}
          >
            <ListFilter />
            Dump all selectors (0x00–0xFF)
          </Button>
          <Button variant="ghost" disabled={!legacy.running} onClick={legacy.cancel}>
            <CircleStop />
            Cancel
          </Button>
        </Toolbar>

        <Prose>
          <p>
            <strong>Dump all selectors</strong> here probes every selector <code>0x00</code>–
            <code>0xFF</code> on the authenticated channel (with the unlock token), so it captures
            every block the older firmware exposes, not just the mapped ones.
          </p>
        </Prose>

        <RunPanel
          id="legacy"
          label="Legacy dump"
          progress={legacy.reporter.progress}
          lines={legacy.reporter.lines}
          trimmed={legacy.reporter.trimmed}
        />
      </Section>

      <Section
        id="offline"
        tone="quiet"
        eyebrow="Optional — not part of the two steps above"
        title="Decrypt a dump you already have"
        icon={<FileKey2 />}
      >
        <Prose>
          <p>
            Step 2 already decrypts everything it reads, so you only need this if your flash image
            came from somewhere else — an earlier run, J-Link, or an SPI programmer. The file is
            read locally and never uploaded. <strong>This part works in every browser</strong>,
            including Safari and iOS, because it needs no USB access.
          </p>
        </Prose>

        <Toolbar label="Offline decrypt actions">
          <FilePickerButton
            id="filePick"
            variant="default"
            icon={<FileSearch />}
            label="Choose dump file…"
            accept={DUMP_FILE_ACCEPT}
            disabled={busy}
            onPick={(file) => {
              void offline.decryptFile(file);
            }}
          />
          <Button variant="ghost" disabled={!offline.running} onClick={offline.cancel}>
            <CircleStop />
            Cancel
          </Button>
        </Toolbar>

        <RunPanel
          id="offline"
          label="Offline decrypt"
          progress={offline.reporter.progress}
          lines={offline.reporter.lines}
          trimmed={offline.reporter.trimmed}
        />

        {offline.detection !== null && (
          <Panel>
            <PanelTitle icon={<FileSearch />}>Detected firmware profile</PanelTitle>
            <Prose className="mb-3">
              <p>
                No camera is attached, so the family is scored from the images in the file itself.
                The key is solved out of each slot&apos;s ciphertext either way; this is what names
                the cipher profile in the report.
              </p>
            </Prose>
            <DetectionBox detection={offline.detection} />
          </Panel>
        )}
      </Section>

      <Section id="output" title="What you get" icon={<FolderArchive />}>
        <Prose>
          <p>
            A single <code>.zip</code> download containing:
          </p>
        </Prose>

        <Table>
          <TableCaption>Files inside the downloaded archive</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead className="w-[19rem]">File</TableHead>
              <TableHead>What it is</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {ARCHIVE.map(([file, what]) => (
              <TableRow key={file}>
                <TableRowHeader className="font-mono text-[0.8rem] font-normal">
                  {file}
                </TableRowHeader>
                <TableCell label="What it is" className="text-muted-foreground">
                  {what}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Prose>
          <p>
            The key is recovered from the dump itself, so no key file or device secret is needed.
          </p>
          <p>
            Decryption is still best-effort. If no key is found — for example on a unit whose
            bootloader derives the key from chip OTP, which is not present in a flash dump — that
            slot is simply skipped and the rest of the archive is unaffected.
          </p>
        </Prose>
      </Section>

      <PlatformNotes />

      <Section id="readonly" tone="ok" title="Read-only guarantee" icon={<ShieldCheck />}>
        <Prose>
          <p>
            This page can issue exactly five vendor commands. That is its entire vocabulary — there
            is no code path to anything else:
          </p>
        </Prose>

        <OpcodeTable caption="The five read-only vendor commands" rows={READ_ONLY_OPCODES} />

        <Prose>
          <p>
            <code>SetFeaturedFirmwareData</code>, <code>CompleteMemoryUpgrade</code>,{' '}
            <code>ResetDevice</code> and every upload, commit and erase command are absent from this
            view. <code>USBDevice.reset()</code> is never called either; the retry path just closes
            and reopens the handle. Decryption happens entirely in memory on the copy in your
            browser and never touches the device.
          </p>
          <p>
            Writing to the camera lives on its own page,{' '}
            <a href="#/flash">Firmware &amp; flashing</a>, which lists the commands it adds. Nothing
            on <em>this</em> page can reach them, and no code path here calls into that view.
          </p>
          <p>
            The <em>legacy firmware</em> dump uses the same five commands. Its only difference is
            that <code>BeginFirmwareUpgrade</code> carries the firmware&apos;s own channel-
            <code>0x12</code> unlock token (an 18-byte payload) so older firmware will arm a read
            window over its protected banks. The token gates the read-window <em>selector</em> only
            — still nothing is written to the device.
          </p>
        </Prose>

        <Disclosure summary="The 0x14060000 gap">
          <p>
            The USB command set exposes a read-window selector for every 64 KiB block of the 4 MiB
            flash except <code>0x14060000..0x1406ffff</code>. That block is filled with{' '}
            <code>0xff</code> in the combined image and recorded in <code>manifest.json</code>.
          </p>
          <p>
            <strong>In practice this costs you nothing.</strong> On most cameras that block is
            simply erased flash, which reads as <code>0xff</code> anyway — so the filler matches
            what is really there and the image is complete.
          </p>
          <p>
            And when the block <em>is</em> in use, what it holds is a redundant copy. These cameras
            keep the same firmware image in several 64 KiB slots: across every multi-slot dump
            checked while building this page, all slots decrypted to byte-identical firmware — in
            one case across four slots that had been written with two different keys. On the one
            unit seen with a real image at <code>0x14060000</code>, it was byte-for-byte the same as
            the copies at <code>0x14050000</code> and <code>0x14070000</code>, so the archive still
            contains that firmware, just read from a different address.
          </p>
          <p>
            That redundancy is also why a camera whose <code>0x14060000</code> reads back as{' '}
            <code>0xff</code> is fine: the bootable firmware still exists in the other slots.
            Nothing on this page writes to the device in any case — the gap affects only the file
            you download.
          </p>
          <p>
            If you do want a strictly complete byte-for-byte image — to diff flash against a
            reference, say — read it over SWD/J-Link or with an SPI programmer.
          </p>
        </Disclosure>
      </Section>
    </>
  );
}

/**
 * The read-only view. The warnings and explanatory paragraphs are the original
 * page's `#dump` view; the five copies of the bar/status/log markup are one
 * `<RunPanel>`, and — the one change in what the page DOES — the dump asks the
 * camera which firmware family it is instead of having the user pick between a
 * "normal" and a "legacy" button. Picking by hand is still there, as an expert
 * override in its own section, and it cannot skip the version check.
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
  SlidersHorizontal,
} from 'lucide-react';
import { listProfiles, type ProfileId } from '@seek-fw/core';
import { CameraIdentity } from '@/components/CameraIdentity';
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
import { Field, Select } from '@/components/ui/field';
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
  /** The expert override: the same runs under a family picked by hand. */
  readonly manual: DumpPanelApi;
  /** The family the override acts under. */
  readonly manualProfile: ProfileId;
  readonly onManualProfile: (profile: ProfileId) => void;
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
  manual,
  manualProfile,
  onManualProfile,
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
            Both first ask the camera which firmware it runs: its version, with{' '}
            <code>GetFirmwareInfo</code> — the one read every Seek build answers the same way — and,
            only if that build can be read over USB, one plain and one token-carrying{' '}
            <code>BeginFirmwareUpgrade</code> and a single read, which tell the post-2018 protocol
            from the locked 2014–2017 one. There is nothing to choose: the answers pick the family,
            and the build&apos;s own selector table decides which block each selector reads. A
            camera that does not report its version, or runs a build older than 0.8.0.0, is not read
            at all, and the page says why.
          </p>
          <p>
            <strong>Start dump</strong> then reads every block that table reaches.{' '}
            <strong>Dump all selectors</strong> instead probes every{' '}
            <code>BeginFirmwareUpgrade</code> selector <code>0x00</code>–<code>0xFF</code> and saves
            whatever each one returns — slower, but it also captures blocks the curated map skips.
            Unmapped selectors simply stall and are recorded.
          </p>
        </Prose>

        <CameraIdentity acting={dump.acting} refusal={dump.refusal} />

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
        id="manual"
        tone="quiet"
        eyebrow="Optional — for experts; Start dump does not need it"
        title="Choose the firmware family yourself"
        icon={<SlidersHorizontal />}
      >
        <Prose>
          <p>
            <strong>Start dump</strong> above asks the camera which family it is, so this is only
            for a camera that detection gets wrong. The family decides the selector table, the
            whitening constant and the acceptance sum the run uses; picking it here skips the three
            channel questions and nothing else.
          </p>
          <p>
            <strong>It cannot skip the safety check.</strong> Whatever you pick, the run reads the
            firmware version first and refuses a camera that does not report it, or one running a
            build older than 0.8.0.0 — on those builds the command numbers a dump sends mean
            something else, and on 0.3.0.1 the one that arms a read window is{' '}
            <code>EnterBootloaderMode</code>.
          </p>
          <p>
            Older Seek firmware locks the boot, calibration and app-image banks (
            <code>0x14010000</code>–<code>0x14070000</code>) behind an authenticated read channel
            and exposes no selector for the top 2 MiB. The legacy family speaks that protocol — and
            Start dump uses it by itself on such a camera: it unlocks the protected banks with the
            firmware&apos;s own channel-<code>0x12</code> token so their firmware images come
            through — including <code>0x14060000</code> — and marks the blocks the old protocol
            genuinely cannot reach as gaps. It is still <strong>read-only</strong>: the token only
            arms a read window, and nothing is ever written.
          </p>
          <p>
            About that token. It is <strong>one 16-byte value, not one per build</strong>: the
            identical bytes are in 22 of the 36 firmware images examined — every 2014–2017 build,
            0.3.0.1 to 1.3.0.8 on the Compact and 1.0.3.0 and 1.0.3.2 on the Compact PRO — and in
            none of the 14 images from 2018 on, which have no token check at all. On a build that
            refused it, the protected banks would just stall and be gap-filled — the same result as
            a dump without it, and still safe. The app images come through <em>encrypted</em> (the
            key&apos;s boot bank at <code>0x14000000</code> is refused on the 2016-2017 builds, and
            read with the token on the 2014 ones from 0.9.0.2), but that no longer matters:
            decryption recovers the key from each encrypted image itself, so any slot that is
            actually captured still decrypts here. If windows come back truncated, open{' '}
            <em>Options</em> in step 2 and lower <strong>chunk</strong>.
          </p>
        </Prose>

        <Field htmlFor="manualProfile" label="firmware family" className="max-w-sm">
          <Select
            id="manualProfile"
            value={manualProfile}
            disabled={busy}
            onChange={(event) => {
              onManualProfile(event.target.value);
            }}
          >
            {listProfiles().map((profile) => (
              <option key={profile.id} value={profile.id}>
                {`${profile.name} (${profile.id})`}
              </option>
            ))}
          </Select>
        </Field>

        <Toolbar label="Hand-picked family dump actions">
          <Button
            variant="default"
            disabled={startDisabled}
            onClick={() => {
              void manual.start('dump');
            }}
          >
            <Play />
            Dump as this family
          </Button>
          <Button
            disabled={startDisabled}
            onClick={() => {
              void manual.start('sweep');
            }}
          >
            <ListFilter />
            Dump all selectors (0x00–0xFF)
          </Button>
          <Button variant="ghost" disabled={!manual.running} onClick={manual.cancel}>
            <CircleStop />
            Cancel
          </Button>
        </Toolbar>

        <Prose>
          <p>
            <strong>Dump all selectors</strong> here probes every selector <code>0x00</code>–
            <code>0xFF</code> the way the chosen family would — on the legacy family, on the
            authenticated channel with the unlock token — so it captures every block the firmware
            exposes, not just the mapped ones.
          </p>
        </Prose>

        <CameraIdentity acting={manual.acting} refusal={manual.refusal} />

        <RunPanel
          id="manual"
          label="Hand-picked family dump"
          progress={manual.reporter.progress}
          lines={manual.reporter.lines}
          trimmed={manual.reporter.trimmed}
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
            This page can issue exactly six vendor commands. That is its entire vocabulary — there
            is no code path to anything else:
          </p>
        </Prose>

        <OpcodeTable caption="The six read-only vendor commands" rows={READ_ONLY_OPCODES} />

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
            A dump of <em>legacy firmware</em> uses the same six commands. Its only difference is
            that <code>BeginFirmwareUpgrade</code> carries the firmware&apos;s own channel-
            <code>0x12</code> unlock token (an 18-byte payload) so older firmware will arm a read
            window over its protected banks. The token gates the read-window <em>selector</em> only
            — still nothing is written to the device.
          </p>
          <p>
            Until the camera has reported its firmware version, only three of the six are sent, and
            only as reads: <code>GetFirmwareInfo</code>, <code>GetOperationMode</code> and{' '}
            <code>GetErrorCode</code>. They are the reads that sit at the same command number, with
            the same meaning, in all 36 firmware images examined; a command number does not mean the
            same thing on every build, so nothing else goes out until the build is known.
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

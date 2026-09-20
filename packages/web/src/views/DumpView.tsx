/**
 * The read-only view. Every control, warning and explanatory paragraph is the
 * original page's `#dump` view; the only structural change is that the five
 * copies of the bar/status/log markup are now one `<RunPanel>`.
 */

import type { ReactElement } from 'react';
import { DetectionBox } from '../components/DetectionBox';
import { FilePickerButton } from '../components/FilePickerButton';
import { OpcodeTable, READ_ONLY_OPCODES } from '../components/OpcodeTable';
import { OptionsDetails } from '../components/OptionsDetails';
import { PlatformNotes } from '../components/PlatformNotes';
import { RunPanel } from '../components/RunPanel';
import type { DumpPanelApi } from '../hooks/useDumpPanel';
import type { OfflineDecryptApi } from '../hooks/useOfflineDecrypt';
import type { OptionField, OptionsForm } from '../lib/options';

const DUMP_FILE_ACCEPT = '.bin,.img,.rom,application/octet-stream';

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
      <section aria-labelledby="dump-heading">
        <h2 id="dump-heading">2 · Dump</h2>
        <div className="btnrow">
          <button
            type="button"
            className="primary"
            disabled={startDisabled}
            onClick={() => {
              void dump.start('dump');
            }}
          >
            Start dump
          </button>
          <button
            type="button"
            disabled={startDisabled}
            onClick={() => {
              void dump.start('sweep');
            }}
          >
            Dump all selectors (0x00–0xFF)
          </button>
          <button type="button" disabled={!dump.running} onClick={dump.cancel}>
            Cancel
          </button>
        </div>
        <p className="note tight">
          <strong>Start dump</strong> uses the known selector map.{' '}
          <strong>Dump all selectors</strong> instead probes every <code>BeginFirmwareUpgrade</code>{' '}
          selector <code>0x00</code>–<code>0xFF</code> and saves whatever each one returns — slower,
          but it also captures blocks the curated map skips. Unmapped selectors simply stall and are
          recorded.
        </p>
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
      </section>

      <section className="optional" aria-labelledby="legacy-heading">
        <p className="optlabel">Optional — for older or locked firmware</p>
        <h2 id="legacy-heading">Dump older / locked firmware</h2>
        <p className="note flush">
          Older Seek firmware locks the boot, calibration and app-image banks (
          <code>0x14010000</code>–<code>0x14070000</code>) behind an authenticated read channel and
          exposes no selector for the top 2 MiB. On such a unit the normal <em>Start dump</em> above
          stalls on those banks and returns only a partial, header-less image that will not decrypt.
          This variant speaks the legacy protocol: it unlocks the protected banks with the
          firmware&apos;s own channel-<code>0x12</code> token so their firmware images come through
          — including <code>0x14060000</code> — and marks the blocks the old protocol genuinely
          cannot reach as gaps. It is still <strong>read-only</strong>: the token only arms a read
          window, and nothing is ever written.
        </p>
        <p className="note">
          Needs a connected device (step 1). If the normal dump already reads every window, use that
          instead — this is only for units where it stalls. If windows come back truncated, open{' '}
          <em>Options</em> in step 2 and lower <strong>chunk</strong>.
        </p>
        <p className="note">
          One caveat. The unlock token is <strong>build-specific</strong>; the one built in was
          recovered from a Compact PRO (PIR324) unit. On firmware with a different token the
          protected banks just stall and are gap-filled — the same result as the normal dump, and
          still safe. The app images come through <em>encrypted</em> (the key&apos;s boot bank at{' '}
          <code>0x14000000</code> stays blocked on every channel), but that no longer matters:
          decryption recovers the key from each encrypted image itself, so any slot that is actually
          captured still decrypts here.
        </p>
        <div className="btnrow">
          <button
            type="button"
            className="primary"
            disabled={startDisabled}
            onClick={() => {
              void legacy.start('dump');
            }}
          >
            Dump legacy firmware
          </button>
          <button
            type="button"
            disabled={startDisabled}
            onClick={() => {
              void legacy.start('sweep');
            }}
          >
            Dump all selectors (0x00–0xFF)
          </button>
          <button type="button" disabled={!legacy.running} onClick={legacy.cancel}>
            Cancel
          </button>
        </div>
        <p className="note tight">
          <strong>Dump all selectors</strong> here probes every selector <code>0x00</code>–
          <code>0xFF</code> on the authenticated channel (with the unlock token), so it captures
          every block the older firmware exposes, not just the mapped ones.
        </p>
        <RunPanel
          id="legacy"
          label="Legacy dump"
          progress={legacy.reporter.progress}
          lines={legacy.reporter.lines}
          trimmed={legacy.reporter.trimmed}
        />
      </section>

      <section className="optional" aria-labelledby="offline-heading">
        <p className="optlabel">Optional — not part of the two steps above</p>
        <h2 id="offline-heading">Decrypt a dump you already have</h2>
        <p className="note flush">
          Step 2 already decrypts everything it reads, so you only need this if your flash image
          came from somewhere else — an earlier run, J-Link, or an SPI programmer. The file is read
          locally and never uploaded. <strong>This part works in every browser</strong>, including
          Safari and iOS, because it needs no USB access.
        </p>
        <div className="btnrow">
          <FilePickerButton
            id="filePick"
            className="primary"
            label="Choose dump file…"
            accept={DUMP_FILE_ACCEPT}
            disabled={busy}
            onPick={(file) => {
              void offline.decryptFile(file);
            }}
          />
          <button type="button" disabled={!offline.running} onClick={offline.cancel}>
            Cancel
          </button>
        </div>
        <RunPanel
          id="offline"
          label="Offline decrypt"
          progress={offline.reporter.progress}
          lines={offline.reporter.lines}
          trimmed={offline.reporter.trimmed}
        />
        {offline.detection !== null && (
          <div className="fwbox">
            <h3>Detected firmware profile</h3>
            <p className="note flush">
              No camera is attached, so the family is scored from the images in the file itself. The
              key is solved out of each slot&apos;s ciphertext either way; this is what names the
              cipher profile in the report.
            </p>
            <DetectionBox detection={offline.detection} />
          </div>
        )}
      </section>

      <section aria-labelledby="output-heading">
        <h2 id="output-heading">What you get</h2>
        <p className="note flush">
          A single <code>.zip</code> download containing:
        </p>
        <div className="tablewrap">
          <table>
            <caption className="visually-hidden">Files inside the downloaded archive</caption>
            <thead className="visually-hidden">
              <tr>
                <th scope="col">File</th>
                <th scope="col">What it is</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="mono">flash_4m_usb_partial_gap_ff.bin</td>
                <td>the assembled 4 MiB flash image</td>
              </tr>
              <tr>
                <td className="mono">windows/*.bin</td>
                <td>each 64 KiB block exactly as it came off the wire</td>
              </tr>
              <tr>
                <td className="mono">decrypted/*.bin</td>
                <td>every firmware image slot, decrypted (if a key was found)</td>
              </tr>
              <tr>
                <td className="mono">decrypted/*.txt</td>
                <td>per-slot report: key, key location, cipher profile, SP, entry, SHA-256</td>
              </tr>
              <tr>
                <td className="mono">manifest.json</td>
                <td>exact read/gap/decryption metadata</td>
              </tr>
              <tr>
                <td className="mono">README.md</td>
                <td>what the capture is and what its limits are</td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="note">
          The key is recovered from the dump itself, so no key file or device secret is needed.
        </p>
        <p className="note">
          Decryption is still best-effort. If no key is found — for example on a unit whose
          bootloader derives the key from chip OTP, which is not present in a flash dump — that slot
          is simply skipped and the rest of the archive is unaffected.
        </p>
      </section>

      <PlatformNotes />

      <section aria-labelledby="readonly-heading">
        <h2 id="readonly-heading">Read-only guarantee</h2>
        <p className="note flush">
          This page can issue exactly five vendor commands. That is its entire vocabulary — there is
          no code path to anything else:
        </p>
        <OpcodeTable caption="The five read-only vendor commands" rows={READ_ONLY_OPCODES} />
        <p className="note last">
          <code>SetFeaturedFirmwareData</code>, <code>CompleteMemoryUpgrade</code>,{' '}
          <code>ResetDevice</code> and every upload, commit and erase command are absent from this
          view. <code>USBDevice.reset()</code> is never called either; the retry path just closes
          and reopens the handle. Decryption happens entirely in memory on the copy in your browser
          and never touches the device.
        </p>
        <p className="note">
          Writing to the camera lives on its own page, <a href="#/flash">Firmware &amp; flashing</a>
          , which lists the commands it adds. Nothing on <em>this</em> page can reach them, and no
          code path here calls into that view.
        </p>
        <p className="note">
          The <em>legacy firmware</em> dump uses the same five commands. Its only difference is that{' '}
          <code>BeginFirmwareUpgrade</code> carries the firmware&apos;s own channel-
          <code>0x12</code> unlock token (an 18-byte payload) so older firmware will arm a read
          window over its protected banks. The token gates the read-window <em>selector</em> only —
          still nothing is written to the device.
        </p>

        <details className="sub-details">
          <summary>The 0x14060000 gap</summary>
          <p className="note">
            The USB command set exposes a read-window selector for every 64 KiB block of the 4 MiB
            flash except <code>0x14060000..0x1406ffff</code>. That block is filled with{' '}
            <code>0xff</code> in the combined image and recorded in <code>manifest.json</code>.
          </p>
          <p className="note">
            <strong>In practice this costs you nothing.</strong> On most cameras that block is
            simply erased flash, which reads as <code>0xff</code> anyway — so the filler matches
            what is really there and the image is complete.
          </p>
          <p className="note">
            And when the block <em>is</em> in use, what it holds is a redundant copy. These cameras
            keep the same firmware image in several 64 KiB slots: across every multi-slot dump
            checked while building this page, all slots decrypted to byte-identical firmware — in
            one case across four slots that had been written with two different keys. On the one
            unit seen with a real image at <code>0x14060000</code>, it was byte-for-byte the same as
            the copies at <code>0x14050000</code> and <code>0x14070000</code>, so the archive still
            contains that firmware, just read from a different address.
          </p>
          <p className="note">
            That redundancy is also why a camera whose <code>0x14060000</code> reads back as{' '}
            <code>0xff</code> is fine: the bootable firmware still exists in the other slots.
            Nothing on this page writes to the device in any case — the gap affects only the file
            you download.
          </p>
          <p className="note">
            If you do want a strictly complete byte-for-byte image — to diff flash against a
            reference, say — read it over SWD/J-Link or with an SPI programmer.
          </p>
        </details>
      </section>
    </>
  );
}

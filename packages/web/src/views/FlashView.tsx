/**
 * The write view. Every warning the original showed is here, word for word,
 * plus the firmware-profile panel the original had no concept of.
 */

import { useState, type ReactElement } from 'react';
import { hexUp, targetSlot } from '@seek-fw/core';
import { Banner } from '../components/Banner';
import { DeviceInfoPanel } from '../components/DeviceInfoPanel';
import { FilePickerButton } from '../components/FilePickerButton';
import { FlashPreview } from '../components/FlashPreview';
import { FLASH_OPCODES, OpcodeTable } from '../components/OpcodeTable';
import { PlatformNotes } from '../components/PlatformNotes';
import { ProfilePanel } from '../components/ProfilePanel';
import { RunPanel } from '../components/RunPanel';
import { WriteConfirm } from '../components/WriteConfirm';
import type { FlashPanelApi, ProfileChoice } from '../hooks/useFlashPanel';

const IMAGE_ACCEPT = '.bin,.img,.rom,application/octet-stream';

export interface FlashViewProps {
  readonly flash: FlashPanelApi;
  readonly connected: boolean;
  readonly busy: boolean;
  readonly profileChoice: ProfileChoice;
  readonly onProfileChoice: (choice: ProfileChoice) => void;
}

export function FlashView({
  flash,
  connected,
  busy,
  profileChoice,
  onProfileChoice,
}: FlashViewProps): ReactElement {
  const [dumpFirst, setDumpFirst] = useState(true);
  const [confirming, setConfirming] = useState(false);
  const { deviceState, prepared } = flash;
  const target = deviceState === null ? null : targetSlot(deviceState);

  return (
    <>
      <section aria-labelledby="fw-heading">
        <h2 id="fw-heading">2 · Current firmware</h2>
        <p className="note flush">
          Read-only. Asks the camera what it is running, then reads the three firmware slots and
          decrypts them in the browser so you can see exactly what is in each one before you change
          anything.
        </p>
        <div className="btnrow">
          <button
            type="button"
            className="primary"
            disabled={!connected || busy}
            onClick={() => {
              void flash.readInfo();
            }}
          >
            Read device info
          </button>
          <button type="button" disabled={!flash.readingInfo} onClick={flash.cancelInfo}>
            Cancel
          </button>
        </div>
        <RunPanel
          id="fwinfo"
          label="Device info"
          progress={flash.infoReporter.progress}
          lines={flash.infoReporter.lines}
          trimmed={flash.infoReporter.trimmed}
        />
        <ProfilePanel
          state={deviceState}
          choice={profileChoice}
          onChange={onProfileChoice}
          disabled={busy}
        />
        {deviceState !== null && <DeviceInfoPanel state={deviceState} />}
        {deviceState !== null && !deviceState.canFlash && (
          <Banner tone="err" inset>
            <p>
              <strong>This camera cannot be flashed from here.</strong>
            </p>
            <ul>
              {deviceState.flashBlockedBy.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
          </Banner>
        )}
      </section>

      <section aria-labelledby="write-heading">
        <h2 id="write-heading">3 · Flash a firmware image</h2>

        <Banner tone="err" flush>
          <p>
            <strong>This writes to the camera&apos;s flash.</strong> It erases a 64 KiB block and
            programs your image into the slot the camera is <em>not</em> currently booted from, then
            points the boot config at it.
          </p>
          <p>
            An image that is structurally valid but does not run leaves the camera unbootable, and
            the first-stage bootloader has no USB — only SWD/J-Link or an SPI programmer can recover
            it. Keep the rescue dump this page downloads for you.
          </p>
        </Banner>

        <p className="note">
          Give it a <strong>plaintext (decrypted)</strong> image — the same kind of file this
          page&apos;s <code>decrypted/*.bin</code> output contains. Everything else is done for you:
          the header length is stamped to the real size, the acceptance-sum adjust word is balanced,
          the image is encrypted with the Key&nbsp;A read out of your camera&apos;s own bootloader
          block, and the <code>CODE</code> footer is rebuilt from the footer already on the device.
        </p>
        <p className="note">
          <strong>The filename must carry the image&apos;s own key pair</strong>, the way this
          page&apos;s decrypted output is named:{' '}
          <code>…-KeyA-&lt;32 hex&gt;-KeyB-&lt;32 hex&gt;.bin</code>. Those keys are found inside
          the image and rewritten to this camera&apos;s before it is packaged, so the image will
          encrypt its own future upgrades with keys this bootloader can read. A file without them is
          refused — there would be no way to tell whether it carries keys for this camera, for
          another one, or none at all, and the wrong pair quietly stops the camera accepting any
          later update. A file whose named keys are not both inside it, exactly once each, is
          refused too.
        </p>

        <div className="btnrow">
          <FilePickerButton
            id="filePickFw"
            className="primary"
            label="Choose plaintext image…"
            accept={IMAGE_ACCEPT}
            disabled={busy}
            onPick={(file) => {
              setConfirming(false);
              void flash.pickImage(file);
            }}
          />
          <button
            type="button"
            className="danger"
            disabled={!flash.canWrite || confirming}
            onClick={() => {
              /* Only ever a step towards a write, never the write itself. */
              if (prepared !== null) setConfirming(true);
            }}
          >
            Write to camera
          </button>
          <button type="button" disabled={!flash.writing} onClick={flash.cancelWrite}>
            Cancel
          </button>
        </div>

        <label className="chk" htmlFor="optDumpFirst">
          <input
            type="checkbox"
            id="optDumpFirst"
            checked={dumpFirst}
            disabled={busy}
            onChange={(event) => {
              setDumpFirst(event.target.checked);
            }}
          />
          <span>Dump the whole 4 MiB flash and download it before writing (rescue copy)</span>
        </label>

        {confirming && prepared !== null && (
          <WriteConfirm
            fileName={prepared.prep.fileName}
            targetName={target?.name ?? prepared.prep.targetName ?? 'the upgrade target'}
            targetAddress={target === null ? '' : hexUp(target.address)}
            rekeyRisk={prepared.prep.rekeyRisk}
            bootedName={prepared.prep.bootedName}
            onCancel={() => {
              setConfirming(false);
            }}
            onConfirm={() => {
              setConfirming(false);
              void flash.write(dumpFirst);
            }}
          />
        )}

        {deviceState !== null && prepared !== null && (
          <FlashPreview state={deviceState} prep={prepared.prep} sha256={prepared.sha256} />
        )}

        <RunPanel
          id="flash"
          label="Write"
          progress={flash.flashReporter.progress}
          lines={flash.flashReporter.lines}
          trimmed={flash.flashReporter.trimmed}
        />
      </section>

      <section aria-labelledby="writes-heading">
        <h2 id="writes-heading">What this view writes</h2>
        <p className="note flush">
          The dump view&apos;s five read commands, plus these. Nothing else is in the source — there
          is no <code>ResetDevice</code>, no raw-block write, and no path that touches the
          bootloader at <code>0x14000000</code> or the recovery slot at <code>0x14070000</code>.
        </p>
        <OpcodeTable caption="The five commands the flash view adds" rows={FLASH_OPCODES} />

        <details className="sub-details">
          <summary>What the camera does when you press commit</summary>
          <p className="note">
            <code>BeginFirmwareUpgrade(0)</code> arms the upgrade descriptor at{' '}
            <code>fw_update_slot_address()</code> — the slot the camera did <em>not</em> boot from —
            with a 64 KiB cap. Each <code>SetFeaturedFirmwareData</code> appends up to 64 bytes (the
            EP0 buffer is exactly 64 bytes; longer writes are truncated) into RAM.
          </p>
          <p className="note">
            <code>CompleteMemoryUpgrade</code> takes a 16-bit sum of every staged byte and refuses
            with <code>0x70000</code> if it disagrees. It then decrypts the staged image with
            Key&nbsp;A, re-encrypts it with Key&nbsp;B or the per-device key at{' '}
            <code>0x14000218</code>, erases the target 64 KiB block, programs it, verifies the
            readback, and finally rewrites the boot-config record at <code>0x14010000</code> so{' '}
            <code>cfg[0]</code> points at the slot it just wrote.
          </p>
          <p className="note">
            The bank switch only takes effect on a real power cycle, so unplug and replug the camera
            afterwards.
          </p>
        </details>

        <details className="sub-details">
          <summary>Why the payload is bigger than your image</summary>
          <p className="note">
            Each slot holds the encrypted image, <code>0xff</code> padding, and a 64-byte{' '}
            <code>&quot;CODE&quot;</code> footer at{' '}
            <code>((header.length&gt;&gt;14)+1)×0x4000&nbsp;−&nbsp;0x40</code>. The bootloader reads
            that footer straight out of flash, undecrypted, and takes the normal monolithic boot
            path <em>only</em> if <code>footer[0] == &quot;CODE&quot;</code> and{' '}
            <code>footer[1] == header.length</code>.
          </p>
          <p className="note">
            The camera erases the whole 64 KiB block and writes back only what you stream, and it
            never writes the footer itself. So the footer has to be part of the payload — a
            bare-image upload wipes the footer that was there, the bootloader falls through to its
            segmented loader, decrypts a monolithic image as a segment table, and bricks. This page
            always streams the full bank payload and refuses to send one whose footer does not
            validate.
          </p>
        </details>

        <details className="sub-details">
          <summary>The two checksums, and why images get rejected silently</summary>
          <p className="note">
            They are different values checked at different times.{' '}
            <strong>The transfer checksum</strong> is a 16-bit sum of the payload bytes, checked by{' '}
            <code>CompleteMemoryUpgrade</code> during the write. <strong>The acceptance sum</strong>{' '}
            is a 32-bit sum of the <em>decrypted</em> words over exactly <code>header.length</code>{' '}
            bytes, and the bootloader requires it to be <code>0x0000FFFF</code> at boot. There is no
            signature and no MAC — that sum is the whole check.
          </p>
          <p className="note">
            This is why <code>header.length</code> (file offset <code>0x204</code>) must equal the
            real image size. If it does not, the bootloader sums the wrong range, the slot fails
            acceptance, and the camera quietly boots the other bank — the classic &ldquo;I flashed
            it but it is still running the old firmware&rdquo;. This page stamps the length and
            balances the reserved adjust word at <code>0x238</code> over that exact range for you.
          </p>
        </details>

        <details className="sub-details">
          <summary>If the camera stops working</summary>
          <p className="note">
            The bootloader picks a slot from <code>cfg[0]</code> at <code>0x14010000</code>: blank
            or <code>0</code> tries slot&nbsp;A, then B, then recovery; <code>1</code> tries B, then
            A, then recovery; anything else tries recovery first. A slot is accepted when its header
            is valid and either the device key or Key&nbsp;A decrypts it to the acceptance sum.
          </p>
          <p className="note">
            So an image that fails acceptance is harmless — the camera falls back to a good slot.
            The dangerous case is an image that passes acceptance but does not run: the bootloader
            keeps selecting it and there is no USB in the bootloader to talk to. Recovering that
            means writing the rescue dump back with an SPI programmer, or over SWD/J-Link. The
            recovery slot at <code>0x14070000</code> is never touched by this page, so it stays as
            your golden copy.
          </p>
        </details>
      </section>

      <PlatformNotes />
    </>
  );
}

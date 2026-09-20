/**
 * Human-readable `README.md` shipped inside every archive, ported from
 * `legacy/index.html`'s `makeReadme` / `makeLegacyReadme` / `makeSweepReadme`
 * (plus the inline text `decryptPickedFile` built for an offline decrypt).
 *
 * These documents are carefully worded: they state exactly what was and was
 * not read, and what safety properties hold (no flash-write/erase/commit/reset
 * ever issued). The wording is reproduced verbatim except where the tool has
 * genuinely changed since the original page:
 *
 *   - it now also records which `FirmwareProfile` it detected and acted
 *     under (a new "Profile:" line, matching the manifest's new `profile`
 *     field), and
 *   - it now ships as a CLI in addition to the browser page.
 *
 * Every value used below already lives on the manifest object in its final
 * display form (e.g. `manifest.gapFill` is already `hex(gapFill, 2)`), so
 * these functions do no hex formatting of their own — see `manifest.ts` for
 * that, which is the single place value formatting is decided.
 */

import type {
  DumpManifest,
  LegacyDumpManifest,
  ManifestProfileInfo,
  OfflineDecryptManifest,
  SweepManifest,
} from './manifest.js';

const REPO_URL = 'https://github.com/yrambler2001/seek-thermal-firmware-dump';

/** The "Produced by ..." byline, shared by every README. Notes the CLI is new. */
function producedByLines(): readonly string[] {
  return [
    'Produced by seek-thermal-firmware-dump, which now runs both as a browser app',
    '(over WebUSB) and as a command-line tool, from',
    REPO_URL,
  ];
}

/**
 * The "Profile:" line(s), aligned under "Captured:" / "Device:". NEW versus
 * the original page, which had no concept of firmware profiles.
 */
function profileLines(profile: ManifestProfileInfo): readonly string[] {
  const lines = [
    'Profile:  ' +
      profile.name +
      ' [' +
      profile.id +
      ', detection score ' +
      String(profile.detectionScore) +
      ']',
  ];
  if (profile.reasons.length) lines.push('          ' + profile.reasons.join('; '));
  return lines;
}

/**
 * Original `makeReadme(gapFill, manifest)`. Ported quirk-for-quirk: unlike
 * the legacy/sweep variants, the original never falls back to "unknown" for
 * a null `device.product` here, so neither does this port.
 */
export function makeReadme(manifest: DumpManifest): string {
  return [
    '# Seek Thermal 4 MiB USB Flash Dump',
    '',
    'Captured: ' + manifest.startedAt + ' .. ' + manifest.finishedAt,
    `Device:   ${String(manifest.device.product)} (VID ${manifest.vid} PID ${manifest.pid})`,
    ...profileLines(manifest.profile),
    '',
    ...producedByLines(),
    '',
    'This was read using read-only USB EP0 vendor control transfers.',
    'No flash-write, flash-modify, upload, commit, erase or reset command was issued.',
    '',
    '## Important limitation',
    '',
    'The USB command set does not expose a read window for `0x14060000..0x1406ffff`.',
    'The combined 4 MiB image fills that block with `' +
      manifest.gapFill +
      '` and records it in `manifest.json`.',
    'Use SWD/J-Link or an SPI programmer if you need a strictly complete byte-for-byte image.',
    '',
    '## Files',
    '',
    '- `' + manifest.combinedFile + '`: assembled 4 MiB image with the USB gap filled.',
    '- `windows/`: raw 64 KiB blocks as read, named by flash address and subcommand.',
    '- `decrypted/`: firmware image slots after decryption, with a report per slot.',
    '- `manifest.json`: exact read, gap and decryption metadata.',
    '',
    '## Decryption',
    '',
    'The cipher is Marsaglia xorshift128 (shifts 11/8/19), which is linear over',
    'GF(2). The key is recovered cryptanalytically: the 128-bit state is solved',
    "directly from each image's known-zero Cortex-M reserved vectors, so the stored",
    "key is never needed. This decrypts images even when the dump's key region is",
    "missing or corrupted. Each slot's confidence is recorded in `manifest.json`.",
    '',
  ].join('\n');
}

/** Original `makeLegacyReadme(gapFill, manifest, okCount, reachable, gapCount)`. */
export function makeLegacyReadme(manifest: LegacyDumpManifest): string {
  const fill = '`' + manifest.gapFill + '`';
  const okCount = manifest.usbReadableWindows;
  const reachable = manifest.expectedReadableWindows;
  const gapCount = manifest.gaps.length;
  return [
    '# Seek Thermal Flash Dump — legacy (locked-firmware) algorithm',
    '',
    'Captured: ' + manifest.startedAt + ' .. ' + manifest.finishedAt,
    'Device:   ' +
      (manifest.device.product ?? 'unknown') +
      ' (VID ' +
      manifest.vid +
      ' PID ' +
      manifest.pid +
      ')',
    ...profileLines(manifest.profile),
    '',
    ...producedByLines(),
    '',
    'This capture used the legacy read algorithm, for older firmware that locks its',
    'boot/calibration/app banks behind an authenticated read channel and exposes no',
    'selector for the upper 2 MiB.',
    '',
    'Read-only: BeginFirmwareUpgrade was used only as a read-window selector. On the',
    "protected banks it carried the firmware's own channel-0x12 unlock token so the",
    'device would arm the window; nothing was written. No flash-write, erase, upload,',
    'commit or reset command was issued.',
    '',
    '## Coverage',
    '',
    `${String(okCount)} of ${String(reachable)} reachable 64 KiB windows were read.`,
    `${String(gapCount)} of 64 windows are unreachable on this firmware and were gap-filled with ${fill}:`,
    '  - 0x14000000              live XIP/boot base, hard-blocked by the firmware',
    '  - 0x14200000..0x143fffff  upper 2 MiB, no read-window selector exists',
    'See manifest.json for exact per-window and per-gap detail.',
    '',
    'The protected app-image banks 0x14010000..0x14070000 ARE included here (read via',
    'the unlock token), so this dump contains the firmware images the standard algorithm',
    'cannot reach on these units — including 0x14060000.',
    '',
    '## Files',
    '',
    '- `' + manifest.combinedFile + '`: assembled 4 MiB image (unreachable blocks gap-filled).',
    '- `windows/`: raw 64 KiB blocks as read, named by flash address and subcommand.',
    '- `decrypted/`: firmware image slots after decryption, with a report per slot.',
    '- `manifest.json`: exact read, gap, unlock-token and decryption metadata.',
    '',
    '## Decryption',
    '',
    'Same as the standard dump: Marsaglia xorshift128 (shifts 11/8/19); the key is',
    "recovered cryptanalytically from each image's own ciphertext (the state is solved",
    'from its known-zero Cortex-M reserved vectors), so no stored key is needed.',
    '',
    'Note for legacy dumps: on these units the xorshift key lives in the boot bank at',
    '0x14000000, which the old firmware hard-blocks on every channel (even with the',
    'unlock token). That bank cannot be read here — but it does not have to be. Because',
    'the key is solved from the encrypted image itself, the app-image slots decrypt from',
    'this dump alone as long as the slot was actually captured. Only blocks the old',
    'protocol cannot reach at all are left as gaps and listed in manifest.json.',
    '',
  ].join('\n');
}

/** Original `makeSweepReadme(manifest, legacy)`. `legacy` is now read off `manifest.mode`. */
export function makeSweepReadme(manifest: SweepManifest): string {
  const legacy = manifest.mode === 'selector-sweep-legacy';
  return [
    '# Seek Thermal — full selector sweep' + (legacy ? ' (legacy / unlock token)' : ''),
    '',
    'Captured: ' + manifest.startedAt + ' .. ' + manifest.finishedAt,
    'Device:   ' +
      (manifest.device.product ?? 'unknown') +
      ' (VID ' +
      manifest.vid +
      ' PID ' +
      manifest.pid +
      ')',
    ...profileLines(manifest.profile),
    '',
    ...producedByLines(),
    '',
    'This is an exhaustive probe of every BeginFirmwareUpgrade selector 0x00..0xff,',
    legacy
      ? 'each armed on the authenticated channel (0x12) with the unlock token.'
      : 'each armed on the normal channel (0x02).',
    'Selectors the firmware does not map simply stall and are recorded, not saved.',
    '',
    'Read-only: BeginFirmwareUpgrade was used only as a read-window selector and',
    'GetFeaturedFirmwareData did the reads. No flash-write, erase, upload, commit or',
    'reset command was issued.',
    '',
    '## Results',
    '',
    `${String(manifest.selectorsArmed)} of 256 selectors armed; ${String(manifest.selectorsWithData)} returned data.`,
    `${String(manifest.placedInImage)} had a known flash address and were assembled into \`${manifest.combinedFile}\`.`,
    '',
    '## Files',
    '',
    '- `blocks/subcmd_XX[_addr].bin`: one 64 KiB block per selector that returned data,',
    '  named by selector byte (and flash address when the map knows it).',
    '- `' + manifest.combinedFile + '`: 4 MiB image assembled from selectors with a known address.',
    '- `decrypted/`: any firmware image slots that could be decrypted from that image.',
    '- `manifest.json`: the full 256-row table (armed / begin status / error code / address / preview).',
    '',
  ].join('\n');
}

/** Original: the inline README text built in `decryptPickedFile` for an offline decrypt. */
export function makeOfflineDecryptReadme(manifest: OfflineDecryptManifest): string {
  return [
    '# Decrypted Seek Thermal Firmware',
    '',
    'Source file : ' + manifest.source.fileName,
    'Size        : ' + String(manifest.source.size) + ' bytes',
    'SHA-256     : ' + manifest.source.sha256,
    'Decrypted   : ' + manifest.finishedAt,
    ...profileLines(manifest.profile),
    '',
    ...producedByLines(),
    '',
    'The source image was not modified and no device was contacted.',
    'See `decrypted/decryption_report.txt` for the key, its location in the dump,',
    'the cipher profile, and per-slot SP/entry/SHA-256 details.',
    '',
  ].join('\n');
}

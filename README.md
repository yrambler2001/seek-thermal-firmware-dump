# Seek Thermal Firmware Dump

Read the 4 MiB SPIFI flash of a Seek Thermal camera **from your browser**, over WebUSB, and decrypt
any firmware images found in it.

**→ [Open the tool](https://yrambler2001.github.io/seek-thermal-firmware-dump/)**

No install, no drivers on macOS or Linux, no SDK, no J-Link. Everything runs locally in the browser —
the dump never leaves your machine.

## What it does

1. Walks the device's `BeginFirmwareUpgrade` selector map, reading each 64 KiB block of
   `0x14000000..0x143fffff` with `GetFeaturedFirmwareData` over EP0 vendor control transfers.
2. Assembles the blocks into one 4 MiB image.
3. Scans that image for firmware slots and decrypts them, recovering the key from the dump itself.
4. Hands you a single `.zip`.

There is also an **offline mode**: pick a flash image you already have — from this page, from J-Link,
or from an SPI programmer — and get back a zip of the decrypted firmware. That path touches no device
and needs no WebUSB, so it works in **every** browser, including Safari, Firefox, and iOS.

### Archive contents

| Path | What it is |
| --- | --- |
| `flash_4m_usb_partial_gap_ff.bin` | the assembled 4 MiB flash image |
| `windows/*.bin` | each 64 KiB block exactly as it came off the wire |
| `decrypted/*.bin` | each firmware image slot, decrypted |
| `decrypted/*.txt` | per-slot report: key, key location, cipher profile, SP, entry, SHA-256 |
| `decrypted/decryption_report.txt` | summary across all slots |
| `manifest.json` | exact read, gap and decryption metadata |
| `README.md` | what the capture is and what its limits are |

## Read-only by design

The page can issue exactly five vendor commands — that is its entire vocabulary, and there is no code
path to anything else:

| Opcode | Name | Dir | Why |
| --- | --- | --- | --- |
| `0x35` | GetErrorCode | IN | check status after each step |
| `0x3c` | SetOperationMode | OUT | only to select mode 0, and only if not already there |
| `0x3d` | GetOperationMode | IN | read the current mode |
| `0x4f` | GetFeaturedFirmwareData | IN | the actual flash read |
| `0x52` | BeginFirmwareUpgrade | OUT | volatile read-window selector only — it selects which block subsequent reads return, and writes nothing |

`SetFeaturedFirmwareData`, `CompleteMemoryUpgrade`, `ResetDevice` and every upload, commit and erase
command are absent from the source. `USBDevice.reset()` is never called either; the retry path just
closes and reopens the handle. Decryption happens entirely in memory on the copy in your browser and
never touches the device.

## Known limitation: the 0x14060000 gap

The USB command set exposes a read-window selector for every 64 KiB block of the 4 MiB flash **except**
`0x14060000..0x1406ffff`. That one block is filled with `0xff` in the combined image and recorded in
`manifest.json`.

**In practice this costs you nothing.** On most cameras that block is just erased flash, which reads
as `0xff` anyway — so the filler matches the real contents and the dump is complete.

And when the block *is* in use, what it holds is a redundant copy. These cameras keep the same
firmware image in several 64 KiB slots. Across every multi-slot dump checked while building this
page, all slots decrypted to byte-identical firmware — in one case across four slots that had been
written with two different keys:

| Dump | Slots | Decrypted firmware |
| --- | --- | --- |
| Compact_Android_CW | `14030000` `14050000` `14070000` | all identical |
| Compact_Pro_Android_UQ-AAA | `14050000` **`14060000`** `14070000` | all identical |
| Nano_300_CQ_ABAX | `14030000` `14040000` `14050000` `14070000` | all identical (2 different keys) |
| Restore_20260801 | `14030000` `14050000` `14070000` | all identical |

On the one unit with a real image at `0x14060000`, it was byte-for-byte the same as the copies at
`0x14050000` and `0x14070000` — so the archive still contains that firmware, just read from a
different address.

That redundancy is also why a camera whose `0x14060000` reads back as `0xff` is fine: the bootable
firmware still exists in the other slots. Nothing here writes to the device in any case — the gap
affects only the file you download.

If you do want a strictly complete byte-for-byte image — to diff flash against a reference, say —
read it over SWD/J-Link or with an SPI programmer.

## Browser and platform support

| Platform | Dumping a camera | Decrypting a file |
| --- | --- | --- |
| **macOS** | Works out of the box in Chrome/Edge/Chromium. No driver, no admin rights. | ✅ |
| **Linux** | Needs a one-line udev rule (below). | ✅ |
| **Windows** | Needs WinUSB bound to the camera, via [Zadig](https://zadig.akeo.ie/) — pick the entry named after your camera, e.g. `CompactPRO FF`. | ✅ |
| **Android** | Works in Chrome with a USB-OTG cable, if the phone can power the camera. | ✅ |
| **iPhone / iPad** | **Not possible.** See below. | ✅ |
| **Firefox / Safari** | Not possible — no WebUSB. | ✅ |

WebUSB is a Chromium feature; Firefox and Safari have both declined to implement it. Only the dumping
half depends on it — offline decryption works everywhere.

### Linux udev rule

```
# /etc/udev/rules.d/70-seek-thermal.rules
SUBSYSTEM=="usb", ATTR{idVendor}=="289d", MODE="0666", TAG+="uaccess"
```

```sh
sudo udevadm control --reload-rules && sudo udevadm trigger
```

Then unplug and replug the camera. Snap and Flatpak Chromium builds are often sandboxed away from raw
USB; the `.deb`/`.rpm` build is the reliable one.

### Why iOS can never work

Safari does not implement WebUSB, and on iOS and iPadOS every browser — including Chrome and Firefox —
is required to render with WebKit. So no iOS browser exposes `navigator.usb`. There is no flag,
extension, or app that changes this.

Offline decryption does work on iOS, since it only reads a file you pick.

## How the decryption works

The firmware images are encrypted with a Marsaglia xorshift128 keystream (shifts 11/8/19). The 16-byte
key maps to the generator state as `x = k1^K`, `y = k2^K`, `z = k3^K`, `w = k0^K`, for a per-build
whitening constant `K`. One keystream word is consumed per image word and the generator always
advances, but words 128..143 (`0x200..0x23F`, the cleartext header) are left un-XORed. A key is
accepted when the 32-bit sum of the decrypted words equals the profile's target.

That acceptance test makes the cipher self-validating, which is what lets the key be found without
knowing where it is stored: every 16-byte window in the dump is a candidate. A pre-filter on the
decrypted reset vector — stack pointer must be SRAM-resident and word-aligned, entry must be a Thumb
code address — discards almost every window before the full checksum runs, so a pass over the whole
4 MiB takes a fraction of a second.

### The key search widens if the first pass fails

The obvious way to decide "SRAM-resident" is to read the dump's own word 0 and take its top byte.
That breaks on units that ship with a **poisoned reset vector**: word 0 reads `0xBEBEBE00` while the
rest of the vector table is intact, so the derived prefix is `0xbe` and every genuine candidate is
thrown away before the checksum ever runs. The key is sitting right there in the dump, and a naive
scan reports "no key found".

Because the pre-filter is only an optimisation — the checksum is the real acceptance test — relaxing
it can never yield a wrong key, only a slower scan. So the search runs in stages and stops at the
first one that finds a key:

| Stage | SP constraint |
| --- | --- |
| `reset-vector` | top byte equals the dump's own word 0 — fastest, and what a naive scan does |
| `sram-region` | any LPC43xx SRAM region (`0x10` or `0x20`) |
| `alignment-only` | none; alignment and the entry vector alone |

Dumps that the first stage already handles resolve identically and at identical speed. The stage that
succeeded is recorded per key as `keySearch` in `manifest.json` and in the per-slot report.

Two cipher profiles are known:

| Builds | `K` | checksum target |
| --- | --- | --- |
| 2018.07.05 / 2019.01.07 / 2021.08.12 | `0x13579BDF` | `0x0000FFFF` |
| 2016.06.26 | `0x00000000` | `0x00000000` |

Decryption is best-effort. A unit whose bootloader derives its key from chip OTP cannot be decrypted
from a flash dump alone, because the OTP is not in the dump. Those slots are skipped and listed in
`manifest.json`; the flash image itself is unaffected.

The implementation is a direct port of `decrypt_firmware.js` and produces byte-identical output —
verified against it on real dumps covering both cipher profiles, multi-key devices, duplicate slots,
and the no-key-found path.

## Running it locally

WebUSB needs a secure context, which means HTTPS or `localhost`:

```sh
git clone https://github.com/yrambler2001/seek-thermal-firmware-dump
cd seek-thermal-firmware-dump
python3 -m http.server 8000
# open http://localhost:8000
```

Opening `index.html` straight from disk also works in Chrome, but the origin is opaque, so the browser
will not remember the device between reloads.

To reach it from an Android phone over USB, forward the port so the phone sees `localhost`:

```sh
adb reverse tcp:8000 tcp:8000
```


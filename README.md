# Seek Thermal Firmware Dump

Read the 4 MiB SPIFI flash of a Seek Thermal camera **from your browser**, over WebUSB, and decrypt
any firmware images found in it. A second view reports the firmware the camera is running and flashes
a new plaintext image to it.

**→ [Open the tool](https://yrambler2001.github.io/seek-thermal-firmware-dump/)**
&nbsp;·&nbsp;
**[Firmware and flashing](https://yrambler2001.github.io/seek-thermal-firmware-dump/#flash)**

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
| `decrypted/*.bin` | each firmware image slot, decrypted — named `…-KeyA-<32 hex>-KeyB-<32 hex>` when the image embeds that key pair (see below) |
| `decrypted/*.txt` | per-slot report: key, key location, cipher profile, SP, entry, SHA-256 |
| `decrypted/decryption_report.txt` | summary across all slots |
| `manifest.json` | exact read, gap and decryption metadata |
| `README.md` | what the capture is and what its limits are |

## Read-only by design

The dump view — the default page — can issue exactly five vendor commands. That is its entire
vocabulary, and there is no code path to anything else:

| Opcode | Name | Dir | Why |
| --- | --- | --- | --- |
| `0x35` | GetErrorCode | IN | check status after each step |
| `0x3c` | SetOperationMode | OUT | only to select mode 0, and only if not already there |
| `0x3d` | GetOperationMode | IN | read the current mode |
| `0x4f` | GetFeaturedFirmwareData | IN | the actual flash read |
| `0x52` | BeginFirmwareUpgrade | OUT | volatile read-window selector only — it selects which block subsequent reads return, and writes nothing |

`SetFeaturedFirmwareData`, `CompleteMemoryUpgrade`, `ResetDevice` and every upload, commit and erase
command are absent from this view. `USBDevice.reset()` is never called either; the retry path just
closes and reopens the handle. Decryption happens entirely in memory on the copy in your browser and
never touches the device.

Writing lives on its own page, [Firmware and flashing](#firmware-and-flashing), with its own listed
command set. Nothing in the dump view reaches it.

## Operation mode 0, and why a cold camera used to hang

Each RPC carries two permission bits in the firmware's dispatch table: bit 0 "allowed in operation
mode 0", bit 1 "allowed in mode 1". They are not the same across builds:

| Command | 4.18.x | 4.9.x |
| --- | --- | --- |
| `BeginFirmwareUpgrade` | `3` — either mode | `1` — **mode 0 only** |
| `GetFeaturedFirmwareData` | `3` — either mode | `1` — **mode 0 only** |
| `GetFirmwareInfo`, `SetFirmwareInfoFeatures`, `SetRamDataFeatures` | `3` | `3` |

So on a 4.9.x camera the two commands the dump is built from are refused while the camera is still
imaging, and the page has to get it into mode 0 first. Leaving imaging is not instant — there is a
sensor and a shutter to park — so the page now waits for mode 0 to actually read back rather than
assuming a fixed delay covers it, and says so plainly if the camera never gets there.

This is also why *reading device info first made dumping work*: the info selectors are allowed in
either mode, and the mode switch that happens on the way settles the camera before the dump starts.

Separately, WebUSB control transfers have no timeout of their own. A camera that simply never answers
left the transfer pending forever, which looked like the page freezing mid-dump with no error and no
retry. Every transfer is now raced against a timer (5 s, or 20 s for the commit, which erases and
programs inside the transfer), so a silent camera becomes an ordinary failure that the existing retry
path reopens and recovers from.

## Read chunk size

**The default is 64 bytes**, the EP0 max packet size, because that is the value that works on every
camera tested. Raising it to 256 is roughly four times faster and is fine on most units.

Some firmware does not tolerate the larger size everywhere. On a 4.9.x PIR324, 256-byte requests serve
65280 bytes of a window and then the request that would empty it is never answered — the same bytes
come back fine in 64-byte requests. So the page adapts: a failed request is retried once at the same
size, then at progressively smaller ones, and **whatever size works is kept for the rest of the
window**. Shrinking only for the stuck request and then going back up just stalls again on the next.

If a chunk will not come at any size, the read stops and keeps what it has. A single bad 256-byte
request used to discard the whole 64 KiB window; now the good bytes are kept, the missing tail is
gap-filled, and both the log and `manifest.json` record exactly which addresses were filled and why.

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
firmware still exists in the other slots. The dump view writes nothing to the device in any case — the
gap affects only the file you download, and the flash view never touches that block either.

If you do want a strictly complete byte-for-byte image — to diff flash against a reference, say —
read it over SWD/J-Link or with an SPI programmer.

## Firmware and flashing

There is a second view at **[`#flash`](https://yrambler2001.github.io/seek-thermal-firmware-dump/#flash)**. It
shows what firmware the camera is running, and writes a new **plaintext** firmware image to it through
the camera's own upgrade path.

The default page is unchanged and still read-only. The write view is a separate URL with its own
command vocabulary, and nothing on the dump page can reach it.

### What it shows

**Read device info** asks the camera what it is, then reads all three firmware slots and decrypts them
locally:

| | |
| --- | --- |
| Running firmware | version and build string from `GetFirmwareInfo`, plus the bootloader's own build string |
| Serial, platform, USB link | from the device-id RAM block and the info selectors |
| Boot config | `cfg[0]` at `0x14010000`, which slot the camera booted, and which slot an upgrade would write |
| Keys | Key A and Key B, read out of the camera's bootloader block and confirmed against a slot's recovered keystream |
| Per-device key | whether `0x14000218` is programmed |
| Each slot | firmware version, image id, size, model string, which key encrypts it, whether it passes the bootloader's acceptance sum and `CODE` footer check, and the SHA-256 of its plaintext |

All of that is reads only.

### What it writes

Give it a **decrypted** image — the same kind of file this page's `decrypted/*.bin` output contains —
and it does the packaging for you:

1. stamps `header.length` (file `+0x204`) to the real image size;
2. tunes the reserved adjust word at `+0x238` so the 32-bit word sum over `header.length` bytes is
   `0x0000FFFF`, the bootloader's acceptance target;
3. encrypts with the Key A it read from your camera;
4. appends `0xff` padding and a 64-byte `"CODE"` footer at
   `((header.length>>14)+1)*0x4000 - 0x40`, carrying over the image id, version and model string from
   the footer already on the device and patching only the length;
5. shows you the whole plan — target slot, both checksums, footer, payload size, a hex preview —
   before anything is sent;
6. streams it in 64-byte chunks and commits.

Then unplug and replug the camera. The bank switch only takes effect on a real power cycle.

### Why the payload is bigger than your image

Each slot holds the encrypted image, padding, and that `CODE` footer. The bootloader reads the footer
straight out of flash, undecrypted, and takes the normal monolithic boot path **only** if
`footer[0] == "CODE"` and `footer[1] == header.length`.

The camera erases the whole 64 KiB block and writes back only what the host streams, and it never
writes the footer itself. So a bare-image upload wipes the footer that was there, the bootloader falls
through to its segmented loader, decrypts a monolithic image as a segment table, and the camera bricks.
The page always streams the full bank and refuses to send one whose footer does not validate.

The other classic failure is `header.length` not matching the real size. The bootloader sums exactly
`header.length` bytes, so a stale length makes the slot fail acceptance and the camera quietly boots
the other bank — "I flashed it but it is still running the old firmware". The page stamps the length
and balances the sum over that exact range.

### Commands it adds

The dump view's five, plus these — that is the entire additional vocabulary:

| Opcode | Name | Dir | Why |
| --- | --- | --- | --- |
| `0x4e` | GetFirmwareInfo | IN | running version, bootloader string, platform, USB speed, boot state |
| `0x55` | SetFirmwareInfoFeatures | OUT | selects which of those to return — a selector register, writes no flash |
| `0x5a` | SetRamDataFeatures | OUT | arms the 248-byte RAM device-id block so the serial can be read |
| `0x50` | SetFeaturedFirmwareData | OUT | streams the payload into the camera's RAM staging buffer |
| `0x51` | CompleteMemoryUpgrade | OUT | the commit — the only command that erases or programs flash |

`ResetDevice` (`0x59`) is still never sent. There is no raw-block write path, and no code path writes
the bootloader at `0x14000000` or the recovery slot at `0x14070000`.

### The keys inside the image, and why the filename carries them

A firmware image contains its own `g_keyA` / `g_keyB`, and once it runs *those* are the keys it uses:
Key A to decrypt an upload, Key B to re-encrypt it into flash. Flash an image whose table belongs to a
different camera and you have quietly changed which keys your camera will use from then on — every
later upgrade lands under a key the bootloader cannot try, and the camera stops taking updates.

So a decrypted image is named after the key pair it actually contains:

```
flash_4m_usb_partial_gap_ff_decrypted_14030000-KeyA-f32ad771…-KeyB-997ed6e5….bin
```

The suffix is added **only when the keys are genuinely in that image** — checked, not assumed. The
keys are locatable by value but not by offset (the pair was found at `0xf54`, `0x9670`, `0x9a3c` and
`0x9a40` across builds, with no constant word nearby to anchor on), and what makes a value search
safe is uniqueness: each key must occur exactly once, so there is no ambiguity about which bytes to
rewrite. They are usually adjacent but need not be — a build may place them apart, and each is
patched where it is found. An image that does not contain the dump's own pair — because it was built
for a different key family, or keeps no literal keys — gets no suffix, and the per-slot report says
so.

At flash time the filename is the contract:

- **Keys present and both found** → they are rewritten to the target camera's keys before packaging,
  so the image will encrypt its own future upgrades with keys that camera's bootloader can read. If
  they are already the target's, nothing changes.
- **No keys in the name** → refused. There is no way to tell whether the file carries keys for this
  camera, for another one, or none at all, and the wrong pair quietly stops the camera accepting any
  later update. The error names the suffix to add if the image does turn out to hold the right pair.
- **Named keys not both in the file, or either appearing more than once** → refused, saying which
  check failed. The file has been renamed, edited, or is not the one those keys came from.

The acceptance sum is balanced after the substitution, so the patch costs nothing else.

### When a flash lands but the camera keeps running the old firmware

The bootloader's `image_try_keys()` tries exactly two keys: the store key (the per-device key at
`0x14000218` if one is programmed, otherwise Key B) and Key A. A slot written under any *third* key
decrypts perfectly, passes its acceptance sum, has a valid footer — and is still skipped at boot,
because the bootloader has no way to derive that key.

That is not hypothetical. On a camera with a 2019 bootloader running a downgraded 4.9.2.0
application, the application re-encrypts every upgrade under a key that is in neither the
bootloader's table nor the per-device slot nor anywhere in flash. Each USB upgrade landed correctly
in the target slot and was then skipped, and the camera carried on booting the other bank — the
write succeeded and nothing changed.

So this page reports **decryptability and bootability as separate things**. A slot is only marked
bootable when the key that encrypted it is one the bootloader will actually try. If a slot holds a
valid image under an unknown key, the page says so, and — because that is direct evidence the
running application re-keys in a way this bootloader cannot follow — it warns before writing that
the flash will not be booted. Changing what such a camera runs needs an SPI programmer or SWD/J-Link.

After a commit the page re-reads 576 bytes of the slot, recovers the keystream from the vector table
alone, and names the key the camera actually stored it under. That is the one thing a clean commit
does not tell you.

### Risk, plainly

`CompleteMemoryUpgrade` erases a 64 KiB block and repoints the boot config. If the image fails
acceptance the camera just falls back to a good slot, which is harmless. The dangerous case is an image
that **passes** acceptance but does not run: the bootloader keeps selecting it, and the bootloader has
no USB. Recovering from that means writing your dump back with an SPI programmer or over SWD/J-Link.

So **Dump the whole flash before writing** is checked by default. Leave it on. The recovery slot at
`0x14070000` is never touched and stays as a golden copy, but `cfg[0]` has to be rewritten to reach it,
and that also needs a programmer once the camera stops enumerating.

### Which cameras

The 2018-and-later generation — the `K=0x13579BDF` / acceptance-sum `0xFFFF` profile, which covers the
Compact, Compact PRO, Compact PRO FF, Compact XR and Nano 300 builds this page has been checked
against. The 2016 Compact Pro generation uses a different cipher profile and a different upgrade
selector map; it is detected and refused rather than guessed at, as is any camera whose Key A cannot be
confirmed against a slot.

### How it was verified

Without a camera on the bench, the packaging was checked against real hardware artifacts instead:

- **Byte-identical rebuild.** For ten real 4 MiB dumps across four device generations, decrypting a
  slot and running the plaintext back through the page's packaging reproduces the bank on the flash —
  image, padding and footer — byte for byte.
- **Agreement with the reference tool.** The cipher, acceptance-sum repair, bank payload, footer offset
  and transfer checksum are byte-identical to `seek_fw_tool.mjs`, the implementation known to have
  booted a real Compact PRO FF, including for resized images.
- **A camera emulator.** The upgrade FSM, the boot-slot selection and the key handling were emulated
  from the reconstructed firmware and bootloader sources, and the page's own code was driven against
  it: it picks the right slot for `cfg[0]` of 0 and 1, alternates A → B → A across power cycles,
  leaves the recovery slot bootable, and the slot it writes decrypts back to exactly the bytes that
  were uploaded — including for an image large enough to move the footer into the next bank.
- **The refusals.** Bad inputs (misaligned, headerless, still-encrypted, bad stack pointer, ARM reset
  vector, oversized), a camera that rejects the transfer checksum, a camera that faults mid-stream, and
  out-of-scope hardware all abort with nothing written.
- **The dump view is unchanged.** Driven against the same emulator it still issues only the five read
  opcodes and leaves the camera's flash byte-identical.
- **Key retargeting, end to end.** The emulator was taught to run the key table inside whatever image
  it booted, like real hardware does. Flashing a foreign-key image without retargeting reproduces the
  failure above — the camera comes up running the foreign keys and the next flash lands unbootable —
  and with retargeting the running keys are the camera's own and every later flash stays bootable.

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


# Seek Thermal Firmware Toolkit

Read the 4 MiB SPIFI flash of a Seek Thermal camera, decrypt the firmware images inside it, and
flash a new plaintext image back — **from a browser over WebUSB, or from the command line**.

**→ [Open the web tool](https://yrambler2001.github.io/seek-thermal-firmware-dump/)**
&nbsp;·&nbsp;
**[Firmware and flashing](https://yrambler2001.github.io/seek-thermal-firmware-dump/#/flash)**

No drivers on macOS or Linux, no SDK, no J-Link. Nothing is uploaded anywhere: the browser build
runs entirely on your machine, and the CLI talks to the camera directly.

```sh
npm ci && npm run build
node packages/cli/dist/bin.js dump --out ./my-camera   # whole flash + decrypted images
node packages/cli/dist/bin.js info                     # what is this camera running?
node packages/cli/dist/bin.js decrypt flash_4m.bin     # works with no camera attached
```

## What it does

1. Walks the device's `BeginFirmwareUpgrade` selector map, reading each 64 KiB block of
   `0x14000000..0x143fffff` with `GetFeaturedFirmwareData` over EP0 vendor control transfers.
2. Assembles the blocks into one 4 MiB image.
3. Scans that image for firmware slots and decrypts them, recovering the key from the dump itself —
   by cryptanalysis, not by searching for a stored key.
4. Hands you a directory or a single `.zip`.

There is also an **offline mode**: point it at a flash image you already have — from this tool, from
J-Link, or from an SPI programmer — and get back the decrypted firmware. That path touches no device
and needs no WebUSB, so in the browser it works in **every** browser, including Safari, Firefox and
iOS.

### Archive contents

| Path                              | What it is                                                                                                                  |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `flash_4m_usb_partial_gap_ff.bin` | the assembled 4 MiB flash image                                                                                             |
| `windows/*.bin`                   | each 64 KiB block exactly as it came off the wire                                                                           |
| `decrypted/*.bin`                 | each firmware image slot, decrypted — named `…-KeyA-<32 hex>-KeyB-<32 hex>` when the image embeds that key pair (see below) |
| `decrypted/*.txt`                 | per-slot report: key, key location, cipher profile, SP, entry, SHA-256                                                      |
| `decrypted/decryption_report.txt` | summary across all slots                                                                                                    |
| `manifest.json`                   | exact read, gap and decryption metadata, including the firmware profile used                                                |
| `README.md`                       | what the capture is and what its limits are                                                                                 |

## Install and use

### Web

Nothing to install — [open the page](https://yrambler2001.github.io/seek-thermal-firmware-dump/).
WebUSB needs Chrome, Edge, or another Chromium browser on Windows, macOS, Linux or Android.

The **Preserve (stepwise)** view runs the [v1 preservation pipeline](#the-v1-full-flash-preservation-pipeline)
one step at a time: six gated steps (backup → patch → commit → drain → restore → verify), each
with its own progress bar and log, and a downloadable run file rebuilt after every completed step.
The run file is the run's only memory — the page keeps no browser storage — so a run can be
resumed from it, or started at a non-first step after an issue. The backup step's archive is taken
before the patched firmware is ever flashed.

### CLI

The packages are not published to npm, so the CLI runs from a clone:

```sh
git clone https://github.com/yrambler2001/seek-thermal-firmware-dump
cd seek-thermal-firmware-dump
npm ci && npm run build
node packages/cli/dist/bin.js --help
```

To get a `seek-fw` on your `PATH`, link it once with
`npm link --workspace @seek-fw/cli`. The examples below use `seek-fw` for
brevity; substitute `node packages/cli/dist/bin.js` if you have not linked it.

| Command                  | What it does                                                             |
| ------------------------ | ------------------------------------------------------------------------ |
| `seek-fw devices`        | list connected Seek cameras                                              |
| `seek-fw info`           | firmware version, slots, key table, boot config, detected profile        |
| `seek-fw dump`           | read the whole 4 MiB flash and decrypt it                                |
| `seek-fw sweep`          | probe every `BeginFirmwareUpgrade` selector and report what each exposes |
| `seek-fw decrypt <file>` | decrypt a dump or image you already have — no camera needed              |
| `seek-fw flash <image>`  | write a decrypted image to the camera                                    |
| `seek-fw profiles`       | list the supported firmware families                                     |

Common options:

```
--out <dir>          write files to a directory (default)
--zip <file>         write a single archive instead
--profile <id>       force a firmware profile instead of detecting one
--chunk <n>          control-IN request size (default 64)
--gap-fill <byte>    fill byte for unreachable blocks (default 0xff)
--retries <n>        per-window retry count (default 2)
--retry-delay <ms>   pause between window retries (default 500)
--recipient <r>      interface | device | auto (default auto)
--serial <id>        pick one camera when several are attached
--no-decrypt         dump the flash but skip the decryption stage
--json               machine-readable output on stdout
--quiet, --verbose, --no-color
```

`seek-fw flash` additionally takes `--yes` to skip the confirmation prompt and `--no-rescue-dump` to
skip the full-flash backup taken before writing. Skipping that backup is not recommended: if the
image does not boot, the dump is the only way back.

On Linux the CLI needs permission to talk to the device — see [the udev rule](#linux-udev-rule)
below, which applies to both the CLI and the browser.

## Firmware version profiles

Seek cameras do not all speak the same protocol, and the differences are not cosmetic — they change
which selector exposes which block, how a stored key maps to the cipher state, and what the
bootloader will accept. A **profile** captures one firmware family:

| Profile        | Family                                                                                                             | Dump   | Decrypt | Flash   |
| -------------- | ------------------------------------------------------------------------------------------------------------------ | ------ | ------- | ------- |
| `modern-4x`    | 2018 and later: Compact 4.8/4.16, Compact Pro 4.9/4.18, Compact XR, Mosaic 2.27/10.9, Nano 200 42.x, Nano 300 44.x | yes    | yes     | **yes** |
| `legacy-auth`  | 2014-2017 locked line: Compact 0.8.0.0-1.3.0.8, Compact PRO 1.0.3.x                                                | yes    | yes     | no      |
| `compact-2016` | the same locked protocol with the 2016 cipher (K=0, acceptance sum 0)                                              | yes    | yes     | no      |
| `compact-2014` | Compact builds older than 0.8.0.0 — no read handler exists in their RPC table                                      | **no** | yes     | no      |
| `generic`      | fallback when the family cannot be identified                                                                      | yes    | yes     | no      |

The profile is detected from evidence — and, on an attached camera, from **asking it**. Before a
dump, a sweep or a device-info read, both the CLI and the web app send up to four read-only
transfers (`--no-probe` turns this off on the CLI): the running firmware's version, then — only
if that build can be read at all — a plain 2-byte arm of a bank the locked line protects, the
18-byte authenticated arm of the same bank, and a read of a bank that is open on every line. Those
answers separate the families directly, where a USB product string or an acceptance sum only
correlates with them. The web app has no "modern" and "legacy" buttons any more: it asks, and
says why when it will not read a camera. `--profile <id>`, or the web app's hand-picked family,
overrides detection and skips the probe — but not the version check: the run still reads the
version first and refuses a camera that does not report it, or runs a build older than 0.8.0.0,
whatever family was named.

**`compact-2014` refuses to dump, and that refusal is the point.** Every decrypted image carries
its own RPC method table — wire id = index + 53 — and recovering it from all 36 images in the
reference corpus shows five builds (0.3.0.1, 0.5.0.2, 0.5.1.0, 0.5.1.3, 0.6.0.4) with no
`GetFeaturedFirmwareData` at all: wire id `0x4F` is `UploadFirmwareRowSize` there, so nothing can
read a window however it is armed. On 0.7.0.7 and 0.7.0.8 it is in the table with its handler in
the write (setter) column only, so the control-IN read a dump sends cannot be dispatched either;
0.8.0.0 is the first build with a read handler. On 0.3.0.1, `0x52` — the id a dump arms 63 windows with — is
`EnterBootloaderMode`. Dumping such a camera would not fail; it would send it 63 requests to leave
the application. The facts are committed in `packages/core/test/firmware/facts.json` and asserted
by `packages/core/test/firmware-facts.test.ts`.

**The locked line reaches `0x14060000` and the modern line does not**, which is the reverse of what
the section below says about 4.x cameras: on a 2016 or 2017 build that block is subcommand 8 behind
the authenticated channel, and the six protected banks (`0x14010000`, `0x14030000`-`0x14070000`)
come back with the token. What that line cannot reach is `0x14000000`, blocked on every channel,
and everything above `0x141FFFFF`, for which it decodes no selector at all — 2 MiB that the dump
now declares as gaps instead of trying 32 selectors and reporting 32 refusals.

Three properties that older versions of this tool conflated are kept independent, because measurement
showed they are:

- the **selector map** (which subcommand exposes which window),
- the **whitening constant K** (how a stored key maps to the keystream state),
- the **acceptance sum TARGET** (what the decrypted word sum must equal).

A real 1.3.0.8 Compact build has `TARGET = 0x0000FFFF` and yet **no whitening at all**. Pairing the
two, as the original single-file page did, reports that build's key wrongly — and a wrong Key A
poisons the upgrade path on a real camera. The tool now resolves K by looking for each candidate key
form in the image's own plaintext and keeping the one that actually occurs.

Adding a family is one file in `packages/core/src/profiles/` plus one `registerProfile()` call.

## Project layout

```
packages/
  core/    @seek-fw/core   isomorphic, zero-dependency: cipher, key recovery,
                           image packaging, USB protocol, firmware profiles
  cli/     @seek-fw/cli    Node CLI, talks to the camera through `usb` v3
  web/     @seek-fw/web    React app, talks to the camera through WebUSB
legacy/index.html          the original single-file page, kept for reference
docs/                      the built web app — GitHub Pages serves this folder
scripts/                   the differential test against the legacy page
```

`core` knows nothing about React, Node or the DOM: it takes a `UsbTransport` and a `Reporter` and
does the work. Both front ends are thin. That is what makes the CLI and the browser genuinely the
same tool rather than two implementations that drift.

## Read-only by design

The dump view — the default page — can issue exactly six vendor commands. That is its entire
vocabulary, and there is no code path to anything else:

| Opcode | Name                    | Dir | Why                                                                                                      |
| ------ | ----------------------- | --- | -------------------------------------------------------------------------------------------------------- |
| `0x4e` | GetFirmwareInfo         | IN  | the running firmware version, read first: it picks the build's own selector table, or refuses the camera |
| `0x35` | GetErrorCode            | IN  | check status after each step                                                                             |
| `0x3c` | SetOperationMode        | OUT | only to select mode 0, and only if not already there                                                     |
| `0x3d` | GetOperationMode        | IN  | read the current mode                                                                                    |
| `0x4f` | GetFeaturedFirmwareData | IN  | the actual flash read                                                                                    |
| `0x52` | BeginFirmwareUpgrade    | OUT | volatile read-window selector only — it selects which block subsequent reads return, and writes nothing  |

Until the camera has reported its firmware version only three of the six go out, and only as
reads — `GetFirmwareInfo`, `GetOperationMode` and `GetErrorCode`, the reads that mean the same thing
on every one of the 36 images examined — because a command number does not mean the same thing on
every build.

`SetFeaturedFirmwareData`, `CompleteMemoryUpgrade`, `ResetDevice` and every upload, commit and erase
command are absent from this view. `USBDevice.reset()` is never called either; the retry path just
closes and reopens the handle. Decryption happens entirely in memory on the copy in your browser and
never touches the device.

Writing lives on its own page, [Firmware and flashing](#firmware-and-flashing), with its own listed
command set. Nothing in the dump view reaches it.

## The v1 full-flash preservation pipeline

`packages/core/src/preservation/` and `seek-fw preserve` implement a full-flash preservation
pipeline for the v1 "locked line" cameras. These are the builds whose write path the profiles
refuse, and that refusal is still right for the general `flash` command; this pipeline is a
separate, explicit, operator-invoked route that exists because in-place preservation cannot be
done read-only. It started with Compact 1.0.0.0 / 1.2.0.0 / 1.3.0.0 (FW-V1 docs 33 sec. 11.7 and 34) and now covers sixteen builds across three cipher/acceptance families — the eight 2014
Compact 0.x builds (0.7.0.7 .. 0.10.0.0) joined in the doc-36 campaign. The command takes NO
image argument: the backup step reads the active slot's image TWICE (two independent captures
that must agree byte for byte — a disagreement refuses the run), derives the factory plaintext
from that capture (identity on the 2014 plain chain, the build family's keystream solver on a
cipher family), gates the derived image, and prints what it will do before anything write-shaped
runs.

### The supported builds

| Build                                                    | Family       | Patch                                                                | Staged form                        | Restore                 | Drain (whole part)                                                                                                                                                                                                              |
| -------------------------------------------------------- | ------------ | -------------------------------------------------------------------- | ---------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compact 1.0.0.0 / 1.2.0.0 / 1.3.0.0                      | v1-2014      | widen + reader trio + arm cursor reset, word 142 rebalanced          | plain (the capture, conjugated)    | capture verbatim        | yes — one widened-window arm; byte-exact at the 64-byte ask                                                                                                                                                                     |
| Compact 0.9.0.2 / 0.9.0.6 / 0.9.0.7 / 0.9.1.0 / 0.10.0.0 | v1-2014      | widen + trio (per-layout offsets) + arm cursor reset, word 142       | plain                              | capture verbatim        | yes — 13 bytes move; full in-place proven on the emulator (doc 36.4); stock cap 65,536 B/arm                                                                                                                                    |
| Compact 0.8.0.0 / 0.7.0.8                                | v1-2014      | widen + trio + arm cursor reset + the mode-2 nop (15 bytes)          | plain                              | capture verbatim        | yes — the nop site MUST be committed before any mode-2 arm (the factory mode 2 arms `*(0x14000000)` and faults under an armed read); full in-place through ip3; the ip4 boot-back stage is open (transport timeouts, doc 36.10) |
| Compact 0.7.0.7                                          | v1-2014      | widen + trio + arm cursor reset (10 bytes, word 142 := `0x0000B300`) | plain                              | capture verbatim        | yes — reads on **wire 88**, and the widened window serves the part ROTATED from the slot the cfg does not name (slot B on the donor); the drain unrotates; full in-place incl. the boot-back (doc 36.4.2)                       |
| Compact 1.3.0.8 (8 Hz "insecure")                        | v1-2014      | widen only (the 2017 reader is already 32-bit; no guard), `0x3000`   | plain                              | capture verbatim        | yes — proven in-place on the 2014 donor                                                                                                                                                                                         |
| Compact 1.3.0.8 FF (16 Hz)                               | v1-2014-ff   | guard + widen, word 142 := `0x485523E8` (the accept solve)           | plain ⊕ ks0 ⊕ ksD (two keystreams) | **refused** (see below) | commit + drain proven **through the recovery slot only**; the in-place variant is derived, not run                                                                                                                              |
| Compact Pro 1.0.3.0 (9 Hz)                               | compact-2016 | guard + widen (by shape), `0xF1003000`                               | plain ⊕ ks(block 0)                | factory image, staged   | yes — the doc-33 chain                                                                                                                                                                                                          |
| Compact Pro 1.0.3.2 (9 Hz and 18 Hz FF)                  | compact-2016 | guard + widen + the arm-tail hook nop, `0x29FD6B0F`                  | plain ⊕ ks(block 0)                | factory image, staged   | **refused** — 128 B is the lossless read unit and the EP0 sessions die at ~64–81 KB; backup → patch → commit → restore → verify only                                                                                            |

Three 0.x-specific facts the plan print states and the gates enforce:

- **The 0.x line is emulator-proven, not hardware-proven.** Every 0.x patch was derived from the
  images' bytes and measured end-to-end on the emulator against the plaintext 1.3.0.0 donor
  (FW-V1 doc 36.4); no native flash dump of any of these builds exists, so a hardware run is
  the first silicon evidence for each. The capability line each run prints says so.
- **The 0.7.x builds serve their reader on wire 88 (`GetFeaturedData`), not 79.** Their method
  table puts the read handler in 0x4F's setter column, and 0x4F stalls for every request length.
  The pipeline selects the reader wire from the version (0.4F everywhere else); on 0.7.0.7 the
  widened mode-2 window serves the part from the A/B slot the boot config does NOT name (measured
  slot B `0x14060000` on the donor's blank record), so the drain unrotates the served bytes
  before the delivered dump is built.
- **On 0.8.0.0 and 0.7.0.8 the factory mode-2 row is a crash hazard**: it loads the word stored
  AT `0x14000000` (the bootloader vector's initial SP) and an armed read walks off SRAM —
  measured on 0.8.0.0 (32 KiB served, then the guest faulted). The patch turns that dereference
  into a nop, and the drain gate refuses a run whose recorded patch lacks the site: the nop is
  applied BEFORE any mode-2 arm is ever sent.

The builds OLDER than 0.7.0.7 (0.3.0.1, 0.5.x, 0.6.0.4) are refused with the doc-cited verdict:
the route does not port to that generation (every arm shape answers `0x400000`, the mode-2 row
is not a `0x14000000`-named window, and the widen constant is not the patchable two-store
immediate — FW-V1 doc 36.7), and no standard dump path exists on it either.

Two build-specific facts the plan print states and the gates enforce:

- **The 1.3.0.8-FF build boots its patch from the RECOVERY slot only.** Its raw word sum is the
  0xFFFF sentinel, which the 2014 bootloader rejects at slots A/B — it boots the recovery bank
  unchecked. The run refuses a commit into A/B, and a run whose detection names A/B (the factory
  chimera's blank cfg) refuses before any write. The restore is refused too, for a measured
  reason: no staged form of the factory image passes the running app's own acceptance while
  transforming back to the original slot bytes (accept1 reads sum(P ⊕ ksD); the factory carries
  `0xB7AB9D17` there, not `0xFFFF`). The FF run ends with the delivered dump in hand and the
  patch in place; the original content can only go back with a full-flash programmer.
- **1.3.0.8 and 1.3.0.8-FF report the same version string.** The build is chosen from image
  properties — the 0xFFFF word-sum sentinel and the key blocks (located by value), never the
  version alone. A 2018-or-later build (4.x, Compact XR, Nano 200/300, Mosaic) is refused with a
  pointer at the standard dump workflow: no widening patch is needed, the modern stock plan
  already reads 63 of the 64 flash windows.
- **A ciphered slot refuses at the keystream-solver seam.** Self-sourcing has to READ the factory
  plaintext out of the slot, and today only the identity solve is implemented (the 2014 plain
  chain, plus every build whose donor stores the image as-is — the 1.3.0.8 chimeras included). A
  genuinely ciphered capture (the native 2016 Compact Pro dumps, whose banks hold plain ⊕ ks) gets
  as far as the build gates and then refuses with "the <family> keystream solver is not
  implemented in this build" — nothing is written, and the run says so.

### What it does — the four phases

| Phase                 | What happens                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | What it touches            |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| **P1 backup**         | Reads all 31 windows a stock camera can serve (BeginFirmwareUpgrade modes 3..9 with the 18-byte token, 0x0A..0x21 plain; 0x14010000..0x141FFFFF, 64 KiB each) and refuses to continue if any window comes back short. The active bank is then read AGAIN as an independent capture — the two must agree byte for byte, and a disagreement refuses the run (a read glitch must become a refusal, never a write) — and the factory plaintext is DERIVED from the agreed capture: identity on the 2014 plain chain, the build family's keystream solver on a cipher family. The derived image's header version must equal what the camera reports, and the build table's gates (detect hooks, before-bytes — an already-patched bank refuses here) run on it before anything is trusted. | read-only                  |
| **P2 in-place patch** | Reads the 28-byte boot-config record (mode 3) and names the ACTIVE slot (a blank `cfg[0]` boots bank A 0x14050000 — the bootloader's fixed A→B→recovery validate order), then commits the patch into the active slot via the raw types-7 path (`0x52` mode 7 + token, `0x50` staging in 64-B chunks, `0x51` commit with the u16 sum) — the bank was already captured, double-read and its image gated in P1. No boot-config write, no other-slot write.                                                                                                                                                                                                                                                                                                                               | **writes the active slot** |
| **P3 full dump**      | Sends the wire-89 reset, which boots the PATCHED image; after re-enumeration it probes the widened mode-2 window (the patch turns the reader's 64 KiB window into the whole 4 MiB part) and drains all 4 MiB at 64 B per call (one EP0 packet — the ask measured exact on the hardware, TESTING.md §28.3). The DELIVERED dump is post-processed: the active bank's 64 KiB is replaced from the P1 backup, so the file you keep is the camera's original flash content, byte-clean.                                                                                                                                                                                                                                                                                                    | read-only after the reset  |
| **P4 restore**        | Commits the ORIGINAL bank content (the P1 capture, staged verbatim — the raw path programs exactly what is staged) back over the active bank while the patched image still runs from SRAM, resets, then re-reads the 31 windows and requires 0 differing bytes against the P1 backup.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | **writes the active slot** |

### The patch, and the ciphertext rule

The patch is five instruction edits in the build's own update machinery, plus one free header
word rebalanced so the bootloader's plaintext word-sum check still passes:

- the reader-window widening, `mov.w r3,#0x10000 → #0x400000`;
- the three halfword loads/stores of the wire-79 reader's cursor, which wrapped every 64 KiB;
- the arm tail's cursor reset, `strh r5,[r4,#12] → str r5,[r4,#12]`. Without it, the arm zeroes
  only the low half of the now 32-bit cursor. After a read that crosses 64 KiB, every later
  window is served pages too far up, and after the drain every read stalls until a power cycle
  (TESTING.md §35.4, §36).

Together they move exactly **thirteen bytes** on the part: 0x238..0x23B, 0x3C1C, 0x3C1D, 0x3C68,
0x3C69, 0x3C70, 0x3C71, 0x3DB7, 0x3DC6, 0x3DC7 (bank-relative). The 0.x line carries the same
arm-tail edit at its own offsets (see the table above).

A flash slot does not hold the firmware image; it holds the image XOR a keystream. The wire-79
reader serves those SLOT BYTES. Pasting the new plaintext bytes into a ciphertext capture corrupts
the slot — the first FW-V1 wire run did exactly that. The pipeline conjugates instead:
`wire[off] := wire[off] XOR old_plain[off] XOR new_plain[off]` per patched byte; the keystream
cancels, the decrypted image changes by exactly the diff. (`conjugateCapture` in
`src/preservation/patch.ts`.)

### The honest risk

**P2 and P4 write the ACTIVE boot slot.** On real hardware an interrupted write there has NO
bootable fallback: the other banks hold whatever they hold, the recovery slot is not written by
this pipeline, and a power loss mid-commit is unrecoverable without an SPI programmer. P1's backup,
P4's restore and the post-processed dump are the mitigation — not a guarantee. Run it on mains
power, keep `preserve_backup_windows.bin`, and treat every commit transfer as the moment the
camera can die.

### Running it

Against the emulator (needs the FW-V1 `emu` directory — point `SEEK_EMU_DIR` at one whose
`seekemu/cli.py` carries `--jedec`, `--flash`, `--flash-out`, `--corpus-entry` and
`--usbip-clock`; the suites boot the real corpus dumps, the corpus entry itself included):

```sh
SEEK_EMU_DIR=/path/to/FW-V1/emu npm run test -- preserve
# the whole file:
SEEK_EMU_DIR=/path/to/FW-V1/emu npx vitest run packages/core/test/preservation/
```

On hardware (Chrome/WebUSB or the node-usb backend). There is no image to pass: the run derives
everything from the camera, and the detailed plan prints after the backup step — before anything
write-shaped runs, with a second confirmation at that point on an interactive terminal:

```sh
seek-fw preserve --out ./preserve-run --yes
```

### Stepwise runs, and resuming one

The pipeline also exists as SIX RESUMABLE STEPS — `backup → patch → commit → drain → restore →
verify` — and this is what `seek-fw preserve` drives: after every step it rewrites
`preserve_run.json` (the run state: what completed, what each step produced, the sha256 of every
artifact) in the run directory. Three properties fall out of that, and they are the reason the
stepwise shape exists:

- **The restore source reaches disk before the first write.** The backup step persists the 31
  windows, the active-bank capture, the DERIVED factory plaintext, AND the standard dump archive
  built offline from the windows (decrypted slots, reports, manifest) — the user's pre-flash dump
  of every region the stock plan can read — before anything write-shaped can possibly run.
- **The run needs nothing but the camera and its own directory.** The image always comes from the
  camera itself, and the derived plaintext is a run artifact — so `--resume <dir>` needs no file
  but the run directory. (Run directories from before the self-sourcing schema kept their
  plaintext outside; resume one at a patch-building step and it asks for that file copied into
  the directory as `preserve_image_plain.bin`.)
- **A crash is a pause, not a loss.** Re-run with `--resume <dir>` and the run continues at
  `state.nextStep`; the interrupted step starts over, and a completed step is never repeated.
  The commit step is not replayable, so it reads the bank back before it writes: a bank that
  already holds the patch (a crash between the commit transfer and its checkpoint) is refused
  with "resume at the drain", and a bank that changed any other way is refused outright.

```sh
seek-fw preserve --print-state ./preserve-run    # the run's state, its next step, and
                                                 # whether the checkpoint files still match
seek-fw preserve --resume ./preserve-run         # continue from the run's next step
seek-fw preserve --resume ./preserve-run --from-step restore  # start at a chosen step
```

`--from-step` refuses, with the reason, when the step it names is missing its files from the
run directory (commit without the backup files) or already completed; jumping past an incomplete
commit warns loudly and then proceeds on your explicit assertion that the camera is in the
patched state — the restore's already-original detection and the verify's 0-diff proof stay in
the steps either way. A Ctrl-C is not a failure: it stops at the
next safe point, leaves the previous checkpoint standing, and exits 130 — the interrupted step is
re-run on the next `--resume`.

On a core level the same steps are `createPreserveRun(opts)` — no image argument; it builds the
empty, self-sourcing shell of a run — and
`runPreserveStep(step, opener, state, loadArtifact, reporter, signal?)` in
`packages/core/src/preservation/steps.ts`: core returns bytes as `Artifact[]` and never touches
the filesystem; the caller (CLI or web) persists them and rewrites the state after every step.
The plaintext-from-capture seam is `solvePlainFromCapture(family, capture)` in
`packages/core/src/preservation/solve.ts`.

Artifacts in the run directory: `preserve_run.json` (the state, rewritten after every step),
`preserve_backup_windows.bin` (the backup, assembled at its flash addresses),
`preserve_bank_capture.bin`, `preserve_image_plain.bin` (the factory plaintext the backup step
derived from the capture), `preserve_patch_plain_patched.bin` (the patched plaintext),
`preserve_dump_postwrite.bin` (the part as patched), `preserve_dump_original.bin` (the delivered
image — the camera's original content), plus `manifest.json`, `README.md` and the decrypted
slots under `decrypted/` (the backup's dump archive).

Artifacts in `--out`: `preserve_backup_windows.bin` (the P1 backup, assembled at its flash
addresses), `preserve_bank_capture.bin`, `preserve_image_plain.bin` (the derived factory
plaintext), `preserve_dump_postwrite.bin` (the part as patched), `preserve_dump_original.bin`
(the delivered image — the camera's original content) and `preserve_run.json` (per-step records
with sha256 of everything).

In the browser, the **Preserve (stepwise)** view drives the same checkpoint-step API one step at a
time; the run there is self-sourced exactly as the CLI's is — the image comes from the camera's
active slot, never from a file the person picked — and each completed step re-issues a
downloadable `preserve-run-<runId>.zip` (the run state plus every checkpoint produced so far,
the derived plaintext included), from which the run resumes. The commit session never resets; the
drain step owns the wire-89 and waits out the reboot ("camera rebooting…"). This camera has no USB
serial number, so Chrome forgets it on every reboot: when the log asks, press "Connect device" and
pick it again, and the phase continues by itself. A run whose committed patch predates the
arm-tail cursor reset (the fifth site) ends Patch & dump by asking you to unplug the camera and
plug it back in: without that site the drain leaves the reader dead until it is powered off. With
it, the restore reads on the same boot and no replug is asked for.

## Operation mode 0, and why a cold camera used to hang

Each RPC carries two permission bits in the firmware's dispatch table: bit 0 "allowed in operation
mode 0", bit 1 "allowed in mode 1". They are not the same across builds:

| Command                                                            | 4.18.x            | 4.9.x                 |
| ------------------------------------------------------------------ | ----------------- | --------------------- |
| `BeginFirmwareUpgrade`                                             | `3` — either mode | `1` — **mode 0 only** |
| `GetFeaturedFirmwareData`                                          | `3` — either mode | `1` — **mode 0 only** |
| `GetFirmwareInfo`, `SetFirmwareInfoFeatures`, `SetRamDataFeatures` | `3`               | `3`                   |

So on a 4.9.x camera the two commands the dump is built from are refused while the camera is still
imaging, and the page has to get it into mode 0 first. Leaving imaging is not instant — there is a
sensor and a shutter to park — so the page now waits for mode 0 to actually read back rather than
assuming a fixed delay covers it, and says so plainly if the camera never gets there.

This is also why _reading device info first made dumping work_: the info selectors are allowed in
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

And when the block _is_ in use, what it holds is a redundant copy. These cameras keep the same
firmware image in several 64 KiB slots. Across every multi-slot dump checked while building this
page, all slots decrypted to byte-identical firmware — in one case across four slots that had been
written with two different keys:

| Dump                       | Slots                                       | Decrypted firmware               |
| -------------------------- | ------------------------------------------- | -------------------------------- |
| Compact_Android_CW         | `14030000` `14050000` `14070000`            | all identical                    |
| Compact_Pro_Android_UQ-AAA | `14050000` **`14060000`** `14070000`        | all identical                    |
| Nano_300_CQ_ABAX           | `14030000` `14040000` `14050000` `14070000` | all identical (2 different keys) |
| Restore_20260801           | `14030000` `14050000` `14070000`            | all identical                    |

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

|                            |                                                                                                                                                                                    |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Running firmware           | version and build string from `GetFirmwareInfo`, plus the bootloader's own build string                                                                                            |
| Serial, platform, USB link | from the device-id RAM block and the info selectors                                                                                                                                |
| Boot config                | `cfg[0]` at `0x14010000`, which slot the camera booted, and which slot an upgrade would write                                                                                      |
| Keys                       | Key A and Key B, read out of the camera's bootloader block and confirmed against a slot's recovered keystream                                                                      |
| Per-device key             | whether `0x14000218` is programmed                                                                                                                                                 |
| Each slot                  | firmware version, image id, size, model string, which key encrypts it, whether it passes the bootloader's acceptance sum and `CODE` footer check, and the SHA-256 of its plaintext |

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

| Opcode | Name                    | Dir | Why                                                                     |
| ------ | ----------------------- | --- | ----------------------------------------------------------------------- |
| `0x4e` | GetFirmwareInfo         | IN  | running version, bootloader string, platform, USB speed, boot state     |
| `0x55` | SetFirmwareInfoFeatures | OUT | selects which of those to return — a selector register, writes no flash |
| `0x5a` | SetRamDataFeatures      | OUT | arms the 248-byte RAM device-id block so the serial can be read         |
| `0x50` | SetFeaturedFirmwareData | OUT | streams the payload into the camera's RAM staging buffer                |
| `0x51` | CompleteMemoryUpgrade   | OUT | the commit — the only command that erases or programs flash             |

`ResetDevice` (`0x59`) is still never sent. There is no raw-block write path, and no code path writes
the bootloader at `0x14000000` or the recovery slot at `0x14070000`.

### The keys inside the image, and why the filename carries them

A firmware image contains its own `g_keyA` / `g_keyB`, and once it runs _those_ are the keys it uses:
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
`0x14000218` if one is programmed, otherwise Key B) and Key A. A slot written under any _third_ key
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

| Platform             | Dumping a camera                                                                                                                      | Decrypting a file |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| **macOS**            | Works out of the box in Chrome/Edge/Chromium. No driver, no admin rights.                                                             | ✅                |
| **Linux**            | Needs a one-line udev rule (below).                                                                                                   | ✅                |
| **Windows**          | Needs WinUSB bound to the camera, via [Zadig](https://zadig.akeo.ie/) — pick the entry named after your camera, e.g. `CompactPRO FF`. | ✅                |
| **Android**          | Works in Chrome with a USB-OTG cable, if the phone can power the camera.                                                              | ✅                |
| **iPhone / iPad**    | **Not possible.** See below.                                                                                                          | ✅                |
| **Firefox / Safari** | Not possible — no WebUSB.                                                                                                             | ✅                |

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

| Stage            | SP constraint                                                               |
| ---------------- | --------------------------------------------------------------------------- |
| `reset-vector`   | top byte equals the dump's own word 0 — fastest, and what a naive scan does |
| `sram-region`    | any LPC43xx SRAM region (`0x10` or `0x20`)                                  |
| `alignment-only` | none; alignment and the entry vector alone                                  |

Dumps that the first stage already handles resolve identically and at identical speed. The stage that
succeeded is recorded per key as `keySearch` in `manifest.json` and in the per-slot report.

Two cipher profiles are known:

| Builds                               | `K`          | checksum target |
| ------------------------------------ | ------------ | --------------- |
| 2018.07.05 / 2019.01.07 / 2021.08.12 | `0x13579BDF` | `0x0000FFFF`    |
| 2016.06.26                           | `0x00000000` | `0x00000000`    |

Decryption is best-effort. A unit whose bootloader derives its key from chip OTP cannot be decrypted
from a flash dump alone, because the OTP is not in the dump. Those slots are skipped and listed in
`manifest.json`; the flash image itself is unaffected.

The implementation is a direct port of `decrypt_firmware.js` and produces byte-identical output —
verified against it on real dumps covering both cipher profiles, multi-key devices, duplicate slots,
and the no-key-found path.

## Development

```sh
git clone https://github.com/yrambler2001/seek-thermal-firmware-dump
cd seek-thermal-firmware-dump
npm ci

npm run dev        # web app on http://localhost:5173
npm run test       # vitest, all packages
npm run check      # format + lint + typecheck + test
npm run build      # builds core, cli, and the web app into docs/
```

Requires Node 22.13 or newer.

The web app is built into `docs/`, which GitHub Pages serves, so **a change to the web app is not
released until `npm run build` is run and `docs/` is committed**. CI fails if the two are out of
sync.

### Running the web app locally

WebUSB needs a secure context, which means HTTPS or `localhost`. `npm run dev` gives you the latter.
To reach it from an Android phone over USB, forward the port so the phone sees `localhost`:

```sh
adb reverse tcp:5173 tcp:5173
```

### Verifying a change against the original

`legacy/index.html` is the only version of this code that has ever driven real hardware, so it is the
reference. `scripts/verify-against-legacy.mjs` loads that page's own `<script>` into a stub-DOM `vm`
context, runs both implementations over real flash dumps, and requires identical results — recovered
keystream state, acceptance checksum, decrypted plaintext, and the rebuilt bank payload byte for
byte.

```sh
npm run build
node scripts/verify-against-legacy.mjs ~/path/to/SEEK_DUMPS
```

The dumps are real camera images and are deliberately not in this repository, so this is a local
audit tool rather than a CI gate. Run it before changing anything in `packages/core/src/crypto` or
`packages/core/src/image` — a bad payload bricks a camera whose bootloader has no USB recovery.

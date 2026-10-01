/**
 * Help text. One table for the commands, one for the flags, and a short block
 * per command — the same surface the README documents.
 */

export const COMMAND_NAMES = [
  'devices',
  'info',
  'dump',
  'sweep',
  'decrypt',
  'flash',
  'preserve',
  'profiles',
] as const;

export type CommandName = (typeof COMMAND_NAMES)[number];

export function isCommandName(value: string): value is CommandName {
  return (COMMAND_NAMES as readonly string[]).includes(value);
}

const COMMON_OPTIONS = `Options
  --out <dir>            write files to a directory (default)
  --zip <file>           write a single archive instead
  --profile <id>         force a firmware profile instead of detecting one
  --no-probe             do not ask the camera which protocol it speaks
  --chunk <n>            control-IN request size, at most 64 (default 64)
  --gap-fill <byte>      fill byte for unreachable blocks (default 0xff)
  --retries <n>          per-window retry count (default 2)
  --retry-delay <ms>     pause between window retries (default 500)
  --recipient <r>        interface | device | auto (default auto)
  --serial <id>          pick one camera when several are attached
  --no-decrypt           dump the flash but skip the decryption stage
  --json                 one JSON document on stdout (--help and --version too)
  --quiet                no progress bar and no log lines
  --verbose              show detail lines and full stack traces
  --no-color             never emit ANSI colour
  -h, --help             show this help
  -V, --version          print the version`;

export const MAIN_USAGE = `seek-fw — dump, decrypt and reflash Seek Thermal camera firmware

Usage
  seek-fw <command> [options]

Commands
  devices                list connected Seek cameras
  info                   firmware version, slots, key table, boot config, detected profile
  dump                   read the whole 4 MiB flash and decrypt it
  sweep                  probe every BeginFirmwareUpgrade selector and report what each exposes
  decrypt <file>         decrypt a dump or image you already have — no camera needed
  flash <image>          write a decrypted image to the camera
  preserve <image>       v1 full-flash preservation: in-place patch, whole-part dump, restore
  profiles               list the supported firmware families

${COMMON_OPTIONS}

flash also takes
  --yes                  skip the interactive confirmation
  --no-rescue-dump       skip the full-flash backup taken before writing (not recommended)

Examples
  seek-fw dump --out ./my-camera
  seek-fw preserve plain-1.3.0.0.bin --out ./preserve-run --yes
  seek-fw info --json | jq .firmware
  seek-fw decrypt flash_4m.bin --out ./decrypted
  seek-fw flash image-KeyA-....-KeyB-....bin --out ./rescue

Under --json stdout carries exactly one JSON document, --help and --version
included, and every human line goes to stderr.

Exit codes: 0 success, 1 the operation failed, 2 bad usage, 130 interrupted.
`;

const COMMAND_USAGE: Record<CommandName, string> = {
  devices: `seek-fw devices — list connected Seek cameras

Usage
  seek-fw devices [--json]

Lists every device with vendor id 0x289d that this host can see. Exits 0 and
says "no Seek camera found" when there is none.
`,
  info: `seek-fw info — what is this camera running?

Usage
  seek-fw info [--profile <id>] [--chunk <n>] [--json]

Reads the firmware info selectors, the boot config and all three firmware
slots, decrypts them locally and reports the running version, the key table,
which slot booted, which slot an upgrade would write, and whether each slot is
merely decryptable or actually bootable. Read-only.
`,
  dump: `seek-fw dump — read the whole 4 MiB flash

Usage
  seek-fw dump [--out <dir> | --zip <file>] [options]

Walks the profile's BeginFirmwareUpgrade selector map, reads every 64 KiB
window, assembles a 4 MiB image, and decrypts whatever firmware slots it
contains. Ctrl-C stops the read and still writes what was read.
`,
  sweep: `seek-fw sweep — probe every selector

Usage
  seek-fw sweep [--out <dir> | --zip <file>] [options]

Arms every BeginFirmwareUpgrade subcommand in the profile's sweep range and
records what each one exposes. The tool for a camera whose selector map is not
known. Read-only; stalls are expected and are recorded, not treated as errors.
`,
  decrypt: `seek-fw decrypt — decrypt a dump you already have

Usage
  seek-fw decrypt <file> [--out <dir> | --zip <file>] [--profile <id>]

Needs no camera, no USB permissions and no drivers. Scans the file for firmware
image slots, recovers each slot's key by cryptanalysis (not by searching for a
stored key) and writes the plaintext images plus per-slot reports.
`,
  flash: `seek-fw flash — write a decrypted image to the camera

Usage
  seek-fw flash <image> [--yes] [--no-rescue-dump] [--out <dir>] [options]

Reads the device info, takes a full rescue dump FIRST (unless --no-rescue-dump),
packages the image for this camera — stamping header.length, balancing the
acceptance sum, retargeting the image's own key table to this camera's keys,
appending the CODE footer — shows the whole plan and asks for confirmation
before anything is sent.

The image file must be a DECRYPTED image whose name still carries the key pair
it contains, exactly as \`seek-fw dump\` wrote it. Refused otherwise.

  --yes                  skip the confirmation (required when stdin is not a tty)
  --no-rescue-dump       skip the backup. If the image does not boot, that dump
                         is the only way back. Not recommended.
`,
  preserve: `seek-fw preserve — the v1 full-flash preservation pipeline

Usage
  seek-fw preserve <plain-image> [--out <dir>] [--yes] [options]

The four phases for a v1 locked-line camera (Compact 1.0.0.0 / 1.2.0.0 /
1.3.0.0): P1 backs up the 31 reachable windows (read-only), P2 names the
ACTIVE boot slot from the boot-config record and patches it IN PLACE — the
reader-window widening and cursor fix, conjugated into the slot's ciphertext
so the decrypted image changes by exactly the ten enumerated bytes — P3 resets
the camera, drains the whole 4 MiB through the widened window and post-
processes the dump back to the camera's original content, and P4 restores the
original bank and re-reads the part to prove it.

THE IMAGE ARGUMENT is the DECRYPTED factory plaintext of the build the camera
runs (the corpus image, or your own decrypt). The expected firmware version is
derived from it; the camera must report that build before anything is sent.

THE RISK, PLAINLY: P2 and P4 write the ACTIVE boot slot. On real hardware an
interrupted write there has no bootable fallback — a power loss mid-commit
needs an SPI programmer. P1's backup and P4's restore are the mitigation, not
a guarantee. Run on mains power, keep the backup.

  --yes                  skip the confirmation (required when stdin is not a tty)

Artifacts written under --out: preserve_backup_windows.bin,
preserve_bank_capture.bin, preserve_dump_postwrite.bin (the patched part),
preserve_dump_original.bin (the delivered, original-content image) and
preserve_run.json (phase records, sha256 of everything).
`,
  profiles: `seek-fw profiles — list the supported firmware families

Usage
  seek-fw profiles [--json]

Shows each profile's id, name, capabilities and cipher parameters. Any of these
ids may be passed to --profile to override detection.
`,
};

export function usageFor(command: CommandName | null): string {
  return command === null ? MAIN_USAGE : COMMAND_USAGE[command];
}

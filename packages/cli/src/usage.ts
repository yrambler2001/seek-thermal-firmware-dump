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

preserve also takes
  --resume <dir>         continue the run whose state lives in <dir> (from its next step)
  --from-step <id>       with --resume: start at a chosen step (backup patch commit drain
                         restore verify); refused when the step's prerequisites are missing
  --print-state <dir>    print a run's state, its next step, and whether the checkpoint
                         files still match what was recorded; touches no camera

Examples
  seek-fw dump --out ./my-camera
  seek-fw preserve plain-1.3.0.0.bin --out ./preserve-run --yes
  seek-fw preserve --resume ./preserve-run
  seek-fw preserve --print-state ./preserve-run
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
  seek-fw preserve --resume <dir> [plain-image] [--from-step <id>] [--yes]
  seek-fw preserve --print-state <dir>

The pipeline runs as SIX RESUMABLE STEPS, checkpointed after every one, for a
v1 locked-line camera (Compact 1.0.0.0 / 1.2.0.0 / 1.3.0.0):

  backup   read the 31 windows a stock camera can serve (read-only), name the
           ACTIVE boot slot, capture its bank, and write the backup AND the
           standard dump archive (decrypted slots, reports, manifest) built
           from it. The user's pre-flash dump of every reachable region —
           on disk before anything write-shaped can run.
  patch    offline, no device: derive the in-place patch (the reader-window
           widening and cursor fix, conjugated later into the slot's
           ciphertext so exactly the ten enumerated bytes change).
  commit   verify the bank against the backup, read the bank back (a commit
           that already landed is never replayed), stage image-length-only,
           and commit — on a session that never resets.
  drain    the reset that boots the patched image (with its retry ladder for
           the ~10 s of silence a reboot costs), then the whole 4 MiB through
           the widened window, drained FIRST on its own single arm.
  restore  stage the original bank content back, verbatim, and reset.
  verify   a fresh boot re-reads the 31 windows: 0 differing bytes proves the
           camera's flash came back byte-identical.

THE IMAGE ARGUMENT is the DECRYPTED factory plaintext of the build the camera
runs (the corpus image, or your own decrypt). The expected firmware version is
derived from it; the camera must report that build before anything is sent.
--resume needs it only when it resumes at patch or commit.

THE RISK, PLAINLY: commit and restore write the ACTIVE boot slot. On real
hardware an interrupted write there has no bootable fallback — a power loss
mid-commit needs an SPI programmer. The backup checkpoint (written before the
first write) and the restore are the mitigation, not a guarantee. Run on mains
power, keep the run directory.

  --yes                  skip the confirmation (required when stdin is not a tty)
  --resume <dir>         continue the run in <dir> from its next step
  --from-step <id>       with --resume: start at a chosen step. Refused when the
                         step's files are missing from the run directory (commit
                         without the backup files) or the step already completed;
                         jumping past an incomplete commit warns loudly and then
                         runs on your explicit assertion that the camera is in the
                         patched state (the restore and verify keep their own
                         wire-side checks).
  --print-state <dir>    print the run's state, its next step, and whether the
                         checkpoint files still match what was recorded.

Interrupted runs: Ctrl-C stops at the next safe point, leaves the previous
checkpoint standing, and exits 130. Re-run the same --resume command to
continue; the interrupted step starts over.

Artifacts in the run directory: preserve_run.json (the state, rewritten after
every step), preserve_backup_windows.bin, preserve_bank_capture.bin,
preserve_patch_plain_patched.bin, preserve_dump_postwrite.bin (the patched
part), preserve_dump_original.bin (the delivered, original-content image),
manifest.json and README.md (the backup's dump archive) plus the decrypted
slots under decrypted/.
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

/**
 * Argument parsing and command dispatch.
 *
 * Parsing is `node:util`'s `parseArgs` and nothing else — a CLI with seven
 * commands and fifteen flags does not need a framework. `parseCli` is pure and
 * exported so the tests can assert the whole flag surface without running
 * anything; `run` owns the process-shaped parts: streams, the abort signal and
 * the exit code.
 */

import { parseArgs } from 'node:util';
import {
  getProfile,
  listProfiles,
  type ProfileId,
  type RecipientPreference,
  type UsbBackend,
} from '@seek-fw/core';
import type { BackendOptions } from './backend.js';
import { shouldColor } from './ansi.js';
import {
  CliError,
  describeError,
  EXIT_CANCELLED,
  EXIT_OK,
  EXIT_USAGE,
  UsageError,
} from './errors.js';
import { TerminalReporter } from './reporter.js';
import type { Sink } from './sink.js';
import { isCommandName, usageFor, type CommandName } from './usage.js';
import { devicesCommand } from './commands/devices.js';
import { profilesCommand } from './commands/profiles.js';
import { infoCommand } from './commands/info.js';
import { dumpCommand } from './commands/dump.js';
import { sweepCommand } from './commands/sweep.js';
import { decryptCommand } from './commands/decrypt.js';
import { flashCommand } from './commands/flash.js';
import { preserveCommand } from './commands/preserve.js';

/* ==================================================================== *
 * Options
 * ==================================================================== */

export interface GlobalOptions {
  readonly out: string | null;
  readonly zip: string | null;
  readonly profile: ProfileId | null;
  /**
   * Ask the camera which protocol it speaks before choosing a profile.
   *
   * On by default, and `--no-probe` turns it off. The probe is four read-only
   * transfers and it is the difference between choosing a family from a USB
   * product string and choosing it from the camera's own answers — see
   * `probeSelectorChannel`. Off is for a bench session that wants nothing sent
   * but the dump itself.
   */
  readonly probe: boolean;
  /** null means "core's default", which is the value the README documents. */
  readonly chunk: number | null;
  readonly gapFill: number | null;
  readonly retries: number | null;
  readonly retryDelayMs: number | null;
  readonly recipient: RecipientPreference;
  readonly serial: string | null;
  /** False when `--no-decrypt` was passed: dump the flash but skip decryption. */
  readonly decrypt: boolean;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  /** False when `--no-color` was passed. The environment is consulted later. */
  readonly colorFlag: boolean;
  readonly yes: boolean;
  readonly rescueDump: boolean;
}

export type ParsedCli =
  /* `json` rides along on all three: `--json` means "stdout is a JSON
   * document", and help and version are no exception. */
  | { readonly kind: 'help'; readonly command: CommandName | null; readonly json: boolean }
  | { readonly kind: 'version'; readonly json: boolean }
  | {
      readonly kind: 'run';
      readonly command: CommandName;
      /** The single positional `decrypt` and `flash` take. */
      readonly file: string | null;
      readonly options: GlobalOptions;
    };

const RECIPIENTS: readonly RecipientPreference[] = ['interface', 'device', 'auto'];

/** Commands that take exactly one file argument. */
const FILE_COMMANDS: ReadonlySet<CommandName> = new Set<CommandName>([
  'decrypt',
  'flash',
  'preserve',
]);

function parseInteger(name: string, text: string): number {
  if (!/^(0[xX][0-9a-fA-F]+|[0-9]+)$/.test(text.trim())) {
    throw new UsageError(`--${name} expects a number, got '${text}'`);
  }
  const value = Number(text.trim());
  if (!Number.isInteger(value)) throw new UsageError(`--${name} expects a whole number`);
  return value;
}

function bounded(name: string, value: number, min: number, max: number): number {
  if (value < min || value > max) {
    throw new UsageError(
      `--${name} must be between ${String(min)} and ${String(max)}, got ${String(value)}`,
    );
  }
  return value;
}

function validProfileId(id: string): ProfileId {
  try {
    return getProfile(id).id;
  } catch {
    const known = listProfiles()
      .map((profile) => profile.id)
      .join(', ');
    throw new UsageError(`unknown profile '${id}'`, `known profiles: ${known}`);
  }
}

/**
 * Parses argv (WITHOUT the node and script entries).
 *
 * Every failure here is a `UsageError`, which the caller renders with the
 * usage text and exits 2 for — a malformed command line is never a silent
 * fallback to a default.
 */
export function parseCli(argv: readonly string[]): ParsedCli {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      allowNegative: true,
      strict: true,
      options: {
        out: { type: 'string' },
        zip: { type: 'string' },
        profile: { type: 'string' },
        chunk: { type: 'string' },
        'gap-fill': { type: 'string' },
        retries: { type: 'string' },
        'retry-delay': { type: 'string' },
        recipient: { type: 'string' },
        serial: { type: 'string' },
        decrypt: { type: 'boolean', default: true },
        json: { type: 'boolean', default: false },
        quiet: { type: 'boolean', default: false },
        verbose: { type: 'boolean', default: false },
        color: { type: 'boolean', default: true },
        yes: { type: 'boolean', default: false },
        'rescue-dump': { type: 'boolean', default: true },
        probe: { type: 'boolean', default: true },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'V', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }

  const values = parsed.values;
  const positionals = parsed.positionals;
  const [commandWord, ...rest] = positionals;

  if (values.version) return { kind: 'version', json: values.json };

  if (commandWord === undefined) {
    if (values.help) return { kind: 'help', command: null, json: values.json };
    throw new UsageError('no command given');
  }
  if (!isCommandName(commandWord)) {
    throw new UsageError(`unknown command '${commandWord}'`);
  }
  if (values.help) return { kind: 'help', command: commandWord, json: values.json };

  const takesFile = FILE_COMMANDS.has(commandWord);
  if (takesFile && rest.length === 0) {
    throw new UsageError(`${commandWord} needs a file argument`);
  }
  if (rest.length > (takesFile ? 1 : 0)) {
    const extra = rest[takesFile ? 1 : 0] ?? '';
    throw new UsageError(`unexpected argument '${extra}' after '${commandWord}'`);
  }

  const recipient = values.recipient ?? 'auto';
  if (!(RECIPIENTS as readonly string[]).includes(recipient)) {
    throw new UsageError(`--recipient must be one of ${RECIPIENTS.join(', ')}, got '${recipient}'`);
  }

  const options: GlobalOptions = {
    out: values.out ?? null,
    zip: values.zip ?? null,
    profile: values.profile === undefined ? null : validProfileId(values.profile),
    chunk:
      values.chunk === undefined
        ? null
        : bounded('chunk', parseInteger('chunk', values.chunk), 1, 0x10000),
    gapFill:
      values['gap-fill'] === undefined
        ? null
        : bounded('gap-fill', parseInteger('gap-fill', values['gap-fill']), 0, 0xff),
    retries:
      values.retries === undefined
        ? null
        : bounded('retries', parseInteger('retries', values.retries), 0, 100),
    retryDelayMs:
      values['retry-delay'] === undefined
        ? null
        : bounded('retry-delay', parseInteger('retry-delay', values['retry-delay']), 0, 600_000),
    recipient: recipient as RecipientPreference,
    serial: values.serial ?? null,
    decrypt: values.decrypt,
    json: values.json,
    quiet: values.quiet,
    verbose: values.verbose,
    probe: values.probe,
    /* `--no-color`, `--no-rescue-dump` and `--no-probe` come through parseArgs'
     * own negation support, so each arrives here already resolved. */
    colorFlag: values.color,
    yes: values.yes,
    rescueDump: values['rescue-dump'],
  };

  if (options.quiet && options.verbose) {
    throw new UsageError('--quiet and --verbose contradict each other');
  }

  return { kind: 'run', command: commandWord, file: takesFile ? (rest[0] ?? null) : null, options };
}

/* ==================================================================== *
 * Dispatch
 * ==================================================================== */

/** Everything a command may touch, so tests can drive one without a process. */
export interface Io {
  readonly stdout: Sink;
  readonly stderr: Sink;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly stdinIsTty: boolean;
  readonly platform: string;
  readonly version: string;
  /** Asks a yes/no question. Rejecting is up to the caller; false means no. */
  confirm(question: string): Promise<boolean>;
  now?(): Date;
  /**
   * Replaces USB discovery. Only the tests set it — they hand back core's own
   * fake camera, which is how every command below this line is exercised
   * without hardware.
   */
  backend?(options: BackendOptions): UsbBackend;
}

export interface CommandContext {
  readonly options: GlobalOptions;
  /** The positional file, for `decrypt` and `flash`. */
  readonly file: string | null;
  readonly reporter: TerminalReporter;
  readonly io: Io;
  readonly signal: AbortSignal;
  /** False under `--json`, where stdout belongs to the JSON document. */
  readonly human: boolean;
  /** Writes a line of result text (not a log line): never suppressed by --quiet. */
  out(text: string): void;
  /** Colours text, honouring --no-color / NO_COLOR / a non-tty stdout. */
  readonly color: boolean;
}

/**
 * A command returns the object that `--json` prints.
 *
 * One key is a contract rather than data: `cancelled: true` means the run was
 * interrupted and what it produced is PARTIAL. The output is still written and
 * still printed — core stops a dump where it is and hands back everything it
 * read — but the process exits 130, so no script mistakes a partial archive
 * for a finished one.
 */
export type CommandResult = Record<string, unknown>;

export type Command = (ctx: CommandContext) => Promise<CommandResult>;

const COMMANDS: Record<CommandName, Command> = {
  devices: devicesCommand,
  profiles: profilesCommand,
  info: infoCommand,
  dump: dumpCommand,
  sweep: sweepCommand,
  decrypt: decryptCommand,
  flash: flashCommand,
  preserve: preserveCommand,
};

/**
 * The one JSON document `--json` is allowed to put on stdout.
 *
 * Every `--json` path goes through here, so "exactly one document per run" is
 * a property of the code and not of a convention four call sites remember.
 */
function emitJson(stdout: Sink, document: Record<string, unknown>): void {
  stdout.write(`${JSON.stringify(document, null, 2)}\n`);
}

/**
 * Runs one command line and returns the process exit code.
 *
 * Stream policy, which the `--json` contract depends on: under `--json`
 * stdout carries exactly one JSON document and every human line goes to
 * stderr; otherwise human output goes to stdout. The progress bar is always on
 * stderr, so `seek-fw dump --json > run.json` still shows progress.
 */
export async function run(argv: readonly string[], io: Io, signal: AbortSignal): Promise<number> {
  let parsed: ParsedCli;
  try {
    parsed = parseCli(argv);
  } catch (error) {
    const described = describeError(error, io.platform);
    /* `--json` is read straight off argv here because parsing is what failed.
     * Without this, a usage error was the one outcome that wrote nothing to
     * stdout, so `seek-fw … --json | jq` broke on a typo'd flag while every
     * other failure produced a readable error document. */
    if (argv.includes('--json')) {
      emitJson(io.stdout, {
        command: null,
        ok: false,
        error: {
          code: 'cli/usage',
          message: described.message,
          ...(described.hint === undefined ? {} : { hint: described.hint }),
        },
      });
    }
    io.stderr.write(`${usageFor(null)}\n`);
    io.stderr.write(`error: ${described.message}\n`);
    if (described.hint !== undefined) io.stderr.write(`${described.hint}\n`);
    return EXIT_USAGE;
  }

  /* `--help` and `--version` are documents under `--json` like everything
   * else. The alternative — two commands whose stdout is prose no matter what
   * was asked for — is the one exception that makes `seek-fw ... --json | jq`
   * unsafe to write in a script. */
  if (parsed.kind === 'version') {
    if (parsed.json) emitJson(io.stdout, { command: null, ok: true, version: io.version });
    else io.stdout.write(`${io.version}\n`);
    return EXIT_OK;
  }
  if (parsed.kind === 'help') {
    if (parsed.json) {
      emitJson(io.stdout, { command: parsed.command, ok: true, help: usageFor(parsed.command) });
    } else {
      io.stdout.write(usageFor(parsed.command));
    }
    return EXIT_OK;
  }

  const { options, command, file } = parsed;
  const logSink = options.json ? io.stderr : io.stdout;
  const color = shouldColor({
    noColorFlag: !options.colorFlag,
    isTty: logSink.isTty,
    env: io.env,
  });
  const reporter = new TerminalReporter({
    log: logSink,
    progress: io.stderr,
    color,
    quiet: options.quiet,
    verbose: options.verbose,
  });

  const ctx: CommandContext = {
    options,
    file,
    reporter,
    io,
    signal,
    human: !options.json,
    color,
    out(text: string): void {
      /* --quiet means quiet: the exit code and, with --json, the document are
       * what a script reads. */
      if (!options.quiet) reporter.write(text);
    },
  };

  try {
    const result = await COMMANDS[command](ctx);
    reporter.finish();
    const cancelled = result.cancelled === true;
    if (options.json) emitJson(io.stdout, { command, ok: !cancelled, ...result });
    if (cancelled) {
      io.stderr.write('\ninterrupted — what had been read was saved; the result is partial\n');
      return EXIT_CANCELLED;
    }
    return EXIT_OK;
  } catch (error) {
    reporter.finish();
    const described = describeError(error, io.platform);
    if (options.json) {
      emitJson(io.stdout, {
        command,
        ok: false,
        error: {
          code: described.code,
          message: described.message,
          ...(described.hint === undefined ? {} : { hint: described.hint }),
        },
      });
    }
    if (described.cancelled) {
      io.stderr.write('\ninterrupted\n');
      return described.exitCode;
    }
    io.stderr.write(`error: ${described.message}\n`);
    if (described.hint !== undefined) io.stderr.write(`\n${described.hint}\n`);
    if (options.verbose && error instanceof Error && error.stack !== undefined) {
      io.stderr.write(`\n${error.stack}\n`);
    }
    if (error instanceof CliError && error.code === 'cli/usage') {
      io.stderr.write(`\n${usageFor(command)}`);
    }
    return described.exitCode;
  }
}

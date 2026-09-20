/**
 * The exit-code contract, pinned where it is decided.
 *
 * `run` prints the usage block for any error whose code is `cli/usage`, so the
 * code and the number have to agree — a command that prints usage and exits 1
 * is a CLI that lies about what went wrong.
 */

import { describe, expect, it } from 'vitest';
import { parseCli, type CommandContext } from '../src/cli.js';
import { decryptCommand } from '../src/commands/decrypt.js';
import { flashCommand } from '../src/commands/flash.js';
import { CliError, EXIT_FAILED, EXIT_USAGE, UsageError, describeError } from '../src/errors.js';
import { TerminalReporter } from '../src/reporter.js';
import { MemorySink } from '../src/sink.js';
import { testIo } from './helpers.js';

/**
 * A context with no positional file. Argument parsing rejects that first today,
 * so this is the only way to reach the guard the commands still carry.
 */
function contextWithoutFile(): CommandContext {
  const parsed = parseCli(['decrypt', 'unused.bin']);
  if (parsed.kind !== 'run') throw new Error(`expected a run, got ${parsed.kind}`);
  const sink = new MemorySink();
  const { io } = testIo();
  return {
    options: parsed.options,
    file: null,
    reporter: new TerminalReporter({
      log: sink,
      progress: sink,
      color: false,
      quiet: true,
      verbose: false,
    }),
    io,
    signal: new AbortController().signal,
    human: false,
    color: false,
    out: (text: string): void => {
      sink.write(text);
    },
  };
}

async function refusal(work: Promise<unknown>): Promise<CliError> {
  try {
    await work;
  } catch (error) {
    if (error instanceof CliError) return error;
    throw error;
  }
  throw new Error('expected the command to refuse');
}

describe('CliError', () => {
  it('exits 2 for cli/usage, whatever the caller asked for', () => {
    expect(new CliError('bad', { code: 'cli/usage' }).exitCode).toBe(EXIT_USAGE);
    expect(new CliError('bad', { code: 'cli/usage', exitCode: EXIT_FAILED }).exitCode).toBe(
      EXIT_USAGE,
    );
    expect(new UsageError('bad').exitCode).toBe(EXIT_USAGE);
    /* Everything else keeps the old behaviour. */
    expect(new CliError('bad').exitCode).toBe(EXIT_FAILED);
    expect(new CliError('bad', { code: 'flash/refused' }).exitCode).toBe(EXIT_FAILED);
    expect(new CliError('bad', { code: 'cli/no-input', exitCode: 7 }).exitCode).toBe(7);
  });

  it('carries that through describeError, which is what run() acts on', () => {
    expect(describeError(new CliError('bad', { code: 'cli/usage' })).exitCode).toBe(EXIT_USAGE);
  });
});

describe('the commands that raise cli/usage themselves', () => {
  it('ask for exit 2, not exit 1', async () => {
    const fromDecrypt = await refusal(decryptCommand(contextWithoutFile()));
    expect(fromDecrypt.code).toBe('cli/usage');
    expect(fromDecrypt.exitCode).toBe(EXIT_USAGE);

    const fromFlash = await refusal(flashCommand(contextWithoutFile()));
    expect(fromFlash.code).toBe('cli/usage');
    expect(fromFlash.exitCode).toBe(EXIT_USAGE);
  });
});

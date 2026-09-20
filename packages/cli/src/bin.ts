#!/usr/bin/env node
/**
 * The executable. Everything process-shaped lives here and nowhere else:
 * argv, the streams, the version string, SIGINT and the exit code.
 *
 * Ctrl-C aborts through an `AbortSignal` that is handed to core, which stops
 * at the next loop boundary and throws `CancelledError` — the dump command
 * then writes the windows that were already read before the error propagates.
 * A second Ctrl-C gives up on that and quits immediately.
 */

import { createInterface } from 'node:readline/promises';
import { createRequire } from 'node:module';
import { run, type Io } from './cli.js';
import { streamSink } from './sink.js';
import { EXIT_CANCELLED } from './errors.js';

function packageVersion(): string {
  try {
    const require = createRequire(import.meta.url);
    const manifest: unknown = require('../package.json');
    if (typeof manifest === 'object' && manifest !== null && 'version' in manifest) {
      const version = (manifest as { version?: unknown }).version;
      if (typeof version === 'string') return version;
    }
  } catch {
    /* running from somewhere without the package.json next to us */
  }
  return '0.0.0-dev';
}

async function confirm(question: string): Promise<boolean> {
  /* The prompt goes to stderr so that `--json` keeps stdout clean even when it
   * asks a question. */
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    const answer = await rl.question(question);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

const controller = new AbortController();
let interrupts = 0;
process.on('SIGINT', () => {
  interrupts += 1;
  if (interrupts > 1) {
    process.stderr.write('\nquitting now\n');
    process.exit(EXIT_CANCELLED);
  }
  process.stderr.write(
    '\ninterrupted — stopping at the next safe point and keeping what has already been read ' +
      '(Ctrl-C again to quit immediately)\n',
  );
  controller.abort();
});

const io: Io = {
  stdout: streamSink(process.stdout),
  stderr: streamSink(process.stderr),
  env: process.env,
  stdinIsTty: process.stdin.isTTY,
  platform: process.platform,
  version: packageVersion(),
  confirm,
};

process.exitCode = await run(process.argv.slice(2), io, controller.signal);

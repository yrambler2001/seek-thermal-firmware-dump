#!/usr/bin/env node
/**
 * The executable. Everything process-shaped lives here and nowhere else:
 * argv, the streams, the version string, SIGINT and the exit code.
 *
 * Ctrl-C aborts through an `AbortSignal` that is handed to core, which stops
 * at the next loop boundary and throws `CancelledError` — the dump command
 * then writes the windows that were already read before the error propagates.
 * A second Ctrl-C gives up on that and quits immediately. The handler itself,
 * including its removal and the flush the hard exit waits for, is in
 * `interrupt.ts`.
 */

import { createInterface } from 'node:readline/promises';
import { createRequire } from 'node:module';
import { run, type Io } from './cli.js';
import { installInterruptHandler } from './interrupt.js';
import { streamSink } from './sink.js';

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
const interrupt = installInterruptHandler({
  target: process,
  stdout: process.stdout,
  warn: (text) => {
    process.stderr.write(text);
  },
  abort: () => {
    controller.abort();
  },
  exit: (code) => {
    process.exit(code);
  },
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

try {
  process.exitCode = await run(process.argv.slice(2), io, controller.signal);
} finally {
  /* The run is over. A Ctrl-C from here on belongs to whatever comes next — and
   * the `--json` document is already on stdout, where a hard exit could have
   * cut it in half. */
  interrupt.release();
}

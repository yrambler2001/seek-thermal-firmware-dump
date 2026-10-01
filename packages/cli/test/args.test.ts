import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_DUMP_OPTIONS } from '@seek-fw/core';
import { parseCli, run } from '../src/cli.js';
import { EXIT_OK, EXIT_USAGE, UsageError } from '../src/errors.js';
import { MAIN_USAGE } from '../src/usage.js';
import { testIo } from './helpers.js';

function runOptions(argv: readonly string[]) {
  const parsed = parseCli(argv);
  if (parsed.kind !== 'run') throw new Error(`expected a run, got ${parsed.kind}`);
  return parsed;
}

describe('parseCli', () => {
  it('turns decryption off with --no-decrypt, which a default of true needs', () => {
    /* `decrypt` defaults to true in core, so "only forward what was set"
     * could never express turning it off — the web UI has always had this
     * control and the CLI silently did not. */
    expect(runOptions(['dump']).options.decrypt).toBe(true);
    expect(runOptions(['dump', '--no-decrypt']).options.decrypt).toBe(false);
    expect(runOptions(['dump', '--decrypt']).options.decrypt).toBe(true);
  });

  it('defaults every option that was not given', () => {
    const parsed = runOptions(['dump']);
    expect(parsed.command).toBe('dump');
    expect(parsed.file).toBeNull();
    expect(parsed.options).toEqual({
      out: null,
      zip: null,
      profile: null,
      chunk: null,
      gapFill: null,
      retries: null,
      retryDelayMs: null,
      recipient: 'auto',
      serial: null,
      json: false,
      quiet: false,
      verbose: false,
      colorFlag: true,
      decrypt: true,
      yes: false,
      rescueDump: true,
      probe: true,
      resume: null,
      fromStep: null,
      printState: null,
    });
  });

  it('turns the capability probe off with --no-probe', () => {
    expect(runOptions(['dump']).options.probe).toBe(true);
    expect(runOptions(['dump', '--no-probe']).options.probe).toBe(false);
  });

  it('accepts the whole documented flag surface', () => {
    const parsed = runOptions([
      'dump',
      '--out',
      'out-dir',
      '--zip',
      'out.zip',
      '--profile',
      'modern-4x',
      '--chunk',
      '256',
      '--gap-fill',
      '0x00',
      '--retries',
      '5',
      '--retry-delay',
      '1500',
      '--recipient',
      'device',
      '--serial',
      'ABC123',
      '--json',
      '--quiet',
      '--no-color',
    ]);
    expect(parsed.options).toMatchObject({
      out: 'out-dir',
      zip: 'out.zip',
      profile: 'modern-4x',
      chunk: 256,
      gapFill: 0,
      retries: 5,
      retryDelayMs: 1500,
      recipient: 'device',
      serial: 'ABC123',
      json: true,
      quiet: true,
      colorFlag: false,
    });
  });

  it('takes the flash-only flags', () => {
    const parsed = runOptions(['flash', 'image.bin', '--yes', '--no-rescue-dump']);
    expect(parsed.file).toBe('image.bin');
    expect(parsed.options.yes).toBe(true);
    expect(parsed.options.rescueDump).toBe(false);
  });

  it('parses hex and decimal numbers', () => {
    expect(runOptions(['dump', '--gap-fill', '255']).options.gapFill).toBe(0xff);
    expect(runOptions(['dump', '--gap-fill', '0xff']).options.gapFill).toBe(0xff);
    expect(runOptions(['dump', '--chunk', '0x40']).options.chunk).toBe(64);
  });

  it('returns help and version without running anything', () => {
    expect(parseCli(['--help'])).toEqual({ kind: 'help', command: null, json: false });
    expect(parseCli(['-h'])).toEqual({ kind: 'help', command: null, json: false });
    expect(parseCli(['dump', '--help'])).toEqual({ kind: 'help', command: 'dump', json: false });
    expect(parseCli(['-V'])).toEqual({ kind: 'version', json: false });
    expect(parseCli(['--version'])).toEqual({ kind: 'version', json: false });
  });

  it('carries --json through to help and version', () => {
    expect(parseCli(['--help', '--json'])).toEqual({ kind: 'help', command: null, json: true });
    expect(parseCli(['dump', '--help', '--json'])).toEqual({
      kind: 'help',
      command: 'dump',
      json: true,
    });
    expect(parseCli(['--version', '--json'])).toEqual({ kind: 'version', json: true });
  });

  it.each([
    [['bogus'], /unknown command/],
    [[], /no command/],
    [['dump', '--nope'], /Unknown option/],
    [['decrypt'], /needs a file/],
    [['flash'], /needs a file/],
    [['dump', 'extra'], /unexpected argument/],
    [['decrypt', 'a.bin', 'b.bin'], /unexpected argument/],
    [['dump', '--profile', 'nope'], /unknown profile/],
    [['dump', '--recipient', 'sideways'], /--recipient must be one of/],
    [['dump', '--chunk', 'lots'], /--chunk expects a number/],
    [['dump', '--chunk', '0'], /--chunk must be between/],
    [['dump', '--chunk', '65537'], /--chunk must be between/],
    [['dump', '--gap-fill', '256'], /--gap-fill must be between/],
    [['dump', '--retries=-1'], /--retries expects a number/],
    [['dump', '--retry-delay', '1.5'], /--retry-delay expects a number/],
    [['dump', '--quiet', '--verbose'], /contradict/],
  ])('rejects %j', (argv, message) => {
    expect(() => parseCli(argv)).toThrow(UsageError);
    expect(() => parseCli(argv)).toThrow(message);
  });

  it('names the known profiles when --profile is wrong', () => {
    try {
      parseCli(['dump', '--profile', 'nope']);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(UsageError);
      expect((error as UsageError).hint).toContain('modern-4x');
      expect((error as UsageError).exitCode).toBe(EXIT_USAGE);
    }
  });
});

describe('run', () => {
  it('exits 2 and prints usage on stderr for a bad command line', async () => {
    const { io, stdout, stderr } = testIo();
    const code = await run(['bogus'], io, new AbortController().signal);
    expect(code).toBe(EXIT_USAGE);
    expect(stdout.text).toBe('');
    expect(stderr.text).toContain('seek-fw <command> [options]');
    expect(stderr.text).toContain("error: unknown command 'bogus'");
  });

  it('prints help on stdout and exits 0', async () => {
    const { io, stdout, stderr } = testIo();
    const code = await run(['--help'], io, new AbortController().signal);
    expect(code).toBe(EXIT_OK);
    expect(stdout.text).toContain('seek-fw — dump, decrypt and reflash');
    expect(stderr.text).toBe('');
  });

  it('prints per-command help', async () => {
    const { io, stdout } = testIo();
    await run(['flash', '--help'], io, new AbortController().signal);
    expect(stdout.text).toContain('seek-fw flash — write a decrypted image');
    expect(stdout.text).toContain('--no-rescue-dump');
  });

  it('prints the version on stdout', async () => {
    const { io, stdout } = testIo();
    const code = await run(['--version'], io, new AbortController().signal);
    expect(code).toBe(EXIT_OK);
    expect(stdout.text).toBe('2.0.0-test\n');
  });

  /* The contract: under --json stdout is ONE JSON document, with no exception
   * for the two paths that used to print prose. `seek-fw ... --json | jq` has
   * to be safe to write without knowing which flags the caller passed. */
  it('makes --help a JSON document under --json', async () => {
    const { io, stdout, stderr } = testIo();
    const code = await run(['flash', '--help', '--json'], io, new AbortController().signal);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(stdout.text)).toEqual({
      command: 'flash',
      ok: true,
      help: expect.stringContaining('--no-rescue-dump') as unknown,
    });
    expect(stderr.text).toBe('');
  });

  it('makes --version a JSON document under --json', async () => {
    const { io, stdout } = testIo();
    const code = await run(['--version', '--json'], io, new AbortController().signal);
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(stdout.text)).toEqual({ command: null, ok: true, version: '2.0.0-test' });
  });
});

/**
 * The help text spells the dump defaults out for a reader; core owns them. A
 * copy that drifts is worse than no documentation at all, so it is pinned
 * against the values themselves rather than against another copy of them.
 */
describe('documented defaults', () => {
  function documentedDefault(flag: string, text: string): number {
    const line = text.split('\n').find((l) => l.trimStart().startsWith(`--${flag} `));
    if (line === undefined) throw new Error(`the help text does not mention --${flag}`);
    const match = /\(default (0x[0-9a-f]+|\d+)\)/.exec(line);
    if (match?.[1] === undefined) throw new Error(`--${flag} documents no default: ${line}`);
    return Number(match[1]);
  }

  it("match core's DEFAULT_DUMP_OPTIONS", () => {
    expect(documentedDefault('chunk', MAIN_USAGE)).toBe(DEFAULT_DUMP_OPTIONS.chunk);
    expect(documentedDefault('gap-fill', MAIN_USAGE)).toBe(DEFAULT_DUMP_OPTIONS.gapFill);
    expect(documentedDefault('retries', MAIN_USAGE)).toBe(DEFAULT_DUMP_OPTIONS.retries);
    expect(documentedDefault('retry-delay', MAIN_USAGE)).toBe(DEFAULT_DUMP_OPTIONS.retryDelayMs);
  });

  it('the README is not a third copy that can drift', () => {
    /* The same four numbers are written out a third time, for people who never
     * run --help. An audit found the README had already drifted on other
     * points; this is the cheap way to stop it drifting on these. */
    const readme = readFileSync(new URL('../../../README.md', import.meta.url), 'utf8');
    expect(documentedDefault('chunk', readme)).toBe(DEFAULT_DUMP_OPTIONS.chunk);
    expect(documentedDefault('gap-fill', readme)).toBe(DEFAULT_DUMP_OPTIONS.gapFill);
    expect(documentedDefault('retries', readme)).toBe(DEFAULT_DUMP_OPTIONS.retries);
    expect(documentedDefault('retry-delay', readme)).toBe(DEFAULT_DUMP_OPTIONS.retryDelayMs);
  });
});

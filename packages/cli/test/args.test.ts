import { describe, expect, it } from 'vitest';
import { parseCli, run } from '../src/cli.js';
import { EXIT_OK, EXIT_USAGE, UsageError } from '../src/errors.js';
import { testIo } from './helpers.js';

function runOptions(argv: readonly string[]) {
  const parsed = parseCli(argv);
  if (parsed.kind !== 'run') throw new Error(`expected a run, got ${parsed.kind}`);
  return parsed;
}

describe('parseCli', () => {
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
      yes: false,
      rescueDump: true,
    });
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
    expect(parseCli(['--help'])).toEqual({ kind: 'help', command: null });
    expect(parseCli(['-h'])).toEqual({ kind: 'help', command: null });
    expect(parseCli(['dump', '--help'])).toEqual({ kind: 'help', command: 'dump' });
    expect(parseCli(['-V'])).toEqual({ kind: 'version' });
    expect(parseCli(['--version'])).toEqual({ kind: 'version' });
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
});

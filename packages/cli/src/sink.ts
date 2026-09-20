/**
 * The two output streams, behind an interface small enough to fake.
 *
 * Every write in the CLI goes through one of these, so a test can assert on
 * exact bytes and on TTY-dependent behaviour without touching `process`.
 */

export interface Sink {
  write(text: string): void;
  readonly isTty: boolean;
  /** Terminal width, or null when it is not a terminal. */
  readonly columns: number | null;
}

/** Collects everything written, for tests. */
export class MemorySink implements Sink {
  readonly chunks: string[] = [];
  readonly isTty: boolean;
  readonly columns: number | null;

  constructor(options: { readonly isTty?: boolean; readonly columns?: number } = {}) {
    this.isTty = options.isTty ?? false;
    this.columns = options.columns ?? (this.isTty ? 80 : null);
  }

  write(text: string): void {
    this.chunks.push(text);
  }

  get text(): string {
    return this.chunks.join('');
  }

  /** Written text with the escape sequences removed and bar redraws collapsed. */
  get lines(): string[] {
    return this.text.split('\n');
  }
}

interface NodeStreamLike {
  write(text: string): unknown;
  isTTY?: boolean | undefined;
  columns?: number | undefined;
}

/** Wraps `process.stdout` / `process.stderr`. */
export function streamSink(stream: NodeStreamLike): Sink {
  return {
    write(text: string): void {
      stream.write(text);
    },
    get isTty(): boolean {
      return stream.isTTY === true;
    },
    get columns(): number | null {
      return stream.columns ?? null;
    },
  };
}

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'core',
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    /**
     * How many `test.concurrent` tests run at once.
     *
     * This exists for the emulator suites: each of their tests owns one Python
     * emulator process, so this number is literally "how many emulated cameras
     * are alive at the same time". Vitest's own promise pool does the limiting —
     * nothing here hand-rolls a semaphore.
     *
     * 6 is the default because an emulator is CPU-bound (Unicorn) and wants most
     * of a core, and the vitest worker driving it wants some of another. Override
     * with SEEK_EMU_WORKERS. Every other test in this project is sequential, so
     * this affects nothing else.
     *
     * IT IS PER SUITE FILE, NOT PER RUN. Vitest applies `maxConcurrency` inside a
     * suite, and the two emulator suites are two files that vitest runs in
     * parallel workers — so with both in flight the real peak is TWICE this. On a
     * ten-core machine 5 is therefore already ten emulators; say the peak rather
     * than the setting when quoting a wall time.
     */
    maxConcurrency: Number(process.env.SEEK_EMU_WORKERS ?? '6'),
  },
});

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The browser end-to-end runs. OPT-IN ONLY: the root config's projects are
 * `packages/*`, so no test here runs in `npm test` / `npm run check` (those
 * only lint and type-check this folder). Each script names its file
 * (`npm run e2e:emu`, `e2e:camera`, `e2e:prompt`).
 *
 * One file at a time, one test at a time: a run owns a Chrome, a dev server
 * and an emulated (or real) camera, and two runs would fight over them.
 */
export default defineConfig({
  /* The root's node_modules, not one inside e2e/. */
  cacheDir: fileURLToPath(new URL('../node_modules/.vite/e2e', import.meta.url)),
  resolve: {
    alias: {
      '@seek-fw/core': fileURLToPath(new URL('../packages/core/src/index.ts', import.meta.url)),
    },
  },
  test: {
    name: 'e2e',
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['**/*.e2e.ts'],
    environment: 'node',
    fileParallelism: false,
    maxConcurrency: 1,
    testTimeout: 2 * 60 * 60_000,
    hookTimeout: 10 * 60_000,
  },
});

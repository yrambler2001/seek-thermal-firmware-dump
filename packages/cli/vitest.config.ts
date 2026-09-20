import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/* The CLI's tests run against core's SOURCE rather than its build output, so
 * `vitest run --project cli` works in a fresh checkout with nothing built. */
export default defineConfig({
  resolve: {
    alias: {
      '@seek-fw/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  test: { name: 'cli', environment: 'node', include: ['src/**/*.test.ts', 'test/**/*.test.ts'] },
});

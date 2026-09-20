import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/*'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: ['**/*.d.ts', '**/index.ts', '**/*.test.*', '**/test-helpers.tsx'],
      /**
       * Thresholds are per-area on purpose.
       *
       * The cipher, the image packaging and the profile tables decide whether a
       * camera boots again, and they are pure functions with no excuse for
       * being untested — so they are held near 100%. The protocol layer, the
       * CLI and the React views are dominated by code paths that need real
       * hardware or a real browser, and a single global number would either be
       * so low it protects nothing or so high it forces fake tests for them.
       */
      thresholds: {
        lines: 75,
        functions: 70,
        branches: 60,
        statements: 75,
        'packages/core/src/crypto/**': {
          lines: 98,
          functions: 95,
          branches: 78,
          statements: 95,
        },
        'packages/core/src/image/**': {
          lines: 95,
          functions: 95,
          branches: 90,
          statements: 95,
        },
        'packages/core/src/profiles/**': {
          lines: 95,
          functions: 95,
          branches: 90,
          statements: 95,
        },
        'packages/core/src/archive/**': {
          lines: 95,
          functions: 95,
          branches: 85,
          statements: 95,
        },
      },
    },
  },
});

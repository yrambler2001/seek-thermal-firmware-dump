import { defineConfig } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

// `tseslint.config()` is deprecated upstream in favour of ESLint core's
// `defineConfig()`, which is what this uses.
export default defineConfig([
  {
    ignores: [
      '**/dist/**',
      'docs/**',
      'legacy/**',
      'coverage/**',
      '**/*.tsbuildinfo',
      /* Measurement instruments run with `npx jiti`, kept as they were run: they reach
       * into the USB/IP adapter's private session through `any` and load the toolkit by
       * computed dynamic import. scripts/recipient-fidelity/README.md has the reason. */
      'scripts/recipient-fidelity/**',
    ],
  },

  js.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [tseslint.configs.strictTypeChecked, tseslint.configs.stylisticTypeChecked],
    languageOptions: {
      parserOptions: {
        /* Root-level config files sit outside every package's tsconfig.
         * `tsconfig.tools.json` covers them so they are linted under the same
         * strict options as everything else, rather than an inferred project
         * with strictNullChecks off. */
        projectService: {
          allowDefaultProject: ['vitest.config.ts'],
          defaultProject: './tsconfig.tools.json',
        },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
    rules: {
      // Firmware work is full of intentional bit twiddling and numeric literals.
      '@typescript-eslint/no-non-null-assertion': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/require-await': 'error',
      '@typescript-eslint/prefer-readonly': 'error',
      'no-console': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      curly: ['error', 'multi-line'],
      'prefer-const': 'error',
      'no-param-reassign': 'error',
      'object-shorthand': 'error',
    },
  },

  // The core is isomorphic: it must not reach for browser or Node globals.
  {
    files: ['packages/core/src/**/*.ts'],
    languageOptions: { globals: {} },
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'window',
          message: 'Core must stay isomorphic — inject platform behaviour instead.',
        },
        { name: 'document', message: 'Core must stay isomorphic — no DOM access.' },
        { name: 'navigator', message: 'Core must stay isomorphic — pass a UsbTransport in.' },
        { name: 'process', message: 'Core must stay isomorphic — no Node globals.' },
      ],
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['node:*', 'usb', 'react*'],
              message: 'Core must have zero platform dependencies.',
            },
          ],
        },
      ],
    },
  },

  // The CLI is the one place that is allowed to write to stdout.
  {
    files: ['packages/cli/**/*.ts'],
    languageOptions: { globals: globals.node },
    rules: { 'no-console': 'off' },
  },

  {
    files: ['packages/web/**/*.{ts,tsx}'],
    languageOptions: { globals: globals.browser },
  },

  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'packages/core/test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },

  {
    files: ['**/*.js', '**/*.mjs', 'scripts/**'],
    languageOptions: { globals: globals.node, sourceType: 'module' },
    rules: { 'no-console': 'off' },
  },

  prettier,
]);

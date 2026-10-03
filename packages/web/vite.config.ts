import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * The built site is committed to `docs/` because GitHub Pages serves this repo
 * from that folder. `base: './'` keeps the bundle position-independent, so the
 * same output works at a project path, at a user-site root, and opened from disk.
 *
 * `@seek-fw/core` resolves to the package's TYPESCRIPT SOURCE, never its dist:
 * the dev server pre-bundles workspace dependencies into node_modules/.vite and
 * does not reliably notice a rebuilt dist — on 2026-10-03 that stale pre-bundle
 * drove three hardware runs with the OLD core code under the NEW web code. The
 * alias makes dev and build compile the true source on every start.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@seek-fw/core': fileURLToPath(new URL('../core/src/index.ts', import.meta.url)),
    },
  },
  base: './',
  build: {
    outDir: '../../docs',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2023',
  },
  server: { port: 5173 },
});

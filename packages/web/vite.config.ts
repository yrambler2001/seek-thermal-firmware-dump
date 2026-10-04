import { readFileSync } from 'node:fs';
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
/* `npm run dev:phone` (scripts/dev-phone.mjs): HTTPS with the certificate it
 * made, so a phone on the Wi-Fi gets a secure context — WebUSB needs one — and
 * NO WEBSOCKET. `hmr: false` alone is not enough: Vite's client still opens its
 * socket, and when the socket drops (airplane mode) it polls and reloads the
 * page the moment the server answers again — mid-write, if the Wi-Fi comes
 * back. With `ws: false` the client's one connect attempt fails quietly and
 * nothing ever reloads the page. Its own cache dir keeps the re-optimized deps
 * apart from the plain dev server's. Plain `npm run dev` sets none of this. */
const phoneKey = process.env.SEEK_DEV_HTTPS_KEY;
const phoneCert = process.env.SEEK_DEV_HTTPS_CERT;
const phoneMode = process.env.SEEK_DEV_PHONE === '1';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  ...(phoneMode ? { cacheDir: '../../node_modules/.vite-phone' } : {}),
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
  server: {
    port: 5173,
    ...(phoneKey !== undefined && phoneCert !== undefined
      ? { https: { key: readFileSync(phoneKey), cert: readFileSync(phoneCert) } }
      : {}),
    ...(phoneMode ? { hmr: false, ws: false as const } : {}),
  },
});

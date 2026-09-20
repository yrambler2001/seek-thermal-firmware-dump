import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * The built site is committed to `docs/` because GitHub Pages serves this repo
 * from that folder. `base: './'` keeps the bundle position-independent, so the
 * same output works at a project path, at a user-site root, and opened from disk.
 */
export default defineConfig({
  plugins: [react()],
  base: './',
  build: {
    outDir: '../../docs',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2023',
  },
  server: { port: 5173 },
});

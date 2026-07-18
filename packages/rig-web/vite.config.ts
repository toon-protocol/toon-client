import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './',
  root: resolve(import.meta.dirname, 'src/web'),
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      '@': resolve(import.meta.dirname, 'src/web'),
    },
  },
  build: {
    outDir: resolve(import.meta.dirname, 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/web/index.html'),
      output: {
        // Keep every chunk's GZIPPED size under ArDrive Turbo's 105 KiB
        // free-tier per-file cap: the Arweave deployment uploads each output
        // gzipped (Content-Encoding tag), so the constraint is per chunk.
        // node_modules split per top-level package (`v-<pkg>`) — no single
        // dependency gzips anywhere near the cap once separated — leaving
        // only app code in the entry chunk (README "Deploying").
        manualChunks(id: string) {
          const m = id.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/);
          if (!m) return undefined; // app code → entry/dynamic chunks
          const pkg = (m[1] as string).replace(/^@/, '').replace('/', '-');
          // shiki keeps its own per-language dynamic chunks.
          if (pkg.startsWith('shiki')) return undefined;
          return `v-${pkg}`;
        },
      },
    },
  },
});

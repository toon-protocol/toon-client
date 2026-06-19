import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Builds the MCP-app iframe bundle as a single self-contained HTML file
 * (`dist/app/index.html`) that `@toon-protocol/client-mcp` registers as the
 * `ui://toon/app` resource (rawHtml content, `text/html;profile=mcp-app`).
 *
 * NOTE: vitest uses `vitest.config.ts`, which takes precedence over this file,
 * so this config only affects `vite build` (the `build:app` script).
 */
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
    // Inline everything so the result is one portable HTML document.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});

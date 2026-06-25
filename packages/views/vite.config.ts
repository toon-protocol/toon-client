import path from 'path';
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
 *
 * `@toon-protocol/client` (the render trust gradient) pulls `@toon-protocol/core`,
 * whose root entry top-level-imports several Node builtins for a Node-only devnet
 * `preset` helper the iframe never touches. Vite's default browser-external stub
 * does not export the *named* bindings core imports (`execFile`, `mkdtemp`, …),
 * which fails the build at link time. We alias those builtins to a tiny shim that
 * exports the names — the dead imports resolve, the bundle stays browser-safe, and
 * any actual call throws (none happens in the iframe).
 */
const nodeShim = path.resolve(import.meta.dirname, 'src/render/node-shims/node-builtins.ts');
const NODE_BUILTIN_SHIMS = ['child_process', 'fs/promises', 'os', 'path', 'crypto'];

export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      ...Object.fromEntries(
        NODE_BUILTIN_SHIMS.flatMap((b) => [
          [b, nodeShim],
          [`node:${b}`, nodeShim],
        ])
      ),
    },
  },
  build: {
    outDir: 'dist/app',
    emptyOutDir: true,
    // Inline everything so the result is one portable HTML document.
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
  },
});

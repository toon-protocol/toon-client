import { defineConfig } from 'tsup';

export default defineConfig({
  // `standalone` is a separate entry behind the `./standalone` subpath export
  // so the core stays dependency-light: only it imports @toon-protocol/client
  // (an optional peer dependency — external, never bundled).
  entry: ['src/index.ts', 'src/standalone/index.ts'],
  format: ['esm'],
  // @toon-protocol/arweave is a private workspace package (not on npm), so
  // inline it — code AND types — into dist at build time (same strategy as
  // client-mcp's tsup config).
  noExternal: ['@toon-protocol/arweave'],
  dts: { resolve: ['@toon-protocol/arweave'] },
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});

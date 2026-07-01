import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
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

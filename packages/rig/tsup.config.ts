import { defineConfig } from 'tsup';

export default defineConfig({
  // `standalone` is a separate entry behind the `./standalone` subpath export
  // so the core stays dependency-light: only it imports @toon-protocol/client
  // (an optional peer dependency — external, never bundled). `cli/rig` is the
  // `rig` bin (#229, standalone-only since #248): its shebang is preserved by
  // tsup, and the embedded publisher + key derivation sit behind dynamic
  // imports so esm code-splitting keeps the @toon-protocol/client dependency
  // out of runs that fail earlier (usage errors, missing git repo, …).
  entry: ['src/index.ts', 'src/standalone/index.ts', 'src/cli/rig.ts'],
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

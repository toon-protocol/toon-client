import { defineConfig } from 'tsup';

export default defineConfig({
  // `standalone` is a separate entry behind the `./standalone` subpath export
  // so the core stays light at import time: only it imports
  // @toon-protocol/client (a regular runtime dependency since #259 —
  // external, never bundled). `cli/rig` is the `rig` bin (#229,
  // standalone-only since #248): its shebang is preserved by tsup, and the
  // embedded publisher + key derivation sit behind dynamic imports so esm
  // code-splitting keeps @toon-protocol/client out of runs that fail earlier
  // (usage errors, missing git repo, …).
  entry: ['src/index.ts', 'src/standalone/index.ts', 'src/cli/rig.ts'],
  format: ['esm'],
  // @toon-protocol/arweave is inlined — code AND types — into dist at build
  // time (same strategy as client-mcp's tsup config), so it must live in
  // devDependencies, NOT dependencies: a runtime `dependencies` entry gets
  // `workspace:*` rewritten to a concrete version at publish time, which is
  // exactly how rig 2.0.0 shipped uninstallable (#259).
  noExternal: ['@toon-protocol/arweave'],
  dts: { resolve: ['@toon-protocol/arweave'] },
  sourcemap: true,
  clean: true,
  outDir: 'dist',
});

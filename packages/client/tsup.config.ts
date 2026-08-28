import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the library, and the `toon` CLI. The CLI is its own entry so a
  // library consumer never pulls in argument parsing or the keystore prompt,
  // and so `bin` can point at a file with a shebang.
  entry: {
    index: 'src/index.ts',
    'cli/main': 'src/cli/main.ts',
  },
  format: ['esm'],
  // Types for the library only. The CLI's surface is its arguments.
  dts: { entry: { index: 'src/index.ts' } },
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  platform: 'node',
  target: 'node22',
  // tsup externalizes `dependencies` automatically but BUNDLES
  // `optionalDependencies`, and `ws` must stay external: it is loaded through a
  // guarded dynamic import so a runtime with a global `WebSocket` (Node 22,
  // browsers) never needs it installed at all.
  external: ['ws'],
  // `bin` points here, so it has to be executable.
  onSuccess: 'chmod +x dist/cli/main.js',
});

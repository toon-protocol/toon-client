import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the library, and the `toon` CLI. The CLI is its own entry so a
  // library consumer never pulls in argument parsing or the keystore prompt,
  // and so `bin` can point at a file with a shebang.
  entry: {
    index: 'src/index.ts',
    'cli/main': 'src/cli/main.ts',
    // Node-only, and its own entry for exactly that reason: the library barrel
    // must stay free of `node:module` so a browser bundle of this package still
    // builds. See `src/transport/index.ts`.
    'transport/hidden-service': 'src/transport/hidden-service.ts',
  },
  format: ['esm'],
  // Types for the library only. The CLI's surface is its arguments.
  dts: {
    entry: {
      index: 'src/index.ts',
      'transport/hidden-service': 'src/transport/hidden-service.ts',
    },
  },
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  platform: 'node',
  target: 'node22',
  // tsup externalizes `dependencies` automatically but BUNDLES
  // `optionalDependencies`, and every one of these must stay external: each is
  // loaded through a guarded dynamic `require`, so a consumer who never uses the
  // feature it serves never needs it installed at all. `ws` serves a runtime
  // without a global `WebSocket`; `undici` and `socks` serve the hidden-service
  // transport, and bundling undici in particular would put a second HTTP stack
  // in every consumer's build.
  external: ['ws', 'undici', 'socks'],
  // `bin` points here, so it has to be executable.
  onSuccess: 'chmod +x dist/cli/main.js',
});

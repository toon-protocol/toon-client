import { defineConfig } from 'tsup';

export default defineConfig({
  // `src/render/index.ts` is a separate, browser-safe subpath entry (the
  // NIP-on-TOON render trust gradient): it pulls only `@toon-protocol/core`'s pure
  // `ui` helpers + nostr-tools, none of the client's Node-only channel/transport
  // code. `@toon-protocol/views` imports `@toon-protocol/client/render` for the
  // iframe app bundle, so it must stay its own tree-shakeable entry point.
  entry: ['src/index.ts', 'src/render/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  // Keep optional / heavy runtime deps external so their dynamic `import()` is
  // preserved and resolved from node_modules at runtime (NOT bundled). tsup
  // externalizes `dependencies` automatically but BUNDLES `optionalDependencies`
  // by default — mina-signer is optional, so without this its direct dynamic
  // import in KeyDerivation.deriveMinaKey gets inlined and breaks for npm
  // consumers (deriveFullIdentity would silently return an empty Mina key).
  external: [
    'o1js',
    '@toon-protocol/mina-zkapp',
    'mina-signer',
    '@noble/curves/ed25519',
    '@noble/curves/ed25519.js',
    'ws',
    'socks-proxy-agent',
  ],
});

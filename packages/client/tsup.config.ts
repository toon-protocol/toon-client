import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
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
    'mina-signer',
    '@noble/curves/ed25519',
    '@noble/curves/ed25519.js',
    'ws',
    'socks-proxy-agent',
  ],
});

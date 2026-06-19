import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { defineConfig } from 'tsup';

export default defineConfig({
  // After bundling, ship the MCP-app UI bundle WITH this package: copy
  // @toon-protocol/views' prebuilt single-file `dist/app/index.html` into our
  // own dist/app so a published client-mcp serves `ui://toon/app` without
  // resolving the (unpublished, workspace-only) views package at runtime.
  // views is a bundled devDep; `pnpm -r build` builds it (incl. the bundle)
  // before client-mcp, so the source exists here. Non-fatal if it doesn't yet.
  onSuccess: async () => {
    try {
      const req = createRequire(import.meta.url);
      const viewsEntry = req.resolve('@toon-protocol/views'); // …/views/dist/index.js
      const src = join(dirname(viewsEntry), 'app', 'index.html');
      mkdirSync('dist/app', { recursive: true });
      copyFileSync(src, 'dist/app/index.html');
      console.log('[tsup] copied @toon-protocol/views app bundle → dist/app/index.html');
    } catch (err) {
      console.warn(
        `[tsup] skipped copying views app bundle (build views first): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  },
  // Three entry points: the library surface (index), and the two bins
  // (`toon-clientd` daemon, `toon-mcp` stdio server). The bin sources carry a
  // `#!/usr/bin/env node` shebang which tsup preserves in the emitted files.
  entry: ['src/index.ts', 'src/daemon.ts', 'src/mcp.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  banner: {
    // The bundle uses `require()` (createRequire) for the node-only `ws` /
    // `socks-proxy-agent` factory; provide it in the ESM output.
    js: `import { createRequire as __cr } from 'module'; const require = __cr(import.meta.url);`,
  },
  // ── Bundling strategy (mirrors @toon-protocol/townhouse) ──────────────────
  // The published package must carry ZERO `@toon-protocol/*` runtime deps (those
  // workspace packages are not on npm). So INLINE them — and the crypto libs
  // they use — into dist at BUILD time. Bundling @noble/@scure too avoids a
  // runtime version-skew between what the inlined client expects and whatever
  // the consumer's tree resolves (same rationale as townhouse's tsup config).
  noExternal: [
    '@toon-protocol/client',
    '@toon-protocol/core',
    // The swap path (toon_swap → streamSwap) is inlined; the arweave/turbo-sdk
    // modules of @toon-protocol/sdk are NOT in that import graph, so they
    // tree-shake out (turbo-sdk stays external/undeclared, as before).
    '@toon-protocol/sdk',
    '@noble/curves',
    '@noble/hashes',
    '@noble/ed25519',
    '@scure/bip32',
    '@scure/bip39',
    'ed25519-hd-key',
  ],
  // Kept external (declared as deps / optionalDependencies so npm installs them):
  //  • required, on npm: fastify, @modelcontextprotocol/sdk, nostr-tools, viem,
  //    ws, @toon-format/toon, @ardrive/turbo-sdk, arweave, simple-git, hono.
  //  • optional/native/heavy (loaded dynamically only for a given chain or HS):
  //    o1js, mina-signer, @solana/web3.js, socks-proxy-agent. `@toon-protocol/
  //    mina-zkapp` is an unpublished optional workspace dep — left external and
  //    UNDECLARED; the client's dynamic import fails gracefully (Mina on-chain
  //    open only) when it is absent, which it always is for npm consumers.
  external: [
    'o1js',
    'mina-signer',
    '@solana/web3.js',
    'socks-proxy-agent',
    '@toon-protocol/mina-zkapp',
  ],
});

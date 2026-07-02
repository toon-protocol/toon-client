import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // Alias only packages that live in THIS workspace so tests run against
    // source. @toon-protocol/{core,relay,bls,sdk} moved out of the repo and
    // are plain npm deps now — stale aliases to their old packages/* paths
    // broke resolution (Cannot find module), so they must resolve normally
    // from each package's node_modules.
    alias: {
      '@toon-protocol/arweave': resolve(__dirname, 'packages/arweave/src/index.ts'),
      '@toon-protocol/client': resolve(__dirname, 'packages/client/src/index.ts'),
      '@toon-protocol/rig': resolve(__dirname, 'packages/rig/src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 120_000,
    pool: 'forks',
    poolOptions: {
      forks: { minForks: 1, maxForks: 4 },
    },
    // Canonical test count: `pnpm test` at the repo root is the single source
    // of truth for total test count. All workspace members with tests must be
    // listed here so counts are consistent across pipeline steps.
    include: ['packages/*/src/**/*.test.ts', 'packages/memvid-node/tests/**/*.test.ts', 'docker/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/__integration__/**', 'packages/mina-zkapp/**', 'packages/pet-circuit/**', 'packages/pet-dvm/**', 'packages/memvid-node/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/__integration__/**',
        '**/index.ts',
      ],
    },
  },
});

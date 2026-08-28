import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    // Alias only packages that live in THIS workspace so tests run against
    // source. Everything else (@toon-protocol/* published packages) resolves
    // normally from node_modules.
    alias: {
      '@toon-protocol/client': resolve(__dirname, 'packages/client/src/index.ts'),
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
    include: ['packages/*/src/**/*.test.ts', '.sandcastle/**/*.test.ts', '.github/rig-web-redirect/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/__integration__/**'],
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

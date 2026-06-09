import { defineConfig } from 'vitest/config';

/**
 * Scripts-local vitest config so the harness unit tests under `scripts/lib/`
 * are runnable without touching the package-level `vitest.config.ts` (whose
 * `include` is `src/**`). Infra-free.
 *
 *   pnpm --filter @toon-protocol/client exec vitest run \
 *     --config scripts/lib/vitest.config.ts
 */
export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/lib/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});

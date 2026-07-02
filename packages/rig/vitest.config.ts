import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Match the repo-root config's generous timeout: identity derivation and
    // the #278 clone/fetch tests (many spawned git processes) exceed the 5s
    // default under full-suite parallel load.
    testTimeout: 30_000,
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['**/node_modules/**', '**/dist/**', '**/*.test.ts'],
    },
  },
});

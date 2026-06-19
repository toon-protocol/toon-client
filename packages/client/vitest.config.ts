import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Live integration tests need real testnets + fixtures (e2e/testnets.json);
    // they run via a dedicated job, not the unit suite.
    exclude: ['**/node_modules/**', '**/dist/**', '**/__integration__/**', '**/*.integration.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: [
        '**/node_modules/**',
        '**/dist/**',
        '**/*.test.ts',
        '**/tests/**',
      ],
    },
  },
});

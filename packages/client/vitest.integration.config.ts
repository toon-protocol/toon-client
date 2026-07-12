import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__integration__/**/*.integration.test.ts'],
    // These bind loopback servers only (no external services), but leave
    // generous room for slow CI networking stacks.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});

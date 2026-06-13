import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__integration__/**/*.integration.test.ts'],
    // Live HS round-trips (anon bootstrap + paid publish) are slow.
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});

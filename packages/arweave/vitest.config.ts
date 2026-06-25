import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: __dirname,
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});

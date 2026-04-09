import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@toon-protocol/core/toon': resolve(__dirname, '../core/src/toon/index.ts'),
      '@toon-protocol/core/nip34': resolve(__dirname, '../core/src/nip34/index.ts'),
      '@toon-protocol/core': resolve(__dirname, '../core/src/index.ts'),
      '@toon-protocol/relay': resolve(__dirname, '../relay/src/index.ts'),
      '@toon-protocol/client': resolve(__dirname, './src/index.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/e2e/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120000,
  },
});

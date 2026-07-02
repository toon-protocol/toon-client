import { defineConfig } from '@playwright/test';

export default defineConfig({
  timeout: 30000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: 'http://localhost:5173',
    headless: true,
  },
  projects: [
    {
      name: 'legacy',
      testDir: './tests/e2e',
      testMatch: '*.spec.ts',
      testIgnore: '**/specs/**',
    },
    {
      name: 'rig-e2e',
      testDir: './tests/e2e/specs',
      globalSetup: './tests/e2e/seed/seed-all.ts',
    },
  ],
  webServer: {
    command: 'pnpm dev',
    url: 'http://localhost:5173',
    reuseExistingServer: true,
    timeout: 30000,
  },
});

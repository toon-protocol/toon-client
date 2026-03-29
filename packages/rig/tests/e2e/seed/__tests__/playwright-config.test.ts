/**
 * ATDD Tests: Story 10.1 — AC-1.5 Playwright Config
 * TDD RED PHASE: These tests define expected behavior for playwright.config.ts updates
 *
 * Tests will FAIL until playwright.config.ts is updated with two-project structure.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';

const CONFIG_PATH = resolve(__dirname, '../../../../playwright.config.ts');

describe('AC-1.5: Playwright Config (two-project structure)', () => {
  it('[P0] should define a legacy project for existing 6 specs', () => {
    const configContent = readFileSync(CONFIG_PATH, 'utf-8');

    // Config should contain a "legacy" project definition
    expect(configContent).toContain('legacy');
    // Legacy project should use testDir: './tests/e2e'
    expect(configContent).toContain('./tests/e2e');
    // Legacy project should ignore specs/ directory
    expect(configContent).toContain('**/specs/**');
  });

  it('[P0] should define a rig-e2e project for new specs', () => {
    const configContent = readFileSync(CONFIG_PATH, 'utf-8');

    // Config should contain a "rig-e2e" project definition
    expect(configContent).toContain('rig-e2e');
    // rig-e2e project should use testDir: './tests/e2e/specs'
    expect(configContent).toContain('./tests/e2e/specs');
    // rig-e2e project should reference globalSetup
    expect(configContent).toContain('globalSetup');
    expect(configContent).toContain('seed-all');
  });

  it('[P0] should share webServer config starting pnpm dev', () => {
    const configContent = readFileSync(CONFIG_PATH, 'utf-8');

    expect(configContent).toContain('pnpm dev');
    expect(configContent).toContain('http://localhost:5173');
    expect(configContent).toContain('reuseExistingServer');
  });

  it('[P1] should increase webServer timeout to 30s', () => {
    const configContent = readFileSync(CONFIG_PATH, 'utf-8');

    // webServer.timeout should be 30000 (increased from 15000)
    expect(configContent).toContain('30000');
  });

  it('[P1] should add CI retries (1 retry in CI, 0 locally)', () => {
    const configContent = readFileSync(CONFIG_PATH, 'utf-8');

    // Should contain CI retry logic
    expect(configContent).toContain('process.env.CI');
    expect(configContent).toContain('retries');
  });

  it('[P1] should set baseURL to http://localhost:5173', () => {
    const configContent = readFileSync(CONFIG_PATH, 'utf-8');

    expect(configContent).toContain('baseURL');
    expect(configContent).toContain('http://localhost:5173');
  });
});

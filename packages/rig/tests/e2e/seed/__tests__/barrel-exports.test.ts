/**
 * ATDD Tests: Story 10.1 — AC-1.8 Barrel Export & Seed Stub
 * TDD RED PHASE: These tests define expected behavior for index.ts and seed-all.ts
 *
 * Tests will FAIL until index.ts barrel and seed-all.ts stub are implemented.
 */

import { describe, it, expect } from 'vitest';
import { existsSync } from 'fs';
import { resolve } from 'path';

describe('Barrel Export (index.ts) and Seed Stub (seed-all.ts)', () => {
  it('[P0] should export all public APIs from barrel index.ts', async () => {
    const barrel = await import('../lib/index.js');

    // Should re-export from clients.ts
    expect(typeof barrel.createSeedClients).toBe('function');
    expect(typeof barrel.stopAllClients).toBe('function');
    expect(typeof barrel.healthCheck).toBe('function');

    // Should re-export from constants.ts
    expect(barrel.PEER1_RELAY_URL).toBeDefined();
    expect(barrel.PEER1_BTP_URL).toBeDefined();
    expect(barrel.PEER1_BLS_URL).toBeDefined();
    expect(barrel.ANVIL_RPC).toBeDefined();
    expect(barrel.TOKEN_ADDRESS).toBeDefined();
    expect(barrel.TOKEN_NETWORK_ADDRESS).toBeDefined();
    expect(barrel.CHAIN_ID).toBeDefined();
    expect(barrel.PEER1_PUBKEY).toBeDefined();
    expect(barrel.PEER1_DESTINATION).toBeDefined();
    expect(barrel.AGENT_IDENTITIES).toBeDefined();

    // Should re-export from event-builders.ts
    expect(typeof barrel.buildRepoAnnouncement).toBe('function');
    expect(typeof barrel.buildRepoRefs).toBe('function');
    expect(typeof barrel.buildIssue).toBe('function');
    expect(typeof barrel.buildComment).toBe('function');
    expect(typeof barrel.buildPatch).toBe('function');
    expect(typeof barrel.buildStatus).toBe('function');

    // Should re-export from git-builder.ts
    expect(typeof barrel.createGitBlob).toBe('function');
    expect(typeof barrel.createGitTree).toBe('function');
    expect(typeof barrel.createGitCommit).toBe('function');
    expect(typeof barrel.uploadGitObject).toBe('function');
    expect(typeof barrel.waitForArweaveIndex).toBe('function');

    // Should re-export from publish.ts
    expect(typeof barrel.publishWithRetry).toBe('function');
    expect(typeof barrel.createPublishState).toBe('function');

    // PublishEventResult type re-exported (verified by presence of the module export)
    // Type-only exports don't have runtime presence, but the re-export path must not throw
  });

  it('[P0] should have seed-all.ts stub that exports a no-op globalSetup', async () => {
    // seed-all.ts should exist at the expected path
    const seedAllPath = resolve(__dirname, '../../seed/seed-all.ts');
    expect(existsSync(seedAllPath)).toBe(true);

    // It should export a default function (Playwright globalSetup convention)
    const seedAll = await import('../../seed/seed-all.js');
    expect(typeof seedAll.default).toBe('function');
  });

  it('[P0] should have specs/ directory created', () => {
    const specsDir = resolve(__dirname, '../../specs');
    expect(existsSync(specsDir)).toBe(true);
  });

  it('[P1] should have seed/lib/ directory created', () => {
    const libDir = resolve(__dirname, '../lib');
    expect(existsSync(libDir)).toBe(true);
  });
});

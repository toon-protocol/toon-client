/**
 * ATDD Tests: Story 10.9 -- Seed Orchestrator
 *
 * Unit tests verify seed-all.ts exports globalSetup as default, checkAllServicesReady,
 * loadSeedState, saveSeedState, isFresh; that SeedState interface matches Push08State
 * plus generatedAt; that all 8 push scripts are imported; and that createSeedClients,
 * stopAllClients, AGENT_IDENTITIES are imported from lib.
 *
 * Integration tests (.todo) require live SDK E2E infrastructure.
 *
 * AC-9.1: checkAllServicesReady() polls Peer1 BLS, Peer2 BLS, and Anvil
 * AC-9.2: Runs push-01 through push-08 in sequence
 * AC-9.3: Exports final state to state.json with SeedState shape
 * AC-9.4: Default export matches Playwright globalSetup contract
 * AC-9.5: Skips seeding if state.json is fresh (< 10 min)
 * AC-9.6: Total seed time < 60s (integration only)
 */

import { describe, it, expect } from 'vitest';
import type { SeedState } from '../seed-all.js';

describe('Story 10.9: Seed Orchestrator', () => {
  // -------------------------------------------------------------------------
  // AC-9.4: Default export -- globalSetup contract
  // -------------------------------------------------------------------------

  it('[P0] AC-9.4: should export globalSetup as default export (Playwright contract)', async () => {
    const module = await import('../seed-all.js');
    expect(typeof module.default).toBe('function');
  });

  // -------------------------------------------------------------------------
  // AC-9.1: checkAllServicesReady named export
  // -------------------------------------------------------------------------

  it('[P0] AC-9.1: should export checkAllServicesReady function', async () => {
    const module = await import('../seed-all.js');
    expect(typeof module.checkAllServicesReady).toBe('function');
  });

  // -------------------------------------------------------------------------
  // AC-9.3: SeedState interface existence (source introspection)
  // -------------------------------------------------------------------------

  it('[P0] AC-9.3: source contains interface SeedState', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('export interface SeedState');
  });

  // -------------------------------------------------------------------------
  // AC-9.3: SeedState has generatedAt: string
  // -------------------------------------------------------------------------

  it('[P0] AC-9.3: SeedState interface declares generatedAt: string', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    const start = source.indexOf('export interface SeedState');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 1200);

    expect(interfaceBlock).toContain('generatedAt: string');
  });

  // -------------------------------------------------------------------------
  // AC-9.3: SeedState contains all Push08State fields
  // -------------------------------------------------------------------------

  it('[P0] AC-9.3: SeedState interface contains all Push08State fields', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    const start = source.indexOf('export interface SeedState');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 1200);

    // All Push08State fields must be present
    expect(interfaceBlock).toContain('repoId: string');
    expect(interfaceBlock).toContain('ownerPubkey: string');
    expect(interfaceBlock).toContain('commits:');
    expect(interfaceBlock).toContain('shaMap:');
    expect(interfaceBlock).toContain('repoAnnouncementId: string');
    expect(interfaceBlock).toContain('refsEventId: string');
    expect(interfaceBlock).toContain('branches: string[]');
    expect(interfaceBlock).toContain('tags: string[]');
    expect(interfaceBlock).toContain('files: string[]');
    expect(interfaceBlock).toContain('prs:');
    expect(interfaceBlock).toContain('issues:');
    expect(interfaceBlock).toContain('comments:');
    expect(interfaceBlock).toContain('closedIssueEventIds: string[]');
  });

  // -------------------------------------------------------------------------
  // AC-9.3, 9.5: loadSeedState and saveSeedState named exports
  // -------------------------------------------------------------------------

  it('[P0] AC-9.3: should export loadSeedState function', async () => {
    const module = await import('../seed-all.js');
    expect(typeof module.loadSeedState).toBe('function');
  });

  it('[P0] AC-9.3: should export saveSeedState function', async () => {
    const module = await import('../seed-all.js');
    expect(typeof module.saveSeedState).toBe('function');
  });

  // -------------------------------------------------------------------------
  // AC-9.5: isFresh named export
  // -------------------------------------------------------------------------

  it('[P0] AC-9.5: should export isFresh function', async () => {
    const module = await import('../seed-all.js');
    expect(typeof module.isFresh).toBe('function');
  });

  // -------------------------------------------------------------------------
  // AC-9.5: isFresh returns true for fresh timestamp, false for stale
  // -------------------------------------------------------------------------

  it('[P0] AC-9.5: isFresh returns true for timestamp < 10 min ago', async () => {
    const { isFresh } = await import('../seed-all.js');

    const freshState = {
      generatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), // 5 min ago
    } as Pick<SeedState, 'generatedAt'> as SeedState;

    expect(isFresh(freshState, 10 * 60 * 1000)).toBe(true);
  });

  it('[P0] AC-9.5: isFresh returns false for timestamp > 10 min ago', async () => {
    const { isFresh } = await import('../seed-all.js');

    const staleState = {
      generatedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), // 15 min ago
    } as Pick<SeedState, 'generatedAt'> as SeedState;

    expect(isFresh(staleState, 10 * 60 * 1000)).toBe(false);
  });

  it('[P1] AC-9.5: isFresh uses default TTL of 10 minutes when not provided', async () => {
    const { isFresh } = await import('../seed-all.js');

    const freshState = {
      generatedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    } as Pick<SeedState, 'generatedAt'> as SeedState;
    const staleState = {
      generatedAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(),
    } as Pick<SeedState, 'generatedAt'> as SeedState;

    // Default TTL should be 10 minutes
    expect(isFresh(freshState)).toBe(true);
    expect(isFresh(staleState)).toBe(false);
  });

  it('[P1] AC-9.5: isFresh returns false at exact TTL boundary', async () => {
    const { isFresh } = await import('../seed-all.js');

    // Exactly at the boundary (Date.now() - ttlMs === generatedAt) should return false
    // because the check is strict less-than (< ttlMs), not less-than-or-equal
    const ttlMs = 10 * 60 * 1000;
    const boundaryState = {
      generatedAt: new Date(Date.now() - ttlMs).toISOString(),
    } as Pick<SeedState, 'generatedAt'> as SeedState;

    expect(isFresh(boundaryState, ttlMs)).toBe(false);
  });

  // -------------------------------------------------------------------------
  // AC-9.2: Source imports all 8 push scripts
  // -------------------------------------------------------------------------

  it('[P0] AC-9.2: source imports from all 8 push scripts (push-01 through push-08)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('push-01-init.js');
    expect(source).toContain('push-02-nested.js');
    expect(source).toContain('push-03-branch.js');
    expect(source).toContain('push-04-branch-work.js');
    expect(source).toContain('push-05-tag.js');
    expect(source).toContain('push-06-prs.js');
    expect(source).toContain('push-07-issues.js');
    expect(source).toContain('push-08-close.js');
  });

  // -------------------------------------------------------------------------
  // AC-9.2: Source imports runPush01..runPush08
  // -------------------------------------------------------------------------

  it('[P0] AC-9.2: source imports runPush01 through runPush08 functions', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('runPush01');
    expect(source).toContain('runPush02');
    expect(source).toContain('runPush03');
    expect(source).toContain('runPush04');
    expect(source).toContain('runPush05');
    expect(source).toContain('runPush06');
    expect(source).toContain('runPush07');
    expect(source).toContain('runPush08');
  });

  // -------------------------------------------------------------------------
  // AC-9.1: Source imports createSeedClients and stopAllClients from lib
  // -------------------------------------------------------------------------

  it('[P0] AC-9.1: source imports createSeedClients and stopAllClients from lib', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('createSeedClients');
    expect(source).toContain('stopAllClients');
    expect(source).toContain('./lib/index.js');
  });

  // -------------------------------------------------------------------------
  // AC-9.1: Source imports AGENT_IDENTITIES from lib
  // -------------------------------------------------------------------------

  it('[P0] AC-9.1: source imports AGENT_IDENTITIES from lib', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('AGENT_IDENTITIES');
  });

  // -------------------------------------------------------------------------
  // AC-9.1: Source imports PEER1_BLS_URL, PEER2_BLS_URL, ANVIL_RPC from lib
  // -------------------------------------------------------------------------

  it('[P0] AC-9.1: source imports PEER1_BLS_URL, PEER2_BLS_URL, and ANVIL_RPC from lib', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('PEER1_BLS_URL');
    expect(source).toContain('PEER2_BLS_URL');
    expect(source).toContain('ANVIL_RPC');
  });

  // -------------------------------------------------------------------------
  // AC-9.1: checkAllServicesReady polls all three services (source introspection)
  // -------------------------------------------------------------------------

  it('[P0] AC-9.1: checkAllServicesReady polls Peer1 BLS, Peer2 BLS, and Anvil', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Should contain health endpoint polling for both peers
    expect(source).toContain('PEER1_BLS_URL');
    expect(source).toContain('PEER2_BLS_URL');
    // Should contain Anvil RPC polling (eth_blockNumber)
    expect(source).toContain('eth_blockNumber');
    // Should use Promise.all for concurrent polling
    expect(source).toContain('Promise.all');
  });

  // -------------------------------------------------------------------------
  // AC-9.5: Source contains freshness check logic
  // -------------------------------------------------------------------------

  it('[P1] AC-9.5: source contains freshness check with 10-minute TTL', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Source should contain the 10 minute TTL constant
    expect(source).toContain('10 * 60 * 1000');
    // Source should reference isFresh in globalSetup logic
    expect(source).toContain('isFresh');
  });

  // -------------------------------------------------------------------------
  // AC-9.3: Source writes state.json with generatedAt
  // -------------------------------------------------------------------------

  it('[P1] AC-9.3: saveSeedState writes state.json with generatedAt timestamp', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('state.json');
    expect(source).toContain('generatedAt');
    expect(source).toContain('toISOString');
  });

  // -------------------------------------------------------------------------
  // AC-9.2: Source uses ShaToTxIdMap type from lib
  // -------------------------------------------------------------------------

  it('[P1] AC-9.2: source imports ShaToTxIdMap type from lib', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('ShaToTxIdMap');
  });

  // -------------------------------------------------------------------------
  // AC-9.2: Source derives secret keys from AGENT_IDENTITIES
  // -------------------------------------------------------------------------

  it('[P1] AC-9.2: source derives secret keys for alice, bob, and carol from AGENT_IDENTITIES', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('AGENT_IDENTITIES.alice');
    expect(source).toContain('AGENT_IDENTITIES.bob');
    expect(source).toContain('AGENT_IDENTITIES.carol');
    expect(source).toContain('secretKeyHex');
  });

  // -------------------------------------------------------------------------
  // AC-9.4: globalSetup calls stopAllClients in finally block
  // -------------------------------------------------------------------------

  it('[P1] AC-9.4: source uses finally block to call stopAllClients', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('finally');
    expect(source).toContain('stopAllClients');
  });

  // -------------------------------------------------------------------------
  // AC-9.2: Sequential push execution with progress logging
  // -------------------------------------------------------------------------

  it('[P1] AC-9.2: source contains sequential push progress logging', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Progress logging for each push
    expect(source).toContain('[seed]');
    expect(source).toContain('Push 1/8');
    expect(source).toContain('Push 8/8');
  });

  // -------------------------------------------------------------------------
  // AC-9.4: globalSetup signature (0 params, returns Promise)
  // -------------------------------------------------------------------------

  it('[P0] AC-9.4: globalSetup accepts 0 parameters (Playwright contract)', async () => {
    const module = await import('../seed-all.js');
    // Playwright globalSetup expects a function with 0 required params
    expect(module.default.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // AC-9.3: saveSeedState / loadSeedState functional round-trip
  // -------------------------------------------------------------------------

  it('[P0] AC-9.3: saveSeedState writes file and loadSeedState reads it back with generatedAt', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const os = await import('node:os');
    const { loadSeedState } = await import('../seed-all.js');

    // Create a temp dir for cleanup tracking (saveSeedState writes to fixed STATE_FILE)
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-test-'));

    // Test loadSeedState with a hand-written file at the actual STATE_FILE location
    const mockState = {
      generatedAt: new Date().toISOString(),
      repoId: 'test-repo',
      ownerPubkey: 'a'.repeat(64),
      commits: [{ sha: 'abc', txId: 'tx1', message: 'init' }],
      shaMap: { abc: 'tx1' },
      repoAnnouncementId: 'ann-id',
      refsEventId: 'refs-id',
      branches: ['main'],
      tags: ['v1.0.0'],
      files: ['README.md'],
      prs: [],
      issues: [],
      comments: [],
      closedIssueEventIds: [],
    };

    // Write mock state to the actual STATE_FILE location and read it back
    const sourceDir = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
    );
    const stateFile = path.join(sourceDir, 'state.json');
    const existed = fs.existsSync(stateFile);
    let backup: string | null = null;
    if (existed) {
      backup = fs.readFileSync(stateFile, 'utf-8');
    }

    try {
      fs.writeFileSync(stateFile, JSON.stringify(mockState, null, 2), 'utf-8');
      const loaded = loadSeedState();
      expect(loaded).not.toBeNull();
      const state = loaded as NonNullable<typeof loaded>;
      expect(state.repoId).toBe('test-repo');
      expect(state.generatedAt).toBe(mockState.generatedAt);
      expect(state.commits).toHaveLength(1);
      expect(state.closedIssueEventIds).toEqual([]);
    } finally {
      // Restore or clean up
      if (backup !== null) {
        fs.writeFileSync(stateFile, backup, 'utf-8');
      } else {
        if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // -------------------------------------------------------------------------
  // AC-9.3: saveSeedState writes generatedAt and all fields to state.json
  // -------------------------------------------------------------------------

  it('[P0] AC-9.3: saveSeedState writes state.json with generatedAt and all fields', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { saveSeedState, loadSeedState } = await import('../seed-all.js');

    const sourceDir = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
    );
    const stateFile = path.join(sourceDir, 'state.json');

    // Backup existing file if present
    const existed = fs.existsSync(stateFile);
    let backup: string | null = null;
    if (existed) {
      backup = fs.readFileSync(stateFile, 'utf-8');
    }

    const before = Date.now();

    try {
      // Call saveSeedState with a mock Push08State (no generatedAt -- saveSeedState adds it)
      const mockState = {
        repoId: 'save-test-repo',
        ownerPubkey: 'a'.repeat(64),
        commits: [{ sha: 'abc', txId: 'tx1', message: 'init' }],
        shaMap: { abc: 'tx1' },
        repoAnnouncementId: 'ann-id',
        refsEventId: 'refs-id',
        branches: ['main'],
        tags: ['v1.0.0'],
        files: ['README.md'],
        prs: [],
        issues: [],
        comments: [],
        closedIssueEventIds: [],
      };

      saveSeedState(mockState);

      // Verify file was written
      expect(fs.existsSync(stateFile)).toBe(true);

      // Read back and verify generatedAt was injected
      const loaded = loadSeedState();
      expect(loaded).not.toBeNull();
      const state = loaded as NonNullable<typeof loaded>;
      expect(state.repoId).toBe('save-test-repo');
      expect(state.generatedAt).toBeDefined();

      // generatedAt should be a recent ISO timestamp
      const generatedTime = Date.parse(state.generatedAt);
      expect(generatedTime).toBeGreaterThanOrEqual(before);
      expect(generatedTime).toBeLessThanOrEqual(Date.now());
    } finally {
      if (backup !== null) {
        fs.writeFileSync(stateFile, backup, 'utf-8');
      } else {
        if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      }
    }
  });

  // -------------------------------------------------------------------------
  // AC-9.5: loadSeedState returns null for missing file
  // -------------------------------------------------------------------------

  it('[P0] AC-9.5: loadSeedState returns null for malformed JSON in state.json', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { loadSeedState } = await import('../seed-all.js');

    const sourceDir = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
    );
    const stateFile = path.join(sourceDir, 'state.json');

    // Backup existing file if present
    const existed = fs.existsSync(stateFile);
    let backup: string | null = null;
    if (existed) {
      backup = fs.readFileSync(stateFile, 'utf-8');
    }

    try {
      // Write malformed JSON
      fs.writeFileSync(stateFile, '{invalid json content!!!', 'utf-8');
      const result = loadSeedState();
      expect(result).toBeNull();
    } finally {
      if (backup !== null) {
        fs.writeFileSync(stateFile, backup, 'utf-8');
      } else {
        if (fs.existsSync(stateFile)) fs.unlinkSync(stateFile);
      }
    }
  });

  it('[P0] AC-9.5: loadSeedState returns null when state.json does not exist', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { loadSeedState } = await import('../seed-all.js');

    const sourceDir = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
    );
    const stateFile = path.join(sourceDir, 'state.json');

    // Temporarily remove state.json if it exists
    const existed = fs.existsSync(stateFile);
    let backup: string | null = null;
    if (existed) {
      backup = fs.readFileSync(stateFile, 'utf-8');
      fs.unlinkSync(stateFile);
    }

    try {
      const result = loadSeedState();
      expect(result).toBeNull();
    } finally {
      if (backup !== null) {
        fs.writeFileSync(stateFile, backup, 'utf-8');
      }
    }
  });

  // -------------------------------------------------------------------------
  // AC-9.2: Push execution order verified in source (sequential, not reordered)
  // -------------------------------------------------------------------------

  it('[P0] AC-9.2: pushes are called in correct sequential order (01 through 08)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify call order: runPush01 appears before runPush02, etc.
    const idx01 = source.indexOf('await runPush01(');
    const idx02 = source.indexOf('await runPush02(');
    const idx03 = source.indexOf('await runPush03(');
    const idx04 = source.indexOf('await runPush04(');
    const idx05 = source.indexOf('await runPush05(');
    const idx06 = source.indexOf('await runPush06(');
    const idx07 = source.indexOf('await runPush07(');
    const idx08 = source.indexOf('await runPush08(');

    expect(idx01).toBeGreaterThan(-1);
    expect(idx02).toBeGreaterThan(idx01);
    expect(idx03).toBeGreaterThan(idx02);
    expect(idx04).toBeGreaterThan(idx03);
    expect(idx05).toBeGreaterThan(idx04);
    expect(idx06).toBeGreaterThan(idx05);
    expect(idx07).toBeGreaterThan(idx06);
    expect(idx08).toBeGreaterThan(idx07);
  });

  // -------------------------------------------------------------------------
  // AC-9.2: Push-06 receives 2 clients, Push-07 receives 3 clients
  // -------------------------------------------------------------------------

  it('[P0] AC-9.2: runPush06 is called with 2 clients (alice, carol) and 2 keys', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Extract the runPush06 call
    const push06Call = source.match(/await runPush06\([^)]+\)/s);
    expect(push06Call).not.toBeNull();
    const call = (push06Call as RegExpMatchArray)[0];
    // Should have alice, carol, aliceKey, carolKey as args
    expect(call).toContain('alice');
    expect(call).toContain('carol');
    expect(call).toContain('aliceKey');
    expect(call).toContain('carolKey');
  });

  it('[P0] AC-9.2: runPush07 is called with 3 clients (alice, bob, carol) and 3 keys', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Extract the runPush07 call
    const push07Call = source.match(/await runPush07\([^)]+\)/s);
    expect(push07Call).not.toBeNull();
    const call = (push07Call as RegExpMatchArray)[0];
    // Should have alice, bob, carol, aliceKey, bobKey, carolKey as args
    expect(call).toContain('alice');
    expect(call).toContain('bob');
    expect(call).toContain('carol');
    expect(call).toContain('aliceKey');
    expect(call).toContain('bobKey');
    expect(call).toContain('carolKey');
  });

  // -------------------------------------------------------------------------
  // AC-9.1: checkAllServicesReady error message format
  // -------------------------------------------------------------------------

  it('[P0] AC-9.1: checkAllServicesReady error message format includes "Services not ready"', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // AC-9.1 specifies descriptive error: 'Services not ready: ...'
    expect(source).toContain('Services not ready:');
  });

  // -------------------------------------------------------------------------
  // AC-9.1: 30s timeout for service polling
  // -------------------------------------------------------------------------

  it('[P1] AC-9.1: source uses 30s (30000ms) timeout for service polling', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('30000');
  });

  // -------------------------------------------------------------------------
  // AC-9.6: Source contains timing report logic
  // -------------------------------------------------------------------------

  it('[P1] AC-9.6: source contains timing report with "Total seed time" logging', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('Total seed time');
    // Should calculate elapsed time
    expect(source).toContain('startTime');
  });

  // -------------------------------------------------------------------------
  // AC-9.5: stale file deletion before re-seed
  // -------------------------------------------------------------------------

  it('[P1] AC-9.5: source deletes stale state.json before re-seeding (unlinkSync)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('unlinkSync');
    // Should check existence before deletion
    expect(source).toContain('existsSync(STATE_FILE)');
  });

  // -------------------------------------------------------------------------
  // AC-9.2: State flows between pushes (source verifies chaining)
  // -------------------------------------------------------------------------

  it('[P1] AC-9.2: push state chains correctly (push01State -> runPush02, etc.)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify state chaining: each push receives the output of the prior push
    expect(source).toContain('runPush02(alice, aliceKey, push01State)');
    expect(source).toContain('runPush03(alice, aliceKey, push02State)');
    expect(source).toContain('runPush04(alice, aliceKey, push03State)');
    expect(source).toContain('runPush05(alice, aliceKey, push04State)');
    // push06 receives push05State
    expect(source).toMatch(/runPush06\([^)]*push05State/);
    // push07 receives push06State
    expect(source).toMatch(/runPush07\([^)]*push06State/);
    // push08 receives push07State
    expect(source).toContain('runPush08(alice, aliceKey, push07State)');
  });

  // -------------------------------------------------------------------------
  // AC-9.2: runPush01 receives empty shaMap (not a state object)
  // -------------------------------------------------------------------------

  it('[P1] AC-9.2: runPush01 receives a shaMap parameter (not a state object)', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Push01 takes shaMap directly, initialized as empty {}
    expect(source).toMatch(/shaMap:\s*ShaToTxIdMap\s*=\s*\{\}/);
    expect(source).toContain('runPush01(alice, aliceKey, shaMap)');
  });

  // -------------------------------------------------------------------------
  // AC-9.5: freshness skip log message
  // -------------------------------------------------------------------------

  it('[P1] AC-9.5: source contains freshness skip log message', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'seed-all.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    expect(source).toContain('state.json is fresh');
    expect(source).toContain('skipping seed');
  });

  // -------------------------------------------------------------------------
  // Integration test stubs (.todo) for live orchestration
  // -------------------------------------------------------------------------

  it.todo('[integration] AC-9.1: checkAllServicesReady succeeds when all services are healthy');
  it.todo('[integration] AC-9.1: checkAllServicesReady throws after 30s when a service is down');
  it.todo('[integration] AC-9.2: full orchestration runs push-01 through push-08 and produces state.json');
  it.todo('[integration] AC-9.5: globalSetup skips seeding when state.json is fresh');
  it.todo('[integration] AC-9.5: globalSetup re-seeds when state.json is stale');
  it.todo('[integration] AC-9.6: total seed time < 60 seconds');
});

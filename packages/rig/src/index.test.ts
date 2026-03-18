// ATDD Red Phase - tests will fail until implementation exists
//
// Test IDs: 3.12-UNIT-001, 3.12-UNIT-002

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as rig from './index.js';
import { parseCliFlags } from './cli.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory for creating mock CLI argument arrays.
 */
function createMockArgs(
  overrides: {
    mnemonic?: string;
    relayUrl?: string;
    httpPort?: number;
    repoDir?: string;
  } = {}
): string[] {
  const args: string[] = [];

  if (overrides.mnemonic !== undefined) {
    args.push('--mnemonic', overrides.mnemonic);
  }
  if (overrides.relayUrl !== undefined) {
    args.push('--relay-url', overrides.relayUrl);
  }
  if (overrides.httpPort !== undefined) {
    args.push('--http-port', String(overrides.httpPort));
  }
  if (overrides.repoDir !== undefined) {
    args.push('--repo-dir', overrides.repoDir);
  }

  return args;
}

// ============================================================================
// Tests
// ============================================================================

describe('@toon-protocol/rig public API exports', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.12-UNIT-001: Package exports startRig and RigConfig
  // ---------------------------------------------------------------------------

  it.skip('[P3] exports startRig function', () => {
    // Arrange & Act & Assert
    expect(typeof rig.startRig).toBe('function');
  });

  it.skip('[P3] exports RigConfig type (verified via startRig parameter type existence)', () => {
    // Arrange & Act & Assert
    // RigConfig is a TypeScript type -- we verify the function exists
    // and can be referenced. The type check happens at compile time.
    expect(rig.startRig).toBeDefined();
    // If we can construct a config object and pass it, the type exists
    const _config = {
      mnemonic: 'test test test test test test test test test test test about',
      relayUrl: 'ws://localhost:7100',
    };
    // We do NOT call startRig (it would try to start a server),
    // we just verify the export signature accepts config-like objects
    expect(typeof rig.startRig).toBe('function');
  });
});

describe('@toon-protocol/rig CLI entrypoint', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.12-UNIT-002: CLI entrypoint parses flags
  // ---------------------------------------------------------------------------

  it.skip('[P3] parses --mnemonic flag into config.mnemonic', () => {
    // Arrange
    const args = createMockArgs({
      mnemonic:
        'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
      relayUrl: 'ws://localhost:7100',
    });

    // Act
    const config = parseCliFlags(args);

    // Assert
    expect(config.mnemonic).toBe(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
  });

  it.skip('[P3] parses --relay-url flag into config.relayUrl', () => {
    // Arrange
    const args = createMockArgs({
      mnemonic: 'test test test test test test test test test test test about',
      relayUrl: 'ws://localhost:7100',
    });

    // Act
    const config = parseCliFlags(args);

    // Assert
    expect(config.relayUrl).toBe('ws://localhost:7100');
  });

  it.skip('[P3] parses --http-port flag into config.httpPort as number', () => {
    // Arrange
    const args = createMockArgs({
      mnemonic: 'test test test test test test test test test test test about',
      relayUrl: 'ws://localhost:7100',
      httpPort: 3000,
    });

    // Act
    const config = parseCliFlags(args);

    // Assert
    expect(config.httpPort).toBe(3000);
    expect(typeof config.httpPort).toBe('number');
  });

  it.skip('[P3] parses --repo-dir flag into config.repoDir', () => {
    // Arrange
    const args = createMockArgs({
      mnemonic: 'test test test test test test test test test test test about',
      relayUrl: 'ws://localhost:7100',
      repoDir: '/data/repos',
    });

    // Act
    const config = parseCliFlags(args);

    // Assert
    expect(config.repoDir).toBe('/data/repos');
  });

  it.skip('[P3] missing required flags throws error with usage message', () => {
    // Arrange
    const args: string[] = []; // No flags at all

    // Act & Assert
    expect(() => parseCliFlags(args)).toThrow(/usage|required|missing/i);
  });

  it.skip('[P3] missing --mnemonic flag throws with descriptive error', () => {
    // Arrange
    const args = createMockArgs({
      relayUrl: 'ws://localhost:7100',
    }); // Missing mnemonic

    // Act & Assert
    expect(() => parseCliFlags(args)).toThrow(/mnemonic/i);
  });

  it.skip('[P3] missing --relay-url flag throws with descriptive error', () => {
    // Arrange
    const args = createMockArgs({
      mnemonic: 'test test test test test test test test test test test about',
    }); // Missing relay-url

    // Act & Assert
    expect(() => parseCliFlags(args)).toThrow(/relay.*url/i);
  });
});

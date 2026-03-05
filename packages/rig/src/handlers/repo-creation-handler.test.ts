// ATDD Red Phase - tests will fail until implementation exists
//
// Test IDs: 3.1-UNIT-003, 3.1-UNIT-004
// Risk links: E3-R010 (git missing at runtime), E3-R007 (unsupported NIP-34 kind)

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  verifyGitAvailable,
  createRepoCreationHandler,
} from './repo-creation-handler.js';
import type { HandlerContext } from '@crosstown/sdk';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory for creating a mock HandlerContext matching the SDK's pattern.
 * Mirrors the convention from @crosstown/sdk handler-registry.test.ts.
 */
function createMockHandlerContext(
  overrides: Partial<HandlerContext> = {}
): HandlerContext {
  return {
    toon: 'mock-toon-string',
    kind: 30617,
    pubkey: 'ab'.repeat(32),
    amount: 1000n,
    destination: 'g.test.rig',
    decode: vi.fn().mockReturnValue({
      id: 'a'.repeat(64),
      pubkey: 'ab'.repeat(32),
      kind: 30617,
      content: '',
      tags: [
        ['d', 'test-repo'],
        ['name', 'test-repo'],
        ['description', 'A test repository'],
      ],
      created_at: Math.floor(Date.now() / 1000),
      sig: 'c'.repeat(128),
    }),
    accept: vi.fn().mockReturnValue({ accept: true, fulfillment: 'mock' }),
    reject: vi.fn().mockReturnValue({
      accept: false,
      code: 'F00',
      message: 'rejected',
    }),
    ...overrides,
  } as HandlerContext;
}

/**
 * Factory for creating a mock execFile that simulates git binary availability.
 */
function createMockExecFileForGitCheck(
  overrides: {
    available?: boolean;
    version?: string;
  } = {}
) {
  const { available = true, version = 'git version 2.43.0' } = overrides;
  return vi
    .fn()
    .mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback?: (err: Error | null, stdout: string, stderr: string) => void
      ) => {
        if (callback) {
          if (available) {
            callback(null, version, '');
          } else {
            callback(
              new Error('ENOENT: git not found'),
              '',
              'git: command not found'
            );
          }
        }
        return { pid: 12345, kill: vi.fn() };
      }
    );
}

// ============================================================================
// Tests
// ============================================================================

describe('Repo Creation Handler - Git Startup Verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.1-UNIT-003: Git startup verification
  // Risk: E3-R010 (git binary missing at runtime)
  // ---------------------------------------------------------------------------

  it.skip('[P1] verifyGitAvailable succeeds when git is found and logs version', async () => {
    // Arrange
    const mockExecFile = createMockExecFileForGitCheck({
      available: true,
      version: 'git version 2.43.0',
    });
    const mockLogger = { info: vi.fn(), error: vi.fn() };

    // Act
    const result = await verifyGitAvailable({
      execFile: mockExecFile,
      logger: mockLogger,
    });

    // Assert
    expect(result.available).toBe(true);
    expect(result.version).toBe('git version 2.43.0');
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('git version 2.43.0')
    );
  });

  it.skip('[P1] verifyGitAvailable fails when git is not found', async () => {
    // Arrange
    const mockExecFile = createMockExecFileForGitCheck({ available: false });
    const mockLogger = { info: vi.fn(), error: vi.fn() };

    // Act
    const result = await verifyGitAvailable({
      execFile: mockExecFile,
      logger: mockLogger,
    });

    // Assert
    expect(result.available).toBe(false);
    expect(result.version).toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringMatching(/git.*not found|git.*unavailable/i)
    );
  });

  it.skip('[P1] verifyGitAvailable returns version string from git --version output', async () => {
    // Arrange
    const mockExecFile = createMockExecFileForGitCheck({
      available: true,
      version: 'git version 2.39.2 (Apple Git-143)',
    });
    const mockLogger = { info: vi.fn(), error: vi.fn() };

    // Act
    const result = await verifyGitAvailable({
      execFile: mockExecFile,
      logger: mockLogger,
    });

    // Assert
    expect(result.available).toBe(true);
    expect(result.version).toContain('2.39.2');
  });
});

describe('Repo Creation Handler - Unsupported NIP-34 Kind', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ---------------------------------------------------------------------------
  // 3.1-UNIT-004: Unsupported NIP-34 kind -> ctx.reject('F00')
  // Risk: E3-R007 (NIP-34 event validation)
  // ---------------------------------------------------------------------------

  it.skip('[P2] unsupported kind triggers ctx.reject with F00 code', async () => {
    // Arrange
    const ctx = createMockHandlerContext({
      kind: 99999,
      decode: vi.fn().mockReturnValue({
        id: 'a'.repeat(64),
        pubkey: 'ab'.repeat(32),
        kind: 99999,
        content: 'unknown event type',
        tags: [],
        created_at: Math.floor(Date.now() / 1000),
        sig: 'c'.repeat(128),
      }),
    });
    const handler = createRepoCreationHandler({ repoDir: '/tmp/repos' });

    // Act
    const _result = await handler(ctx);

    // Assert
    expect(ctx.reject).toHaveBeenCalledTimes(1);
    expect(ctx.reject).toHaveBeenCalledWith('F00', 'Unsupported NIP-34 kind');
    expect(ctx.accept).not.toHaveBeenCalled();
  });

  it.skip('[P2] unsupported kind does not call ctx.accept', async () => {
    // Arrange
    const ctx = createMockHandlerContext({ kind: 12345 });
    const handler = createRepoCreationHandler({ repoDir: '/tmp/repos' });

    // Act
    await handler(ctx);

    // Assert
    expect(ctx.accept).not.toHaveBeenCalled();
  });
});

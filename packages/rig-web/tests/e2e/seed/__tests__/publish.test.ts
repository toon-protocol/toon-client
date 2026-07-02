/**
 * ATDD Tests: Story 10.1 — AC-1.3 Publish Wrapper
 * TDD RED PHASE: These tests define expected behavior for publish.ts
 *
 * Tests will FAIL until publish.ts is implemented.
 */

import { describe, it, expect } from 'vitest';

describe('AC-1.3: Publish Wrapper (publish.ts)', () => {
  it('[P0] should export publishWithRetry function', async () => {
    const publish = await import('../lib/publish.js');

    expect(typeof publish.publishWithRetry).toBe('function');
  });

  it('[P0] should export createPublishState factory returning a Map', async () => {
    const publish = await import('../lib/publish.js');

    expect(typeof publish.createPublishState).toBe('function');

    const state = publish.createPublishState();
    expect(state).toBeInstanceOf(Map);
    expect(state.size).toBe(0);
  });

  it('[P0] should return error result when client has no payment channels', async () => {
    const publish = await import('../lib/publish.js');

    // Given a mock client with no tracked channels
    const mockClient = {
      getTrackedChannels: () => [],
    } as never;

    const mockEvent = {
      id: 'test',
      kind: 1,
      content: 'test',
      tags: [],
      created_at: 1700000000,
      pubkey: 'aabb',
      sig: 'ccdd',
    };

    // When publishWithRetry is called
    const result = await publish.publishWithRetry(mockClient, mockEvent);

    // Then it should return a failure result about missing channels
    expect(result.success).toBe(false);
    expect(result.error).toContain('No payment channels');
  });

  it('[P0] should sign balance proof before each publish', async () => {
    const publish = await import('../lib/publish.js');

    // Given a mock client that tracks calls
    const calls: string[] = [];
    const mockClient = {
      getTrackedChannels: () => ['channel-1'],
      signBalanceProof: async () => {
        calls.push('signBalanceProof');
        return { channelId: 'channel-1', amount: '100' };
      },
      publishEvent: async () => {
        calls.push('publishEvent');
        return { success: true, eventId: 'evt-1' };
      },
    } as never;

    const mockEvent = {
      id: 'test',
      kind: 1,
      content: 'test',
      tags: [],
      created_at: 1700000000,
      pubkey: 'aabb',
      sig: 'ccdd',
    };

    const result = await publish.publishWithRetry(mockClient, mockEvent);

    // Then signBalanceProof must be called before publishEvent
    expect(result.success).toBe(true);
    expect(calls).toEqual(['signBalanceProof', 'publishEvent']);
  });

  it('[P1] should retry up to 3 times on transient payment errors', async () => {
    const publish = await import('../lib/publish.js');

    let attempts = 0;
    const mockClient = {
      getTrackedChannels: () => ['channel-1'],
      signBalanceProof: async () => ({ channelId: 'channel-1', amount: '100' }),
      publishEvent: async () => {
        attempts++;
        if (attempts < 3) {
          return { success: false, error: 'transient error' };
        }
        return { success: true, eventId: 'evt-1' };
      },
    } as never;

    const mockEvent = {
      id: 'test', kind: 1, content: 'test', tags: [],
      created_at: 1700000000, pubkey: 'aabb', sig: 'ccdd',
    };

    // Use short delay for test speed
    const result = await publish.publishWithRetry(mockClient, mockEvent, 3, 10);

    expect(result.success).toBe(true);
    expect(attempts).toBe(3);
  });

  it('[P1] should return failure after exhausting all retry attempts', async () => {
    const publish = await import('../lib/publish.js');

    const mockClient = {
      getTrackedChannels: () => ['channel-1'],
      signBalanceProof: async () => ({ channelId: 'channel-1', amount: '100' }),
      publishEvent: async () => ({ success: false, error: 'permanent error' }),
    } as never;

    const mockEvent = {
      id: 'test', kind: 1, content: 'test', tags: [],
      created_at: 1700000000, pubkey: 'aabb', sig: 'ccdd',
    };

    const result = await publish.publishWithRetry(mockClient, mockEvent, 2, 10);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed after 2 attempts');
    expect(result.error).toContain('permanent error');
  });

  it('[P1] should handle exceptions from publishEvent and retry', async () => {
    const publish = await import('../lib/publish.js');

    let attempts = 0;
    const mockClient = {
      getTrackedChannels: () => ['channel-1'],
      signBalanceProof: async () => ({ channelId: 'channel-1', amount: '100' }),
      publishEvent: async () => {
        attempts++;
        if (attempts === 1) throw new Error('connection reset');
        return { success: true, eventId: 'evt-1' };
      },
    } as never;

    const mockEvent = {
      id: 'test', kind: 1, content: 'test', tags: [],
      created_at: 1700000000, pubkey: 'aabb', sig: 'ccdd',
    };

    const result = await publish.publishWithRetry(mockClient, mockEvent, 3, 10);

    expect(result.success).toBe(true);
    expect(attempts).toBe(2);
  });

  it('[P1] should NOT duplicate ILP amount calculation (ToonClient does it internally)', async () => {
    // Verify that publishWithRetry computes amount for balance proof signing
    // but passes it to signBalanceProof, NOT to publishEvent options
    const publish = await import('../lib/publish.js');

    let publishOptions: Record<string, unknown> = {};
    const mockClient = {
      getTrackedChannels: () => ['channel-1'],
      signBalanceProof: async () => ({ channelId: 'channel-1', amount: '100' }),
      publishEvent: async (_event: unknown, opts: Record<string, unknown>) => {
        publishOptions = opts;
        return { success: true, eventId: 'evt-1' };
      },
    } as never;

    const mockEvent = {
      id: 'test', kind: 1, content: 'test', tags: [],
      created_at: 1700000000, pubkey: 'aabb', sig: 'ccdd',
    };

    await publish.publishWithRetry(mockClient, mockEvent, 1, 0);

    // publishEvent should receive claim and destination, but NOT an explicit amount
    expect(publishOptions).toHaveProperty('claim');
    expect(publishOptions).toHaveProperty('destination');
    expect(publishOptions).not.toHaveProperty('amount');
  });

  it('[P2] should provide SeedPublishState as a Map for tracking cumulative amounts per client', async () => {
    const publish = await import('../lib/publish.js');

    // SeedPublishState is a Map<string, bigint> — a convenience container
    // for seed scripts to track cumulative amounts. Monotonic enforcement
    // is handled by ChannelManager internally, not by this Map.
    const state = publish.createPublishState();

    // Can track per-client cumulative amounts
    state.set('alice', 1000n);
    state.set('bob', 500n);

    expect(state.get('alice')).toBe(1000n);
    expect(state.get('bob')).toBe(500n);
    expect(state.size).toBe(2);

    // Seed scripts update amounts as they publish
    state.set('alice', 2000n);
    expect(state.get('alice')).toBe(2000n);
  });
});

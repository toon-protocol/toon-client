// Test IDs: 8.1-UNIT-006
// AC covered: AC11 (TOON format decoding in browser relay client)

import { describe, it, expect } from 'vitest';
import { encode } from '@toon-format/toon';

import { decodeToonMessage } from './relay-client.js';

// ============================================================================
// Factories
// ============================================================================

/**
 * Factory: creates a minimal kind:30617 NostrEvent object.
 */
function createMockRepoAnnouncementEvent(
  overrides: {
    id?: string;
    pubkey?: string;
    name?: string;
    description?: string;
    dTag?: string;
  } = {}
) {
  return {
    id: overrides.id ?? 'a'.repeat(64),
    pubkey: overrides.pubkey ?? 'ab'.repeat(32),
    created_at: 1700000000,
    kind: 30617,
    tags: [
      ['d', overrides.dTag ?? 'my-repo'],
      ['name', overrides.name ?? 'My Repository'],
      ['description', overrides.description ?? 'A test repository'],
      ['clone', 'https://git.example.com/my-repo.git'],
      ['r', 'HEAD', 'main'],
    ],
    content: overrides.description ?? 'A test repository',
    sig: 'b'.repeat(128),
  };
}

describe('Relay Client - TOON Format Decoding', () => {
  // ---------------------------------------------------------------------------
  // 8.1-UNIT-006: TOON-encoded kind:30617 event is correctly decoded
  // AC: #11
  // ---------------------------------------------------------------------------

  it('[P1] decodes TOON-encoded string to a valid NostrEvent', () => {
    // Arrange -- encode a real event as a TOON string
    const mockEvent = createMockRepoAnnouncementEvent({
      name: 'test-project',
      dTag: 'test-project',
    });
    const toonString = encode(mockEvent);

    // Act -- decode the TOON string
    const decoded = decodeToonMessage(toonString);

    // Assert
    expect(decoded).toBeDefined();
    expect(decoded.kind).toBe(30617);
    expect(decoded.id).toBe('a'.repeat(64));
    expect(decoded.pubkey).toBe('ab'.repeat(32));
  });

  it('[P1] decodes TOON-encoded event preserving all tags', () => {
    // Arrange
    const mockEvent = createMockRepoAnnouncementEvent({
      name: 'tagged-repo',
      dTag: 'tagged-repo',
    });
    const toonString = encode(mockEvent);

    // Act
    const decoded = decodeToonMessage(toonString);

    // Assert -- verify tags are preserved
    const dTag = decoded.tags.find((t: string[]) => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe('tagged-repo');

    const nameTag = decoded.tags.find((t: string[]) => t[0] === 'name');
    expect(nameTag).toBeDefined();
    expect(nameTag![1]).toBe('tagged-repo');

    const cloneTag = decoded.tags.find((t: string[]) => t[0] === 'clone');
    expect(cloneTag).toBeDefined();
    expect(cloneTag![1]).toBe('https://git.example.com/my-repo.git');
  });

  it('[P1] handles object passthrough for already-decoded events', () => {
    // Arrange -- pass an already-decoded object (non-TOON relay or test scenario)
    const mockEvent = createMockRepoAnnouncementEvent({
      name: 'passthrough-project',
      dTag: 'passthrough-project',
    });

    // Act -- decode should pass through objects unchanged
    const decoded = decodeToonMessage(mockEvent);

    // Assert
    expect(decoded).toBe(mockEvent);
    expect(decoded.kind).toBe(30617);
  });

  it('[P1] decoded TOON string preserves content field', () => {
    // Arrange
    const mockEvent = createMockRepoAnnouncementEvent({
      description: 'A longer description with special chars: <>&"',
    });
    const toonString = encode(mockEvent);

    // Act
    const decoded = decodeToonMessage(toonString);

    // Assert -- content field preserved
    expect(decoded.content).toBe(
      'A longer description with special chars: <>&"'
    );
  });
});

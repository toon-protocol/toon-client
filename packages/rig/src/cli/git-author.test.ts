/**
 * `resolveGitAuthor` / `displayNameFromKind0` (#302): the kind:0-name-else-npub
 * resolution behind `rig init`'s git commit-author, with the relay read mocked.
 */

import { describe, it, expect } from 'vitest';
import { hexToNpub } from '../npub.js';
import type { NostrEvent, queryRelay } from '../remote-state.js';
import {
  displayNameFromKind0,
  profileTimeoutFromEnv,
  resolveGitAuthor,
  PROFILE_KIND,
} from './git-author.js';

// A real 64-char hex pubkey (mnemonic "abandon…about", account 0).
const PUBKEY =
  '2813187eb66741f9509de2055161f328a0f04e01e1fc20188610b8dbd0591ea5';
const NPUB = hexToNpub(PUBKEY);
const EMAIL = `${NPUB}@nostr`;
const RELAY = 'wss://relay.example';

function kind0(content: string, created_at: number, pubkey = PUBKEY): NostrEvent {
  return {
    id: `id-${created_at}`,
    pubkey,
    created_at,
    kind: PROFILE_KIND,
    tags: [],
    content,
    sig: 'sig',
  };
}

/** A `queryRelay`-shaped stub that returns a fixed event buffer. */
function stubQuery(events: NostrEvent[]): typeof queryRelay {
  return (() => Promise.resolve(events)) as never;
}

describe('displayNameFromKind0', () => {
  it('prefers display_name over name', () => {
    expect(
      displayNameFromKind0(JSON.stringify({ name: 'alice', display_name: 'Alice' }))
    ).toBe('Alice');
  });

  it('falls back to name when display_name is absent/empty', () => {
    expect(displayNameFromKind0(JSON.stringify({ name: 'alice' }))).toBe('alice');
    expect(
      displayNameFromKind0(JSON.stringify({ display_name: '  ', name: 'bob' }))
    ).toBe('bob');
  });

  it('returns undefined for no name fields, non-object, or bad JSON', () => {
    expect(displayNameFromKind0(JSON.stringify({ about: 'hi' }))).toBeUndefined();
    expect(displayNameFromKind0('not json')).toBeUndefined();
    expect(displayNameFromKind0('"a string"')).toBeUndefined();
  });
});

describe('resolveGitAuthor', () => {
  it('email is always <npub>@nostr', async () => {
    const author = await resolveGitAuthor({ pubkey: PUBKEY });
    expect(author.email).toBe(EMAIL);
    expect(author.npub).toBe(NPUB);
  });

  it('uses the kind:0 display_name when a profile is published', async () => {
    const author = await resolveGitAuthor({
      pubkey: PUBKEY,
      relayUrl: RELAY,
      queryRelayImpl: stubQuery([
        kind0(JSON.stringify({ display_name: 'Alice', name: 'alice' }), 100),
      ]),
    });
    expect(author).toEqual({
      name: 'Alice',
      email: EMAIL,
      npub: NPUB,
      source: 'profile',
    });
  });

  it('takes the LATEST kind:0 (highest created_at), not first-in-buffer (#157)', async () => {
    const author = await resolveGitAuthor({
      pubkey: PUBKEY,
      relayUrl: RELAY,
      // A stale event arrives FIRST; the newer one must win regardless.
      queryRelayImpl: stubQuery([
        kind0(JSON.stringify({ display_name: 'Old Name' }), 100),
        kind0(JSON.stringify({ display_name: 'New Name' }), 200),
      ]),
    });
    expect(author.name).toBe('New Name');
    expect(author.source).toBe('profile');
  });

  it('falls back to the npub when no relay is resolvable', async () => {
    const author = await resolveGitAuthor({ pubkey: PUBKEY });
    expect(author).toEqual({
      name: NPUB,
      email: EMAIL,
      npub: NPUB,
      source: 'npub',
    });
  });

  it('falls back to the npub for a non-ws relay URL (read is skipped)', async () => {
    let called = false;
    const author = await resolveGitAuthor({
      pubkey: PUBKEY,
      relayUrl: 'https://relay.example',
      queryRelayImpl: ((..._a: unknown[]) => {
        called = true;
        return Promise.resolve([]);
      }) as never,
    });
    expect(called).toBe(false);
    expect(author.source).toBe('npub');
  });

  it('falls back to the npub when the relay read throws (best-effort)', async () => {
    const author = await resolveGitAuthor({
      pubkey: PUBKEY,
      relayUrl: RELAY,
      queryRelayImpl: (() => Promise.reject(new Error('unreachable'))) as never,
    });
    expect(author.name).toBe(NPUB);
    expect(author.source).toBe('npub');
  });

  it('falls back to the npub on an empty buffer or a profile with no name', async () => {
    const empty = await resolveGitAuthor({
      pubkey: PUBKEY,
      relayUrl: RELAY,
      queryRelayImpl: stubQuery([]),
    });
    expect(empty.source).toBe('npub');

    const noName = await resolveGitAuthor({
      pubkey: PUBKEY,
      relayUrl: RELAY,
      queryRelayImpl: stubQuery([kind0(JSON.stringify({ about: 'hi' }), 100)]),
    });
    expect(noName.source).toBe('npub');
  });

  it('ignores kind:0 events from other authors', async () => {
    const author = await resolveGitAuthor({
      pubkey: PUBKEY,
      relayUrl: RELAY,
      queryRelayImpl: stubQuery([
        kind0(JSON.stringify({ display_name: 'Impostor' }), 300, 'ff'.repeat(32)),
      ]),
    });
    expect(author.source).toBe('npub');
  });
});

describe('profileTimeoutFromEnv', () => {
  it('parses a positive integer, else undefined', () => {
    expect(profileTimeoutFromEnv({ RIG_PROFILE_TIMEOUT_MS: '1500' })).toBe(1500);
    expect(profileTimeoutFromEnv({ RIG_PROFILE_TIMEOUT_MS: '0' })).toBeUndefined();
    expect(profileTimeoutFromEnv({ RIG_PROFILE_TIMEOUT_MS: 'x' })).toBeUndefined();
    expect(profileTimeoutFromEnv({})).toBeUndefined();
  });
});

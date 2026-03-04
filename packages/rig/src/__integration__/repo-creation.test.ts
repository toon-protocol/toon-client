// ATDD Red Phase - Integration tests will fail until implementation exists
// Test: 3.1-INT-001 [P0]: Repo creation: kind:30617 -> git init --bare -> SQLite

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  generateSecretKey,
  getPublicKey,
  finalizeEvent,
} from 'nostr-tools/pure';
import type { NostrEvent } from 'nostr-tools/pure';

// --- Imports from @crosstown/rig (DOES NOT EXIST YET) ---
import { handleRepoCreation } from '../handlers/repo-creation-handler.js';
import { createInMemoryMetadataStore } from '../storage/metadata-store.js';
import type { MetadataStore, RepoMetadata } from '../storage/metadata-store.js';
import type { HandlerContext } from '../types.js';

// --- Imports from @crosstown/core (exists) ---
import { REPOSITORY_ANNOUNCEMENT_KIND } from '@crosstown/core/nip34';

// ---------------------------------------------------------------------------
// Factory Functions
// ---------------------------------------------------------------------------

/**
 * Creates a valid kind:30617 Repository Announcement event for testing.
 * Follows NIP-34 specification for repository announcements.
 */
function createRepoAnnouncementEvent(
  overrides: {
    secretKey?: Uint8Array;
    repoName?: string;
    description?: string;
    repoId?: string;
    maintainers?: string[];
  } = {}
): { event: NostrEvent; secretKey: Uint8Array; pubkey: string } {
  const secretKey = overrides.secretKey ?? generateSecretKey();
  const pubkey = getPublicKey(secretKey);
  const repoName = overrides.repoName ?? 'test-repo';
  const description =
    overrides.description ?? 'A test repository for integration testing';
  const repoId = overrides.repoId ?? repoName;
  const maintainers = overrides.maintainers ?? [pubkey];

  const tags: string[][] = [
    ['d', repoId],
    ['name', repoName],
    ['description', description],
    ['clone', `https://rig.example.com/${pubkey.slice(0, 8)}/${repoName}.git`],
    ['web', `https://rig.example.com/${pubkey.slice(0, 8)}/${repoName}`],
    ['relays', 'wss://relay.example.com'],
    ['maintainers', ...maintainers],
  ];

  const event = finalizeEvent(
    {
      kind: REPOSITORY_ANNOUNCEMENT_KIND,
      content: '',
      tags,
      created_at: Math.floor(Date.now() / 1000),
    },
    secretKey
  );

  return { event, secretKey, pubkey };
}

/**
 * Creates a temporary directory for repository storage.
 * Returns the path and a cleanup function.
 */
function createTempRepoDir(): { repoDir: string; cleanup: () => void } {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-test-repos-'));
  return {
    repoDir,
    cleanup: () => {
      fs.rmSync(repoDir, { recursive: true, force: true });
    },
  };
}

/**
 * Creates a mock HandlerContext for testing handler functions.
 * Wraps a NostrEvent with accept/reject spies and decode capability.
 */
function createMockHandlerContext(
  event: NostrEvent,
  overrides: {
    amount?: bigint;
    destination?: string;
  } = {}
): HandlerContext & {
  acceptSpy: ReturnType<typeof vi.fn>;
  rejectSpy: ReturnType<typeof vi.fn>;
} {
  const acceptSpy = vi.fn().mockResolvedValue({ accept: true });
  const rejectSpy = vi.fn().mockResolvedValue({ accept: false });

  let decoded: NostrEvent | null = null;

  return {
    toon: '', // Raw TOON would be here in real impl
    kind: event.kind,
    pubkey: event.pubkey,
    amount: overrides.amount ?? 1000n,
    destination: overrides.destination ?? 'g.rig.test',
    decode: () => {
      if (!decoded) {
        decoded = event;
      }
      return decoded;
    },
    accept: acceptSpy,
    reject: rejectSpy,
    acceptSpy,
    rejectSpy,
  };
}

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describe('3.1-INT-001: Repo Creation via kind:30617', () => {
  let repoDir: string;
  let cleanupRepoDir: () => void;
  let metadataStore: MetadataStore;

  beforeEach(() => {
    const temp = createTempRepoDir();
    repoDir = temp.repoDir;
    cleanupRepoDir = temp.cleanup;
    metadataStore = createInMemoryMetadataStore();
  });

  afterEach(() => {
    cleanupRepoDir();
  });

  // -------------------------------------------------------------------------
  // [P0] kind:30617 event creates bare git repo on disk
  // -------------------------------------------------------------------------

  it.skip('[P0] kind:30617 event creates a bare git repository on disk', async () => {
    // Arrange
    const { event, pubkey } = createRepoAnnouncementEvent({
      repoName: 'my-project',
      description: 'My awesome project',
    });
    const ctx = createMockHandlerContext(event);

    // Act
    await handleRepoCreation(ctx, { repoDir, metadataStore });

    // Assert - bare git repo created on disk
    const expectedRepoPath = path.join(
      repoDir,
      pubkey.slice(0, 8),
      'my-project.git'
    );
    expect(fs.existsSync(expectedRepoPath)).toBe(true);
    expect(fs.existsSync(path.join(expectedRepoPath, 'HEAD'))).toBe(true);
    expect(fs.existsSync(path.join(expectedRepoPath, 'objects'))).toBe(true);
    expect(fs.existsSync(path.join(expectedRepoPath, 'refs'))).toBe(true);

    // Verify HEAD points to a valid ref (bare repo convention)
    const headContent = fs.readFileSync(
      path.join(expectedRepoPath, 'HEAD'),
      'utf-8'
    );
    expect(headContent.trim()).toMatch(/^ref: refs\/heads\//);
  });

  // -------------------------------------------------------------------------
  // [P0] Repo metadata stored in SQLite :memory:
  // -------------------------------------------------------------------------

  it.skip('[P0] repo metadata is stored in SQLite metadata store', async () => {
    // Arrange
    const { event, pubkey } = createRepoAnnouncementEvent({
      repoName: 'metadata-test',
      description: 'Testing metadata storage',
    });
    const ctx = createMockHandlerContext(event);

    // Act
    await handleRepoCreation(ctx, { repoDir, metadataStore });

    // Assert - metadata stored in SQLite
    const storedRepo: RepoMetadata | undefined = metadataStore.getRepo(
      pubkey.slice(0, 8),
      'metadata-test'
    );
    expect(storedRepo).toBeDefined();
    expect(storedRepo!.name).toBe('metadata-test');
    expect(storedRepo!.description).toBe('Testing metadata storage');
    expect(storedRepo!.ownerPubkey).toBe(pubkey);
    expect(storedRepo!.createdAt).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // [P0] ctx.accept() called with repo metadata on success
  // -------------------------------------------------------------------------

  it.skip('[P0] ctx.accept() is called with repo metadata on successful creation', async () => {
    // Arrange
    const { event } = createRepoAnnouncementEvent({
      repoName: 'accept-test',
    });
    const ctx = createMockHandlerContext(event);

    // Act
    await handleRepoCreation(ctx, { repoDir, metadataStore });

    // Assert
    expect(ctx.acceptSpy).toHaveBeenCalledOnce();
    const acceptArg = ctx.acceptSpy.mock.calls[0]?.[0];
    expect(acceptArg).toBeDefined();
    expect(acceptArg).toHaveProperty('name', 'accept-test');
    expect(acceptArg).toHaveProperty('ownerPubkey');
  });

  // -------------------------------------------------------------------------
  // [P0] Duplicate repo creation is rejected
  // -------------------------------------------------------------------------

  it.skip('[P0] duplicate repo creation is rejected with F00', async () => {
    // Arrange - create repo first time
    const { event, secretKey } = createRepoAnnouncementEvent({
      repoName: 'duplicate-repo',
    });
    const ctx1 = createMockHandlerContext(event);
    await handleRepoCreation(ctx1, { repoDir, metadataStore });

    // Act - attempt to create same repo again
    const { event: event2 } = createRepoAnnouncementEvent({
      secretKey,
      repoName: 'duplicate-repo',
    });
    const ctx2 = createMockHandlerContext(event2);
    await handleRepoCreation(ctx2, { repoDir, metadataStore });

    // Assert
    expect(ctx2.rejectSpy).toHaveBeenCalledOnce();
    expect(ctx2.rejectSpy).toHaveBeenCalledWith(
      'F00',
      expect.stringContaining('already exists')
    );
  });

  // -------------------------------------------------------------------------
  // [P1] Missing required tags are rejected
  // -------------------------------------------------------------------------

  it.skip('[P1] event missing required tags is rejected with F00', async () => {
    // Arrange - event with no 'name' tag
    const secretKey = generateSecretKey();
    const event = finalizeEvent(
      {
        kind: REPOSITORY_ANNOUNCEMENT_KIND,
        content: '',
        tags: [['d', 'no-name-repo']], // missing 'name' tag
        created_at: Math.floor(Date.now() / 1000),
      },
      secretKey
    );
    const ctx = createMockHandlerContext(event);

    // Act
    await handleRepoCreation(ctx, { repoDir, metadataStore });

    // Assert
    expect(ctx.rejectSpy).toHaveBeenCalledOnce();
    expect(ctx.rejectSpy).toHaveBeenCalledWith(
      'F00',
      expect.stringContaining('name')
    );
  });

  // -------------------------------------------------------------------------
  // [P1] Repo metadata includes maintainers list
  // -------------------------------------------------------------------------

  it.skip('[P1] repo metadata includes maintainers from event tags', async () => {
    // Arrange
    const maintainerKey = generateSecretKey();
    const maintainerPubkey = getPublicKey(maintainerKey);
    const { event, pubkey } = createRepoAnnouncementEvent({
      repoName: 'maintainer-test',
      maintainers: [pubkey, maintainerPubkey],
    });
    const ctx = createMockHandlerContext(event);

    // Act
    await handleRepoCreation(ctx, { repoDir, metadataStore });

    // Assert
    const storedRepo = metadataStore.getRepo(
      pubkey.slice(0, 8),
      'maintainer-test'
    );
    expect(storedRepo).toBeDefined();
    expect(storedRepo!.maintainers).toContain(pubkey);
    expect(storedRepo!.maintainers).toContain(maintainerPubkey);
  });
});

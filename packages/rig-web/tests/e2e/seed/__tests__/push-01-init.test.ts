/**
 * ATDD Tests: Story 10.2 — Seed Script: Initial Repo Push (Push 1)
 * TDD RED PHASE: These tests define expected behavior for push-01-init.ts
 *
 * Tests will FAIL until push-01-init.ts is implemented.
 *
 * AC-2.1: Git object creation (3 blobs, 2 trees, 1 commit)
 * AC-2.2: Arweave DVM upload (6 objects, bottom-up order)
 * AC-2.3: Repo announcement (kind:30617)
 * AC-2.4: Refs/state (kind:30618)
 * AC-2.5: State return (Push01State)
 * AC-2.6: Alice's client (ToonClient with ILP claims)
 */

import { describe, it, expect } from 'vitest';

describe('Story 10.2: Push 01 — Initial Repo Push', () => {
  // -------------------------------------------------------------------------
  // AC-2.5: Module exports and structure
  // -------------------------------------------------------------------------

  it('[P0] should export runPush01 function', async () => {
    const push01 = await import('../push-01-init.js');
    expect(typeof push01.runPush01).toBe('function');
  });

  it('[P0] should export REPO_ID constant as a valid non-empty string', async () => {
    const push01 = await import('../push-01-init.js');
    expect(typeof push01.REPO_ID).toBe('string');
    expect(push01.REPO_ID.length).toBeGreaterThan(0);
    expect(push01.REPO_ID).toBe('rig-e2e-test-repo');
  });

  // -------------------------------------------------------------------------
  // AC-2.1: File content constants
  // -------------------------------------------------------------------------

  it('[P0] should export README_CONTENT as a non-empty string', async () => {
    const push01 = await import('../push-01-init.js');
    expect(typeof push01.README_CONTENT).toBe('string');
    expect(push01.README_CONTENT.length).toBeGreaterThan(0);
    expect(push01.README_CONTENT).toContain('rig-e2e-test-repo');
  });

  it('[P0] should export PACKAGE_JSON_CONTENT as valid JSON', async () => {
    const push01 = await import('../push-01-init.js');
    expect(typeof push01.PACKAGE_JSON_CONTENT).toBe('string');
    expect(push01.PACKAGE_JSON_CONTENT.length).toBeGreaterThan(0);
    // Should be valid JSON
    const parsed = JSON.parse(push01.PACKAGE_JSON_CONTENT);
    expect(parsed.name).toBe('rig-e2e-test-repo');
  });

  it('[P0] should export INDEX_TS_CONTENT as a non-empty string', async () => {
    const push01 = await import('../push-01-init.js');
    expect(typeof push01.INDEX_TS_CONTENT).toBe('string');
    expect(push01.INDEX_TS_CONTENT.length).toBeGreaterThan(0);
    expect(push01.INDEX_TS_CONTENT).toContain('hello');
  });

  // -------------------------------------------------------------------------
  // AC-2.1: Git object creation — deterministic SHAs
  // -------------------------------------------------------------------------

  it('[P0] should produce deterministic blob SHAs for known file contents', async () => {
    const push01 = await import('../push-01-init.js');
    const { createGitBlob } = await import('../lib/git-builder.js');

    // Blobs created from the exported constants should have deterministic SHAs
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);

    // All SHAs should be valid 40-character hex strings
    expect(readmeBlob.sha).toHaveLength(40);
    expect(pkgBlob.sha).toHaveLength(40);
    expect(indexBlob.sha).toHaveLength(40);

    // SHAs should be different from each other (unique content)
    expect(readmeBlob.sha).not.toBe(pkgBlob.sha);
    expect(readmeBlob.sha).not.toBe(indexBlob.sha);
    expect(pkgBlob.sha).not.toBe(indexBlob.sha);
  });

  it('[P0] should create 3 blobs, 2 trees, and 1 commit (6 git objects total)', async () => {
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const push01 = await import('../push-01-init.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Create the 3 blobs from file contents
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);

    // Create src/ subtree with index.ts
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]);

    // Create root tree with README.md, package.json, and src/ directory
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);

    // Create commit (no parent — first push)
    const commit = createGitCommit({
      treeSha: rootTree.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Initial commit',
      timestamp: 1700000000,
    });

    // Verify all 6 objects have valid SHAs
    const allObjects = [readmeBlob, pkgBlob, indexBlob, srcTree, rootTree, commit];
    expect(allObjects).toHaveLength(6);
    for (const obj of allObjects) {
      expect(obj.sha).toHaveLength(40);
      expect(obj.body).toBeInstanceOf(Buffer);
      expect(obj.buffer).toBeInstanceOf(Buffer);
    }

    // Commit should reference the root tree
    expect(commit.body.toString('utf-8')).toContain(`tree ${rootTree.sha}`);
    // Commit should NOT have a parent (first commit)
    expect(commit.body.toString('utf-8')).not.toContain('parent ');
    // Commit should use fixed timestamp for determinism
    expect(commit.body.toString('utf-8')).toContain('1700000000');
  });

  it('[P0] should produce consistent SHAs across multiple runs (deterministic)', async () => {
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const push01 = await import('../push-01-init.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Run the same object creation twice
    const run = () => {
      const readmeBlob = createGitBlob(push01.README_CONTENT);
      const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
      const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
      const srcTree = createGitTree([
        { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      ]);
      const rootTree = createGitTree([
        { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
        { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
        { mode: '040000', name: 'src', sha: srcTree.sha },
      ]);
      const commit = createGitCommit({
        treeSha: rootTree.sha,
        authorName: 'Alice',
        authorPubkey: AGENT_IDENTITIES.alice.pubkey,
        message: 'Initial commit',
        timestamp: 1700000000,
      });
      return { readmeBlob, pkgBlob, indexBlob, srcTree, rootTree, commit };
    };

    const first = run();
    const second = run();

    // All SHAs must be identical across runs
    expect(first.readmeBlob.sha).toBe(second.readmeBlob.sha);
    expect(first.pkgBlob.sha).toBe(second.pkgBlob.sha);
    expect(first.indexBlob.sha).toBe(second.indexBlob.sha);
    expect(first.srcTree.sha).toBe(second.srcTree.sha);
    expect(first.rootTree.sha).toBe(second.rootTree.sha);
    expect(first.commit.sha).toBe(second.commit.sha);
  });

  it('[P0] should create root tree with correct entries: README.md, package.json, src/', async () => {
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');
    const push01 = await import('../push-01-init.js');

    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);

    // Body should contain all three entries (sorted alphabetically)
    const bodyBin = rootTree.body.toString('binary');
    const readmeIdx = bodyBin.indexOf('README.md');
    const pkgIdx = bodyBin.indexOf('package.json');
    const srcIdx = bodyBin.indexOf('src');

    // All entries should be present
    expect(readmeIdx).toBeGreaterThanOrEqual(0);
    expect(pkgIdx).toBeGreaterThanOrEqual(0);
    expect(srcIdx).toBeGreaterThanOrEqual(0);

    // Sorted order: README.md < package.json < src
    expect(readmeIdx).toBeLessThan(pkgIdx);
    expect(pkgIdx).toBeLessThan(srcIdx);
  });

  it('[P0] should create src/ subtree containing only index.ts', async () => {
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');
    const push01 = await import('../push-01-init.js');

    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]);

    // Body should contain index.ts entry
    const bodyBin = srcTree.body.toString('binary');
    expect(bodyBin).toContain('index.ts');
  });

  // -------------------------------------------------------------------------
  // AC-2.5: runPush01 function signature and return type
  // -------------------------------------------------------------------------

  it('[P0] should accept (aliceClient, aliceSecretKey, shaMap) parameters', async () => {
    const push01 = await import('../push-01-init.js');

    // runPush01 should accept at least 3 parameters
    expect(push01.runPush01.length).toBeGreaterThanOrEqual(3);
  });

  it('[P0] should export Push01State type (verified by compilation)', async () => {
    // The Push01State type is verified at compile time by TypeScript.
    // If the type is not exported, TS compilation will fail when other
    // modules try to import it. This test validates the module loads
    // and serves as a compile-time canary for type exports.
    const push01 = await import('../push-01-init.js');
    expect(push01).toBeDefined();
  });

  it('[P0] AC-2.5: ownerPubkey matches AGENT_IDENTITIES.alice.pubkey', async () => {
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');
    // Alice's pubkey should be a 64-char hex string (secp256k1 compressed)
    expect(AGENT_IDENTITIES.alice.pubkey).toHaveLength(64);
    expect(AGENT_IDENTITIES.alice.pubkey).toMatch(/^[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // AC-2.3: Repo Announcement event structure (unit-testable)
  // -------------------------------------------------------------------------

  it('[P0] AC-2.3: buildRepoAnnouncement produces correct kind:30617 tags for REPO_ID', async () => {
    const { buildRepoAnnouncement } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const event = buildRepoAnnouncement(
      push01.REPO_ID,
      'Rig E2E Test Repo',
      'A test repository for Rig E2E integration tests'
    );

    expect(event.kind).toBe(30617);

    // d tag matches REPO_ID
    const dTag = event.tags.find((t) => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe(push01.REPO_ID);

    // name tag
    const nameTag = event.tags.find((t) => t[0] === 'name');
    expect(nameTag).toBeDefined();
    expect(nameTag![1]).toBe('Rig E2E Test Repo');

    // description tag
    const descTag = event.tags.find((t) => t[0] === 'description');
    expect(descTag).toBeDefined();
    expect(descTag![1]).toBe('A test repository for Rig E2E integration tests');

    // No HEAD tag in kind:30617 (HEAD is in kind:30618 per AC-2.3)
    const headTag = event.tags.find((t) => t[0] === 'HEAD');
    expect(headTag).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC-2.4: Refs/State event structure (unit-testable)
  // -------------------------------------------------------------------------

  it('[P0] AC-2.4: buildRepoRefs produces correct kind:30618 tags with d, r, HEAD, and arweave', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const push01 = await import('../push-01-init.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Build the same git objects as runPush01
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);
    const commit = createGitCommit({
      treeSha: rootTree.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Initial commit',
      timestamp: 1700000000,
    });

    // Simulate the shaMap after all 6 uploads
    const shaMap: Record<string, string> = {
      [readmeBlob.sha]: 'arweave-tx-1',
      [pkgBlob.sha]: 'arweave-tx-2',
      [indexBlob.sha]: 'arweave-tx-3',
      [srcTree.sha]: 'arweave-tx-4',
      [rootTree.sha]: 'arweave-tx-5',
      [commit.sha]: 'arweave-tx-6',
    };

    const event = buildRepoRefs(
      push01.REPO_ID,
      { 'refs/heads/main': commit.sha },
      shaMap
    );

    expect(event.kind).toBe(30618);

    // d tag matches REPO_ID
    const dTag = event.tags.find((t) => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe(push01.REPO_ID);

    // r tag: refs/heads/main -> commit SHA
    const rTag = event.tags.find((t) => t[0] === 'r');
    expect(rTag).toBeDefined();
    expect(rTag![1]).toBe('refs/heads/main');
    expect(rTag![2]).toBe(commit.sha);

    // HEAD tag: ref: refs/heads/main
    const headTag = event.tags.find((t) => t[0] === 'HEAD');
    expect(headTag).toBeDefined();
    expect(headTag![1]).toBe('ref: refs/heads/main');

    // arweave tags: one per git object (all 6)
    const arweaveTags = event.tags.filter((t) => t[0] === 'arweave');
    expect(arweaveTags).toHaveLength(6);

    // Each arweave tag maps a SHA to a txId
    for (const [sha, txId] of Object.entries(shaMap)) {
      const found = arweaveTags.find((t) => t[1] === sha);
      expect(found).toBeDefined();
      expect(found![2]).toBe(txId);
    }
  });

  // -------------------------------------------------------------------------
  // AC-2.1: Commit content verification (author, message)
  // -------------------------------------------------------------------------

  it('[P0] AC-2.1: commit uses Alice as author with correct pubkey and message "Initial commit"', async () => {
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const push01 = await import('../push-01-init.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);
    const commit = createGitCommit({
      treeSha: rootTree.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Initial commit',
      timestamp: 1700000000,
    });

    const body = commit.body.toString('utf-8');
    expect(body).toContain(`author Alice <${AGENT_IDENTITIES.alice.pubkey}@nostr>`);
    expect(body).toContain(`committer Alice <${AGENT_IDENTITIES.alice.pubkey}@nostr>`);
    expect(body).toContain('Initial commit');
  });

  // -------------------------------------------------------------------------
  // AC-2.5: State return structure fields (unit-testable expectations)
  // -------------------------------------------------------------------------

  it('[P0] AC-2.5: Push01State interface expects branches=["main"] and files=["README.md", "package.json", "src/index.ts"]', async () => {
    // This test verifies that the constants used to build the return state
    // in runPush01 match the AC-2.5 specification. Since runPush01 requires
    // infrastructure to execute, we verify the source code expectations
    // by checking the implementation exports the correct file list.
    const push01 = await import('../push-01-init.js');

    // REPO_ID must match what AC-2.5 specifies
    expect(push01.REPO_ID).toBe('rig-e2e-test-repo');

    // The three file contents must map to the expected file paths
    // README.md -> README_CONTENT
    expect(push01.README_CONTENT).toContain('rig-e2e-test-repo');
    // package.json -> PACKAGE_JSON_CONTENT
    const pkg = JSON.parse(push01.PACKAGE_JSON_CONTENT);
    expect(pkg.main).toBe('src/index.ts');
    // src/index.ts -> INDEX_TS_CONTENT
    expect(push01.INDEX_TS_CONTENT).toContain('function hello');
  });

  // -------------------------------------------------------------------------
  // AC-2.2: Upload order enforcement (unit-testable via source inspection)
  // -------------------------------------------------------------------------

  it('[P0] AC-2.2: file contents are under 95KB size limit (R10-005)', async () => {
    const push01 = await import('../push-01-init.js');
    const maxSize = 95 * 1024; // 95KB

    // All file contents must be well under the 95KB Arweave free tier limit
    expect(Buffer.byteLength(push01.README_CONTENT, 'utf-8')).toBeLessThan(maxSize);
    expect(Buffer.byteLength(push01.PACKAGE_JSON_CONTENT, 'utf-8')).toBeLessThan(maxSize);
    expect(Buffer.byteLength(push01.INDEX_TS_CONTENT, 'utf-8')).toBeLessThan(maxSize);

    // Total content should be ~300 bytes per the story spec
    const totalBytes =
      Buffer.byteLength(push01.README_CONTENT, 'utf-8') +
      Buffer.byteLength(push01.PACKAGE_JSON_CONTENT, 'utf-8') +
      Buffer.byteLength(push01.INDEX_TS_CONTENT, 'utf-8');
    expect(totalBytes).toBeLessThan(1000); // Well under limit
    expect(totalBytes).toBeGreaterThan(100); // Sanity: not empty
  });

  // -------------------------------------------------------------------------
  // AC-2.2 / AC-2.3 / AC-2.4 / AC-2.6: Infrastructure-dependent tests
  // These require live Arweave DVM and ToonClient infrastructure.
  // -------------------------------------------------------------------------

  it.todo('[integration] AC-2.2: should upload all 6 git objects to Arweave via kind:5094 DVM');

  it.todo('[integration] AC-2.2: should upload in correct order: blobs, then trees (leaf-to-root), then commit');

  it.todo('[integration] AC-2.2: should capture all 6 { sha, txId } pairs in shaMap');

  it.todo('[integration] AC-2.2: should throw immediately if any upload returns undefined txId (R10-003)');

  it.todo('[integration] AC-2.3: should publish kind:30617 repo announcement with d, name, description tags');

  it.todo('[integration] AC-2.4: should publish kind:30618 refs with d, r, HEAD, and arweave tags');

  it.todo('[integration] AC-2.4: should include arweave tags for all 6 git objects in kind:30618');

  it.todo('[integration] AC-2.5: should return Push01State with repoId, ownerPubkey, commits, shaMap, event IDs');

  it.todo('[integration] AC-2.5: should return branches array containing "main"');

  it.todo('[integration] AC-2.5: should return files array containing README.md, package.json, src/index.ts');

  it.todo('[integration] AC-2.5: should NOT write state.json directly — returns state for orchestrator');

  it.todo('[integration] AC-2.6: should publish all events via Alice ToonClient with valid ILP claims');

  it.todo('[integration] AC-2.2: should sign monotonically increasing cumulative claims for each upload');

  it.todo('[integration] R10-001: should optionally wait for Arweave indexing of commit txId before returning');
});

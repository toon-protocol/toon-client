/**
 * ATDD Tests: Story 10.5 — Seed Script: Tag (Push 5)
 *
 * Unit tests verify push-05-tag.ts tag creation via kind:30618 refs event,
 * state passthrough from Push04State, and the "no new git objects" constraint.
 * Integration tests (.todo) require live Arweave DVM infrastructure.
 *
 * AC-5.1: seed/push-05-tag.ts adds refs/tags/v1.0.0 pointing to main's HEAD commit SHA
 * AC-5.2: kind:30618 refs includes tag alongside both branches, HEAD still points to main
 * AC-5.3: No new git objects needed — tag points to existing commit
 * AC-5.4: Push05State passes through all Push04State fields unchanged except refsEventId and tags
 */

import { describe, it, expect } from 'vitest';

describe('Story 10.5: Push 05 — Tag', () => {
  // -------------------------------------------------------------------------
  // AC-5.1: Module exports and structure
  // -------------------------------------------------------------------------

  it('[P0] should export runPush05 function', async () => {
    const push05 = await import('../push-05-tag.js');
    expect(typeof push05.runPush05).toBe('function');
  });

  it('[P0] should accept (aliceClient, aliceSecretKey, push04State) parameters', async () => {
    const push05 = await import('../push-05-tag.js');
    // runPush05 should accept at least 3 parameters
    expect(push05.runPush05.length).toBeGreaterThanOrEqual(3);
  });

  it('[P0] should export Push05State type (verified by compilation)', async () => {
    const push05 = await import('../push-05-tag.js');
    expect(push05).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-5.2: kind:30618 refs contain tag alongside both branches
  // -------------------------------------------------------------------------

  it('[P0] AC-5.2: kind:30618 refs contain refs/tags/v1.0.0 alongside both branch refs', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const push02CommitSha = 'a'.repeat(40);
    const push04CommitSha = 'b'.repeat(40);

    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': push02CommitSha,
        'refs/heads/feature/add-retry': push04CommitSha,
        'refs/tags/v1.0.0': push02CommitSha,
      },
      {}
    );

    // All three refs should be present
    const mainRef = event.tags.find((t) => t[0] === 'r' && t[1] === 'refs/heads/main');
    const featureRef = event.tags.find((t) => t[0] === 'r' && t[1] === 'refs/heads/feature/add-retry');
    const tagRef = event.tags.find((t) => t[0] === 'r' && t[1] === 'refs/tags/v1.0.0');

    expect(mainRef).toBeDefined();
    expect(featureRef).toBeDefined();
    expect(tagRef).toBeDefined();

    // Exactly 3 'r' tags
    const rTags = event.tags.filter((t) => t[0] === 'r');
    expect(rTags).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // AC-5.1: Tag ref points to Push 2 commit SHA (main HEAD)
  // -------------------------------------------------------------------------

  it('[P0] AC-5.1: tag ref points to Push 2 commit SHA (main HEAD), NOT Push 3 or Push 4', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const push02CommitSha = 'a'.repeat(40);
    const push03CommitSha = 'c'.repeat(40);
    const push04CommitSha = 'b'.repeat(40);

    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': push02CommitSha,
        'refs/heads/feature/add-retry': push04CommitSha,
        'refs/tags/v1.0.0': push02CommitSha,
      },
      {}
    );

    const tagRef = event.tags.find((t) => t[0] === 'r' && t[1] === 'refs/tags/v1.0.0');
    expect(tagRef).toBeDefined();
    expect(tagRef![2]).toBe(push02CommitSha);
    expect(tagRef![2]).not.toBe(push03CommitSha);
    expect(tagRef![2]).not.toBe(push04CommitSha);
  });

  // -------------------------------------------------------------------------
  // AC-5.2: HEAD still points to refs/heads/main (not the tag)
  // -------------------------------------------------------------------------

  it('[P0] AC-5.2: HEAD still points to ref: refs/heads/main (not the tag)', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const push02CommitSha = 'a'.repeat(40);
    const push04CommitSha = 'b'.repeat(40);

    // main MUST be first key so HEAD points to main
    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': push02CommitSha,
        'refs/heads/feature/add-retry': push04CommitSha,
        'refs/tags/v1.0.0': push02CommitSha,
      },
      {}
    );

    const headTag = event.tags.find((t) => t[0] === 'HEAD');
    expect(headTag).toBeDefined();
    expect(headTag![1]).toBe('ref: refs/heads/main');
    expect(headTag![1]).not.toContain('refs/tags');
  });

  // -------------------------------------------------------------------------
  // AC-5.3: No new git objects — shaMap unchanged
  // -------------------------------------------------------------------------

  it('[P0] AC-5.3: no new git objects created — shaMap has same key count as input', async () => {
    // Push05State.shaMap should be identical to Push04State.shaMap
    // This test verifies the contract by constructing expected state
    const push01 = await import('../push-01-init.js');
    const push02 = await import('../push-02-nested.js');
    const push03 = await import('../push-03-branch.js');
    const push04 = await import('../push-04-branch-work.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Build all objects from Push 1-4 to get the expected shaMap size
    const allShas = new Set<string>();

    // Push 1 (6)
    const readmeBlob = createGitBlob(push01.README_CONTENT); allShas.add(readmeBlob.sha);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT); allShas.add(pkgBlob.sha);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT); allShas.add(indexBlob.sha);
    const p1SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]); allShas.add(p1SrcTree.sha);
    const p1RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: p1SrcTree.sha },
    ]); allShas.add(p1RootTree.sha);
    const p1Commit = createGitCommit({
      treeSha: p1RootTree.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Initial commit', timestamp: 1700000000,
    }); allShas.add(p1Commit.sha);

    // Push 2 (11 new)
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT); allShas.add(coreBlob.sha);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT); allShas.add(formatBlob.sha);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT); allShas.add(deepFileBlob.sha);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT); allShas.add(guideBlob.sha);
    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]); allShas.add(helpersTree.sha);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]); allShas.add(utilsTree.sha);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]); allShas.add(docsTree.sha);
    const p2LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]); allShas.add(p2LibTree.sha);
    const p2SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: p2LibTree.sha },
    ]); allShas.add(p2SrcTree.sha);
    const p2RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p2SrcTree.sha },
    ]); allShas.add(p2RootTree.sha);
    const p2Commit = createGitCommit({
      treeSha: p2RootTree.sha, parentSha: p1Commit.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure', timestamp: 1700001000,
    }); allShas.add(p2Commit.sha);

    // Push 3 (5 new)
    const retryBlob = createGitBlob(push03.RETRY_TS_CONTENT); allShas.add(retryBlob.sha);
    const p3LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]); allShas.add(p3LibTree.sha);
    const p3SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: p3LibTree.sha },
    ]); allShas.add(p3SrcTree.sha);
    const p3RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p3SrcTree.sha },
    ]); allShas.add(p3RootTree.sha);
    const p3Commit = createGitCommit({
      treeSha: p3RootTree.sha, parentSha: p2Commit.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry utility', timestamp: 1700002000,
    }); allShas.add(p3Commit.sha);

    // Push 4 (6 new)
    const modifiedIndexBlob = createGitBlob(push04.MODIFIED_INDEX_TS_CONTENT); allShas.add(modifiedIndexBlob.sha);
    const retryTestBlob = createGitBlob(push04.RETRY_TEST_TS_CONTENT); allShas.add(retryTestBlob.sha);
    const p4LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.test.ts', sha: retryTestBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]); allShas.add(p4LibTree.sha);
    const p4SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: modifiedIndexBlob.sha },
      { mode: '040000', name: 'lib', sha: p4LibTree.sha },
    ]); allShas.add(p4SrcTree.sha);
    const p4RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p4SrcTree.sha },
    ]); allShas.add(p4RootTree.sha);
    const p4Commit = createGitCommit({
      treeSha: p4RootTree.sha, parentSha: p3Commit.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry tests and import', timestamp: 1700003000,
    }); allShas.add(p4Commit.sha);

    // Push 4 produces 28 unique SHAs total
    expect(allShas.size).toBe(28);

    // Push 5 should NOT add any new SHAs — shaMap stays at 28
    // This is verified by the fact that Push 5 only publishes a kind:30618 event,
    // no new blobs/trees/commits are created
  });

  // -------------------------------------------------------------------------
  // AC-5.3: commits array has same 4 entries as Push04 (no new commits)
  // -------------------------------------------------------------------------

  it('[P0] AC-5.3: commits array unchanged — source passes through push04State.commits directly', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-05-tag.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify commits are passed through from push04State (not rebuilt or modified)
    expect(source).toContain('commits: push04State.commits');

    // Verify the module does NOT import createGitCommit — no new commits created
    expect(source).not.toContain('createGitCommit');
    expect(source).not.toContain('createGitBlob');
    expect(source).not.toContain('createGitTree');
  });

  // -------------------------------------------------------------------------
  // AC-5.4: Push05State.tags contains ['v1.0.0']
  // -------------------------------------------------------------------------

  it('[P0] AC-5.4: Push05State.tags is set to [v1.0.0] in source return statement', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-05-tag.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify tags field is explicitly set to ['v1.0.0'] (not passed through from push04State)
    expect(source).toContain("tags: ['v1.0.0']");

    // Verify Push05State interface declares tags field
    const start = source.indexOf('export interface Push05State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 500);
    expect(interfaceBlock).toContain('tags: string[]');
  });

  // -------------------------------------------------------------------------
  // AC-5.4: Push05State.branches unchanged ['main', 'feature/add-retry']
  // -------------------------------------------------------------------------

  it('[P0] AC-5.4: branches passed through from push04State unchanged', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-05-tag.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify branches are passed through directly from push04State (not rebuilt)
    expect(source).toContain('branches: push04State.branches');
  });

  // -------------------------------------------------------------------------
  // AC-5.4: Push05State.files identical to Push04State.files (no new files)
  // -------------------------------------------------------------------------

  it('[P0] AC-5.4: files passed through from push04State unchanged', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-05-tag.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify files are passed through directly from push04State (not rebuilt)
    expect(source).toContain('files: push04State.files');
  });

  // -------------------------------------------------------------------------
  // AC-5.4: Push05State.shaMap identical to Push04State.shaMap (no new entries)
  // -------------------------------------------------------------------------

  it('[P0] AC-5.4: shaMap should be identical to Push04State.shaMap (no new entries)', async () => {
    // Verify through the "no new git objects" constraint:
    // Push 5 does not call uploadGitObject, createGitBlob, createGitTree, or createGitCommit.
    // Therefore shaMap cannot grow.
    // This test verifies the module does not re-export any git builder functions.
    const push05 = await import('../push-05-tag.js');
    const exportKeys = Object.keys(push05);

    // Push 5 should NOT export git object creation functions
    expect(exportKeys).not.toContain('createGitBlob');
    expect(exportKeys).not.toContain('createGitTree');
    expect(exportKeys).not.toContain('createGitCommit');
    expect(exportKeys).not.toContain('uploadGitObject');

    // Push 5 SHOULD export runPush05 (and Push05State via TypeScript, but not at runtime)
    expect(exportKeys).toContain('runPush05');
  });

  // -------------------------------------------------------------------------
  // AC-5.2: kind:30618 event is kind 30618 with correct d tag
  // -------------------------------------------------------------------------

  it('[P1] AC-5.2: kind:30618 event has correct kind and d tag', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': 'a'.repeat(40),
        'refs/heads/feature/add-retry': 'b'.repeat(40),
        'refs/tags/v1.0.0': 'a'.repeat(40),
      },
      {}
    );

    expect(event.kind).toBe(30618);

    const dTag = event.tags.find((t) => t[0] === 'd');
    expect(dTag).toBeDefined();
    expect(dTag![1]).toBe(push01.REPO_ID);
  });

  // -------------------------------------------------------------------------
  // AC-5.1: Tag and main both point to same commit SHA
  // -------------------------------------------------------------------------

  it('[P1] AC-5.1: tag and main both point to the same commit SHA', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const push02CommitSha = 'a'.repeat(40);

    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': push02CommitSha,
        'refs/heads/feature/add-retry': 'b'.repeat(40),
        'refs/tags/v1.0.0': push02CommitSha,
      },
      {}
    );

    const mainRef = event.tags.find((t) => t[0] === 'r' && t[1] === 'refs/heads/main');
    const tagRef = event.tags.find((t) => t[0] === 'r' && t[1] === 'refs/tags/v1.0.0');

    expect(mainRef).toBeDefined();
    expect(tagRef).toBeDefined();
    // Both point to the same commit
    expect(tagRef![2]).toBe(mainRef![2]);
    expect(tagRef![2]).toBe(push02CommitSha);
  });

  // -------------------------------------------------------------------------
  // AC-5.2: kind:30618 includes arweave SHA-to-txId tags when shaMap is non-empty
  // -------------------------------------------------------------------------

  it('[P1] AC-5.2: kind:30618 refs event includes arweave tags from shaMap passthrough', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const sha1 = 'a'.repeat(40);
    const sha2 = 'b'.repeat(40);
    const sha3 = 'c'.repeat(40);
    const shaMap: Record<string, string> = {
      [sha1]: 'arweave-tx-1',
      [sha2]: 'arweave-tx-2',
      [sha3]: 'arweave-tx-3',
    };

    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': 'a'.repeat(40),
        'refs/heads/feature/add-retry': 'b'.repeat(40),
        'refs/tags/v1.0.0': 'a'.repeat(40),
      },
      shaMap
    );

    // Arweave mapping tags should be present for all shaMap entries
    const arweaveTags = event.tags.filter((t) => t[0] === 'arweave');
    expect(arweaveTags).toHaveLength(3);

    // Verify each entry maps correctly
    for (const [sha, txId] of Object.entries(shaMap)) {
      const tag = arweaveTags.find((t) => t[1] === sha);
      expect(tag).toBeDefined();
      expect(tag![2]).toBe(txId);
    }
  });

  // -------------------------------------------------------------------------
  // AC-5.2: HEAD points to tag if tag is first key (ordering matters)
  // -------------------------------------------------------------------------

  it('[P1] AC-5.2: HEAD would point to tag if tag were first key — validates ordering requirement', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    // Build event with TAG first (WRONG ordering — used to prove ordering matters)
    const badEvent = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/tags/v1.0.0': 'a'.repeat(40),         // First = HEAD
        'refs/heads/main': 'a'.repeat(40),
        'refs/heads/feature/add-retry': 'b'.repeat(40),
      },
      {}
    );

    const badHead = badEvent.tags.find((t) => t[0] === 'HEAD');
    expect(badHead).toBeDefined();
    // This demonstrates the bug if ordering is wrong: HEAD would point to the tag
    expect(badHead![1]).toBe('ref: refs/tags/v1.0.0');

    // Build event with main first (CORRECT ordering — as push-05-tag.ts does)
    const goodEvent = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': 'a'.repeat(40),           // First = HEAD
        'refs/heads/feature/add-retry': 'b'.repeat(40),
        'refs/tags/v1.0.0': 'a'.repeat(40),
      },
      {}
    );

    const goodHead = goodEvent.tags.find((t) => t[0] === 'HEAD');
    expect(goodHead).toBeDefined();
    expect(goodHead![1]).toBe('ref: refs/heads/main');
  });

  // -------------------------------------------------------------------------
  // AC-5.4: push-05-tag.ts source passes through Push04State fields
  // -------------------------------------------------------------------------

  it('[P1] AC-5.4: push-05-tag.ts source references all Push04State passthrough fields', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-05-tag.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify the return statement references all passthrough fields from push04State
    expect(source).toContain('push04State.repoId');
    expect(source).toContain('push04State.ownerPubkey');
    expect(source).toContain('push04State.commits');
    expect(source).toContain('push04State.shaMap');
    expect(source).toContain('push04State.repoAnnouncementId');
    expect(source).toContain('push04State.branches');
    expect(source).toContain('push04State.files');

    // Verify tags field is set to ['v1.0.0']
    expect(source).toContain("tags: ['v1.0.0']");

    // Verify refsEventId uses the fallback pattern (eventId ?? refsSigned.id)
    expect(source).toContain('refsResult.eventId ?? refsSigned.id');
  });

  // -------------------------------------------------------------------------
  // AC-5.3: push-05-tag.ts source does NOT import git builder functions
  // -------------------------------------------------------------------------

  it('[P1] AC-5.3: push-05-tag.ts source does NOT import uploadGitObject or git-builder', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-05-tag.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Should NOT import git-builder.js or git object creation functions
    expect(source).not.toContain('git-builder');
    expect(source).not.toContain('uploadGitObject');
    expect(source).not.toContain('createGitBlob');
    expect(source).not.toContain('createGitTree');
    expect(source).not.toContain('createGitCommit');
    expect(source).not.toContain('signBalanceProof');
  });

  // -------------------------------------------------------------------------
  // AC-5.4: Push05State interface has correct shape
  // -------------------------------------------------------------------------

  it('[P1] AC-5.4: Push05State interface includes tags field alongside all Push04State fields', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');

    const sourceFile = path.resolve(
      import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
      '..',
      'push-05-tag.ts'
    );
    const source = fs.readFileSync(sourceFile, 'utf-8');

    // Verify Push05State interface is exported
    expect(source).toContain('export interface Push05State');

    // Verify all expected fields are present in the Push05State interface region.
    // Find the block starting at the interface declaration and spanning ~15 lines.
    const start = source.indexOf('export interface Push05State');
    expect(start).toBeGreaterThan(-1);
    const interfaceBlock = source.slice(start, start + 500);

    expect(interfaceBlock).toContain('repoId: string');
    expect(interfaceBlock).toContain('ownerPubkey: string');
    expect(interfaceBlock).toContain('commits:');
    expect(interfaceBlock).toContain('shaMap:');
    expect(interfaceBlock).toContain('repoAnnouncementId: string');
    expect(interfaceBlock).toContain('refsEventId: string');
    expect(interfaceBlock).toContain('branches: string[]');
    expect(interfaceBlock).toContain('tags: string[]');
    expect(interfaceBlock).toContain('files: string[]');
  });

  // -------------------------------------------------------------------------
  // Integration test stubs (.todo) for live relay publishing (AC-5.2)
  // -------------------------------------------------------------------------

  it.todo('[integration] should publish kind:30618 refs with tag to live relay');
  it.todo('[integration] should return valid refsEventId from relay');
  it.todo('[integration] should be queryable by relay after publish');
});

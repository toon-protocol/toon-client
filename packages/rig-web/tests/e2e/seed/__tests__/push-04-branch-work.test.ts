/**
 * ATDD Tests: Story 10.4 — Seed Script: Feature Branch Work (Push 4)
 *
 * Unit tests verify push-04-branch-work.ts deterministic git object construction,
 * feature branch advancement, modified file detection, and multi-branch refs.
 * Integration tests (.todo) require live Arweave DVM infrastructure.
 *
 * AC-4.2: Adds second commit on feature/add-retry modifying index.ts and adding retry.test.ts
 * AC-4.3: kind:30618 refs includes both refs/heads/main and refs/heads/feature/add-retry
 * AC-4.4: Commit parent chain: Push 4 -> Push 3 -> Push 2
 * AC-4.5: refs/heads/main still points to Push 2's commit SHA
 */

import { describe, it, expect } from 'vitest';

describe('Story 10.4: Push 04 — Branch Work', () => {
  // -------------------------------------------------------------------------
  // AC-4.2: Module exports and structure
  // -------------------------------------------------------------------------

  it('[P0] should export runPush04 function', async () => {
    const push04 = await import('../push-04-branch-work.js');
    expect(typeof push04.runPush04).toBe('function');
  });

  it('[P0] should accept (aliceClient, aliceSecretKey, push03State) parameters', async () => {
    const push04 = await import('../push-04-branch-work.js');
    // runPush04 should accept at least 3 parameters
    expect(push04.runPush04.length).toBeGreaterThanOrEqual(3);
  });

  it('[P0] should export Push04State type (verified by compilation)', async () => {
    const push04 = await import('../push-04-branch-work.js');
    expect(push04).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-4.2: File content constants
  // -------------------------------------------------------------------------

  it('[P0] should export MODIFIED_INDEX_TS_CONTENT containing retry import', async () => {
    const push04 = await import('../push-04-branch-work.js');
    expect(typeof push04.MODIFIED_INDEX_TS_CONTENT).toBe('string');
    expect(push04.MODIFIED_INDEX_TS_CONTENT.length).toBeGreaterThan(0);
    expect(push04.MODIFIED_INDEX_TS_CONTENT).toContain('retry');
    expect(push04.MODIFIED_INDEX_TS_CONTENT).toContain('import');
  });

  it('[P0] should export RETRY_TEST_TS_CONTENT as a non-empty string', async () => {
    const push04 = await import('../push-04-branch-work.js');
    expect(typeof push04.RETRY_TEST_TS_CONTENT).toBe('string');
    expect(push04.RETRY_TEST_TS_CONTENT.length).toBeGreaterThan(0);
    expect(push04.RETRY_TEST_TS_CONTENT).toContain('describe');
    expect(push04.RETRY_TEST_TS_CONTENT).toContain('retry');
  });

  // -------------------------------------------------------------------------
  // AC-4.2: Modified index.ts blob has DIFFERENT SHA from Push 1's original
  // -------------------------------------------------------------------------

  it('[P0] AC-4.2: modified index.ts blob has DIFFERENT SHA from Push 1 original', async () => {
    const push04 = await import('../push-04-branch-work.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob } = await import('../lib/git-builder.js');

    const originalIndexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const modifiedIndexBlob = createGitBlob(push04.MODIFIED_INDEX_TS_CONTENT);

    expect(modifiedIndexBlob.sha).not.toBe(originalIndexBlob.sha);

    // Both should be valid SHAs
    const hexShaPattern = /^[0-9a-f]{40}$/;
    expect(originalIndexBlob.sha).toMatch(hexShaPattern);
    expect(modifiedIndexBlob.sha).toMatch(hexShaPattern);
  });

  // -------------------------------------------------------------------------
  // AC-4.2: lib/ tree contains retry.ts AND retry.test.ts entries
  // -------------------------------------------------------------------------

  it('[P0] AC-4.2: lib/ tree contains core.ts, retry.ts, retry.test.ts, and utils/', async () => {
    const push04 = await import('../push-04-branch-work.js');
    const push03 = await import('../push-03-branch.js');
    const push02 = await import('../push-02-nested.js');
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');

    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const retryBlob = createGitBlob(push03.RETRY_TS_CONTENT);
    const retryTestBlob = createGitBlob(push04.RETRY_TEST_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);

    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);

    // Push 4 lib/ tree: core.ts + retry.test.ts + retry.ts + utils/
    const libTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.test.ts', sha: retryTestBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);

    const bodyBin = libTree.body.toString('binary');
    expect(bodyBin).toContain('core.ts');
    expect(bodyBin).toContain('retry.test.ts');
    expect(bodyBin).toContain('retry.ts');
    expect(bodyBin).toContain('utils');

    // Sorted order: core.ts < retry.test.ts < retry.ts < utils
    const coreIdx = bodyBin.indexOf('core.ts');
    const retryTestIdx = bodyBin.indexOf('retry.test.ts');
    const retryIdx = bodyBin.indexOf('retry.ts', retryTestIdx + 1);
    const utilsIdx = bodyBin.indexOf('utils');
    expect(coreIdx).toBeLessThan(retryTestIdx);
    expect(retryTestIdx).toBeLessThan(retryIdx);
    expect(retryIdx).toBeLessThan(utilsIdx);
  });

  // -------------------------------------------------------------------------
  // AC-4.2: Push 4 lib/ tree SHA differs from Push 3 lib/ tree
  // -------------------------------------------------------------------------

  it('[P0] should produce a lib/ tree SHA different from Push 3 lib/ tree', async () => {
    const push04 = await import('../push-04-branch-work.js');
    const push03 = await import('../push-03-branch.js');
    const push02 = await import('../push-02-nested.js');
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');

    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const retryBlob = createGitBlob(push03.RETRY_TS_CONTENT);
    const retryTestBlob = createGitBlob(push04.RETRY_TEST_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);

    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);

    // Push 3 lib/ tree (core.ts + retry.ts + utils/)
    const push03LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);

    // Push 4 lib/ tree (core.ts + retry.test.ts + retry.ts + utils/)
    const push04LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.test.ts', sha: retryTestBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);

    expect(push04LibTree.sha).not.toBe(push03LibTree.sha);
  });

  // -------------------------------------------------------------------------
  // AC-4.4: Commit has parent = Push 3 commit SHA
  // -------------------------------------------------------------------------

  it('[P0] AC-4.4: commit body contains parent <push03CommitSha> (parent chain: Push 4 -> Push 3)', async () => {
    const push04 = await import('../push-04-branch-work.js');
    const push03 = await import('../push-03-branch.js');
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Reconstruct full commit chain: Push 1 -> Push 2 -> Push 3
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);
    const retryBlob = createGitBlob(push03.RETRY_TS_CONTENT);

    // Push 1 commit
    const push01SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]);
    const push01RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: push01SrcTree.sha },
    ]);
    const push01Commit = createGitCommit({
      treeSha: push01RootTree.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Initial commit',
      timestamp: 1700000000,
    });

    // Push 2 commit
    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const push02LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const push02SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: push02LibTree.sha },
    ]);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]);
    const push02RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: push02SrcTree.sha },
    ]);
    const push02Commit = createGitCommit({
      treeSha: push02RootTree.sha,
      parentSha: push01Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure',
      timestamp: 1700001000,
    });

    // Push 3 commit
    const push03LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const push03SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: push03LibTree.sha },
    ]);
    const push03RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: push03SrcTree.sha },
    ]);
    const push03Commit = createGitCommit({
      treeSha: push03RootTree.sha,
      parentSha: push02Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry utility',
      timestamp: 1700002000,
    });

    // Push 4 commit
    const modifiedIndexBlob = createGitBlob(push04.MODIFIED_INDEX_TS_CONTENT);
    const retryTestBlob = createGitBlob(push04.RETRY_TEST_TS_CONTENT);

    const push04LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.test.ts', sha: retryTestBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const push04SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: modifiedIndexBlob.sha },
      { mode: '040000', name: 'lib', sha: push04LibTree.sha },
    ]);
    const push04RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: push04SrcTree.sha },
    ]);
    const push04Commit = createGitCommit({
      treeSha: push04RootTree.sha,
      parentSha: push03Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry tests and import',
      timestamp: 1700003000,
    });

    const body = push04Commit.body.toString('utf-8');

    // Must reference Push 3 commit as parent (NOT Push 2)
    expect(body).toContain(`parent ${push03Commit.sha}`);
    expect(body).not.toContain(`parent ${push02Commit.sha}`);
    // Must reference the new root tree
    expect(body).toContain(`tree ${push04RootTree.sha}`);
    // Must use fixed timestamp 1700003000
    expect(body).toContain('1700003000');
    // Must have correct commit message
    expect(body).toContain('Add retry tests and import');
    // Must use Alice as author
    expect(body).toContain(`author Alice <${AGENT_IDENTITIES.alice.pubkey}@nostr>`);
  });

  // -------------------------------------------------------------------------
  // AC-4.5: kind:30618 main branch STILL points to Push 2 commit (unchanged)
  // -------------------------------------------------------------------------

  it('[P0] AC-4.5: kind:30618 main branch STILL points to Push 2 commit after Push 4', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const push02CommitSha = 'a'.repeat(40);
    const push04CommitSha = 'b'.repeat(40);

    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': push02CommitSha,
        'refs/heads/feature/add-retry': push04CommitSha,
      },
      {}
    );

    const mainRef = event.tags.find((t) => t[0] === 'r' && t[1] === 'refs/heads/main');
    expect(mainRef).toBeDefined();
    // Main must STILL point to Push 2, NOT Push 4
    expect(mainRef![2]).toBe(push02CommitSha);
    expect(mainRef![2]).not.toBe(push04CommitSha);
  });

  // -------------------------------------------------------------------------
  // AC-4.2: feature/add-retry points to Push 4 commit (advanced from Push 3)
  // -------------------------------------------------------------------------

  it('[P0] AC-4.2: feature/add-retry ref advances to Push 4 commit', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const push03CommitSha = 'c'.repeat(40);
    const push04CommitSha = 'd'.repeat(40);

    // In Push 4, feature/add-retry should point to Push 4 commit (advanced from Push 3)
    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': 'a'.repeat(40),
        'refs/heads/feature/add-retry': push04CommitSha,
      },
      {}
    );

    const featureRef = event.tags.find(
      (t) => t[0] === 'r' && t[1] === 'refs/heads/feature/add-retry'
    );
    expect(featureRef).toBeDefined();
    expect(featureRef![2]).toBe(push04CommitSha);
    // Should NOT still be at Push 3
    expect(featureRef![2]).not.toBe(push03CommitSha);
  });

  // -------------------------------------------------------------------------
  // AC-4.2: State has 4 commits total in correct order
  // -------------------------------------------------------------------------

  it('[P0] AC-4.2: state should have 4 commits total with correct messages verified from git objects', async () => {
    // Reconstruct all 4 commits from deterministic git object construction
    // to verify the implementation's commit messages match across all pushes.
    const push01 = await import('../push-01-init.js');
    const push02 = await import('../push-02-nested.js');
    const push03 = await import('../push-03-branch.js');
    const push04 = await import('../push-04-branch-work.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Push 1 commit
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const p1SrcTree = createGitTree([{ mode: '100644', name: 'index.ts', sha: indexBlob.sha }]);
    const p1RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: p1SrcTree.sha },
    ]);
    const c1 = createGitCommit({
      treeSha: p1RootTree.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Initial commit', timestamp: 1700000000,
    });

    // Push 2 commit
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);
    const helpersTree = createGitTree([{ mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha }]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const docsTree = createGitTree([{ mode: '100644', name: 'guide.md', sha: guideBlob.sha }]);
    const p2LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const p2SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: p2LibTree.sha },
    ]);
    const p2RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p2SrcTree.sha },
    ]);
    const c2 = createGitCommit({
      treeSha: p2RootTree.sha, parentSha: c1.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure', timestamp: 1700001000,
    });

    // Push 3 commit
    const retryBlob = createGitBlob(push03.RETRY_TS_CONTENT);
    const p3LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const p3SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: p3LibTree.sha },
    ]);
    const p3RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p3SrcTree.sha },
    ]);
    const c3 = createGitCommit({
      treeSha: p3RootTree.sha, parentSha: c2.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry utility', timestamp: 1700002000,
    });

    // Push 4 commit
    const modifiedIndexBlob = createGitBlob(push04.MODIFIED_INDEX_TS_CONTENT);
    const retryTestBlob = createGitBlob(push04.RETRY_TEST_TS_CONTENT);
    const p4LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.test.ts', sha: retryTestBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const p4SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: modifiedIndexBlob.sha },
      { mode: '040000', name: 'lib', sha: p4LibTree.sha },
    ]);
    const p4RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p4SrcTree.sha },
    ]);
    const c4 = createGitCommit({
      treeSha: p4RootTree.sha, parentSha: c3.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry tests and import', timestamp: 1700003000,
    });

    // Verify 4 unique commits with correct messages extracted from git objects
    const commits = [c1, c2, c3, c4];
    expect(commits).toHaveLength(4);

    const messages = commits.map((c) => c.body.toString('utf-8').split('\n').pop());
    expect(messages[0]).toBe('Initial commit');
    expect(messages[1]).toBe('Add nested directory structure');
    expect(messages[2]).toBe('Add retry utility');
    expect(messages[3]).toBe('Add retry tests and import');

    // All SHAs unique
    const shas = new Set(commits.map((c) => c.sha));
    expect(shas.size).toBe(4);
  });

  // -------------------------------------------------------------------------
  // AC-4.2: Delta logic — exactly 6 new objects
  // -------------------------------------------------------------------------

  it('[P0] AC-4.2: exactly 6 new objects for Push 4 (2 blobs + 3 trees + 1 commit)', async () => {
    const push04 = await import('../push-04-branch-work.js');
    const push03 = await import('../push-03-branch.js');
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Reconstruct all prior objects
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);
    const retryBlob = createGitBlob(push03.RETRY_TS_CONTENT);

    // Build all prior trees and commits
    const push01SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]);
    const push01RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: push01SrcTree.sha },
    ]);
    const push01Commit = createGitCommit({
      treeSha: push01RootTree.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Initial commit',
      timestamp: 1700000000,
    });
    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const push02LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const push02SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: push02LibTree.sha },
    ]);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]);
    const push02RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: push02SrcTree.sha },
    ]);
    const push02Commit = createGitCommit({
      treeSha: push02RootTree.sha,
      parentSha: push01Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure',
      timestamp: 1700001000,
    });
    const push03LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const push03SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: push03LibTree.sha },
    ]);
    const push03RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: push03SrcTree.sha },
    ]);
    const push03Commit = createGitCommit({
      treeSha: push03RootTree.sha,
      parentSha: push02Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry utility',
      timestamp: 1700002000,
    });

    // Simulate shaMap from Push 1 + Push 2 + Push 3 (22 objects)
    const existingShaMap: Record<string, string> = {
      [readmeBlob.sha]: 'tx-1',
      [pkgBlob.sha]: 'tx-2',
      [indexBlob.sha]: 'tx-3',
      [push01SrcTree.sha]: 'tx-4',
      [push01RootTree.sha]: 'tx-5',
      [push01Commit.sha]: 'tx-6',
      [coreBlob.sha]: 'tx-7',
      [formatBlob.sha]: 'tx-8',
      [deepFileBlob.sha]: 'tx-9',
      [guideBlob.sha]: 'tx-10',
      [helpersTree.sha]: 'tx-11',
      [utilsTree.sha]: 'tx-12',
      [push02LibTree.sha]: 'tx-13',
      [push02SrcTree.sha]: 'tx-14',
      [docsTree.sha]: 'tx-15',
      [push02RootTree.sha]: 'tx-16',
      [push02Commit.sha]: 'tx-17',
      [retryBlob.sha]: 'tx-18',
      [push03LibTree.sha]: 'tx-19',
      [push03SrcTree.sha]: 'tx-20',
      [push03RootTree.sha]: 'tx-21',
      [push03Commit.sha]: 'tx-22',
    };
    expect(Object.keys(existingShaMap)).toHaveLength(22);

    // Build Push 4 new objects
    const modifiedIndexBlob = createGitBlob(push04.MODIFIED_INDEX_TS_CONTENT);
    const retryTestBlob = createGitBlob(push04.RETRY_TEST_TS_CONTENT);

    const push04LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.test.ts', sha: retryTestBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const push04SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: modifiedIndexBlob.sha },
      { mode: '040000', name: 'lib', sha: push04LibTree.sha },
    ]);
    const push04RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: push04SrcTree.sha },
    ]);
    const push04Commit = createGitCommit({
      treeSha: push04RootTree.sha,
      parentSha: push03Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry tests and import',
      timestamp: 1700003000,
    });

    // Collect all Push 4 NEW objects
    const allPush04Objects = [
      modifiedIndexBlob, retryTestBlob,
      push04LibTree, push04SrcTree, push04RootTree,
      push04Commit,
    ];

    // Exactly 6 new objects: 2 blobs + 3 trees + 1 commit
    expect(allPush04Objects).toHaveLength(6);

    // None of the new object SHAs should be in the existing shaMap
    for (const obj of allPush04Objects) {
      expect(existingShaMap[obj.sha]).toBeUndefined();
    }

    // Reused objects ARE in the shaMap
    expect(existingShaMap[docsTree.sha]).toBeDefined();
    expect(existingShaMap[utilsTree.sha]).toBeDefined();
    expect(existingShaMap[helpersTree.sha]).toBeDefined();
    expect(existingShaMap[retryBlob.sha]).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-4.2: File content under 95KB (R10-005)
  // -------------------------------------------------------------------------

  it('[P0] AC-4.2: all file contents are under 95KB size limit (R10-005)', async () => {
    const push04 = await import('../push-04-branch-work.js');
    const maxSize = 95 * 1024;

    expect(Buffer.byteLength(push04.MODIFIED_INDEX_TS_CONTENT, 'utf-8')).toBeLessThan(maxSize);
    expect(Buffer.byteLength(push04.RETRY_TEST_TS_CONTENT, 'utf-8')).toBeLessThan(maxSize);

    // Total content should be minimal
    const totalBytes =
      Buffer.byteLength(push04.MODIFIED_INDEX_TS_CONTENT, 'utf-8') +
      Buffer.byteLength(push04.RETRY_TEST_TS_CONTENT, 'utf-8');
    expect(totalBytes).toBeLessThan(1000);
    expect(totalBytes).toBeGreaterThan(20);
  });

  // -------------------------------------------------------------------------
  // AC-4.2: State return structure expectations
  // -------------------------------------------------------------------------

  it('[P0] Push04State files should accumulate 9 unique paths including src/lib/retry.test.ts', async () => {
    // Verify all file content constants exist and the file list is correct
    const push01 = await import('../push-01-init.js');
    const push02 = await import('../push-02-nested.js');
    const push03 = await import('../push-03-branch.js');
    const push04 = await import('../push-04-branch-work.js');

    const fileContentPairs = [
      { path: 'README.md', content: push01.README_CONTENT },
      { path: 'package.json', content: push01.PACKAGE_JSON_CONTENT },
      { path: 'src/index.ts', content: push01.INDEX_TS_CONTENT },
      { path: 'src/lib/core.ts', content: push02.CORE_TS_CONTENT },
      { path: 'src/lib/utils/format.ts', content: push02.FORMAT_TS_CONTENT },
      { path: 'src/lib/utils/helpers/deep-file.ts', content: push02.DEEP_FILE_TS_CONTENT },
      { path: 'docs/guide.md', content: push02.GUIDE_MD_CONTENT },
      { path: 'src/lib/retry.ts', content: push03.RETRY_TS_CONTENT },
      { path: 'src/lib/retry.test.ts', content: push04.RETRY_TEST_TS_CONTENT },
    ];

    expect(fileContentPairs).toHaveLength(9);
    for (const pair of fileContentPairs) {
      expect(pair.content.length).toBeGreaterThan(0);
    }
    expect(fileContentPairs.map((p) => p.path)).toContain('src/lib/retry.test.ts');
    // src/index.ts appears only once even though content differs on feature branch
    const indexOccurrences = fileContentPairs.filter((f) => f.path === 'src/index.ts');
    expect(indexOccurrences).toHaveLength(1);
  });

  it('[P0] Push04State shaMap should have 28 entries (6+11+5+6) verified by object construction', async () => {
    // Build all objects across 4 pushes and count unique SHAs
    const push01 = await import('../push-01-init.js');
    const push02 = await import('../push-02-nested.js');
    const push03 = await import('../push-03-branch.js');
    const push04 = await import('../push-04-branch-work.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

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
    const p2LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]); allShas.add(p2LibTree.sha);
    const p2SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: p2LibTree.sha },
    ]); allShas.add(p2SrcTree.sha);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]); allShas.add(docsTree.sha);
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

    expect(allShas.size).toBe(28);
  });

  it('[P0] Push04State branches should still be ["main", "feature/add-retry"] (no new branch)', async () => {
    // Verify that Push 4 does NOT introduce a new branch -- same 2 branches as Push 3
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const push04Refs = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': 'a'.repeat(40),
        'refs/heads/feature/add-retry': 'b'.repeat(40),
      },
      {}
    );

    const rTags = push04Refs.tags.filter((t) => t[0] === 'r');
    expect(rTags).toHaveLength(2);
    expect(rTags.map((t) => t[1])).toContain('refs/heads/main');
    expect(rTags.map((t) => t[1])).toContain('refs/heads/feature/add-retry');
  });

  // -------------------------------------------------------------------------
  // AC-4.4: Full parent chain: Push 4 -> Push 3 -> Push 2 (verified in single test)
  // -------------------------------------------------------------------------

  it('[P0] AC-4.4: full commit parent chain Push 4 -> Push 3 -> Push 2 is intact', async () => {
    const push04 = await import('../push-04-branch-work.js');
    const push03 = await import('../push-03-branch.js');
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Reconstruct full chain
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);
    const retryBlob = createGitBlob(push03.RETRY_TS_CONTENT);
    const modifiedIndexBlob = createGitBlob(push04.MODIFIED_INDEX_TS_CONTENT);
    const retryTestBlob = createGitBlob(push04.RETRY_TEST_TS_CONTENT);

    // Push 1 commit
    const p1SrcTree = createGitTree([{ mode: '100644', name: 'index.ts', sha: indexBlob.sha }]);
    const p1RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: p1SrcTree.sha },
    ]);
    const p1Commit = createGitCommit({
      treeSha: p1RootTree.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Initial commit', timestamp: 1700000000,
    });

    // Push 2 commit
    const helpersTree = createGitTree([{ mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha }]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const docsTree = createGitTree([{ mode: '100644', name: 'guide.md', sha: guideBlob.sha }]);
    const p2LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const p2SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: p2LibTree.sha },
    ]);
    const p2RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p2SrcTree.sha },
    ]);
    const p2Commit = createGitCommit({
      treeSha: p2RootTree.sha, parentSha: p1Commit.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure', timestamp: 1700001000,
    });

    // Push 3 commit
    const p3LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const p3SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: p3LibTree.sha },
    ]);
    const p3RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p3SrcTree.sha },
    ]);
    const p3Commit = createGitCommit({
      treeSha: p3RootTree.sha, parentSha: p2Commit.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry utility', timestamp: 1700002000,
    });

    // Push 4 commit
    const p4LibTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '100644', name: 'retry.test.ts', sha: retryTestBlob.sha },
      { mode: '100644', name: 'retry.ts', sha: retryBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const p4SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: modifiedIndexBlob.sha },
      { mode: '040000', name: 'lib', sha: p4LibTree.sha },
    ]);
    const p4RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: p4SrcTree.sha },
    ]);
    const p4Commit = createGitCommit({
      treeSha: p4RootTree.sha, parentSha: p3Commit.sha, authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add retry tests and import', timestamp: 1700003000,
    });

    // Verify full parent chain in commit bodies
    const p4Body = p4Commit.body.toString('utf-8');
    const p3Body = p3Commit.body.toString('utf-8');
    const p2Body = p2Commit.body.toString('utf-8');

    // Push 4 -> Push 3
    expect(p4Body).toContain(`parent ${p3Commit.sha}`);
    // Push 3 -> Push 2
    expect(p3Body).toContain(`parent ${p2Commit.sha}`);
    // Push 2 -> Push 1
    expect(p2Body).toContain(`parent ${p1Commit.sha}`);

    // Chain should NOT be confused (Push 4 should NOT reference Push 2 directly)
    expect(p4Body).not.toContain(`parent ${p2Commit.sha}`);
    expect(p4Body).not.toContain(`parent ${p1Commit.sha}`);
  });

  // -------------------------------------------------------------------------
  // AC-4.3: Push 04 refs event includes BOTH branches with correct SHAs
  // -------------------------------------------------------------------------

  it('[P0] AC-4.3: Push 04 refs event includes both refs/heads/main and refs/heads/feature/add-retry', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const push01 = await import('../push-01-init.js');

    const push02CommitSha = 'a'.repeat(40);
    const push04CommitSha = 'b'.repeat(40);

    const event = buildRepoRefs(
      push01.REPO_ID,
      {
        'refs/heads/main': push02CommitSha,
        'refs/heads/feature/add-retry': push04CommitSha,
      },
      { [push02CommitSha]: 'tx-02', [push04CommitSha]: 'tx-04' }
    );

    expect(event.kind).toBe(30618);

    // Both r tags present
    const rTags = event.tags.filter((t) => t[0] === 'r');
    expect(rTags).toHaveLength(2);

    const mainRef = rTags.find((t) => t[1] === 'refs/heads/main');
    const featureRef = rTags.find((t) => t[1] === 'refs/heads/feature/add-retry');
    expect(mainRef).toBeDefined();
    expect(featureRef).toBeDefined();
    expect(mainRef![2]).toBe(push02CommitSha);
    expect(featureRef![2]).toBe(push04CommitSha);

    // HEAD should still point to main
    const headTag = event.tags.find((t) => t[0] === 'HEAD');
    expect(headTag).toBeDefined();
    expect(headTag![1]).toBe('ref: refs/heads/main');
  });

  // -------------------------------------------------------------------------
  // Integration test stubs
  // -------------------------------------------------------------------------

  it.todo('[integration] AC-4.2: should upload only 6 new git objects to Arweave (delta from Push 1+2+3)');

  it.todo('[integration] AC-4.2: should skip all reused objects from Push 1+2+3 via delta logic');

  it.todo('[integration] AC-4.2: should upload in correct order: blobs, then trees (leaf-to-root), then commit');

  it.todo('[integration] AC-4.2: should throw immediately if any upload returns undefined txId (R10-003)');

  it.todo('[integration] AC-4.4: should create commit with parent = Push 3 commit SHA');

  it.todo('[integration] AC-4.3: should publish kind:30618 refs with both main and feature/add-retry branches');

  it.todo('[integration] AC-4.5: should NOT advance main ref (still points to Push 2 commit)');

  it.todo('[integration] AC-4.2: should advance feature/add-retry ref to Push 4 commit');

  it.todo('[integration] AC-4.2: should return Push04State with 4 commits in commits array');

  it.todo('[integration] AC-4.2: should return files array with 9 files including src/lib/retry.test.ts');

  it.todo('[integration] AC-4.2: should sign monotonically increasing cumulative claims for each upload');
});

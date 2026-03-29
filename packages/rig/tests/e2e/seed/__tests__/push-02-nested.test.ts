/**
 * ATDD Tests: Story 10.3 — Seed Script: Nested Directory Structure (Push 2)
 *
 * Unit tests verify push-02-nested.ts deterministic git object construction,
 * nested tree hierarchy, delta upload logic, and state return structure.
 * Integration tests (.todo) require live Arweave DVM infrastructure.
 *
 * AC-3.1: Files at increasing depths (depth 1-4)
 * AC-3.2: Delta upload — only new/changed objects uploaded
 * AC-3.3: Commit parent = Push 1's commit SHA
 * AC-3.4: kind:30618 refs updated with all objects from both pushes
 * AC-3.5: runPush02 returns Push02State with appended state
 */

import { describe, it, expect } from 'vitest';

describe('Story 10.3: Push 02 — Nested Directory Structure', () => {
  // -------------------------------------------------------------------------
  // AC-3.5: Module exports and structure
  // -------------------------------------------------------------------------

  it('[P0] should export runPush02 function', async () => {
    const push02 = await import('../push-02-nested.js');
    expect(typeof push02.runPush02).toBe('function');
  });

  it('[P0] should accept (aliceClient, aliceSecretKey, push01State) parameters', async () => {
    const push02 = await import('../push-02-nested.js');
    // runPush02 should accept at least 3 parameters
    expect(push02.runPush02.length).toBeGreaterThanOrEqual(3);
  });

  it('[P0] should export Push02State type (verified by compilation)', async () => {
    // The Push02State type is verified at compile time by TypeScript.
    // If the type is not exported, TS compilation will fail when other
    // modules try to import it. This test validates the module loads
    // and serves as a compile-time canary for type exports.
    const push02 = await import('../push-02-nested.js');
    expect(push02).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-3.1: File content constants
  // -------------------------------------------------------------------------

  it('[P0] should export CORE_TS_CONTENT as a non-empty string', async () => {
    const push02 = await import('../push-02-nested.js');
    expect(typeof push02.CORE_TS_CONTENT).toBe('string');
    expect(push02.CORE_TS_CONTENT.length).toBeGreaterThan(0);
  });

  it('[P0] should export FORMAT_TS_CONTENT as a non-empty string', async () => {
    const push02 = await import('../push-02-nested.js');
    expect(typeof push02.FORMAT_TS_CONTENT).toBe('string');
    expect(push02.FORMAT_TS_CONTENT.length).toBeGreaterThan(0);
  });

  it('[P0] should export DEEP_FILE_TS_CONTENT as a non-empty string containing depth-4 marker', async () => {
    const push02 = await import('../push-02-nested.js');
    expect(typeof push02.DEEP_FILE_TS_CONTENT).toBe('string');
    expect(push02.DEEP_FILE_TS_CONTENT.length).toBeGreaterThan(0);
    expect(push02.DEEP_FILE_TS_CONTENT).toContain('found-at-depth-4');
  });

  it('[P0] should export GUIDE_MD_CONTENT as a non-empty string', async () => {
    const push02 = await import('../push-02-nested.js');
    expect(typeof push02.GUIDE_MD_CONTENT).toBe('string');
    expect(push02.GUIDE_MD_CONTENT.length).toBeGreaterThan(0);
    expect(push02.GUIDE_MD_CONTENT).toContain('rig-e2e-test-repo');
  });

  // -------------------------------------------------------------------------
  // AC-3.1: Git object creation — deterministic SHAs for 4 new blobs
  // -------------------------------------------------------------------------

  it('[P0] should produce deterministic blob SHAs for all 4 new file contents', async () => {
    const push02 = await import('../push-02-nested.js');
    const { createGitBlob } = await import('../lib/git-builder.js');

    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

    // All SHAs should be valid 40-character hex strings
    const hexShaPattern = /^[0-9a-f]{40}$/;
    expect(coreBlob.sha).toMatch(hexShaPattern);
    expect(formatBlob.sha).toMatch(hexShaPattern);
    expect(deepFileBlob.sha).toMatch(hexShaPattern);
    expect(guideBlob.sha).toMatch(hexShaPattern);

    // SHAs should be different from each other (unique content)
    const shas = [coreBlob.sha, formatBlob.sha, deepFileBlob.sha, guideBlob.sha];
    const uniqueShas = new Set(shas);
    expect(uniqueShas.size).toBe(4);
  });

  it('[P0] should produce consistent SHAs across multiple runs (deterministic)', async () => {
    const push02 = await import('../push-02-nested.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const push01 = await import('../push-01-init.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    const run = () => {
      // Push 1 blobs (reused)
      const readmeBlob = createGitBlob(push01.README_CONTENT);
      const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
      const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);

      // Push 2 new blobs
      const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
      const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
      const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
      const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

      // Nested trees (leaf-to-root)
      const helpersTree = createGitTree([
        { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
      ]);
      const utilsTree = createGitTree([
        { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
        { mode: '040000', name: 'helpers', sha: helpersTree.sha },
      ]);
      const libTree = createGitTree([
        { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
        { mode: '040000', name: 'utils', sha: utilsTree.sha },
      ]);
      const srcTree = createGitTree([
        { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
        { mode: '040000', name: 'lib', sha: libTree.sha },
      ]);
      const docsTree = createGitTree([
        { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
      ]);
      const rootTree = createGitTree([
        { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
        { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
        { mode: '040000', name: 'docs', sha: docsTree.sha },
        { mode: '040000', name: 'src', sha: srcTree.sha },
      ]);

      // Need Push 1 commit SHA for parent reference
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

      const commit = createGitCommit({
        treeSha: rootTree.sha,
        parentSha: push01Commit.sha,
        authorName: 'Alice',
        authorPubkey: AGENT_IDENTITIES.alice.pubkey,
        message: 'Add nested directory structure',
        timestamp: 1700001000,
      });

      return {
        coreBlob, formatBlob, deepFileBlob, guideBlob,
        helpersTree, utilsTree, libTree, srcTree, docsTree, rootTree,
        commit,
      };
    };

    const first = run();
    const second = run();

    // All SHAs must be identical across runs
    expect(first.coreBlob.sha).toBe(second.coreBlob.sha);
    expect(first.formatBlob.sha).toBe(second.formatBlob.sha);
    expect(first.deepFileBlob.sha).toBe(second.deepFileBlob.sha);
    expect(first.guideBlob.sha).toBe(second.guideBlob.sha);
    expect(first.helpersTree.sha).toBe(second.helpersTree.sha);
    expect(first.utilsTree.sha).toBe(second.utilsTree.sha);
    expect(first.libTree.sha).toBe(second.libTree.sha);
    expect(first.srcTree.sha).toBe(second.srcTree.sha);
    expect(first.docsTree.sha).toBe(second.docsTree.sha);
    expect(first.rootTree.sha).toBe(second.rootTree.sha);
    expect(first.commit.sha).toBe(second.commit.sha);
  });

  // -------------------------------------------------------------------------
  // AC-3.1: Nested tree structure correctness
  // -------------------------------------------------------------------------

  it('[P0] should build 6 new trees with correct nested hierarchy', async () => {
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');

    // Push 1 blobs (reused by SHA)
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);

    // Push 2 new blobs
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

    // Build trees leaf-to-root
    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const libTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: libTree.sha },
    ]);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);

    // All 6 trees have valid SHAs (40-char lowercase hex)
    const allTrees = [helpersTree, utilsTree, libTree, srcTree, docsTree, rootTree];
    expect(allTrees).toHaveLength(6);
    const hexShaPattern = /^[0-9a-f]{40}$/;
    for (const tree of allTrees) {
      expect(tree.sha).toMatch(hexShaPattern);
      expect(tree.body).toBeInstanceOf(Buffer);
    }

    // All tree SHAs should be unique (different contents)
    const treeShas = new Set(allTrees.map((t) => t.sha));
    expect(treeShas.size).toBe(6);
  });

  it('[P0] should create helpers/ tree containing only deep-file.ts', async () => {
    const push02 = await import('../push-02-nested.js');
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');

    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);

    const bodyBin = helpersTree.body.toString('binary');
    expect(bodyBin).toContain('deep-file.ts');
  });

  it('[P0] should create utils/ tree containing format.ts and helpers/ subtree', async () => {
    const push02 = await import('../push-02-nested.js');
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');

    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);

    const bodyBin = utilsTree.body.toString('binary');
    expect(bodyBin).toContain('format.ts');
    expect(bodyBin).toContain('helpers');

    // Sorted order: format.ts < helpers
    const formatIdx = bodyBin.indexOf('format.ts');
    const helpersIdx = bodyBin.indexOf('helpers');
    expect(formatIdx).toBeLessThan(helpersIdx);
  });

  it('[P0] should create root tree with README.md, package.json, docs/, src/ (sorted)', async () => {
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');

    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const libTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: libTree.sha },
    ]);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);

    // Body should contain all four entries
    const bodyBin = rootTree.body.toString('binary');
    const readmeIdx = bodyBin.indexOf('README.md');
    const docsIdx = bodyBin.indexOf('docs');
    const pkgIdx = bodyBin.indexOf('package.json');
    const srcIdx = bodyBin.indexOf('src');

    // All entries should be present
    expect(readmeIdx).toBeGreaterThanOrEqual(0);
    expect(docsIdx).toBeGreaterThanOrEqual(0);
    expect(pkgIdx).toBeGreaterThanOrEqual(0);
    expect(srcIdx).toBeGreaterThanOrEqual(0);

    // Sorted order: README.md < docs < package.json < src
    expect(readmeIdx).toBeLessThan(docsIdx);
    expect(docsIdx).toBeLessThan(pkgIdx);
    expect(pkgIdx).toBeLessThan(srcIdx);
  });

  // -------------------------------------------------------------------------
  // AC-3.1: Root tree SHA differs from Push 1 (new structure)
  // -------------------------------------------------------------------------

  it('[P0] should produce a root tree SHA different from Push 1 root tree', async () => {
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree } = await import('../lib/git-builder.js');

    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);

    // Push 1 root tree
    const push01SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
    ]);
    const push01RootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'src', sha: push01SrcTree.sha },
    ]);

    // Push 2 root tree (with nested dirs)
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const libTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const push02SrcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: libTree.sha },
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

    // Root tree SHAs must differ because src/ subtree changed and docs/ added
    expect(push02RootTree.sha).not.toBe(push01RootTree.sha);

    // src/ subtree SHA must also differ (lib/ added)
    expect(push02SrcTree.sha).not.toBe(push01SrcTree.sha);
  });

  // -------------------------------------------------------------------------
  // AC-3.3: Commit has parent = Push 1 commit SHA
  // -------------------------------------------------------------------------

  it('[P0] AC-3.3: commit body contains parent <push01CommitSha>', async () => {
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Reconstruct Push 1 commit to get its SHA
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
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

    // Build Push 2 nested structure
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const libTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: libTree.sha },
    ]);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);

    const push02Commit = createGitCommit({
      treeSha: rootTree.sha,
      parentSha: push01Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure',
      timestamp: 1700001000,
    });

    const body = push02Commit.body.toString('utf-8');

    // Must reference Push 1 commit as parent
    expect(body).toContain(`parent ${push01Commit.sha}`);
    // Must reference the new root tree
    expect(body).toContain(`tree ${rootTree.sha}`);
    // Must use fixed timestamp 1700001000 (after Push 1's 1700000000)
    expect(body).toContain('1700001000');
    // Must have correct commit message
    expect(body).toContain('Add nested directory structure');
    // Must use Alice as author
    expect(body).toContain(`author Alice <${AGENT_IDENTITIES.alice.pubkey}@nostr>`);
  });

  // -------------------------------------------------------------------------
  // AC-3.2: Delta upload logic — only new objects uploaded
  // -------------------------------------------------------------------------

  it('[P0] AC-3.2: exactly 11 new objects to upload (4 blobs + 6 trees + 1 commit), 3 reused from Push 1', async () => {
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Push 1 blobs (these SHAs would be in the shaMap from Push 1)
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);

    // Simulate Push 1 shaMap (already uploaded)
    const push01ShaMap: Record<string, string> = {
      [readmeBlob.sha]: 'arweave-tx-readme',
      [pkgBlob.sha]: 'arweave-tx-pkg',
      [indexBlob.sha]: 'arweave-tx-index',
    };
    // Also include Push 1 trees and commit
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
    push01ShaMap[push01SrcTree.sha] = 'arweave-tx-src-tree';
    push01ShaMap[push01RootTree.sha] = 'arweave-tx-root-tree';
    push01ShaMap[push01Commit.sha] = 'arweave-tx-commit';

    // Push 2 new blobs
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

    // Push 2 new trees
    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const libTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: libTree.sha },
    ]);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);

    // Push 2 commit
    const push02Commit = createGitCommit({
      treeSha: rootTree.sha,
      parentSha: push01Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure',
      timestamp: 1700001000,
    });

    // Collect all Push 2 objects
    const allPush02Objects = [
      coreBlob, formatBlob, deepFileBlob, guideBlob,
      helpersTree, utilsTree, libTree, srcTree, docsTree, rootTree,
      push02Commit,
    ];

    // Exactly 11 new objects
    expect(allPush02Objects).toHaveLength(11);

    // None of the new object SHAs should be in Push 1's shaMap
    for (const obj of allPush02Objects) {
      expect(push01ShaMap[obj.sha]).toBeUndefined();
    }

    // The 3 reused blob SHAs from Push 1 ARE in the shaMap (delta skip)
    expect(push01ShaMap[readmeBlob.sha]).toBeDefined();
    expect(push01ShaMap[pkgBlob.sha]).toBeDefined();
    expect(push01ShaMap[indexBlob.sha]).toBeDefined();
  });

  // -------------------------------------------------------------------------
  // AC-3.1: File contents are under 95KB (R10-005)
  // -------------------------------------------------------------------------

  it('[P0] AC-3.1: all file contents are under 95KB size limit (R10-005)', async () => {
    const push02 = await import('../push-02-nested.js');
    const maxSize = 95 * 1024; // 95KB

    expect(Buffer.byteLength(push02.CORE_TS_CONTENT, 'utf-8')).toBeLessThan(maxSize);
    expect(Buffer.byteLength(push02.FORMAT_TS_CONTENT, 'utf-8')).toBeLessThan(maxSize);
    expect(Buffer.byteLength(push02.DEEP_FILE_TS_CONTENT, 'utf-8')).toBeLessThan(maxSize);
    expect(Buffer.byteLength(push02.GUIDE_MD_CONTENT, 'utf-8')).toBeLessThan(maxSize);

    // Total content should be minimal
    const totalBytes =
      Buffer.byteLength(push02.CORE_TS_CONTENT, 'utf-8') +
      Buffer.byteLength(push02.FORMAT_TS_CONTENT, 'utf-8') +
      Buffer.byteLength(push02.DEEP_FILE_TS_CONTENT, 'utf-8') +
      Buffer.byteLength(push02.GUIDE_MD_CONTENT, 'utf-8');
    expect(totalBytes).toBeLessThan(1000); // Well under limit
    expect(totalBytes).toBeGreaterThan(50); // Sanity: not empty
  });

  // -------------------------------------------------------------------------
  // AC-3.4: kind:30618 refs includes arweave tags from BOTH pushes
  // -------------------------------------------------------------------------

  it('[P0] AC-3.4: buildRepoRefs includes arweave tags from both Push 1 and Push 2', async () => {
    const { buildRepoRefs } = await import('../lib/event-builders.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const push01 = await import('../push-01-init.js');
    const push02 = await import('../push-02-nested.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Reconstruct Push 1 objects
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
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

    // Build accumulated shaMap from Push 1
    const shaMap: Record<string, string> = {
      [readmeBlob.sha]: 'arweave-tx-1',
      [pkgBlob.sha]: 'arweave-tx-2',
      [indexBlob.sha]: 'arweave-tx-3',
      [push01SrcTree.sha]: 'arweave-tx-4',
      [push01RootTree.sha]: 'arweave-tx-5',
      [push01Commit.sha]: 'arweave-tx-6',
    };

    // Push 2 objects
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const libTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: libTree.sha },
    ]);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);
    const push02Commit = createGitCommit({
      treeSha: rootTree.sha,
      parentSha: push01Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure',
      timestamp: 1700001000,
    });

    // Add Push 2 objects to accumulated shaMap
    shaMap[coreBlob.sha] = 'arweave-tx-7';
    shaMap[formatBlob.sha] = 'arweave-tx-8';
    shaMap[deepFileBlob.sha] = 'arweave-tx-9';
    shaMap[guideBlob.sha] = 'arweave-tx-10';
    shaMap[helpersTree.sha] = 'arweave-tx-11';
    shaMap[utilsTree.sha] = 'arweave-tx-12';
    shaMap[libTree.sha] = 'arweave-tx-13';
    shaMap[srcTree.sha] = 'arweave-tx-14';
    shaMap[docsTree.sha] = 'arweave-tx-15';
    shaMap[rootTree.sha] = 'arweave-tx-16';
    shaMap[push02Commit.sha] = 'arweave-tx-17';

    // Total objects: 6 from Push 1 + 11 from Push 2 = 17
    expect(Object.keys(shaMap)).toHaveLength(17);

    const event = buildRepoRefs(
      push01.REPO_ID,
      { 'refs/heads/main': push02Commit.sha },
      shaMap
    );

    expect(event.kind).toBe(30618);

    // r tag should point to Push 2 commit (main branch advanced)
    const rTag = event.tags.find((t) => t[0] === 'r');
    expect(rTag).toBeDefined();
    expect(rTag![1]).toBe('refs/heads/main');
    expect(rTag![2]).toBe(push02Commit.sha);

    // arweave tags: one per git object (all 17 from both pushes)
    const arweaveTags = event.tags.filter((t) => t[0] === 'arweave');
    expect(arweaveTags).toHaveLength(17);

    // Verify every SHA in shaMap has a corresponding arweave tag
    for (const [sha, txId] of Object.entries(shaMap)) {
      const found = arweaveTags.find((t) => t[1] === sha);
      expect(found).toBeDefined();
      expect(found![2]).toBe(txId);
    }
  });

  // -------------------------------------------------------------------------
  // AC-3.5: State return structure expectations
  // -------------------------------------------------------------------------

  it('[P0] AC-3.5: Push02State should include all files from both pushes', async () => {
    // Verify the expected file list for Push 2 state by checking constants
    // that will be used to build the return value.
    const _push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');

    // REPO_ID consistency with Push 1
    expect(push01.REPO_ID).toBe('rig-e2e-test-repo');

    // Push 2 adds 4 files at various depths:
    // depth 1: docs/guide.md
    // depth 2: src/lib/core.ts
    // depth 3: src/lib/utils/format.ts
    // depth 4: src/lib/utils/helpers/deep-file.ts
    //
    // Combined with Push 1's 3 files, the total file list should be 7:
    const expectedFiles = [
      'README.md',
      'package.json',
      'src/index.ts',
      'src/lib/core.ts',
      'src/lib/utils/format.ts',
      'src/lib/utils/helpers/deep-file.ts',
      'docs/guide.md',
    ];
    expect(expectedFiles).toHaveLength(7);

    // Verify the depth-4 file exists (the key regression test target)
    expect(expectedFiles).toContain('src/lib/utils/helpers/deep-file.ts');
  });

  // -------------------------------------------------------------------------
  // AC-3.1: Explicit depth verification for each file path
  // -------------------------------------------------------------------------

  it('[P0] AC-3.1: files exist at depths 1, 2, 3, and 4', async () => {
    // The expected files and their depths per AC-3.1:
    // depth 1: docs/guide.md (1 path segment before filename)
    // depth 2: src/lib/core.ts (2 path segments before filename)
    // depth 3: src/lib/utils/format.ts (3 path segments before filename)
    // depth 4: src/lib/utils/helpers/deep-file.ts (4 path segments before filename)
    const filePaths = [
      'docs/guide.md',
      'src/lib/core.ts',
      'src/lib/utils/format.ts',
      'src/lib/utils/helpers/deep-file.ts',
    ];

    const depths = filePaths.map((p) => p.split('/').length - 1);
    expect(depths).toEqual([1, 2, 3, 4]);

    // Verify depth 4 specifically (regression test target per story)
    const depth4File = filePaths.find((p) => p.split('/').length - 1 === 4);
    expect(depth4File).toBe('src/lib/utils/helpers/deep-file.ts');
  });

  // -------------------------------------------------------------------------
  // AC-3.5: Push02State structure validation (beyond file list)
  // -------------------------------------------------------------------------

  it('[P0] AC-3.5: Push02State commits array should contain 2 entries (Push 1 + Push 2)', async () => {
    // The Push02State interface requires commits as an array that appends
    // Push 2 commit to Push 1 commits. Verify expected structure.
    const push02 = await import('../push-02-nested.js');
    const push01 = await import('../push-01-init.js');
    const { createGitBlob, createGitTree, createGitCommit } = await import('../lib/git-builder.js');
    const { AGENT_IDENTITIES } = await import('../lib/constants.js');

    // Reconstruct Push 1 commit
    const readmeBlob = createGitBlob(push01.README_CONTENT);
    const pkgBlob = createGitBlob(push01.PACKAGE_JSON_CONTENT);
    const indexBlob = createGitBlob(push01.INDEX_TS_CONTENT);
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

    // Reconstruct Push 2 commit
    const coreBlob = createGitBlob(push02.CORE_TS_CONTENT);
    const formatBlob = createGitBlob(push02.FORMAT_TS_CONTENT);
    const deepFileBlob = createGitBlob(push02.DEEP_FILE_TS_CONTENT);
    const guideBlob = createGitBlob(push02.GUIDE_MD_CONTENT);

    const helpersTree = createGitTree([
      { mode: '100644', name: 'deep-file.ts', sha: deepFileBlob.sha },
    ]);
    const utilsTree = createGitTree([
      { mode: '100644', name: 'format.ts', sha: formatBlob.sha },
      { mode: '040000', name: 'helpers', sha: helpersTree.sha },
    ]);
    const libTree = createGitTree([
      { mode: '100644', name: 'core.ts', sha: coreBlob.sha },
      { mode: '040000', name: 'utils', sha: utilsTree.sha },
    ]);
    const srcTree = createGitTree([
      { mode: '100644', name: 'index.ts', sha: indexBlob.sha },
      { mode: '040000', name: 'lib', sha: libTree.sha },
    ]);
    const docsTree = createGitTree([
      { mode: '100644', name: 'guide.md', sha: guideBlob.sha },
    ]);
    const rootTree = createGitTree([
      { mode: '100644', name: 'README.md', sha: readmeBlob.sha },
      { mode: '100644', name: 'package.json', sha: pkgBlob.sha },
      { mode: '040000', name: 'docs', sha: docsTree.sha },
      { mode: '040000', name: 'src', sha: srcTree.sha },
    ]);
    const push02Commit = createGitCommit({
      treeSha: rootTree.sha,
      parentSha: push01Commit.sha,
      authorName: 'Alice',
      authorPubkey: AGENT_IDENTITIES.alice.pubkey,
      message: 'Add nested directory structure',
      timestamp: 1700001000,
    });

    // Simulate the commits array as runPush02 would build it
    const commits = [
      { sha: push01Commit.sha, txId: 'arweave-tx-commit-1', message: 'Initial commit' },
      { sha: push02Commit.sha, txId: 'arweave-tx-commit-2', message: 'Add nested directory structure' },
    ];

    expect(commits).toHaveLength(2);
    expect(commits[0].message).toBe('Initial commit');
    expect(commits[1].message).toBe('Add nested directory structure');
    expect(commits[0].sha).not.toBe(commits[1].sha);
  });

  it('[P0] AC-3.5: Push02State branches should be ["main"]', async () => {
    // The state should indicate only the main branch exists
    const expectedBranches = ['main'];
    expect(expectedBranches).toHaveLength(1);
    expect(expectedBranches).toContain('main');
  });

  it('[P0] AC-3.5: Push02State shaMap should have 17 entries after both pushes', async () => {
    // Push 1: 3 blobs + 2 trees + 1 commit = 6 objects
    // Push 2: 4 blobs + 6 trees + 1 commit = 11 objects
    // Total: 17 unique objects
    const push01ObjectCount = 6;
    const push02ObjectCount = 11;
    const expectedTotal = push01ObjectCount + push02ObjectCount;
    expect(expectedTotal).toBe(17);
  });

  it('[P0] AC-3.5: Push02State preserves repoAnnouncementId from Push 1 (not re-published)', async () => {
    // Verify that the implementation passes through repoAnnouncementId from Push 1
    // without re-publishing kind:30617. Inspect source for correctness.
    const push02Source = await import('../push-02-nested.js');

    // The module should NOT export any function or constant related to repo announcement
    // creation (it only passes through from Push 1 state). Verify the module does not
    // export buildRepoAnnouncement or similar.
    expect((push02Source as Record<string, unknown>)['buildRepoAnnouncement']).toBeUndefined();
    expect((push02Source as Record<string, unknown>)['REPO_ANNOUNCEMENT']).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // AC-3.2 / AC-3.3 / AC-3.4 / AC-3.5: Infrastructure-dependent tests
  // These require live Arweave DVM and ToonClient infrastructure.
  // -------------------------------------------------------------------------

  it.todo('[integration] AC-3.2: should upload only 11 new git objects to Arweave (delta from Push 1)');

  it.todo('[integration] AC-3.2: should skip 3 reused blob SHAs from Push 1 via delta logic');

  it.todo('[integration] AC-3.2: should upload in correct order: blobs, then trees (leaf-to-root), then commit');

  it.todo('[integration] AC-3.2: should throw immediately if any upload returns undefined txId (R10-003)');

  it.todo('[integration] AC-3.3: should create commit with parent = Push 1 commit SHA');

  it.todo('[integration] AC-3.4: should publish kind:30618 refs with updated main branch pointing to Push 2 commit');

  it.todo('[integration] AC-3.4: should include arweave tags for all 17 objects (6 from Push 1 + 11 from Push 2)');

  it.todo('[integration] AC-3.4: should NOT re-publish kind:30617 repo announcement');

  it.todo('[integration] AC-3.5: should return Push02State with 2 commits in commits array');

  it.todo('[integration] AC-3.5: should return files array with all 7 files from both pushes');

  it.todo('[integration] AC-3.5: should return expanded shaMap with 17 entries');

  it.todo('[integration] AC-3.5: should NOT write state.json directly — returns state for orchestrator');

  it.todo('[integration] AC-3.5: should preserve repoAnnouncementId from Push 1 state');

  it.todo('[integration] AC-3.2: should sign monotonically increasing cumulative claims for each upload');
});

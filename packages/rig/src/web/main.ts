/* eslint-disable @typescript-eslint/no-non-null-assertion -- safe DOM/array accesses after null checks */
/**
 * Rig-UI main entry point.
 *
 * Initializes the app, sets up routing, and renders the initial view.
 * This is a static SPA — no backend, no SDK dependency.
 */

import { renderLayout } from './layout.js';
import {
  renderRepoList,
  renderTreeView,
  renderBlobView,
  renderCommitLog,
  renderCommitDiff,
  renderBlameView,
  renderIssueList,
  renderIssueDetail,
  renderPRList,
  renderPRDetail,
} from './templates.js';
import type { FileDiff, TreeViewOptions, HeadCommitInfo } from './templates.js';
import { parseRelayUrl, parseRoute, initRouter } from './router.js';
import {
  queryRelay,
  buildRepoListFilter,
  buildProfileFilter,
  buildRepoRefsFilter,
  buildIssueListFilter,
  buildCommentFilter,
  buildPRListFilter,
  buildStatusFilter,
  buildEventByIdFilter,
  buildIssueCloseFilter,
} from './relay-client.js';
import {
  parseRepoAnnouncement,
  parseRepoRefs,
  parseIssue,
  parsePR,
  parseComment,
  resolvePRStatus,
} from './nip34-parsers.js';
import type { IssueMetadata, PRMetadata } from './nip34-parsers.js';
import { ProfileCache } from './profile-cache.js';
import { resolveDefaultRef } from './ref-resolver.js';
import {
  parseGitTree,
  parseGitCommit,
  isBinaryBlob,
  parseAuthorIdent,
} from './git-objects.js';
import { formatRelativeDate } from './date-utils.js';
import {
  fetchArweaveObject,
  resolveGitSha,
  seedShaCache,
} from './arweave-client.js';
import { walkCommitChain } from './commit-walker.js';
import { computeBlame, isBlameError } from './blame.js';
import { diffTrees } from './tree-diff.js';
import { computeUnifiedDiff } from './unified-diff.js';
import type { Route } from './router.js';
import type { RepoMetadata } from './nip34-parsers.js';

const profileCache = new ProfileCache();

/**
 * Sort events by created_at descending so that for NIP-33 parameterized
 * replaceable events (kind 30000-39999), the newest event is picked first
 * by .find() — matching the NIP-33 spec that only the latest event is valid.
 */
function newestFirst(events: NostrEvent[]): NostrEvent[] {
  return [...events].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
}

/** Monotonically increasing render generation to prevent async race conditions. */
let renderGeneration = 0;

/**
 * Fetch and cache kind:0 profiles for repo owners.
 * Delegates to enrichProfilesForPubkeys with extracted pubkeys.
 */
async function enrichProfiles(
  repos: RepoMetadata[],
  relayUrl: string
): Promise<void> {
  const pubkeys = repos.map((r) => r.ownerPubkey);
  await enrichProfilesForPubkeys(pubkeys, relayUrl);
}

/**
 * Render the tree route: resolve refs, fetch tree from Arweave, render.
 */
async function renderTreeRoute(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  relayUrl: string
): Promise<string> {
  // 1. Query relay for kind:30617 (repo metadata) — limit to prevent unbounded results
  const repoEvents = await queryRelay(relayUrl, {
    kinds: [30617],
    '#d': [repo],
    limit: 10,
  });
  const repoMeta = newestFirst(repoEvents)
    .map((e) => parseRepoAnnouncement(e))
    .find((r): r is RepoMetadata => r !== null);

  if (!repoMeta) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Repository not found.</p></div>',
      relayUrl
    );
  }

  // 2. Query relay for kind:30618 (refs) — limit to prevent unbounded results
  const refsEvents = await queryRelay(relayUrl, {
    ...buildRepoRefsFilter(repoMeta.ownerPubkey, repo),
    limit: 10,
  });
  const repoRefs = newestFirst(refsEvents)
    .map((e) => parseRepoRefs(e))
    .find((r) => r !== null);

  if (!repoRefs) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">No refs</div><p>No branch or tag data found for this repository.</p></div>',
      relayUrl
    );
  }

  // 2b. Seed Arweave SHA→txId cache from relay data (bypasses GraphQL indexing delay)
  if (repoRefs.arweaveMap.size > 0) {
    const mappings: [string, string][] = [];
    for (const [sha, txId] of repoRefs.arweaveMap) {
      mappings.push([`${sha}:${repo}`, txId]);
    }
    seedShaCache(mappings);
  }

  // 3. Resolve ref
  let resolvedRef = ref;
  let commitSha: string | undefined;

  if (!ref) {
    const defaultRef = resolveDefaultRef(repoMeta, repoRefs);
    if (!defaultRef) {
      return renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">No refs</div><p>No branches found.</p></div>',
        relayUrl
      );
    }
    resolvedRef = defaultRef.refName;
    commitSha = defaultRef.commitSha;
  } else {
    commitSha = repoRefs.refs.get(ref) ?? undefined;
  }

  if (!commitSha) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Ref not found.</p></div>',
      relayUrl
    );
  }

  // 4. Resolve commit SHA to Arweave txId and fetch commit
  const commitTxId = await resolveGitSha(commitSha, repo);
  if (!commitTxId) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Content unavailable</div><div class="empty-state-message">Could not resolve commit on Arweave.</div></div>',
      relayUrl
    );
  }

  const commitData = await fetchArweaveObject(commitTxId);
  if (!commitData) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Content unavailable</div><div class="empty-state-message">Arweave gateway error.</div></div>',
      relayUrl
    );
  }

  const commit = parseGitCommit(commitData);
  if (!commit) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Parse error</div><div class="empty-state-message">Could not parse commit object.</div></div>',
      relayUrl
    );
  }

  // 5. Navigate to the correct tree SHA (walk path segments)
  let currentTreeSha = commit.treeSha;

  if (path) {
    const segments = path.split('/').filter(Boolean);
    for (const segment of segments) {
      const treeTxId = await resolveGitSha(currentTreeSha, repo);
      if (!treeTxId) {
        const result = renderTreeView(repo, resolvedRef, path, null, owner);
        return renderLayout('Rig', result.html, relayUrl);
      }
      const treeData = await fetchArweaveObject(treeTxId);
      if (!treeData) {
        const result = renderTreeView(repo, resolvedRef, path, null, owner);
        return renderLayout('Rig', result.html, relayUrl);
      }
      const entries = parseGitTree(treeData);
      const entry = entries.find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') {
        const result = renderTreeView(repo, resolvedRef, path, null, owner);
        return renderLayout('Rig', result.html, relayUrl);
      }
      currentTreeSha = entry.sha;
    }
  }

  // 6. Fetch and parse the target tree
  const treeTxId = await resolveGitSha(currentTreeSha, repo);
  if (!treeTxId) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Content unavailable</div><div class="empty-state-message">Could not resolve tree on Arweave.</div></div>',
      relayUrl
    );
  }

  const treeData = await fetchArweaveObject(treeTxId);
  if (!treeData) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Content unavailable</div><div class="empty-state-message">Arweave gateway error.</div></div>',
      relayUrl
    );
  }

  const treeEntries = parseGitTree(treeData);

  // 7. Try to fetch README for display below tree
  const readmeNames = ['README.md', 'readme.md', 'README', 'README.txt'];
  let readmeHtml: string | undefined;
  let readmeFilename: string | undefined;
  const readmeEntry = treeEntries.find(
    (e) => readmeNames.includes(e.name) && e.mode !== '40000'
  );
  if (readmeEntry) {
    const readmeTxId = await resolveGitSha(readmeEntry.sha, repo);
    if (readmeTxId) {
      const readmeData = await fetchArweaveObject(readmeTxId);
      if (readmeData) {
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const readmeContent = decoder.decode(readmeData);
        const { renderMarkdown } = await import('./markdown-renderer.js');
        const { ARWEAVE_GATEWAYS } = await import('./arweave-client.js');
        const gateway = ARWEAVE_GATEWAYS[0]!;

        // Extract all relative image paths from markdown (![alt](path) and <img src="path">)
        const imgPaths = new Set<string>();
        const mdImgRe = /!\[[^\]]*\]\(([^)]+)\)/g;
        const htmlImgRe = /\bsrc=["']([^"']+)["']/gi;
        let m;
        while ((m = mdImgRe.exec(readmeContent)) !== null) {
          const src = m[1]!.trim();
          if (!/^(?:https?:\/\/|data:|\/\/)/i.test(src)) imgPaths.add(src);
        }
        while ((m = htmlImgRe.exec(readmeContent)) !== null) {
          const src = m[1]!.trim();
          if (!/^(?:https?:\/\/|data:|\/\/)/i.test(src)) imgPaths.add(src);
        }

        // Resolve each relative path by walking the git tree hierarchy via Arweave
        const resolvedUrls = new Map<string, string>();

        async function resolveTreePath(
          relativePath: string
        ): Promise<string | null> {
          const segments = relativePath.split('/').filter(Boolean);
          if (segments.length === 0) return null;

          // Start from the root tree (commit.treeSha)
          let currentTreeShaLocal = commit.treeSha;

          // Walk directory segments (all but last)
          for (let i = 0; i < segments.length - 1; i++) {
            const dirTxId = await resolveGitSha(currentTreeShaLocal, repo);
            if (!dirTxId) return null;
            const dirData = await fetchArweaveObject(dirTxId);
            if (!dirData) return null;
            const dirEntries = parseGitTree(dirData);
            const dirEntry = dirEntries.find(
              (e) => e.name === segments[i] && e.mode === '40000'
            );
            if (!dirEntry) return null;
            currentTreeShaLocal = dirEntry.sha;
          }

          // Resolve the final segment (blob)
          const blobName = segments[segments.length - 1]!;
          const finalTreeTxId = await resolveGitSha(currentTreeShaLocal, repo);
          if (!finalTreeTxId) return null;
          const finalTreeData = await fetchArweaveObject(finalTreeTxId);
          if (!finalTreeData) return null;
          const finalEntries = parseGitTree(finalTreeData);
          const blobEntry = finalEntries.find(
            (e) => e.name === blobName && e.mode !== '40000'
          );
          if (!blobEntry) return null;

          const blobTxId = await resolveGitSha(blobEntry.sha, repo);
          return blobTxId ? `${gateway}/${blobTxId}` : null;
        }

        // Resolve all image paths in parallel
        await Promise.all(
          [...imgPaths].map(async (imgPath) => {
            const url = await resolveTreePath(imgPath);
            if (url) resolvedUrls.set(imgPath, url);
          })
        );

        readmeHtml = renderMarkdown(readmeContent, {
          resolveRelativePath: (p) => resolvedUrls.get(p) ?? null,
        });
        readmeFilename = readmeEntry.name;
      }
    }
  }

  // 8. Build HEAD commit info for the header row
  const commitIdent = parseAuthorIdent(commit.author);
  const headCommit: HeadCommitInfo = {
    sha: commitSha,
    message: commit.message,
    authorName: commitIdent?.name ?? 'Unknown',
    relativeDate: commitIdent ? formatRelativeDate(commitIdent.timestamp) : '',
  };

  const treeViewOptions: TreeViewOptions = {
    allRefs: repoRefs.refs,
    cloneUrls: repoMeta.cloneUrls,
    readmeHtml,
    readmeFilename,
    headCommit,
  };

  const result = renderTreeView(
    repo,
    resolvedRef,
    path,
    treeEntries,
    owner,
    treeViewOptions
  );
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Render the blob route: resolve refs, fetch blob from Arweave, render.
 */
async function renderBlobRoute(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  relayUrl: string
): Promise<string> {
  // 1. Query relay for kind:30617 + kind:30618 — limit to prevent unbounded results
  const repoEvents = await queryRelay(relayUrl, {
    kinds: [30617],
    '#d': [repo],
    limit: 10,
  });
  const repoMeta = newestFirst(repoEvents)
    .map((e) => parseRepoAnnouncement(e))
    .find((r): r is RepoMetadata => r !== null);

  if (!repoMeta) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Repository not found.</p></div>',
      relayUrl
    );
  }

  const refsEvents = await queryRelay(relayUrl, {
    ...buildRepoRefsFilter(repoMeta.ownerPubkey, repo),
    limit: 10,
  });
  const repoRefs = newestFirst(refsEvents)
    .map((e) => parseRepoRefs(e))
    .find((r) => r !== null);

  if (!repoRefs) {
    return renderLayout(
      'Forge',
      renderBlobView(repo, ref, path, null, false, 0, owner).html,
      relayUrl
    );
  }

  // Seed Arweave SHA→txId cache from relay data (bypasses GraphQL indexing delay)
  if (repoRefs.arweaveMap.size > 0) {
    const mappings: [string, string][] = [];
    for (const [sha, txId] of repoRefs.arweaveMap) {
      mappings.push([`${sha}:${repo}`, txId]);
    }
    seedShaCache(mappings);
  }

  // 2. Resolve ref to commit SHA
  let resolvedRef = ref;
  let commitSha: string | undefined;

  if (!ref) {
    const defaultRef = resolveDefaultRef(repoMeta, repoRefs);
    if (!defaultRef) {
      return renderLayout(
        'Forge',
        renderBlobView(repo, ref, path, null, false, 0, owner).html,
        relayUrl
      );
    }
    resolvedRef = defaultRef.refName;
    commitSha = defaultRef.commitSha;
  } else {
    commitSha = repoRefs.refs.get(ref);
  }

  if (!commitSha) {
    return renderLayout(
      'Forge',
      renderBlobView(repo, resolvedRef, path, null, false, 0, owner).html,
      relayUrl
    );
  }

  // 3. Fetch commit → tree
  const commitTxId = await resolveGitSha(commitSha, repo);
  if (!commitTxId) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Content unavailable</div><div class="empty-state-message">Could not resolve commit on Arweave.</div></div>',
      relayUrl
    );
  }

  const commitData = await fetchArweaveObject(commitTxId);
  if (!commitData) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Content unavailable</div><div class="empty-state-message">Arweave gateway error.</div></div>',
      relayUrl
    );
  }

  const commit = parseGitCommit(commitData);
  if (!commit) {
    return renderLayout(
      'Forge',
      renderBlobView(repo, resolvedRef, path, null, false, 0, owner).html,
      relayUrl
    );
  }

  // 4. Walk path segments to find the blob
  const segments = path.split('/').filter(Boolean);
  let currentTreeSha = commit.treeSha;

  // Walk directories up to the last segment
  for (let i = 0; i < segments.length - 1; i++) {
    const treeTxId = await resolveGitSha(currentTreeSha, repo);
    if (!treeTxId) {
      return renderLayout(
        'Forge',
        renderBlobView(repo, resolvedRef, path, null, false, 0, owner).html,
        relayUrl
      );
    }
    const treeData = await fetchArweaveObject(treeTxId);
    if (!treeData) {
      return renderLayout(
        'Forge',
        renderBlobView(repo, resolvedRef, path, null, false, 0, owner).html,
        relayUrl
      );
    }
    const entries = parseGitTree(treeData);
    const entry = entries.find((e) => e.name === segments[i]);
    if (!entry || entry.mode !== '40000') {
      return renderLayout(
        'Forge',
        renderBlobView(repo, resolvedRef, path, null, false, 0, owner).html,
        relayUrl
      );
    }
    currentTreeSha = entry.sha;
  }

  // Find the blob entry in the final tree
  const treeTxId = await resolveGitSha(currentTreeSha, repo);
  if (!treeTxId) {
    return renderLayout(
      'Forge',
      renderBlobView(repo, resolvedRef, path, null, false, 0, owner).html,
      relayUrl
    );
  }
  const treeData = await fetchArweaveObject(treeTxId);
  if (!treeData) {
    return renderLayout(
      'Forge',
      renderBlobView(repo, resolvedRef, path, null, false, 0, owner).html,
      relayUrl
    );
  }
  const entries = parseGitTree(treeData);
  const fileName = segments[segments.length - 1];
  const blobEntry = entries.find((e) => e.name === fileName);

  if (!blobEntry) {
    return renderLayout(
      'Forge',
      renderBlobView(repo, resolvedRef, path, null, false, 0, owner).html,
      relayUrl
    );
  }

  // 5. Fetch blob data
  const blobTxId = await resolveGitSha(blobEntry.sha, repo);
  if (!blobTxId) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Content unavailable</div><div class="empty-state-message">Could not resolve blob on Arweave.</div></div>',
      relayUrl
    );
  }

  const blobData = await fetchArweaveObject(blobTxId);
  if (!blobData) {
    return renderLayout(
      'Forge',
      '<div class="empty-state"><div class="empty-state-title">Content unavailable</div><div class="empty-state-message">Arweave gateway error.</div></div>',
      relayUrl
    );
  }

  const binary = isBinaryBlob(blobData);
  if (binary) {
    const result = renderBlobView(
      repo,
      resolvedRef,
      path,
      null,
      true,
      blobData.length,
      owner
    );
    return renderLayout('Rig', result.html, relayUrl);
  }

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const content = decoder.decode(blobData);
  const result = renderBlobView(
    repo,
    resolvedRef,
    path,
    content,
    false,
    blobData.length,
    owner
  );
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Render the commits log route: resolve ref, walk commit chain, render.
 */
async function renderCommitsRoute(
  owner: string,
  repo: string,
  ref: string,
  relayUrl: string
): Promise<string> {
  // 1. Query relay for kind:30617 (repo metadata)
  const repoEvents = await queryRelay(relayUrl, {
    kinds: [30617],
    '#d': [repo],
    limit: 10,
  });
  const repoMeta = newestFirst(repoEvents)
    .map((e) => parseRepoAnnouncement(e))
    .find((r): r is RepoMetadata => r !== null);

  if (!repoMeta) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Repository not found.</p></div>',
      relayUrl
    );
  }

  // 2. Query relay for kind:30618 (refs)
  const refsEvents = await queryRelay(relayUrl, {
    ...buildRepoRefsFilter(repoMeta.ownerPubkey, repo),
    limit: 10,
  });
  const repoRefs = newestFirst(refsEvents)
    .map((e) => parseRepoRefs(e))
    .find((r) => r !== null);

  if (!repoRefs) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">No refs</div><p>No branch or tag data found.</p></div>',
      relayUrl
    );
  }

  // Seed Arweave SHA→txId cache from relay data
  if (repoRefs.arweaveMap.size > 0) {
    const mappings: [string, string][] = [];
    for (const [sha, txId] of repoRefs.arweaveMap) {
      mappings.push([`${sha}:${repo}`, txId]);
    }
    seedShaCache(mappings);
  }

  // 3. Resolve ref to commit SHA
  let resolvedRef = ref;
  let commitSha: string | undefined;

  if (!ref) {
    const defaultRef = resolveDefaultRef(repoMeta, repoRefs);
    if (!defaultRef) {
      const result = renderCommitLog(repo, ref, [], owner);
      return renderLayout('Rig', result.html, relayUrl);
    }
    resolvedRef = defaultRef.refName;
    commitSha = defaultRef.commitSha;
  } else {
    commitSha = repoRefs.refs.get(ref) ?? undefined;
  }

  if (!commitSha) {
    const result = renderCommitLog(repo, resolvedRef, [], owner);
    return renderLayout('Rig', result.html, relayUrl);
  }

  // 4. Walk commit chain
  const commits = await walkCommitChain(commitSha, repo);
  const result = renderCommitLog(repo, resolvedRef, commits, owner);
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Render the commit diff route: fetch commit, diff trees, render.
 */
async function renderCommitRoute(
  owner: string,
  repo: string,
  sha: string,
  relayUrl: string
): Promise<string> {
  // 0. Seed Arweave SHA→txId cache from relay data (same pattern as tree/blob/commits/blame routes)
  const repoEvents = await queryRelay(relayUrl, {
    kinds: [30617],
    '#d': [repo],
    limit: 10,
  });
  const repoMeta = newestFirst(repoEvents)
    .map((e) => parseRepoAnnouncement(e))
    .find((r): r is RepoMetadata => r !== null);

  if (repoMeta) {
    const refsEvents = await queryRelay(relayUrl, {
      ...buildRepoRefsFilter(repoMeta.ownerPubkey, repo),
      limit: 10,
    });
    const repoRefs = newestFirst(refsEvents)
      .map((e) => parseRepoRefs(e))
      .find((r) => r !== null);

    if (repoRefs && repoRefs.arweaveMap.size > 0) {
      const mappings: [string, string][] = [];
      for (const [arSha, txId] of repoRefs.arweaveMap) {
        mappings.push([`${arSha}:${repo}`, txId]);
      }
      seedShaCache(mappings);
    }
  }

  // 1. Fetch the commit
  const commitTxId = await resolveGitSha(sha, repo);
  if (!commitTxId) {
    const result = renderCommitDiff(repo, sha, null);
    return renderLayout('Rig', result.html, relayUrl);
  }

  const commitData = await fetchArweaveObject(commitTxId);
  if (!commitData) {
    const result = renderCommitDiff(repo, sha, null);
    return renderLayout('Rig', result.html, relayUrl);
  }

  const commit = parseGitCommit(commitData);
  if (!commit) {
    const result = renderCommitDiff(repo, sha, null);
    return renderLayout('Rig', result.html, relayUrl);
  }

  // 2. Fetch current commit's tree
  const currentTreeTxId = await resolveGitSha(commit.treeSha, repo);
  const currentTreeData = currentTreeTxId
    ? await fetchArweaveObject(currentTreeTxId)
    : null;
  const currentTreeEntries = currentTreeData
    ? parseGitTree(currentTreeData)
    : [];

  // 3. Fetch parent commit's tree (if parent exists)
  let parentTreeEntries: ReturnType<typeof parseGitTree> = [];
  const parentSha = commit.parentShas[0];
  if (parentSha) {
    const parentCommitTxId = await resolveGitSha(parentSha, repo);
    if (parentCommitTxId) {
      const parentCommitData = await fetchArweaveObject(parentCommitTxId);
      if (parentCommitData) {
        const parentCommit = parseGitCommit(parentCommitData);
        if (parentCommit) {
          const parentTreeTxId = await resolveGitSha(
            parentCommit.treeSha,
            repo
          );
          if (parentTreeTxId) {
            const parentTreeData = await fetchArweaveObject(parentTreeTxId);
            if (parentTreeData) {
              parentTreeEntries = parseGitTree(parentTreeData);
            }
          }
        }
      }
    }
  }

  // 4. Compute tree diff
  const treeDiffEntries = diffTrees(parentTreeEntries, currentTreeEntries);

  // 5. Fetch blob diffs for modified/added/deleted text files
  const fileDiffs: FileDiff[] = [];
  // Limit concurrency to 3 parallel blob fetches
  const batchSize = 3;
  for (let i = 0; i < treeDiffEntries.length; i += batchSize) {
    const batch = treeDiffEntries.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map(async (entry): Promise<FileDiff> => {
        // For directories, skip blob fetching
        if (entry.mode === '40000') {
          return {
            name: entry.name,
            status: entry.status,
            hunks: [],
            isBinary: false,
          };
        }

        try {
          let oldContent = '';
          let newContent = '';
          let foundBinary = false;

          // Fetch old blob
          if (entry.oldSha) {
            const oldTxId = await resolveGitSha(entry.oldSha, repo);
            if (oldTxId) {
              const oldData = await fetchArweaveObject(oldTxId);
              if (oldData) {
                if (isBinaryBlob(oldData)) {
                  foundBinary = true;
                } else {
                  const decoder = new TextDecoder('utf-8', { fatal: false });
                  oldContent = decoder.decode(oldData);
                }
              }
            }
          }

          // Fetch new blob
          if (entry.newSha && !foundBinary) {
            const newTxId = await resolveGitSha(entry.newSha, repo);
            if (newTxId) {
              const newData = await fetchArweaveObject(newTxId);
              if (newData) {
                if (isBinaryBlob(newData)) {
                  foundBinary = true;
                } else {
                  const decoder = new TextDecoder('utf-8', { fatal: false });
                  newContent = decoder.decode(newData);
                }
              }
            }
          }

          if (foundBinary) {
            return {
              name: entry.name,
              status: entry.status,
              hunks: [],
              isBinary: true,
            };
          }

          const hunks = computeUnifiedDiff(oldContent, newContent);
          return {
            name: entry.name,
            status: entry.status,
            hunks,
            isBinary: false,
          };
        } catch {
          return {
            name: entry.name,
            status: entry.status,
            hunks: [],
            isBinary: false,
          };
        }
      })
    );
    fileDiffs.push(...batchResults);
  }

  const commitLogEntry = { sha, commit };
  const result = renderCommitDiff(
    repo,
    sha,
    commitLogEntry,
    treeDiffEntries,
    fileDiffs,
    owner
  );
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Render the blame route: resolve refs, compute blame from Arweave, render.
 */
async function renderBlameRoute(
  owner: string,
  repo: string,
  ref: string,
  path: string,
  relayUrl: string
): Promise<string> {
  // 1. Query relay for kind:30617 (repo metadata)
  const repoEvents = await queryRelay(relayUrl, {
    kinds: [30617],
    '#d': [repo],
    limit: 10,
  });
  const repoMeta = newestFirst(repoEvents)
    .map((e) => parseRepoAnnouncement(e))
    .find((r): r is RepoMetadata => r !== null);

  if (!repoMeta) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Repository not found.</p></div>',
      relayUrl
    );
  }

  // 2. Query relay for kind:30618 (refs)
  const refsEvents = await queryRelay(relayUrl, {
    ...buildRepoRefsFilter(repoMeta.ownerPubkey, repo),
    limit: 10,
  });
  const repoRefs = newestFirst(refsEvents)
    .map((e) => parseRepoRefs(e))
    .find((r) => r !== null);

  if (!repoRefs) {
    const result = renderBlameView(repo, ref, path, null);
    return renderLayout('Rig', result.html, relayUrl);
  }

  // Seed Arweave SHA→txId cache from relay data
  if (repoRefs.arweaveMap.size > 0) {
    const mappings: [string, string][] = [];
    for (const [sha, txId] of repoRefs.arweaveMap) {
      mappings.push([`${sha}:${repo}`, txId]);
    }
    seedShaCache(mappings);
  }

  // 3. Resolve ref to commit SHA
  let resolvedRef = ref;
  let commitSha: string | undefined;

  if (!ref) {
    const defaultRef = resolveDefaultRef(repoMeta, repoRefs);
    if (!defaultRef) {
      const result = renderBlameView(repo, ref, path, null);
      return renderLayout('Rig', result.html, relayUrl);
    }
    resolvedRef = defaultRef.refName;
    commitSha = defaultRef.commitSha;
  } else {
    commitSha = repoRefs.refs.get(ref) ?? undefined;
  }

  if (!commitSha) {
    const result = renderBlameView(repo, resolvedRef, path, null);
    return renderLayout('Rig', result.html, relayUrl);
  }

  // 4. Compute blame
  const blameResult = await computeBlame(path, commitSha, repo);

  // Handle BlameError (binary or not-found) distinctly from null (resolution failure)
  if (isBlameError(blameResult)) {
    const isBinary = blameResult.reason === 'binary';
    const result = renderBlameView(
      repo,
      resolvedRef,
      path,
      null,
      isBinary,
      owner
    );
    return renderLayout('Rig', result.html, relayUrl);
  }

  const result = renderBlameView(
    repo,
    resolvedRef,
    path,
    blameResult,
    false,
    owner
  );
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Enrich profiles for a set of pubkeys (best-effort).
 */
async function enrichProfilesForPubkeys(
  pubkeys: string[],
  relayUrl: string
): Promise<void> {
  const pending = profileCache.getPendingPubkeys(pubkeys);
  if (pending.length === 0) return;

  try {
    const profileEvents = await queryRelay(
      relayUrl,
      buildProfileFilter(pending),
      5000
    );
    for (const evt of profileEvents) {
      try {
        const profile = JSON.parse(evt.content) as {
          name?: string;
          display_name?: string;
          picture?: string;
        };
        profileCache.setProfile(evt.pubkey, {
          name: profile.name,
          displayName: profile.display_name,
          picture: profile.picture,
        });
      } catch {
        // Ignore malformed profile JSON
      }
    }
    profileCache.markRequested(pending);
  } catch {
    profileCache.markRequested(pending);
  }
}

/**
 * Resolve repo metadata (kind:30617) for issue/PR routes.
 */
async function resolveRepoMeta(
  repo: string,
  relayUrl: string
): Promise<{ ownerPubkey: string; repoId: string } | null> {
  const repoEvents = await queryRelay(relayUrl, {
    kinds: [30617],
    '#d': [repo],
    limit: 10,
  });
  const repoMeta = newestFirst(repoEvents)
    .map((e) => parseRepoAnnouncement(e))
    .find((r): r is RepoMetadata => r !== null);

  if (!repoMeta) return null;

  // Use the d-tag value (repo name) as the repoId for filter construction
  return { ownerPubkey: repoMeta.ownerPubkey, repoId: repo };
}

/**
 * Render the issues list route.
 */
async function renderIssuesRoute(
  owner: string,
  repo: string,
  relayUrl: string
): Promise<string> {
  const meta = await resolveRepoMeta(repo, relayUrl);
  if (!meta) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Repository not found.</p></div>',
      relayUrl
    );
  }

  // Query issues
  const issueEvents = await queryRelay(
    relayUrl,
    buildIssueListFilter(meta.ownerPubkey, meta.repoId)
  );

  const issues: IssueMetadata[] = issueEvents
    .map((e) => parseIssue(e))
    .filter((i): i is IssueMetadata => i !== null);

  // Query close events to determine status
  if (issues.length > 0) {
    const issueIds = issues.map((i) => i.eventId);
    const closeEvents = await queryRelay(
      relayUrl,
      buildIssueCloseFilter(issueIds)
    );
    const closedIds = new Set<string>();
    for (const evt of closeEvents) {
      const eTag = evt.tags.find((t) => t[0] === 'e');
      if (eTag?.[1]) {
        closedIds.add(eTag[1]);
      }
    }
    for (const issue of issues) {
      if (closedIds.has(issue.eventId)) {
        issue.status = 'closed';
      }
    }
  }

  // Sort by created_at descending
  issues.sort((a, b) => b.createdAt - a.createdAt);

  // Enrich profiles
  const pubkeys = issues.map((i) => i.authorPubkey);
  await enrichProfilesForPubkeys(pubkeys, relayUrl);

  const result = renderIssueList(repo, issues, profileCache, owner);
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Render the issue detail route.
 */
async function renderIssueDetailRoute(
  owner: string,
  repo: string,
  eventId: string,
  relayUrl: string
): Promise<string> {
  // Fetch the issue event
  const issueEvents = await queryRelay(
    relayUrl,
    buildEventByIdFilter([eventId])
  );
  const issueEvent = issueEvents[0];
  if (!issueEvent) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Issue not found.</p></div>',
      relayUrl
    );
  }

  const issue = parseIssue(issueEvent);
  if (!issue) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Issue not found.</p></div>',
      relayUrl
    );
  }

  // Check close status
  const closeEvents = await queryRelay(
    relayUrl,
    buildIssueCloseFilter([eventId])
  );
  if (closeEvents.length > 0) {
    issue.status = 'closed';
  }

  // Fetch comments
  const commentEvents = await queryRelay(
    relayUrl,
    buildCommentFilter([eventId])
  );
  const comments = commentEvents
    .map((e) => parseComment(e))
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Enrich profiles
  const pubkeys = [issue.authorPubkey, ...comments.map((c) => c.authorPubkey)];
  await enrichProfilesForPubkeys(pubkeys, relayUrl);

  const result = renderIssueDetail(repo, issue, comments, profileCache, owner);
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Render the pull requests list route.
 */
async function renderPullsRoute(
  owner: string,
  repo: string,
  relayUrl: string
): Promise<string> {
  const meta = await resolveRepoMeta(repo, relayUrl);
  if (!meta) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Repository not found.</p></div>',
      relayUrl
    );
  }

  // Query PRs
  const prEvents = await queryRelay(
    relayUrl,
    buildPRListFilter(meta.ownerPubkey, meta.repoId)
  );

  const prs: PRMetadata[] = prEvents
    .map((e) => parsePR(e))
    .filter((p): p is PRMetadata => p !== null);

  // Query status events
  if (prs.length > 0) {
    const prIds = prs.map((p) => p.eventId);
    const statusEvents = await queryRelay(relayUrl, buildStatusFilter(prIds));
    for (const pr of prs) {
      pr.status = resolvePRStatus(pr.eventId, statusEvents);
    }
  }

  // Sort by created_at descending
  prs.sort((a, b) => b.createdAt - a.createdAt);

  // Enrich profiles
  const pubkeys = prs.map((p) => p.authorPubkey);
  await enrichProfilesForPubkeys(pubkeys, relayUrl);

  const result = renderPRList(repo, prs, profileCache, owner);
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Render the pull request detail route.
 */
async function renderPullDetailRoute(
  owner: string,
  repo: string,
  eventId: string,
  relayUrl: string
): Promise<string> {
  // Fetch the PR event
  const prEvents = await queryRelay(relayUrl, buildEventByIdFilter([eventId]));
  const prEvent = prEvents[0];
  if (!prEvent) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Pull request not found.</p></div>',
      relayUrl
    );
  }

  const pr = parsePR(prEvent);
  if (!pr) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">404</div><p>Pull request not found.</p></div>',
      relayUrl
    );
  }

  // Fetch status events
  const statusEvents = await queryRelay(relayUrl, buildStatusFilter([eventId]));
  pr.status = resolvePRStatus(eventId, statusEvents);

  // Fetch comments
  const commentEvents = await queryRelay(
    relayUrl,
    buildCommentFilter([eventId])
  );
  const comments = commentEvents
    .map((e) => parseComment(e))
    .filter((c): c is NonNullable<typeof c> => c !== null)
    .sort((a, b) => a.createdAt - b.createdAt);

  // Enrich profiles
  const pubkeys = [pr.authorPubkey, ...comments.map((c) => c.authorPubkey)];
  await enrichProfilesForPubkeys(pubkeys, relayUrl);

  const result = renderPRDetail(repo, pr, comments, profileCache, owner);
  return renderLayout('Rig', result.html, relayUrl);
}

/**
 * Render a route into the app container.
 */
async function renderRoute(route: Route, relayUrl: string): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

  // Increment generation — if a newer render starts, this one should bail out
  const thisGeneration = ++renderGeneration;

  // Scroll to top on navigation for a polished SPA feel
  window.scrollTo(0, 0);

  let content: string;

  switch (route.type) {
    case 'repo-list': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading repositories...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      // Fetch repos from relay
      try {
        const events = await queryRelay(relayUrl, buildRepoListFilter());
        const allRepos = newestFirst(events)
          .map((e) => parseRepoAnnouncement(e))
          .filter((r): r is RepoMetadata => r !== null);
        // Deduplicate NIP-33 replaceable events: keep only the newest per repoId
        const seen = new Set<string>();
        const repos: RepoMetadata[] = allRepos.filter((r) => {
          if (seen.has(r.repoId)) return false;
          seen.add(r.repoId);
          return true;
        });

        // Enrich with profile data (best-effort)
        await enrichProfiles(repos, relayUrl);

        const repoListHtml = renderRepoList(repos, profileCache);
        content = renderLayout('Rig', repoListHtml, relayUrl);
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Connection Error</div><div class="empty-state-message">Could not connect to relay. Check the relay URL and try again.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'tree': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading file tree...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderTreeRoute(
          route.owner,
          route.repo,
          route.ref,
          route.path,
          relayUrl
        );
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load file tree.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'blob': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading file...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderBlobRoute(
          route.owner,
          route.repo,
          route.ref,
          route.path,
          relayUrl
        );
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load file.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'commits': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading commit log...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderCommitsRoute(
          route.owner,
          route.repo,
          route.ref,
          relayUrl
        );
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load commit log.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'commit': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading commit...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderCommitRoute(
          route.owner,
          route.repo,
          route.sha,
          relayUrl
        );
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load commit.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'blame': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading blame...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderBlameRoute(
          route.owner,
          route.repo,
          route.ref,
          route.path,
          relayUrl
        );
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load blame view.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'issues': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading issues...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderIssuesRoute(route.owner, route.repo, relayUrl);
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load issues.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'issue-detail': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading issue...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderIssueDetailRoute(
          route.owner,
          route.repo,
          route.eventId,
          relayUrl
        );
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load issue.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'pulls': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading pull requests...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderPullsRoute(route.owner, route.repo, relayUrl);
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load pull requests.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'pull-detail': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading pull request...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      try {
        content = await renderPullDetailRoute(
          route.owner,
          route.repo,
          route.eventId,
          relayUrl
        );
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Error</div><div class="empty-state-message">Could not load pull request.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'not-found':
    default:
      content = renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">404</div><p>Page not found.</p></div>',
        relayUrl
      );
      break;
  }

  // Bail out if a newer navigation started while we were fetching
  if (thisGeneration !== renderGeneration) return;

  app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method
}

/**
 * Initialize the Rig-UI application.
 */
function init(): void {
  const relayUrl = parseRelayUrl(window.location.search);
  const app = document.getElementById('app');
  if (!app) return;

  // Set up router
  initRouter(app, (route) => {
    void renderRoute(route, relayUrl);
  });

  // Render initial route — deep-link to repo if __RIG_CONFIG__ specifies one
  let initialRoute = parseRoute(window.location.pathname);
  if (initialRoute.type === 'repo-list' && window.__RIG_CONFIG__?.repo) {
    const owner = window.__RIG_CONFIG__.owner ?? '';
    const repo = window.__RIG_CONFIG__.repo;
    const deepPath = owner ? `/${owner}/${repo}/` : `/${repo}/`;
    initialRoute = parseRoute(deepPath);
  }
  void renderRoute(initialRoute, relayUrl);
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

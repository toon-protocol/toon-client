/**
 * Forge-UI main entry point.
 *
 * Initializes the app, sets up routing, and renders the initial view.
 * This is a static SPA — no backend, no SDK dependency.
 */

import { renderLayout } from './layout.js';
import { renderRepoList, renderTreeView, renderBlobView } from './templates.js';
import { parseRelayUrl, parseRoute, initRouter } from './router.js';
import {
  queryRelay,
  buildRepoListFilter,
  buildProfileFilter,
  buildRepoRefsFilter,
} from './relay-client.js';
import { parseRepoAnnouncement, parseRepoRefs } from './nip34-parsers.js';
import { ProfileCache } from './profile-cache.js';
import { resolveDefaultRef } from './ref-resolver.js';
import { parseGitTree, parseGitCommit, isBinaryBlob } from './git-objects.js';
import { fetchArweaveObject, resolveGitSha } from './arweave-client.js';
import type { Route } from './router.js';
import type { RepoMetadata } from './nip34-parsers.js';

const profileCache = new ProfileCache();

/**
 * Fetch and cache kind:0 profiles for repo owners, then return a
 * display-name lookup function.
 */
async function enrichProfiles(
  repos: RepoMetadata[],
  relayUrl: string
): Promise<void> {
  const pubkeys = repos.map((r) => r.ownerPubkey);
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
    // Profile enrichment is best-effort; mark as requested to avoid retries
    profileCache.markRequested(pending);
  }
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
  const repoMeta = repoEvents
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
  const repoRefs = refsEvents
    .map((e) => parseRepoRefs(e))
    .find((r) => r !== null);

  if (!repoRefs) {
    return renderLayout(
      'Forge',
      '<div class="stub-page"><div class="stub-page-title">No refs</div><p>No branch or tag data found for this repository.</p></div>',
      relayUrl
    );
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
        return renderLayout('Forge', result.html, relayUrl);
      }
      const treeData = await fetchArweaveObject(treeTxId);
      if (!treeData) {
        const result = renderTreeView(repo, resolvedRef, path, null, owner);
        return renderLayout('Forge', result.html, relayUrl);
      }
      const entries = parseGitTree(treeData);
      const entry = entries.find((e) => e.name === segment);
      if (!entry || entry.mode !== '40000') {
        const result = renderTreeView(repo, resolvedRef, path, null, owner);
        return renderLayout('Forge', result.html, relayUrl);
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
  const result = renderTreeView(repo, resolvedRef, path, treeEntries, owner);
  return renderLayout('Forge', result.html, relayUrl);
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
  const repoMeta = repoEvents
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
  const repoRefs = refsEvents
    .map((e) => parseRepoRefs(e))
    .find((r) => r !== null);

  if (!repoRefs) {
    return renderLayout(
      'Forge',
      renderBlobView(repo, ref, path, null, false, 0, owner).html,
      relayUrl
    );
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
    return renderLayout('Forge', result.html, relayUrl);
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
  return renderLayout('Forge', result.html, relayUrl);
}

/**
 * Render a route into the app container.
 */
async function renderRoute(route: Route, relayUrl: string): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

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
        const repos: RepoMetadata[] = events
          .map((e) => parseRepoAnnouncement(e))
          .filter((r): r is RepoMetadata => r !== null);

        // Enrich with profile data (best-effort)
        await enrichProfiles(repos, relayUrl);

        const repoListHtml = renderRepoList(repos, profileCache);
        content = renderLayout('Forge', repoListHtml, relayUrl);
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
    case 'commit':
      content = renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">Commit</div><p>Commit diff view — coming in Story 8.4.</p></div>',
        relayUrl
      );
      break;
    case 'blame':
      content = renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">Blame</div><p>Blame view — coming in Story 8.5.</p></div>',
        relayUrl
      );
      break;
    case 'not-found':
    default:
      content = renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">404</div><p>Page not found.</p></div>',
        relayUrl
      );
      break;
  }

  app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method
}

/**
 * Initialize the Forge-UI application.
 */
function init(): void {
  const relayUrl = parseRelayUrl(window.location.search);
  const app = document.getElementById('app');
  if (!app) return;

  // Set up router
  initRouter(app, (route) => {
    void renderRoute(route, relayUrl);
  });

  // Render initial route
  const initialRoute = parseRoute(window.location.pathname);
  void renderRoute(initialRoute, relayUrl);
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

/**
 * Web templates for @toon-protocol/rig.
 *
 * Renders HTML templates for the git forge web UI with XSS prevention.
 * All user-supplied content is HTML-escaped before rendering.
 */

import { escapeHtml } from './escape.js';
import { hexToNpub } from './npub.js';
import type { ProfileCache } from './profile-cache.js';
import type { RepoMetadata } from './nip34-parsers.js';
import type { TreeEntry } from './git-objects.js';

export interface TemplateResult {
  status: number;
  html: string;
}

/**
 * Renders the repository list page.
 *
 * @param repos - Array of RepoMetadata objects
 * @param cache - Optional ProfileCache for resolving owner display names
 * @returns HTML string for the repo list
 */
export function renderRepoList(
  repos: RepoMetadata[],
  cache?: ProfileCache
): string {
  if (!repos || repos.length === 0) {
    return `<div class="empty-state">
  <div class="empty-state-title">No repositories found</div>
  <div class="empty-state-message">No repositories have been announced on this relay yet.</div>
</div>`;
  }

  const items = repos
    .map((r) => {
      const name = escapeHtml(r.name ?? '');
      const description = escapeHtml(r.description ?? '');
      const ownerPubkey = r.ownerPubkey ?? '';
      const defaultBranch = escapeHtml(r.defaultBranch ?? 'main');

      // Generate npub for the owner link
      let ownerNpub = '';
      try {
        ownerNpub = hexToNpub(ownerPubkey);
      } catch {
        ownerNpub = ownerPubkey.slice(0, 12) + '...';
      }

      // Use ProfileCache for display name if available, else truncated npub
      const ownerDisplay = escapeHtml(
        cache
          ? cache.getDisplayName(ownerPubkey)
          : ownerNpub.slice(0, 13) + '...' + ownerNpub.slice(-4)
      );
      const repoHref = escapeHtml(
        `/${encodeURIComponent(ownerNpub)}/${encodeURIComponent(r.name ?? '')}/`
      );

      return `<div class="repo-card">
  <div class="repo-card-header">
    <a href="${repoHref}" class="repo-name">${name}</a>
    <span class="repo-branch-badge">${defaultBranch}</span>
  </div>
  <div class="repo-description">${description}</div>
  <div class="repo-owner">${ownerDisplay}</div>
</div>`;
    })
    .join('\n');

  return `<div class="repo-list">\n${items}\n</div>`;
}

/**
 * Get a display icon for a tree entry based on its mode.
 */
function getTreeEntryIcon(mode: string): string {
  if (mode === '40000') return '&#x1F4C1;'; // folder
  if (mode === '120000') return '&#x1F517;'; // symlink
  if (mode === '160000') return '&#x1F4E6;'; // submodule
  return '&#x1F4C4;'; // file
}

/**
 * Render breadcrumb navigation for a path within a repository.
 */
function renderBreadcrumbs(
  ownerNpub: string,
  repoName: string,
  ref: string,
  path: string
): string {
  const escapedRepo = escapeHtml(repoName);
  const encodedOwner = encodeURIComponent(ownerNpub);
  const encodedRepo = encodeURIComponent(repoName);
  const escapedRef = escapeHtml(ref);

  const crumbs: string[] = [];

  // Root repo link
  crumbs.push(
    `<a href="/${encodedOwner}/${encodedRepo}/tree/${encodeURIComponent(ref)}/" class="breadcrumb-link">${escapedRepo}</a>`
  );

  if (path) {
    const segments = path.split('/').filter(Boolean);
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i]!;
      const encodedPartialPath = segments
        .slice(0, i + 1)
        .map((s) => encodeURIComponent(s))
        .join('/');
      const escapedSegment = escapeHtml(segment);
      const href = `/${encodedOwner}/${encodedRepo}/tree/${encodeURIComponent(ref)}/${encodedPartialPath}`;
      crumbs.push(
        `<a href="${escapeHtml(href)}" class="breadcrumb-link">${escapedSegment}</a>`
      );
    }
  }

  return `<nav class="breadcrumbs"><span class="breadcrumb-ref">${escapedRef}</span> ${crumbs.join(' / ')}</nav>`;
}

/**
 * Renders a tree (directory) view for a repository.
 *
 * @param repoName - Repository name
 * @param ref - Git ref (branch/tag name)
 * @param path - Current path within the tree
 * @param treeEntries - Parsed tree entries, or null for 404
 * @param ownerNpub - Owner's npub for constructing links
 */
export function renderTreeView(
  repoName: string,
  ref: string,
  path: string,
  treeEntries: TreeEntry[] | null,
  ownerNpub?: string
): TemplateResult {
  if (treeEntries === null) {
    return {
      status: 404,
      html: '<div class="stub-page"><div class="stub-page-title">404</div><p>Path not found.</p></div>',
    };
  }

  const owner = ownerNpub ?? '';
  const breadcrumbs = renderBreadcrumbs(owner, repoName, ref, path);

  // Sort: directories first, then files, alphabetical within each group
  const sorted = [...treeEntries].sort((a, b) => {
    const aIsDir = a.mode === '40000' ? 0 : 1;
    const bIsDir = b.mode === '40000' ? 0 : 1;
    if (aIsDir !== bIsDir) return aIsDir - bIsDir;
    return a.name.localeCompare(b.name);
  });

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repoName);
  const encodedRef = encodeURIComponent(ref);
  const basePath = path ? `${path}/` : '';

  const rows = sorted
    .map((entry) => {
      const icon = getTreeEntryIcon(entry.mode);
      const escapedName = escapeHtml(entry.name);
      const isDir = entry.mode === '40000';
      const routeType = isDir ? 'tree' : 'blob';
      const encodedBasePath = basePath
        ? basePath
            .split('/')
            .filter(Boolean)
            .map((s) => encodeURIComponent(s))
            .join('/') + '/'
        : '';
      const entryPath = `${encodedBasePath}${encodeURIComponent(entry.name)}`;
      const href = escapeHtml(
        `/${encodedOwner}/${encodedRepo}/${routeType}/${encodedRef}/${entryPath}`
      );
      const modeDisplay = escapeHtml(entry.mode);

      return `<tr class="tree-entry">
  <td class="tree-entry-icon">${icon}</td>
  <td class="tree-entry-name"><a href="${href}">${escapedName}</a></td>
  <td class="tree-entry-mode">${modeDisplay}</td>
</tr>`;
    })
    .join('\n');

  const html = `${breadcrumbs}
<div class="tree-view">
<table class="tree-table">
<tbody>
${rows}
</tbody>
</table>
</div>`;

  return { status: 200, html };
}

/**
 * Renders a blob (file) view for a repository.
 *
 * @param repoName - Repository name
 * @param ref - Git ref (branch/tag name)
 * @param path - File path within the tree
 * @param content - File content as UTF-8 string, or null for 404
 * @param isBinary - Whether the blob is binary
 * @param sizeBytes - Size of the blob in bytes
 * @param ownerNpub - Owner's npub for constructing breadcrumb links
 */
export function renderBlobView(
  repoName: string,
  ref: string,
  path: string,
  content: string | null,
  isBinary = false,
  sizeBytes = 0,
  ownerNpub?: string
): TemplateResult {
  if (content === null && !isBinary) {
    return {
      status: 404,
      html: '<div class="stub-page"><div class="stub-page-title">404</div><p>File not found.</p></div>',
    };
  }

  const owner = ownerNpub ?? '';
  const breadcrumbs = renderBreadcrumbs(owner, repoName, ref, path);

  if (isBinary) {
    return {
      status: 200,
      html: `${breadcrumbs}
<div class="blob-view">
<div class="binary-notice">Binary file (${escapeHtml(String(sizeBytes))} bytes), not displayed</div>
</div>`,
    };
  }

  // Render text content with line numbers
  const escapedContent = escapeHtml(content ?? '');
  const lines = escapedContent.split('\n');
  const lineNumbersHtml = lines
    .map((_, i) => `<span class="line-number">${i + 1}</span>`)
    .join('\n');
  const codeHtml = lines.join('\n');

  return {
    status: 200,
    html: `${breadcrumbs}
<div class="blob-view">
<div class="blob-header">${escapeHtml(path.split('/').pop() ?? '')} (${escapeHtml(String(sizeBytes))} bytes)</div>
<div class="blob-content">
<pre class="blob-lines"><code>${lineNumbersHtml}</code></pre>
<pre class="blob-code"><code>${codeHtml}</code></pre>
</div>
</div>`,
  };
}

/**
 * Renders a commit diff view.
 */
export function renderCommitDiff(
  _repoName: string,
  _sha: string,
  commitData: unknown
): TemplateResult {
  if (commitData === null) {
    return {
      status: 404,
      html: '<div class="stub-page"><div class="stub-page-title">404</div><p>Commit not found.</p></div>',
    };
  }
  return {
    status: 200,
    html: '<div class="stub-page"><div class="stub-page-title">Commit Diff</div><p>Commit diff view — coming in Story 8.4.</p></div>',
  };
}

/**
 * Renders a blame view for a file.
 */
export function renderBlameView(
  _repoName: string,
  _ref: string,
  _path: string,
  blameData: unknown
): TemplateResult {
  if (blameData === null) {
    return {
      status: 404,
      html: '<div class="stub-page"><div class="stub-page-title">404</div><p>File not found for blame.</p></div>',
    };
  }
  return {
    status: 200,
    html: '<div class="stub-page"><div class="stub-page-title">Blame View</div><p>Blame view — coming in Story 8.5.</p></div>',
  };
}

/**
 * Renders a single issue's content with XSS prevention.
 */
export function renderIssueContent(issue: unknown): string {
  const i = issue as {
    title?: string;
    content?: string;
    pubkey?: string;
    id?: string;
    createdAt?: number;
  };
  const title = escapeHtml(i.title ?? '');
  const content = escapeHtml(i.content ?? '');
  const pubkey = escapeHtml((i.pubkey ?? '').slice(0, 12));

  return `<div class="issue">
  <h2 class="issue-title">${title}</h2>
  <div class="issue-meta">by ${pubkey}</div>
  <div class="issue-content">${content}</div>
</div>`;
}

/**
 * Renders the issues list page for a repository.
 */
export function renderIssuesPage(repoName: string, issues: unknown[]): string {
  const escapedName = escapeHtml(repoName);
  const issueHtml = issues.map((issue) => renderIssueContent(issue)).join('\n');
  const banner = `<div class="contribution-banner">
  <p>Active participation requires an ILP/Nostr client. See <a href="https://toon.dev/docs/getting-started" rel="noopener noreferrer" target="_blank">documentation</a> for getting started.</p>
</div>`;

  return `<div class="issues-page">
  <h1>Issues for ${escapedName}</h1>
  ${banner}
  ${issueHtml}
</div>`;
}

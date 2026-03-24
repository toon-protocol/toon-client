/**
 * Web templates for @toon-protocol/rig.
 *
 * Renders HTML templates for the git forge web UI with XSS prevention.
 * All user-supplied content is HTML-escaped before rendering.
 */

import { escapeHtml } from './escape.js';
import { hexToNpub } from './npub.js';
import type { ProfileCache } from './profile-cache.js';
import type {
  RepoMetadata,
  IssueMetadata,
  PRMetadata,
  CommentMetadata,
} from './nip34-parsers.js';
import type { TreeEntry } from './git-objects.js';
import { parseAuthorIdent } from './git-objects.js';
import { formatRelativeDate } from './date-utils.js';
import type { CommitLogEntry } from './commit-walker.js';
import type { TreeDiffEntry } from './tree-diff.js';
import type { DiffHunk } from './unified-diff.js';
import type { BlameResult } from './blame.js';
import { renderMarkdownSafe } from './markdown-safe.js';

/**
 * Build the base URL path for a repository.
 * Uses short form `/<repo>` when owner is empty, full form `/<owner>/<repo>` otherwise.
 */
function repoBasePath(owner: string, repo: string): string {
  const encodedRepo = encodeURIComponent(repo);
  if (!owner) return `/${encodedRepo}`;
  return `/${encodeURIComponent(owner)}/${encodedRepo}`;
}

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
      const repoHref = escapeHtml(`${repoBasePath('', r.repoId)}/`);

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

/** SVG icon for directories — clean Forgejo-style folder. */
const SVG_FOLDER =
  '<svg class="tree-icon" viewBox="0 0 16 16" width="16" height="16"><path fill="#54aeff" d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75z"/></svg>';

/** SVG icon for files — clean Forgejo-style document. */
const SVG_FILE =
  '<svg class="tree-icon" viewBox="0 0 16 16" width="16" height="16"><path fill="#656d76" d="M2 1.75C2 .784 2.784 0 3.75 0h6.586c.464 0 .909.184 1.237.513l2.914 2.914c.329.328.513.773.513 1.237v9.586A1.75 1.75 0 0 1 13.25 16h-9.5A1.75 1.75 0 0 1 2 14.25Zm1.75-.25a.25.25 0 0 0-.25.25v12.5c0 .138.112.25.25.25h9.5a.25.25 0 0 0 .25-.25V6h-2.75A1.75 1.75 0 0 1 9 4.25V1.5Zm6.75.062V4.25c0 .138.112.25.25.25h2.688l-.011-.013-2.914-2.914-.013-.011z"/></svg>';

/** SVG icon for symlinks. */
const SVG_SYMLINK =
  '<svg class="tree-icon" viewBox="0 0 16 16" width="16" height="16"><path fill="#656d76" d="M4.72 3.22a.75.75 0 0 1 1.06 0l3.25 3.25a.75.75 0 0 1 0 1.06l-3.25 3.25a.75.75 0 0 1-1.06-1.06L7.44 7 4.72 4.28a.75.75 0 0 1 0-1.06m4.25 6.56a.75.75 0 0 0 0 1.5h3.25a.75.75 0 0 0 0-1.5z"/></svg>';

/** SVG icon for submodules. */
const SVG_SUBMODULE =
  '<svg class="tree-icon" viewBox="0 0 16 16" width="16" height="16"><path fill="#656d76" d="M0 2.75C0 1.784.784 1 1.75 1H5c.55 0 1.07.26 1.4.7l.9 1.2a.25.25 0 0 0 .2.1h6.75c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 0 0 1 14.25 15H1.75A1.75 1.75 0 0 1 0 13.25Zm9.42 5.08a.75.75 0 0 0 0 1.34l3 1.5a.75.75 0 0 0 .67-1.34L11.44 8.5l1.64-.82a.75.75 0 1 0-.67-1.34Z"/></svg>';

/**
 * Get a display icon for a tree entry based on its mode.
 * Uses inline SVG for clean Forgejo-style rendering.
 */
function getTreeEntryIcon(mode: string): string {
  if (mode === '40000') return SVG_FOLDER;
  if (mode === '120000') return SVG_SYMLINK;
  if (mode === '160000') return SVG_SUBMODULE;
  return SVG_FILE;
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
  const base = repoBasePath(ownerNpub, repoName);
  const escapedRef = escapeHtml(ref);

  const crumbs: string[] = [];

  // Root repo link
  crumbs.push(
    `<a href="${base}/tree/${encodeURIComponent(ref)}/" class="breadcrumb-link">${escapedRepo}</a>`
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
      const href = `${base}/tree/${encodeURIComponent(ref)}/${encodedPartialPath}`;
      crumbs.push(
        `<a href="${escapeHtml(href)}" class="breadcrumb-link">${escapedSegment}</a>`
      );
    }
  }

  // Commits link next to ref badge
  const commitsHref = escapeHtml(`${base}/commits/${encodeURIComponent(ref)}`);
  const commitsLink = `<a href="${commitsHref}" class="breadcrumb-commits-link">Commits</a>`;

  return `<nav class="breadcrumbs"><span class="breadcrumb-ref">${escapedRef}</span> ${crumbs.join(' / ')} ${commitsLink}</nav>`;
}

/** HEAD commit info for the tree header row. */
export interface HeadCommitInfo {
  sha: string;
  message: string;
  authorName: string;
  relativeDate: string;
}

/** Options for tree view rendering enhancements. */
export interface TreeViewOptions {
  /** All branch/tag refs for the branch selector dropdown */
  allRefs?: Map<string, string>;
  /** Clone URLs from repo announcement */
  cloneUrls?: string[];
  /** Rendered README HTML (already safe-escaped) to show below the tree */
  readmeHtml?: string;
  /** README filename for display */
  readmeFilename?: string;
  /** HEAD commit info for the commit header row above the tree */
  headCommit?: HeadCommitInfo;
}

/**
 * Renders a tree (directory) view for a repository.
 *
 * @param repoName - Repository name
 * @param ref - Git ref (branch/tag name)
 * @param path - Current path within the tree
 * @param treeEntries - Parsed tree entries, or null for 404
 * @param ownerNpub - Owner's npub for constructing links
 * @param options - Optional enhancements (branch selector, clone URL, README)
 */
export function renderTreeView(
  repoName: string,
  ref: string,
  path: string,
  treeEntries: TreeEntry[] | null,
  ownerNpub?: string,
  options?: TreeViewOptions
): TemplateResult {
  if (treeEntries === null) {
    return {
      status: 404,
      html: '<div class="stub-page"><div class="stub-page-title">404</div><p>Path not found.</p></div>',
    };
  }

  const owner = ownerNpub ?? '';
  const tabs = renderRepoTabs(owner, repoName, 'code', ref);
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
  const base = repoBasePath(owner, repoName);
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
        `${base}/${routeType}/${encodedRef}/${entryPath}`
      );
      // Per-row commit message and date (from HEAD commit — per-file history requires expensive Arweave walks)
      const hc = options?.headCommit;
      let commitMsgCell = '<td class="tree-entry-message"></td>';
      let commitDateCell = '<td class="tree-entry-date"></td>';
      if (hc) {
        const firstLine = hc.message.split('\n')[0] ?? '';
        const truncMsg =
          firstLine.length > 50 ? firstLine.slice(0, 50) + '...' : firstLine;
        const commitHref = escapeHtml(
          `${base}/commit/${encodeURIComponent(hc.sha)}`
        );
        commitMsgCell = `<td class="tree-entry-message"><a href="${commitHref}">${escapeHtml(truncMsg)}</a></td>`;
        commitDateCell = `<td class="tree-entry-date">${escapeHtml(hc.relativeDate)}</td>`;
      }

      return `<tr class="tree-entry">
  <td class="tree-entry-icon">${icon}</td>
  <td class="tree-entry-name"><a href="${href}">${escapedName}</a></td>
  ${commitMsgCell}
  ${commitDateCell}
</tr>`;
    })
    .join('\n');

  // Branch selector dropdown
  let branchSelectorHtml = '';
  if (options?.allRefs && options.allRefs.size > 0) {
    const branchOptions = [...options.allRefs.keys()]
      .sort()
      .map((refName) => {
        const shortName = refName.replace(/^refs\/heads\//, '');
        const selected =
          refName === ref || shortName === ref ? ' selected' : '';
        const encodedRefName = encodeURIComponent(refName);
        return `<option value="${base}/tree/${encodedRefName}/"${selected}>${escapeHtml(shortName)}</option>`;
      })
      .join('\n');
    branchSelectorHtml = `<div class="branch-selector">
  <select class="branch-select" data-branch-nav="true">
    ${branchOptions}
  </select>
</div>`;
  }

  // Clone URL bar (Forgejo-style: protocol label + URL + Copy button)
  let cloneBarHtml = '';
  if (options?.cloneUrls && options.cloneUrls.length > 0 && !path) {
    const cloneUrl = options.cloneUrls[0]!;
    const isNostr = /^wss?:\/\//i.test(cloneUrl);
    const protocolLabel = isNostr ? 'Nostr' : 'HTTPS';
    const escapedUrl = escapeHtml(cloneUrl);
    cloneBarHtml = `<div class="clone-bar">
  <span class="clone-protocol">${protocolLabel}</span>
  <input class="clone-url" type="text" value="${escapedUrl}" readonly data-clone-url="true" />
  <button class="clone-copy-btn" data-copy-url="true" title="Copy URL">
    <svg viewBox="0 0 16 16" width="14" height="14"><path fill="currentColor" d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25ZM5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"/></svg>
  </button>
</div>`;
  }

  // README section
  let readmeHtml = '';
  if (options?.readmeHtml) {
    const readmeTitle = escapeHtml(options.readmeFilename ?? 'README.md');
    readmeHtml = `<div class="readme-container">
  <div class="readme-header">&#x1F4D6; ${readmeTitle}</div>
  <div class="readme-body">${options.readmeHtml}</div>
</div>`;
  }

  // HEAD commit header row (like Forgejo's "last commit" bar above tree)
  let commitHeaderHtml = '';
  if (options?.headCommit) {
    const hc = options.headCommit;
    const abbrevSha = escapeHtml(hc.sha.slice(0, 7));
    const commitHref = escapeHtml(
      `${base}/commit/${encodeURIComponent(hc.sha)}`
    );
    const firstLine = hc.message.split('\n')[0] ?? '';
    const truncMsg =
      firstLine.length > 72 ? firstLine.slice(0, 72) + '...' : firstLine;
    const escapedMsg = escapeHtml(truncMsg);
    const escapedAuthor = escapeHtml(hc.authorName);
    const escapedDate = escapeHtml(hc.relativeDate);
    commitHeaderHtml = `<div class="tree-commit-header">
  <span class="tree-commit-author">${escapedAuthor}</span>
  <a href="${commitHref}" class="tree-commit-message">${escapedMsg}</a>
  <span class="tree-commit-meta">
    <a href="${commitHref}" class="tree-commit-sha">${abbrevSha}</a>
    <span class="tree-commit-date">${escapedDate}</span>
  </span>
</div>`;
  }

  const html = `${tabs}
<div class="tree-toolbar">${branchSelectorHtml}${cloneBarHtml}</div>
${breadcrumbs}
<div class="tree-view">
${commitHeaderHtml}
<table class="tree-table">
<tbody>
${rows}
</tbody>
</table>
</div>
${readmeHtml}`;

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
  const base = repoBasePath(owner, repoName);
  const tabs = renderRepoTabs(owner, repoName, 'code', ref);
  const breadcrumbs = renderBreadcrumbs(owner, repoName, ref, path);

  if (isBinary) {
    return {
      status: 200,
      html: `${tabs}
${breadcrumbs}
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

  // Blame link for non-binary files
  const blameLink = (() => {
    const encodedOwner = encodeURIComponent(owner);
    const encodedRepo = encodeURIComponent(repoName);
    const encodedRef = encodeURIComponent(ref);
    const encodedPath = path
      .split('/')
      .filter(Boolean)
      .map((s) => encodeURIComponent(s))
      .join('/');
    const blameHref = escapeHtml(`${base}/blame/${encodedRef}/${encodedPath}`);
    return ` <a href="${blameHref}" class="blob-blame-link">Blame</a>`;
  })();

  return {
    status: 200,
    html: `${tabs}
${breadcrumbs}
<div class="blob-view">
<div class="blob-header"><span>${escapeHtml(path.split('/').pop() ?? '')} &middot; ${escapeHtml(String(sizeBytes))} bytes</span>${blameLink}</div>
<div class="blob-content">
<pre class="blob-lines"><code>${lineNumbersHtml}</code></pre>
<pre class="blob-code"><code>${codeHtml}</code></pre>
</div>
</div>`,
  };
}

/**
 * A file diff entry for the commit diff view.
 */
export interface FileDiff {
  /** File name */
  name: string;
  /** Change status */
  status: 'added' | 'deleted' | 'modified';
  /** Diff hunks for text files */
  hunks: DiffHunk[];
  /** Whether this is a binary file */
  isBinary: boolean;
}

/**
 * Render breadcrumb navigation for a commit view (log or diff).
 */
function renderCommitBreadcrumbs(
  ownerNpub: string,
  repoName: string,
  ref?: string,
  activeLabel?: string
): string {
  const escapedRepo = escapeHtml(repoName);
  const encodedOwner = encodeURIComponent(ownerNpub);
  const encodedRepo = encodeURIComponent(repoName);
  const base = repoBasePath(ownerNpub, repoName);

  const treeRef = ref ? encodeURIComponent(ref) : 'main';
  const crumbs: string[] = [];

  crumbs.push(
    `<a href="${base}/tree/${treeRef}/" class="breadcrumb-link">${escapedRepo}</a>`
  );

  if (activeLabel) {
    crumbs.push(
      `<span class="breadcrumb-active">${escapeHtml(activeLabel)}</span>`
    );
  }

  const refBadge = ref
    ? `<span class="breadcrumb-ref">${escapeHtml(ref)}</span> `
    : '';

  return `<nav class="breadcrumbs">${refBadge}${crumbs.join(' / ')}</nav>`;
}

/**
 * Renders the commit log page.
 *
 * @param repoName - Repository name
 * @param ref - Git ref (branch/tag name)
 * @param commits - Array of CommitLogEntry from the chain walker
 * @param ownerNpub - Owner's npub for constructing links
 */
export function renderCommitLog(
  repoName: string,
  ref: string,
  commits: CommitLogEntry[],
  ownerNpub?: string
): TemplateResult {
  const owner = ownerNpub ?? '';
  const tabs = renderRepoTabs(owner, repoName, 'code', ref);
  const breadcrumbs = renderCommitBreadcrumbs(owner, repoName, ref, 'Commits');

  if (!commits || commits.length === 0) {
    return {
      status: 200,
      html: `${tabs}
${breadcrumbs}<div class="empty-state"><div class="empty-state-title">No commits found</div><div class="empty-state-message">No commits are available for this ref.</div></div>`,
    };
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repoName);
  const base = repoBasePath(owner, repoName);

  const rows = commits
    .map((entry) => {
      const abbrevSha = escapeHtml(entry.sha.slice(0, 7));
      const fullSha = escapeHtml(entry.sha);
      const commitHref = escapeHtml(
        `${base}/commit/${encodeURIComponent(entry.sha)}`
      );

      // First line of message, truncated to 72 chars
      const firstLine = entry.commit.message.split('\n')[0] ?? '';
      const truncatedMessage =
        firstLine.length > 72 ? firstLine.slice(0, 72) + '...' : firstLine;
      const escapedMessage = escapeHtml(truncatedMessage);

      // Parse author identity
      const ident = parseAuthorIdent(entry.commit.author);
      const authorName = escapeHtml(ident?.name ?? 'Unknown');
      const relativeDate = ident
        ? escapeHtml(formatRelativeDate(ident.timestamp))
        : '';

      return `<div class="commit-row">
  <div class="commit-row-main">
    <a href="${commitHref}" class="commit-sha" title="${fullSha}">${abbrevSha}</a>
    <span class="commit-message">${escapedMessage}</span>
  </div>
  <div class="commit-row-meta">
    <span class="commit-author">${authorName}</span>
    <span class="commit-date">${relativeDate}</span>
  </div>
</div>`;
    })
    .join('\n');

  return {
    status: 200,
    html: `${tabs}
${breadcrumbs}
<div class="commit-log">
${rows}
</div>`,
  };
}

/**
 * Renders a commit diff view.
 *
 * @param repoName - Repository name
 * @param sha - Commit SHA
 * @param commit - The commit log entry, or null for 404
 * @param diffEntries - Tree diff entries
 * @param fileDiffs - File-level diffs with hunks
 * @param ownerNpub - Owner's npub for constructing links
 */
export function renderCommitDiff(
  repoName: string,
  sha: string,
  commit: CommitLogEntry | null,
  diffEntries?: TreeDiffEntry[],
  fileDiffs?: FileDiff[],
  ownerNpub?: string
): TemplateResult {
  if (commit === null) {
    return {
      status: 404,
      html: '<div class="stub-page"><div class="stub-page-title">404</div><p>Commit not found.</p></div>',
    };
  }

  const owner = ownerNpub ?? '';
  const base = repoBasePath(owner, repoName);
  const tabs = renderRepoTabs(owner, repoName, 'code');
  const breadcrumbs = renderCommitBreadcrumbs(
    owner,
    repoName,
    undefined,
    'Commit'
  );
  const entries = diffEntries ?? [];
  const diffs = fileDiffs ?? [];

  // Commit header
  const escapedMessage = escapeHtml(commit.commit.message);
  const ident = parseAuthorIdent(commit.commit.author);
  const authorName = escapeHtml(ident?.name ?? 'Unknown');
  const authorEmail = escapeHtml(ident?.email ?? '');
  const relativeDate = ident
    ? escapeHtml(formatRelativeDate(ident.timestamp))
    : '';
  const escapedSha = escapeHtml(sha);

  const parentShasHtml =
    commit.commit.parentShas.length > 0
      ? commit.commit.parentShas
          .map((p) => {
            const encodedOwner = encodeURIComponent(owner);
            const encodedRepo = encodeURIComponent(repoName);
            const href = escapeHtml(`${base}/commit/${encodeURIComponent(p)}`);
            return `<a href="${href}" class="commit-parent-link">${escapeHtml(p.slice(0, 7))}</a>`;
          })
          .join(', ')
      : '<span class="commit-root-label">root commit</span>';

  // File change summary
  const addedCount = entries.filter((e) => e.status === 'added').length;
  const deletedCount = entries.filter((e) => e.status === 'deleted').length;
  const modifiedCount = entries.filter((e) => e.status === 'modified').length;

  // File diffs
  const fileDiffHtml = diffs
    .map((fileDiff) => {
      const statusBadge = getStatusBadge(fileDiff.status);
      const escapedName = escapeHtml(fileDiff.name);

      let diffContent: string;
      if (fileDiff.isBinary) {
        diffContent = '<div class="diff-binary">Binary file changed</div>';
      } else if (fileDiff.hunks.length === 0) {
        diffContent = '';
      } else {
        const hunkHtml = fileDiff.hunks
          .map((hunk) => {
            const linesHtml = hunk.lines
              .map((line) => {
                const prefix =
                  line.type === 'add'
                    ? '+'
                    : line.type === 'delete'
                      ? '-'
                      : ' ';
                const cssClass = `diff-line diff-line-${line.type}`;
                return `<div class="${cssClass}">${escapeHtml(prefix + line.content)}</div>`;
              })
              .join('');
            return `<div class="diff-hunk">
<div class="diff-hunk-header">@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@</div>
${linesHtml}
</div>`;
          })
          .join('');
        diffContent = hunkHtml;
      }

      return `<div class="diff-file">
<div class="diff-file-header">
  ${statusBadge} <span class="diff-file-name">${escapedName}</span>
</div>
<div class="diff-file-content">
${diffContent}
</div>
</div>`;
    })
    .join('\n');

  return {
    status: 200,
    html: `${tabs}
${breadcrumbs}
<div class="commit-diff">
<div class="commit-diff-header">
  <pre class="commit-diff-message">${escapedMessage}</pre>
  <div class="commit-diff-meta">
    <span class="commit-author">${authorName}</span>
    ${authorEmail ? `<span class="commit-email">&lt;${authorEmail}&gt;</span>` : ''}
    <span class="commit-date">${relativeDate}</span>
  </div>
  <div class="commit-diff-info">
    <span class="commit-sha-label">Commit:</span> <span class="commit-sha-full">${escapedSha}</span>
  </div>
  <div class="commit-diff-parents">
    <span class="commit-parent-label">Parent:</span> ${parentShasHtml}
  </div>
</div>
<div class="commit-diff-summary">
  <span class="diff-stat diff-stat-added">${addedCount} added</span>
  <span class="diff-stat diff-stat-deleted">${deletedCount} deleted</span>
  <span class="diff-stat diff-stat-modified">${modifiedCount} modified</span>
</div>
<div class="commit-diff-files">
${fileDiffHtml}
</div>
</div>`,
  };
}

/**
 * Get an HTML status badge for a file change type.
 */
function getStatusBadge(status: 'added' | 'deleted' | 'modified'): string {
  const label = status === 'added' ? 'A' : status === 'deleted' ? 'D' : 'M';
  return `<span class="diff-status-badge diff-status-${status}">${label}</span>`;
}

/**
 * Renders a blame view for a file.
 *
 * @param repoName - Repository name
 * @param ref - Git ref (branch/tag name)
 * @param path - File path within the repository
 * @param blameResult - Blame result, or null for 404/binary
 * @param isBinary - Whether the file is binary (affects error message)
 * @param ownerNpub - Owner's npub for constructing links
 */
export function renderBlameView(
  repoName: string,
  ref: string,
  path: string,
  blameResult: BlameResult | null,
  isBinary?: boolean,
  ownerNpub?: string
): TemplateResult {
  if (blameResult === null) {
    const message = isBinary
      ? 'Binary files cannot be blamed'
      : 'File not found for blame.';
    return {
      status: 404,
      html: `<div class="stub-page"><div class="stub-page-title">404</div><p>${escapeHtml(message)}</p></div>`,
    };
  }

  const owner = ownerNpub ?? '';
  const tabs = renderRepoTabs(owner, repoName, 'code', ref);
  const breadcrumbs = renderBreadcrumbs(owner, repoName, ref, path);
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repoName);
  const base = repoBasePath(owner, repoName);

  // Build blame table rows with grouping
  const rows: string[] = [];
  let prevCommitSha = '';
  const fileLines = blameResult.fileContent.split('\n');

  for (let i = 0; i < blameResult.lines.length; i++) {
    const line = blameResult.lines[i]!;
    const lineContent = escapeHtml(fileLines[i] ?? '');
    const isNewGroup = line.commitSha !== prevCommitSha;
    const groupClass = isNewGroup ? ' blame-group-start' : '';

    let commitInfoHtml: string;
    if (isNewGroup) {
      const abbrevSha = escapeHtml(line.commitSha.slice(0, 7));
      const commitHref = escapeHtml(
        `${base}/commit/${encodeURIComponent(line.commitSha)}`
      );
      const ident = parseAuthorIdent(line.author);
      const authorName = escapeHtml(ident?.name ?? 'Unknown');
      const relativeDate = ident
        ? escapeHtml(formatRelativeDate(ident.timestamp))
        : '';

      commitInfoHtml = `<td class="blame-sha"><a href="${commitHref}">${abbrevSha}</a></td>
  <td class="blame-author">${authorName}</td>
  <td class="blame-date">${relativeDate}</td>`;
    } else {
      commitInfoHtml = `<td class="blame-sha"></td>
  <td class="blame-author"></td>
  <td class="blame-date"></td>`;
    }

    rows.push(`<tr class="blame-line${groupClass}">
  ${commitInfoHtml}
  <td class="blame-line-number">${line.lineNumber}</td>
  <td class="blame-content"><pre>${lineContent}</pre></td>
</tr>`);

    prevCommitSha = line.commitSha;
  }

  const beyondLimitNotice = blameResult.beyondLimit
    ? `<div class="blame-depth-notice">Blame history limited to ${escapeHtml(String(blameResult.maxDepth))} commits. Older attributions may be approximate.</div>`
    : '';

  const html = `${tabs}
${breadcrumbs}
<div class="blame-view">
<table class="blame-table">
<tbody>
${rows.join('\n')}
</tbody>
</table>
${beyondLimitNotice}
</div>`;

  return { status: 200, html };
}

// ============================================================================
// Shared Helpers (Story 8.5)
// ============================================================================

/**
 * Render the contribution banner displayed on issue/PR pages.
 */
function renderContributionBanner(): string {
  return `<div class="contribution-banner">Forge-UI is read-only. To create issues or submit patches, use a TOON agent with the NIP-34 skill.</div>`;
}

/**
 * Render repository navigation tabs (Code / Issues / Pull Requests).
 */
export function renderRepoTabs(
  owner: string,
  repo: string,
  activeTab: 'code' | 'issues' | 'pulls',
  ref?: string
): string {
  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repo);
  const base = repoBasePath(owner, repo);

  const codeHref = ref
    ? escapeHtml(`${base}/tree/${encodeURIComponent(ref)}/`)
    : escapeHtml(`${base}/`);
  const issuesHref = escapeHtml(`${base}/issues`);
  const pullsHref = escapeHtml(`${base}/pulls`);

  const codeActive = activeTab === 'code' ? ' tab-active' : '';
  const issuesActive = activeTab === 'issues' ? ' tab-active' : '';
  const pullsActive = activeTab === 'pulls' ? ' tab-active' : '';

  return `<nav class="repo-tabs">
  <a href="${codeHref}" class="repo-tab${codeActive}">Code</a>
  <a href="${issuesHref}" class="repo-tab${issuesActive}">Issues</a>
  <a href="${pullsHref}" class="repo-tab${pullsActive}">Pull Requests</a>
</nav>`;
}

/**
 * Get a display name for a pubkey using the profile cache.
 */
function getAuthorDisplay(pubkey: string, profileCache: ProfileCache): string {
  return escapeHtml(profileCache.getDisplayName(pubkey));
}

// ============================================================================
// Issue Templates (Story 8.5)
// ============================================================================

/**
 * Renders the issue list page for a repository.
 */
export function renderIssueList(
  repoName: string,
  issues: IssueMetadata[],
  profileCache: ProfileCache,
  ownerNpub?: string
): TemplateResult {
  const owner = ownerNpub ?? '';
  const base = repoBasePath(owner, repoName);
  const tabs = renderRepoTabs(owner, repoName, 'issues');
  const banner = renderContributionBanner();

  if (!issues || issues.length === 0) {
    return {
      status: 200,
      html: `${tabs}
${banner}
<div class="empty-state">
  <div class="empty-state-title">No issues found for this repository.</div>
  <div class="empty-state-message">Issues are created by publishing kind:1621 events to the relay.</div>
</div>`,
    };
  }

  const rows = issues
    .map((issue) => {
      const title = escapeHtml(issue.title);
      const author = getAuthorDisplay(issue.authorPubkey, profileCache);
      const date = escapeHtml(formatRelativeDate(issue.createdAt));
      const statusClass =
        issue.status === 'closed' ? 'status-closed' : 'status-open';
      const statusLabel = escapeHtml(issue.status);
      const encodedOwner = encodeURIComponent(owner);
      const encodedRepo = encodeURIComponent(repoName);
      const detailHref = escapeHtml(
        `${base}/issues/${encodeURIComponent(issue.eventId)}`
      );

      const labelBadges = issue.labels
        .map((l) => `<span class="label-badge">${escapeHtml(l)}</span>`)
        .join(' ');

      return `<div class="issue-row">
  <div class="issue-row-main">
    <span class="status-badge ${statusClass}">${statusLabel}</span>
    <a href="${detailHref}" class="issue-title-link">${title}</a>
    ${labelBadges}
  </div>
  <div class="issue-row-meta">
    <span class="issue-author">${author}</span>
    <span class="issue-date">${date}</span>
  </div>
</div>`;
    })
    .join('\n');

  return {
    status: 200,
    html: `${tabs}
${banner}
<div class="issue-list">
${rows}
</div>`,
  };
}

/**
 * Renders the issue detail page.
 */
export function renderIssueDetail(
  repoName: string,
  issue: IssueMetadata,
  comments: CommentMetadata[],
  profileCache: ProfileCache,
  ownerNpub?: string
): TemplateResult {
  const owner = ownerNpub ?? '';
  const tabs = renderRepoTabs(owner, repoName, 'issues');
  const banner = renderContributionBanner();

  const title = escapeHtml(issue.title);
  const author = getAuthorDisplay(issue.authorPubkey, profileCache);
  const date = escapeHtml(formatRelativeDate(issue.createdAt));
  const statusClass =
    issue.status === 'closed' ? 'status-closed' : 'status-open';
  const statusLabel = escapeHtml(issue.status);
  const body = renderMarkdownSafe(issue.content);

  const labelBadges = issue.labels
    .map((l) => `<span class="label-badge">${escapeHtml(l)}</span>`)
    .join(' ');

  const commentHtml = comments
    .map((c) => {
      const cAuthor = getAuthorDisplay(c.authorPubkey, profileCache);
      const cDate = escapeHtml(formatRelativeDate(c.createdAt));
      const cBody = renderMarkdownSafe(c.content);
      return `<div class="comment">
  <div class="comment-header">
    <span class="comment-author">${cAuthor}</span>
    <span class="comment-date">${cDate}</span>
  </div>
  <div class="comment-body">${cBody}</div>
</div>`;
    })
    .join('\n');

  return {
    status: 200,
    html: `${tabs}
${banner}
<div class="issue-detail">
  <div class="issue-detail-header">
    <h2 class="issue-detail-title">${title}</h2>
    <div class="issue-detail-meta">
      <span class="status-badge ${statusClass}">${statusLabel}</span>
      <span class="issue-author">${author}</span>
      <span class="issue-date">${date}</span>
      ${labelBadges}
    </div>
  </div>
  <div class="issue-detail-body">${body}</div>
  <div class="comment-thread">
${commentHtml}
  </div>
</div>`,
  };
}

// ============================================================================
// PR Templates (Story 8.5)
// ============================================================================

/**
 * Renders the pull request list page for a repository.
 */
export function renderPRList(
  repoName: string,
  prs: PRMetadata[],
  profileCache: ProfileCache,
  ownerNpub?: string
): TemplateResult {
  const owner = ownerNpub ?? '';
  const base = repoBasePath(owner, repoName);
  const tabs = renderRepoTabs(owner, repoName, 'pulls');
  const banner = renderContributionBanner();

  if (!prs || prs.length === 0) {
    return {
      status: 200,
      html: `${tabs}
${banner}
<div class="empty-state">
  <div class="empty-state-title">No pull requests found for this repository.</div>
  <div class="empty-state-message">Pull requests are created by publishing kind:1617 patch events to the relay.</div>
</div>`,
    };
  }

  const rows = prs
    .map((pr) => {
      const title = escapeHtml(pr.title);
      const author = getAuthorDisplay(pr.authorPubkey, profileCache);
      const date = escapeHtml(formatRelativeDate(pr.createdAt));
      const statusClass = `status-${pr.status}`;
      const statusLabel = escapeHtml(pr.status);
      const baseBranch = escapeHtml(pr.baseBranch);
      const encodedOwner = encodeURIComponent(owner);
      const encodedRepo = encodeURIComponent(repoName);
      const detailHref = escapeHtml(
        `${base}/pulls/${encodeURIComponent(pr.eventId)}`
      );

      return `<div class="pr-row">
  <div class="pr-row-main">
    <span class="status-badge ${statusClass}">${statusLabel}</span>
    <a href="${detailHref}" class="pr-title-link">${title}</a>
    <span class="pr-base-branch">${baseBranch}</span>
  </div>
  <div class="pr-row-meta">
    <span class="pr-author">${author}</span>
    <span class="pr-date">${date}</span>
  </div>
</div>`;
    })
    .join('\n');

  return {
    status: 200,
    html: `${tabs}
${banner}
<div class="pr-list">
${rows}
</div>`,
  };
}

/**
 * Renders the pull request detail page.
 */
export function renderPRDetail(
  repoName: string,
  pr: PRMetadata,
  comments: CommentMetadata[],
  profileCache: ProfileCache,
  ownerNpub?: string
): TemplateResult {
  const owner = ownerNpub ?? '';
  const tabs = renderRepoTabs(owner, repoName, 'pulls');
  const banner = renderContributionBanner();

  const title = escapeHtml(pr.title);
  const author = getAuthorDisplay(pr.authorPubkey, profileCache);
  const date = escapeHtml(formatRelativeDate(pr.createdAt));
  const statusClass = `status-${pr.status}`;
  const statusLabel = escapeHtml(pr.status);
  const baseBranch = escapeHtml(pr.baseBranch);
  const body = renderMarkdownSafe(pr.content);

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repoName);
  const base = repoBasePath(owner, repoName);

  const commitLinks = pr.commitShas
    .map((sha) => {
      const abbrev = escapeHtml(sha.slice(0, 7));
      const commitHref = escapeHtml(
        `${base}/commit/${encodeURIComponent(sha)}`
      );
      return `<a href="${commitHref}" class="commit-sha">${abbrev}</a>`;
    })
    .join(', ');

  const commentHtml = comments
    .map((c) => {
      const cAuthor = getAuthorDisplay(c.authorPubkey, profileCache);
      const cDate = escapeHtml(formatRelativeDate(c.createdAt));
      const cBody = renderMarkdownSafe(c.content);
      return `<div class="comment">
  <div class="comment-header">
    <span class="comment-author">${cAuthor}</span>
    <span class="comment-date">${cDate}</span>
  </div>
  <div class="comment-body">${cBody}</div>
</div>`;
    })
    .join('\n');

  const commitsSection = commitLinks
    ? `<div class="pr-commits"><span class="pr-commits-label">Commits:</span> ${commitLinks}</div>`
    : '';

  return {
    status: 200,
    html: `${tabs}
${banner}
<div class="pr-detail">
  <div class="pr-detail-header">
    <h2 class="pr-detail-title">${title}</h2>
    <div class="pr-detail-meta">
      <span class="status-badge ${statusClass}">${statusLabel}</span>
      <span class="pr-author">${author}</span>
      <span class="pr-date">${date}</span>
      <span class="pr-base-branch">${baseBranch}</span>
    </div>
    ${commitsSection}
  </div>
  <div class="pr-detail-body">${body}</div>
  <div class="comment-thread">
${commentHtml}
  </div>
</div>`,
  };
}

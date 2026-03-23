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
import { parseAuthorIdent } from './git-objects.js';
import { formatRelativeDate } from './date-utils.js';
import type { CommitLogEntry } from './commit-walker.js';
import type { TreeDiffEntry } from './tree-diff.js';
import type { DiffHunk } from './unified-diff.js';

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

  // Commits link next to ref badge
  const commitsHref = escapeHtml(
    `/${encodedOwner}/${encodedRepo}/commits/${encodeURIComponent(ref)}`
  );
  const commitsLink = `<a href="${commitsHref}" class="breadcrumb-commits-link">Commits</a>`;

  return `<nav class="breadcrumbs"><span class="breadcrumb-ref">${escapedRef}</span> ${crumbs.join(' / ')} ${commitsLink}</nav>`;
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

  const treeRef = ref ? encodeURIComponent(ref) : 'main';
  const crumbs: string[] = [];

  crumbs.push(
    `<a href="/${encodedOwner}/${encodedRepo}/tree/${treeRef}/" class="breadcrumb-link">${escapedRepo}</a>`
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
  const breadcrumbs = renderCommitBreadcrumbs(owner, repoName, ref, 'Commits');

  if (!commits || commits.length === 0) {
    return {
      status: 200,
      html: `${breadcrumbs}<div class="empty-state"><div class="empty-state-title">No commits found</div><div class="empty-state-message">No commits are available for this ref.</div></div>`,
    };
  }

  const encodedOwner = encodeURIComponent(owner);
  const encodedRepo = encodeURIComponent(repoName);

  const rows = commits
    .map((entry) => {
      const abbrevSha = escapeHtml(entry.sha.slice(0, 7));
      const fullSha = escapeHtml(entry.sha);
      const commitHref = escapeHtml(
        `/${encodedOwner}/${encodedRepo}/commit/${encodeURIComponent(entry.sha)}`
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
    html: `${breadcrumbs}
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
            const href = escapeHtml(
              `/${encodedOwner}/${encodedRepo}/commit/${encodeURIComponent(p)}`
            );
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
    html: `${breadcrumbs}
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

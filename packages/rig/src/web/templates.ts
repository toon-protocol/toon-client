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
 * Renders a tree (directory) view for a repository.
 */
export function renderTreeView(
  _repoName: string,
  _ref: string,
  _path: string,
  treeEntries: unknown[] | null
): TemplateResult {
  if (treeEntries === null) {
    return {
      status: 404,
      html: '<div class="stub-page"><div class="stub-page-title">404</div><p>Path not found.</p></div>',
    };
  }
  return {
    status: 200,
    html: '<div class="stub-page"><div class="stub-page-title">File Tree</div><p>File tree view — coming in Story 8.2.</p></div>',
  };
}

/**
 * Renders a blob (file) view for a repository.
 */
export function renderBlobView(
  _repoName: string,
  _ref: string,
  _path: string,
  content: string | null
): TemplateResult {
  if (content === null) {
    return {
      status: 404,
      html: '<div class="stub-page"><div class="stub-page-title">404</div><p>File not found.</p></div>',
    };
  }
  return {
    status: 200,
    html: '<div class="stub-page"><div class="stub-page-title">File View</div><p>Blob view — coming in Story 8.3.</p></div>',
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

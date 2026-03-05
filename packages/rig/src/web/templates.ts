/**
 * Web templates for @crosstown/rig.
 *
 * Stub: Will be implemented as part of the rig epic.
 * Renders HTML templates for the git forge web UI with XSS prevention.
 */

export interface TemplateResult {
  status: number;
  html: string;
}

/**
 * Renders the repository list page.
 */
export function renderRepoList(_repos: unknown[]): string {
  throw new Error('renderRepoList is not yet implemented');
}

/**
 * Renders a tree (directory) view for a repository.
 */
export function renderTreeView(
  _repoName: string,
  _ref: string,
  _path: string,
  _treeEntries: unknown[] | null
): TemplateResult {
  throw new Error('renderTreeView is not yet implemented');
}

/**
 * Renders a blob (file) view for a repository.
 */
export function renderBlobView(
  _repoName: string,
  _ref: string,
  _path: string,
  _content: string | null
): TemplateResult {
  throw new Error('renderBlobView is not yet implemented');
}

/**
 * Renders a commit diff view.
 */
export function renderCommitDiff(
  _repoName: string,
  _sha: string,
  _commitData: unknown
): TemplateResult {
  throw new Error('renderCommitDiff is not yet implemented');
}

/**
 * Renders a blame view for a file.
 */
export function renderBlameView(
  _repoName: string,
  _ref: string,
  _path: string,
  _blameData: unknown
): TemplateResult {
  throw new Error('renderBlameView is not yet implemented');
}

/**
 * Renders a single issue's content with XSS prevention.
 */
export function renderIssueContent(_issue: unknown): string {
  throw new Error('renderIssueContent is not yet implemented');
}

/**
 * Renders the issues list page for a repository.
 */
export function renderIssuesPage(
  _repoName: string,
  _issues: unknown[]
): string {
  throw new Error('renderIssuesPage is not yet implemented');
}

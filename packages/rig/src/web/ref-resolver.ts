/**
 * Default branch/ref resolution for Forge-UI.
 *
 * Resolves the default ref (branch) from repository metadata and refs events.
 */

import type { RepoMetadata, RepoRefs } from './nip34-parsers.js';

/**
 * Resolved ref result.
 */
export interface ResolvedRef {
  /** The ref name that was resolved */
  refName: string;
  /** The commit SHA the ref points to */
  commitSha: string;
}

/**
 * Resolve the default ref for a repository.
 *
 * Resolution order:
 * 1. The default branch from kind:30617 repo metadata
 * 2. `HEAD` ref
 * 3. First available ref
 *
 * @param repoMeta - Repository metadata from kind:30617
 * @param repoRefs - Repository refs from kind:30618
 * @returns Resolved ref with name and commit SHA, or null if no refs available
 */
export function resolveDefaultRef(
  repoMeta: RepoMetadata,
  repoRefs: RepoRefs
): ResolvedRef | null {
  if (repoRefs.refs.size === 0) {
    return null;
  }

  // 1. Try the default branch from repo metadata
  const defaultBranch = repoMeta.defaultBranch;
  const defaultSha = repoRefs.refs.get(defaultBranch);
  if (defaultSha) {
    return { refName: defaultBranch, commitSha: defaultSha };
  }

  // 2. Try HEAD
  const headSha = repoRefs.refs.get('HEAD');
  if (headSha) {
    return { refName: 'HEAD', commitSha: headSha };
  }

  // 3. Use the first available ref
  const firstEntry = repoRefs.refs.entries().next();
  if (!firstEntry.done) {
    const [refName, commitSha] = firstEntry.value;
    return { refName, commitSha };
  }

  return null;
}

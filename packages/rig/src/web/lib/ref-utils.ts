import type { RepoRefs } from '../nip34-parsers.js';

/**
 * Strip the refs/heads/ or refs/tags/ prefix from a ref name for URL display.
 */
export function shortRefName(fullRef: string): string {
  if (fullRef.startsWith('refs/heads/')) return fullRef.slice('refs/heads/'.length);
  if (fullRef.startsWith('refs/tags/')) return fullRef.slice('refs/tags/'.length);
  return fullRef;
}

/**
 * Resolve a short ref name (from URL) back to a commit SHA.
 * Tries: exact match, refs/heads/<ref>, refs/tags/<ref>.
 */
export function resolveRefSha(ref: string, refs: RepoRefs): string | undefined {
  return (
    refs.refs.get(ref) ??
    refs.refs.get(`refs/heads/${ref}`) ??
    refs.refs.get(`refs/tags/${ref}`)
  );
}

import { useState, useEffect } from 'react';
import { resolveGitSha, ARWEAVE_GATEWAYS } from '../arweave-client.js';
import { parseGitTree } from '../git-objects.js';
import { fetchArweaveObject } from '../arweave-client.js';
import type { RepoRefs } from '../nip34-parsers.js';

/**
 * Async-resolve relative image src attributes in a markdown HTML string
 * by walking the git tree to find blob SHAs, then mapping to Arweave URLs.
 *
 * Returns a new HTML string with resolved image URLs.
 */
export function useResolveImages(
  html: string | null,
  treeSha: string | null,
  repoId: string,
  _refs: RepoRefs | null,
): string | null {
  const [resolved, setResolved] = useState(html);

  useEffect(() => {
    if (!html || !treeSha) {
      setResolved(html);
      return;
    }

    // Find all relative image src attributes in the HTML
    const imgSrcRegex = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
    const relativePaths: { fullMatch: string; path: string }[] = [];
    let match;
    while ((match = imgSrcRegex.exec(html)) !== null) {
      const src = match[1] ?? '';
      if (/^(?:https?:\/\/|data:|\/\/|blob:|#)/i.test(src)) continue;
      relativePaths.push({ fullMatch: match[0], path: src });
    }

    if (relativePaths.length === 0) {
      setResolved(html);
      return;
    }

    let cancelled = false;

    (async () => {
      const replacements = new Map<string, string>();

      for (const { path } of relativePaths) {
        if (cancelled) return;
        try {
          const segments = path.split('/').filter(Boolean);
          let currentSha = treeSha;

          for (const segment of segments) {
            const txId = await resolveGitSha(currentSha, repoId);
            if (!txId || cancelled) return;
            const data = await fetchArweaveObject(txId);
            if (!data || cancelled) return;
            const entries = parseGitTree(data);
            const entry = entries.find((e) => e.name === segment);
            if (!entry || cancelled) return;
            currentSha = entry.sha;
          }

          const blobTxId = await resolveGitSha(currentSha, repoId);
          if (blobTxId && !cancelled) {
            replacements.set(path, `${ARWEAVE_GATEWAYS[0]}/${blobTxId}`);
          }
        } catch {
          // Skip unresolvable images
        }
      }

      if (cancelled || replacements.size === 0) return;

      // Replace all resolved paths in the HTML string
      let newHtml = html;
      for (const [oldPath, newUrl] of replacements) {
        // Replace src="oldPath" with src="newUrl" (escape special regex chars in path)
        const escaped = oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        newHtml = newHtml.replace(
          new RegExp(`(src=")${escaped}(")`, 'g'),
          `$1${newUrl}$2`,
        );
      }

      setResolved(newHtml);
    })();

    return () => { cancelled = true; };
  }, [html, treeSha, repoId, _refs]);

  return resolved;
}

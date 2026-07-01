/**
 * Git-SHA → Arweave transaction ID resolution.
 *
 * Git objects uploaded to Arweave are tagged with `Git-SHA` (the object's
 * SHA-1) and `Repo` (the repository identifier, matching the NIP-34 `d` tag).
 * This module resolves a git SHA to its Arweave tx id via the Arweave GraphQL
 * gateway, with a bounded in-memory cache that can be pre-seeded from relay
 * state (kind:30618 `arweave` tags) to skip the GraphQL indexing delay.
 *
 * Extracted verbatim from rig's `web/arweave-client.ts` (#225) so the browser
 * SPA (rig) and the Node write path (@toon-protocol/git) share ONE resolver.
 * Uses only WHATWG fetch + AbortSignal.timeout — browser and Node compatible.
 */

import { ARWEAVE_FETCH_TIMEOUT_MS } from './gateways.js';

/** Arweave GraphQL endpoint used for Git-SHA tag lookups. */
const ARWEAVE_GRAPHQL_URL = 'https://arweave.net/graphql';

/** Maximum number of entries in the SHA-to-txId cache to prevent unbounded memory growth. */
const SHA_CACHE_MAX_SIZE = 10000;

/** In-memory cache for SHA-to-txId resolution. Bounded to prevent memory leaks. */
const shaToTxIdCache = new Map<string, string>();

/**
 * Validate a git SHA-1 hash format (40-character hex string).
 */
function isValidGitSha(sha: string): boolean {
  return /^[0-9a-f]{40}$/i.test(sha);
}

/**
 * Sanitize a string for safe inclusion in a GraphQL query.
 * Removes characters that could break out of a GraphQL string literal,
 * including backticks which some GraphQL parsers may interpret.
 */
function sanitizeGraphQLValue(value: string): string {
  // eslint-disable-next-line no-control-regex -- intentional: strip control chars for GraphQL safety
  return value.replace(/["\\\n\r\u0000-\u001f`]/g, '');
}

/**
 * Build the cache key used by {@link resolveGitSha} / {@link seedShaCache}.
 *
 * The cache is keyed on `"sha:repo"` so the same SHA in different repos
 * resolves independently (uploads are tagged per-repo).
 */
export function shaCacheKey(sha: string, repo: string): string {
  return `${sha}:${repo}`;
}

/**
 * Clear the SHA-to-txId cache. Used for test isolation.
 */
export function clearShaCache(): void {
  shaToTxIdCache.clear();
}

/**
 * Pre-seed the SHA-to-txId cache with known mappings.
 *
 * Used when txId mappings are available from relay events (e.g., kind:30618
 * `arweave` tags) to avoid the GraphQL indexing delay after Turbo/Irys uploads.
 *
 * @param mappings - Map of "sha:repo" cache keys to Arweave transaction IDs
 */
export function seedShaCache(
  mappings: Map<string, string> | [string, string][]
): void {
  const entries = mappings instanceof Map ? mappings.entries() : mappings;
  for (const [key, txId] of entries) {
    if (shaToTxIdCache.size >= SHA_CACHE_MAX_SIZE) {
      const firstKey = shaToTxIdCache.keys().next().value;
      if (firstKey !== undefined) {
        shaToTxIdCache.delete(firstKey);
      }
    }
    shaToTxIdCache.set(key, txId);
  }
}

/** Arweave transaction IDs are 43-character base64url strings. */
const ARWEAVE_TX_ID_RE = /^[a-zA-Z0-9_-]{43}$/;

/**
 * Validate an Arweave transaction ID format.
 * Arweave tx IDs are 43-character base64url-encoded strings.
 */
export function isValidArweaveTxId(txId: string): boolean {
  return ARWEAVE_TX_ID_RE.test(txId);
}

/**
 * Resolve a git SHA to an Arweave transaction ID via GraphQL.
 *
 * Queries the Arweave GraphQL endpoint for transactions tagged with
 * the given Git-SHA and Repo values. Results are cached in-memory.
 *
 * @param sha - Git object SHA-1 hash (hex)
 * @param repo - Repository identifier (matches d tag)
 * @returns Arweave transaction ID, or null if not found
 */
export async function resolveGitSha(
  sha: string,
  repo: string
): Promise<string | null> {
  // Validate SHA format to prevent injection of arbitrary strings into GraphQL
  if (!isValidGitSha(sha)) {
    return null;
  }

  const cacheKey = shaCacheKey(sha, repo);
  const cached = shaToTxIdCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  const safeSha = sanitizeGraphQLValue(sha);
  const safeRepo = sanitizeGraphQLValue(repo);
  const query = `query {
  transactions(tags: [
    { name: "Git-SHA", values: ["${safeSha}"] },
    { name: "Repo", values: ["${safeRepo}"] }
  ]) {
    edges { node { id } }
  }
}`;

  try {
    const response = await fetch(ARWEAVE_GRAPHQL_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
      signal: AbortSignal.timeout(ARWEAVE_FETCH_TIMEOUT_MS),
    });

    if (!response.ok) {
      return null;
    }

    const json = (await response.json()) as {
      data?: {
        transactions?: {
          edges?: { node?: { id?: string } }[];
        };
      };
    };

    const edges = json.data?.transactions?.edges;
    if (!edges || edges.length === 0) {
      return null;
    }

    const txId = edges[0]?.node?.id;
    if (!txId || !isValidArweaveTxId(txId)) {
      return null;
    }

    // Evict oldest entries if cache exceeds max size
    if (shaToTxIdCache.size >= SHA_CACHE_MAX_SIZE) {
      const firstKey = shaToTxIdCache.keys().next().value;
      if (firstKey !== undefined) {
        shaToTxIdCache.delete(firstKey);
      }
    }
    shaToTxIdCache.set(cacheKey, txId);
    return txId;
  } catch {
    return null;
  }
}

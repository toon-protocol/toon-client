/**
 * Arweave gateway client for Forge-UI.
 *
 * Fetches git objects from Arweave gateways and resolves git SHAs
 * to Arweave transaction IDs via GraphQL.
 *
 * Uses browser-native fetch() with AbortSignal.timeout() for all requests.
 * No Node.js APIs — browser-compatible only.
 */

/** Ordered list of Arweave gateways to try (primary first, then fallbacks). */
export const ARWEAVE_GATEWAYS = [
  'https://arweave.net',
  'https://gateway.irys.xyz',
];

/** Timeout for individual Arweave fetch requests in milliseconds. */
export const ARWEAVE_FETCH_TIMEOUT_MS = 15000;

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
  return value.replace(/["\\\n\r\u0000-\u001f`]/g, '');
}

/**
 * Clear the SHA-to-txId cache. Used for test isolation.
 */
export function clearShaCache(): void {
  shaToTxIdCache.clear();
}

/** Arweave transaction IDs are 43-character base64url strings. */
const ARWEAVE_TX_ID_RE = /^[a-zA-Z0-9_-]{43}$/;

/**
 * Validate an Arweave transaction ID format.
 * Arweave tx IDs are 43-character base64url-encoded strings.
 */
function isValidArweaveTxId(txId: string): boolean {
  return ARWEAVE_TX_ID_RE.test(txId);
}

/**
 * Fetch a raw object from an Arweave gateway by transaction ID.
 *
 * Tries the primary gateway first, then falls back to secondary gateways.
 * Returns null if all gateways fail (404, network error, timeout).
 *
 * @param txId - Arweave transaction ID (43-character base64url string)
 * @returns Raw bytes as Uint8Array, or null if unavailable
 */
export async function fetchArweaveObject(
  txId: string
): Promise<Uint8Array | null> {
  if (!isValidArweaveTxId(txId)) {
    return null;
  }

  for (const gateway of ARWEAVE_GATEWAYS) {
    try {
      const url = `${gateway}/${txId}`;
      const response = await fetch(url, {
        signal: AbortSignal.timeout(ARWEAVE_FETCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        continue;
      }

      const buffer = await response.arrayBuffer();
      return new Uint8Array(buffer);
    } catch {
      // Network error, timeout, or other failure — try next gateway
      continue;
    }
  }

  return null;
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

  const cacheKey = `${sha}:${repo}`;
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
    const response = await fetch('https://arweave.net/graphql', {
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
          edges?: Array<{ node?: { id?: string } }>;
        };
      };
    };

    const edges = json.data?.transactions?.edges;
    if (!edges || edges.length === 0) {
      return null;
    }

    const txId = edges[0]?.node?.id;
    if (!txId) {
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

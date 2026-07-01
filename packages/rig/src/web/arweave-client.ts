/**
 * Arweave gateway client for Rig-UI.
 *
 * Fetches git objects from Arweave gateways and resolves git SHAs
 * to Arweave transaction IDs via GraphQL.
 *
 * Uses browser-native fetch() with AbortSignal.timeout() for all requests.
 * No Node.js APIs — browser-compatible only.
 */

// Gateway list + fetch timeout are owned by @toon-protocol/arweave (the single
// source of truth shared with views + client-mcp); the Git-SHA → txId GraphQL
// resolver (resolveGitSha / seedShaCache / clearShaCache) moved there too so
// the Node write path (@toon-protocol/git) shares ONE implementation (#225).
// Everything is re-exported here so existing rig importers keep their
// `../arweave-client.js` path.
export {
  ARWEAVE_GATEWAYS,
  ARWEAVE_FETCH_TIMEOUT_MS,
  clearShaCache,
  resolveGitSha,
  seedShaCache,
} from '@toon-protocol/arweave';
import {
  ARWEAVE_GATEWAYS,
  ARWEAVE_FETCH_TIMEOUT_MS,
  isValidArweaveTxId,
} from '@toon-protocol/arweave';

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

/**
 * Arweave gateway redundancy — single source of truth.
 *
 * Media bytes are content-addressed by Arweave tx id, so every gateway serves
 * the same bytes. This module owns the ordered gateway preference list and the
 * URL helpers used on BOTH sides of the wire:
 *   - upload (client-mcp daemon): stamp a primary `url` + `fallback` mirrors.
 *   - render (views/rig browser): re-point imeta URLs + fail over on error.
 *
 * Previously hand-duplicated in `views`, `rig`, and `client-mcp`; those now all
 * import from here. The default list can be overridden per call (e.g. from a
 * daemon env var) — pass `gateways` to the helpers.
 */

/** Ordered Arweave gateways to try (primary first, then fallbacks). */
export const ARWEAVE_GATEWAYS = [
  'https://ar-io.dev',
  'https://arweave.net',
  'https://permagate.io',
] as const;

/** Timeout for individual Arweave fetch requests in milliseconds. */
export const ARWEAVE_FETCH_TIMEOUT_MS = 15000;

/** Arweave transaction IDs are 43-character base64url strings. */
const TX_ID_RE = /^[a-zA-Z0-9_-]{43}$/;

/** Hosts recognized as Arweave gateways (path-addressed). */
const ARWEAVE_HOST_RE =
  /(^|\.)(arweave\.net|ar-io\.dev|permagate\.io|g8way\.io|ar\.io)$/i;

/**
 * Extract an Arweave tx id from a media URL, or null if it is not
 * Arweave-addressable. Handles `ar://<txid>` and path-style
 * `https://<gateway>/<txid>`.
 *
 * Sandbox-subdomain URLs (`https://<txid>.<gateway>`) are deliberately NOT
 * decoded: tx ids are case-sensitive base64url, but `URL` (and DNS) lower-case
 * the hostname, which would corrupt the id. Real gateway sandboxing uses a
 * base32 label, not the raw id — the canonical id always travels in the path.
 */
export function arweaveTxId(rawUrl: string): string | null {
  const ar = /^ar:\/\/([a-zA-Z0-9_-]{43})(?:[/?#]|$)/.exec(rawUrl);
  if (ar?.[1]) return ar[1];

  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  // Only re-point hosts we actually recognize as Arweave gateways, so a stray
  // 43-char path segment on some other CDN is never misread as a tx id.
  if (!ARWEAVE_HOST_RE.test(u.hostname)) return null;

  // Path style: https://arweave.net/<txid>
  const seg = u.pathname.split('/').find(Boolean);
  if (seg && TX_ID_RE.test(seg)) return seg;

  return null;
}

/**
 * Primary URL + fallback mirror URLs for an Arweave tx id, one per gateway in
 * preference order. Used by the upload path to stamp `imeta` `url` + `fallback`.
 */
export function arweaveUrls(
  txId: string,
  gateways: readonly string[] = ARWEAVE_GATEWAYS
): { url: string; fallbacks: string[] } {
  const all = (gateways.length ? gateways : ARWEAVE_GATEWAYS).map(
    (g) => `${g}/${txId}`
  );
  const [url, ...fallbacks] = all;
  return { url: url ?? `${ARWEAVE_GATEWAYS[0]}/${txId}`, fallbacks };
}

/**
 * Ordered candidate URLs for a media URL. Arweave-addressable URLs expand to the
 * full gateway-preference list (primary first); anything else is returned
 * unchanged. `extraFallbacks` (e.g. publisher-supplied `imeta` mirrors) are
 * appended last, de-duplicated. Used by the render path to fail over on error.
 */
export function arweaveGatewayCandidates(
  rawUrl: string,
  extraFallbacks: string[] = [],
  gateways: readonly string[] = ARWEAVE_GATEWAYS
): string[] {
  const txId = arweaveTxId(rawUrl);
  const candidates = txId
    ? (gateways.length ? gateways : ARWEAVE_GATEWAYS).map((g) => `${g}/${txId}`)
    : [rawUrl];
  const seen = new Set(candidates);
  for (const f of extraFallbacks) {
    if (f && !seen.has(f)) {
      seen.add(f);
      candidates.push(f);
    }
  }
  return candidates;
}

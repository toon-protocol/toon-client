/**
 * Arweave gateway redundancy for media rendering.
 *
 * Media bytes are content-addressed by Arweave tx id, so every gateway serves the
 * same bytes. Publishers stamp whatever gateway they happened to use into the
 * `imeta` `url` (our own upload path hardcodes `arweave.net`); to avoid a hard
 * dependency on a single gateway we re-point Arweave-addressable URLs to an
 * ordered preference list and let the renderer fall through to the next gateway
 * on error.
 *
 * NOTE: `ARWEAVE_GATEWAYS` mirrors the list in `@toon-protocol/rig`
 * (`web/arweave-client.ts`). It is duplicated by hand because `views` is a
 * dependency of `rig` and cannot import back from it. Keep the two in sync.
 */

/** Ordered Arweave gateways to try (primary first, then fallbacks). */
export const ARWEAVE_GATEWAYS = [
  'https://ar-io.dev',
  'https://arweave.net',
  'https://permagate.io',
];

/** Arweave transaction IDs are 43-character base64url strings. */
const TX_ID_RE = /^[a-zA-Z0-9_-]{43}$/;

/** Hosts we recognize as Arweave gateways (path- or sandbox-subdomain-addressed). */
const ARWEAVE_HOST_RE = /(^|\.)(arweave\.net|ar-io\.dev|permagate\.io|g8way\.io|ar\.io)$/i;

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
 * Ordered candidate URLs for a media URL. Arweave-addressable URLs expand to the
 * full gateway-preference list (primary first); anything else is returned
 * unchanged. `extraFallbacks` (e.g. publisher-supplied `imeta` mirrors) are
 * appended last, de-duplicated.
 */
export function arweaveGatewayCandidates(
  rawUrl: string,
  extraFallbacks: string[] = []
): string[] {
  const txId = arweaveTxId(rawUrl);
  const candidates = txId
    ? ARWEAVE_GATEWAYS.map((g) => `${g}/${txId}`)
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

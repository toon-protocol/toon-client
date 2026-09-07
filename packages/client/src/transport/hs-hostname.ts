/**
 * Hidden-service hostname validation for the Anyone Protocol network.
 *
 * The `anon` binary routes hidden-service hostnames under the **`.anyone`** TLD
 * ONLY. A `<host>.anon` name is NOT recognized as a hidden service — anon treats
 * it as a clearnet name and tries to exit-resolve it, which fails
 * (`resolve failed` / `HostUnreachable`). Only `<host>.anyone` triggers anon's
 * `parse_extended_hostname: Anyone dns address lookup` and is validated.
 *
 * Historically this client accepted BOTH `.anon` and `.anyone`, so a `.anon`
 * address was silently accepted and then failed deep in the transport with an
 * opaque error. This module makes `.anyone` the single accepted HS TLD and
 * rejects the near-misses up front with an actionable message.
 *
 * `.onion` is a near-miss too, and a more tempting one: it is a real hidden
 * service, just on a network this client does not dial. We route through `anon`,
 * not `tor`, so accepting a `.onion` address would repeat the exact mistake
 * `.anon` taught us — an address we cannot reach, failing late and cryptically.
 *
 * This is a pure, browser-safe helper (no Node built-ins) so it can be imported
 * from any path, including config validation.
 */

/**
 * A `<host>.anyone` hidden-service hostname. The label is base32 (`a-z2-7`),
 * matching the on-wire onion-style address alphabet anon uses.
 */
export const HS_HOSTNAME_REGEX = /^[a-z2-7]+\.anyone$/;

/** Max length of an HS hostname (defensive bound against pathological input). */
export const HS_HOSTNAME_MAX_LENGTH = 80;

/**
 * Returns true iff `s` is a routable `.anyone` hidden-service hostname.
 * Does NOT accept `.anon` or `.onion` (see {@link assertRoutableHsHostname}).
 */
export function isRoutableHsHostname(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length <= HS_HOSTNAME_MAX_LENGTH &&
    HS_HOSTNAME_REGEX.test(s)
  );
}

/**
 * Returns true iff `url` addresses a hidden service — i.e. its host is a
 * routable `.anyone` address.
 *
 * Takes a URL string rather than a hostname because that is what a caller
 * actually holds: a `connector` config value, an `httpEndpoint` off a
 * self-description. A string that is not a URL at all is not a hidden service.
 */
export function isHiddenServiceUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  try {
    return isRoutableHsHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Validates that `hostname` is a routable `.anyone` hidden-service address.
 *
 * - `<host>.anyone` → returns the hostname unchanged.
 * - `<host>.anon`   → throws, pointing at `.anyone` (anon does NOT route
 *   `.anon`; it is treated as a clearnet address and fails `HostUnreachable`).
 * - `<host>.onion`  → throws, naming the network mismatch: that is Tor, and
 *   this client dials the Anyone Protocol.
 * - anything else   → throws a generic format error.
 *
 * @throws {Error} if the hostname is not a routable `.anyone` HS address.
 */
export function assertRoutableHsHostname(hostname: unknown): string {
  if (typeof hostname === 'string' && /\.anon$/.test(hostname)) {
    throw new Error(
      `"${hostname}" is not a routable hidden-service address; use the .anyone TLD ` +
        `(e.g. "${hostname.replace(/\.anon$/, '.anyone')}"). ` +
        'The anon daemon only resolves hidden services under .anyone — a .anon ' +
        'name is treated as a clearnet address and fails (HostUnreachable).'
    );
  }
  if (typeof hostname === 'string' && /\.onion$/.test(hostname)) {
    throw new Error(
      `"${hostname}" is a Tor hidden service, which this client does not dial. ` +
        'Packets are routed through the Anyone Protocol `anon` daemon, whose ' +
        'hidden services live under the .anyone TLD.'
    );
  }
  if (!isRoutableHsHostname(hostname)) {
    throw new Error(
      `Invalid hidden-service hostname: ${JSON.stringify(hostname)}. ` +
        `Expected a base32 .anyone address matching ${HS_HOSTNAME_REGEX}.`
    );
  }
  return hostname;
}

/**
 * Hidden-service hostname validation for the anyone-protocol / ATOR network.
 *
 * The `anon` binary routes hidden-service hostnames under the **`.anyone`** TLD
 * ONLY. A `<host>.anon` name is NOT recognized as a hidden service — anon treats
 * it as a clearnet name and tries to exit-resolve it, which fails
 * (`resolve failed` / `HostUnreachable`). Only `<host>.anyone` triggers anon's
 * `parse_extended_hostname: Anyone dns address lookup` and is validated.
 *
 * Historically the client and the toon-client pod accepted BOTH `.anon` and
 * `.anyone`, so a `.anon` address was silently accepted and then failed deep in
 * the transport with an opaque error. This module makes `.anyone` the single
 * accepted/routable HS TLD and rejects `.anon` up front with an actionable
 * message (see issue #201).
 *
 * This is a pure, browser-safe helper (no Node built-ins) so it can be imported
 * from any transport path.
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
 * Does NOT accept the legacy `.anon` TLD (see {@link assertRoutableHsHostname}).
 */
export function isRoutableHsHostname(s: unknown): s is string {
  return (
    typeof s === 'string' &&
    s.length <= HS_HOSTNAME_MAX_LENGTH &&
    HS_HOSTNAME_REGEX.test(s)
  );
}

/**
 * Validates that `hostname` is a routable `.anyone` hidden-service address.
 *
 * - `<host>.anyone` → returns the hostname unchanged.
 * - `<host>.anon`   → throws with an actionable message pointing at `.anyone`
 *   (anon does NOT route `.anon`; it would silently fail in the transport).
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
  if (!isRoutableHsHostname(hostname)) {
    throw new Error(
      `Invalid hidden-service hostname: ${JSON.stringify(hostname)}. ` +
        `Expected a base32 .anyone address matching ${HS_HOSTNAME_REGEX}.`
    );
  }
  return hostname;
}

/**
 * URL string handling that stays linear on adversarial input.
 *
 * Every URL this package trims arrives from a caller — a `connector` in the
 * config, a `faucetUrl`, an endpoint read off a node's self-description — so it
 * is library input rather than a constant, and the cost of handling it should
 * not depend on how it is shaped.
 */

/** `/`, compared by code unit so no substring is allocated per character. */
const SLASH = 0x2f;

/**
 * `url` with any trailing `/` removed.
 *
 * Written as a scan rather than `replace(/\/+$/, '')` because that regular
 * expression backtracks: with `+` under an end anchor, a string of many slashes
 * that does NOT end in one makes the engine retry the run from each position in
 * turn, which is quadratic in the length of the run (`js/polynomial-redos`).
 * The equivalent scan visits each trailing slash once and allocates one string.
 */
export function trimTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === SLASH) end -= 1;
  return end === url.length ? url : url.slice(0, end);
}

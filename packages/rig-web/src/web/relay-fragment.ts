/**
 * Boot-time normalization of the documented `#relay=` fragment.
 *
 * The SPA uses `HashRouter`, which owns the URL fragment: a bare
 * `#relay=wss://…` is read as the route path `relay=wss://…`, matches no
 * route, and blank-pages the app. But `#relay=…` is the canonical
 * shareable form in the docs (it survives static gateways with no
 * server-side rewrites), so instead of outlawing it we rewrite it — before
 * the router mounts — to the router-safe equivalent `#/?relay=…`, which
 * the config reader (`use-rig-config`) already understands via its
 * `[?&]relay=` matcher.
 *
 * Must run before the router initializes (see `main.tsx`).
 */

const BARE_RELAY_FRAGMENT = /^#relay=/;

/**
 * Compute the router-safe hash for a bare `#relay=` fragment.
 *
 * Pure helper: given `location.hash`, returns the rewritten hash
 * (`#/?relay=…`, preserving any extra `&`-separated params) when the
 * fragment is the bare documented form, or `null` when no rewrite is
 * needed (already router-safe, different fragment, or no fragment).
 *
 * The relay value is passed through untouched — validation (ws/wss
 * scheme, decodeURIComponent) stays in `use-rig-config` so precedence
 * and fallback behavior are unchanged.
 */
export function rewriteBareRelayFragment(hash: string): string | null {
  if (!BARE_RELAY_FRAGMENT.test(hash)) return null;
  return hash.replace(BARE_RELAY_FRAGMENT, '#/?relay=');
}

/**
 * If the current location carries a bare `#relay=` fragment, rewrite it in
 * place via `history.replaceState` — no navigation, no reload, no history
 * entry — so the hash router sees the index route (`#/`) and the URL in
 * the address bar stays shareable in the router-safe form.
 */
export function normalizeRelayFragment(win: Window = window): void {
  const rewritten = rewriteBareRelayFragment(win.location.hash);
  if (rewritten === null) return;
  const { pathname, search } = win.location;
  win.history.replaceState(
    win.history.state,
    '',
    `${pathname}${search}${rewritten}`,
  );
}

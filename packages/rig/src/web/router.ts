/**
 * Minimal client-side router for Forge-UI.
 *
 * Uses History API for clean URLs. Routes:
 * - `/` — repository list
 * - `/<npub>/<repo>/` — tree view at default ref
 * - `/<npub>/<repo>/tree/<ref>/<path...>` — tree view
 * - `/<npub>/<repo>/blob/<ref>/<path...>` — blob view
 * - `/<npub>/<repo>/commits/<ref>` — commit log
 * - `/<npub>/<repo>/commit/<sha>` — commit diff view
 * - `/<npub>/<repo>/blame/<ref>/<path...>` — blame view
 * - `/<npub>/<repo>/issues` — issue list
 * - `/<npub>/<repo>/issues/<eventId>` — issue detail
 * - `/<npub>/<repo>/pulls` — PR list
 * - `/<npub>/<repo>/pulls/<eventId>` — PR detail
 */

/**
 * Parsed route descriptor.
 */
export type Route =
  | { type: 'repo-list' }
  | { type: 'tree'; owner: string; repo: string; ref: string; path: string }
  | { type: 'blob'; owner: string; repo: string; ref: string; path: string }
  | { type: 'commits'; owner: string; repo: string; ref: string }
  | { type: 'commit'; owner: string; repo: string; sha: string }
  | { type: 'blame'; owner: string; repo: string; ref: string; path: string }
  | { type: 'issues'; owner: string; repo: string }
  | { type: 'issue-detail'; owner: string; repo: string; eventId: string }
  | { type: 'pulls'; owner: string; repo: string }
  | { type: 'pull-detail'; owner: string; repo: string; eventId: string }
  | { type: 'not-found' };

// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
const DEFAULT_RELAY_URL = 'wss://localhost:7100';

/**
 * Validate that a relay URL uses the WebSocket protocol.
 *
 * @param url - URL string to validate
 * @returns true if the URL uses a WebSocket protocol scheme
 */
export function isValidRelayUrl(url: string): boolean {
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  return /^wss?:\/\//i.test(url);
}

/**
 * Extract relay URL from URL search query parameters.
 *
 * Only accepts URLs with WebSocket protocol schemes to prevent
 * SSRF, open redirect, and protocol confusion attacks.
 *
 * @param search - The URL search string (e.g., "?relay=wss%3A%2F%2Fexample.com")
 * @returns The relay URL, or the default if not specified or invalid
 */
export function parseRelayUrl(search: string): string {
  const params = new URLSearchParams(search);
  const relay = params.get('relay');
  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  if (relay && isValidRelayUrl(relay)) {
    return relay;
  }
  return DEFAULT_RELAY_URL;
}

/**
 * Parse a URL pathname into a Route descriptor.
 */
export function parseRoute(pathname: string): Route {
  // Normalize: remove trailing slash for matching (except root)
  const path = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');

  if (path === '/' || path === '') {
    return { type: 'repo-list' };
  }

  const segments = path.split('/').filter(Boolean);

  if (segments.length >= 2) {
    const owner = segments[0]!;
    const repo = segments[1]!;

    // /<npub>/<repo>/tree/<ref>/<path...>
    if (segments.length >= 4 && segments[2] === 'tree' && segments[3]) {
      const ref = segments[3];
      const treePath = segments.length > 4 ? segments.slice(4).join('/') : '';
      return { type: 'tree', owner, repo, ref, path: treePath };
    }

    // /<npub>/<repo>/blob/<ref>/<path...>
    if (segments.length >= 4 && segments[2] === 'blob' && segments[3]) {
      const ref = segments[3];
      const blobPath = segments.length > 4 ? segments.slice(4).join('/') : '';
      return { type: 'blob', owner, repo, ref, path: blobPath };
    }

    // /<npub>/<repo>/commits/<ref> — commit log (MUST be before 'commit' singular)
    if (segments.length >= 4 && segments[2] === 'commits' && segments[3]) {
      return { type: 'commits', owner, repo, ref: segments[3] };
    }

    // /<npub>/<repo>/commit/<sha>
    if (segments.length >= 4 && segments[2] === 'commit' && segments[3]) {
      return { type: 'commit', owner, repo, sha: segments[3] };
    }

    // /<npub>/<repo>/blame/<ref>/<path...>
    if (segments.length >= 5 && segments[2] === 'blame' && segments[3]) {
      const ref = segments[3];
      const blamePath = segments.slice(4).join('/');
      return { type: 'blame', owner, repo, ref, path: blamePath };
    }

    // /<npub>/<repo>/issues/<eventId> — issue detail (MUST be before issues list)
    if (segments.length >= 4 && segments[2] === 'issues' && segments[3]) {
      return { type: 'issue-detail', owner, repo, eventId: segments[3] };
    }

    // /<npub>/<repo>/issues — issue list
    if (segments.length === 3 && segments[2] === 'issues') {
      return { type: 'issues', owner, repo };
    }

    // /<npub>/<repo>/pulls/<eventId> — PR detail (MUST be before pulls list)
    if (segments.length >= 4 && segments[2] === 'pulls' && segments[3]) {
      return { type: 'pull-detail', owner, repo, eventId: segments[3] };
    }

    // /<npub>/<repo>/pulls — PR list
    if (segments.length === 3 && segments[2] === 'pulls') {
      return { type: 'pulls', owner, repo };
    }

    // /<npub>/<repo>/ — bare repo route, resolve default ref
    return { type: 'tree', owner, repo, ref: '', path: '' };
  }

  return { type: 'not-found' };
}

/**
 * Navigate to a new route using History API.
 *
 * Only accepts relative paths starting with `/` to prevent open redirect
 * attacks via absolute URLs or protocol-relative URLs.
 */
export function navigateTo(path: string): void {
  // Block absolute URLs and protocol-relative URLs to prevent open redirects
  if (!path.startsWith('/') || path.startsWith('//')) {
    return;
  }
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/**
 * Initialize the router on a container element.
 *
 * Intercepts anchor clicks within the container and uses History API
 * navigation instead of full page reloads.
 */
export function initRouter(
  container: HTMLElement,
  onNavigate?: (route: Route) => void
): void {
  // Intercept link clicks
  container.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement;
    const anchor = target.closest('a');
    if (!anchor) return;

    const href = anchor.getAttribute('href');
    if (!href || href.startsWith('http') || href.startsWith('//')) return;

    e.preventDefault();
    navigateTo(href);
  });

  // Listen for popstate (back/forward)
  if (onNavigate) {
    window.addEventListener('popstate', () => {
      const route = parseRoute(window.location.pathname);
      onNavigate(route);
    });
  }
}

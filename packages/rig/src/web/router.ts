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

// Build-time configurable via VITE_DEFAULT_RELAY env var (e.g., for Arweave deployments).
// Priority: (1) #relay= hash fragment, (2) ?relay= query param, (3) this default.
// nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
const DEFAULT_RELAY_URL: string =
  import.meta.env.VITE_DEFAULT_RELAY || 'wss://localhost:7100';

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
 * Resolve the relay URL from (in priority order):
 * 1. URL hash fragment: `#relay=wss://...` (works on Arweave gateways, shareable)
 * 2. `?relay=` query parameter (legacy/convenience, migrated to hash)
 * 3. Default relay URL
 *
 * The hash fragment is used because:
 * - It's part of the URL (shareable, bookmarkable)
 * - It works identically across Arweave gateways (ar-io.dev, arweave.net, etc.)
 * - It's not sent to the server (no CORS/privacy concerns)
 * - localStorage doesn't persist across different gateway domains
 *
 * Example URLs:
 *   https://ar-io.dev/<txId>/#relay=wss://relay.toon-protocol.org
 *   http://localhost:5173/#relay=ws://localhost:19700
 *   http://localhost:5173/toon-protocol/#relay=ws://localhost:19700
 */
export function parseRelayUrl(search: string): string {
  // 1. Check hash fragment: #relay=wss://...
  if (typeof window !== 'undefined' && window.location.hash) {
    const hashParams = new URLSearchParams(window.location.hash.slice(1));
    const hashRelay = hashParams.get('relay');
    // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
    if (hashRelay && isValidRelayUrl(hashRelay)) {
      return hashRelay;
    }
  }

  // 2. Check ?relay= query param (legacy/convenience — migrate to hash)
  const params = new URLSearchParams(search);
  const relay = params.get('relay');

  // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
  if (relay && isValidRelayUrl(relay)) {
    // Migrate from ?relay= to #relay= for clean URLs
    if (typeof window !== 'undefined') {
      params.delete('relay');
      const cleanSearch = params.toString();
      const cleanPath =
        window.location.pathname + (cleanSearch ? `?${cleanSearch}` : '');
      const newHash = `#relay=${encodeURIComponent(relay)}`;
      window.history.replaceState(null, '', cleanPath + newHash);
    }
    return relay;
  }

  return DEFAULT_RELAY_URL;
}

/**
 * Safely decode a URI component, returning the original string
 * if the input contains malformed percent-encoded sequences.
 */
function safeDecodeURIComponent(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str;
  }
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

  // /<repo>/ — short form: repo-id only, owner resolved at render time
  // /<repo>/tree/<ref>/<path...>, /<repo>/issues, etc.
  if (segments.length >= 1) {
    const firstSeg = segments[0]!;

    // Determine if this is /<owner>/<repo>/... (2+ segments, first looks like npub/hex)
    // or /<repo>/... (1+ segments, first is the repo id)
    const looksLikeOwner =
      segments.length >= 2 &&
      (firstSeg.startsWith('npub1') || /^[0-9a-f]{64}$/i.test(firstSeg));

    const owner = looksLikeOwner ? firstSeg : '';
    const repo = looksLikeOwner ? segments[1]! : firstSeg;
    const routeSegments = looksLikeOwner
      ? segments.slice(2)
      : segments.slice(1);

    // /<repo>/tree/<ref>/<path...>
    if (
      routeSegments.length >= 2 &&
      routeSegments[0] === 'tree' &&
      routeSegments[1]
    ) {
      const ref = safeDecodeURIComponent(routeSegments[1]);
      const treePath =
        routeSegments.length > 2 ? routeSegments.slice(2).join('/') : '';
      return { type: 'tree', owner, repo, ref, path: treePath };
    }

    // /<repo>/blob/<ref>/<path...>
    if (
      routeSegments.length >= 2 &&
      routeSegments[0] === 'blob' &&
      routeSegments[1]
    ) {
      const ref = safeDecodeURIComponent(routeSegments[1]);
      const blobPath =
        routeSegments.length > 2 ? routeSegments.slice(2).join('/') : '';
      return { type: 'blob', owner, repo, ref, path: blobPath };
    }

    // /<repo>/commits/<ref>
    if (
      routeSegments.length >= 2 &&
      routeSegments[0] === 'commits' &&
      routeSegments[1]
    ) {
      return {
        type: 'commits',
        owner,
        repo,
        ref: safeDecodeURIComponent(routeSegments[1]),
      };
    }

    // /<repo>/commit/<sha>
    if (
      routeSegments.length >= 2 &&
      routeSegments[0] === 'commit' &&
      routeSegments[1]
    ) {
      return { type: 'commit', owner, repo, sha: routeSegments[1] };
    }

    // /<repo>/blame/<ref>/<path...>
    if (
      routeSegments.length >= 3 &&
      routeSegments[0] === 'blame' &&
      routeSegments[1]
    ) {
      const ref = safeDecodeURIComponent(routeSegments[1]);
      const blamePath = routeSegments.slice(2).join('/');
      return { type: 'blame', owner, repo, ref, path: blamePath };
    }

    // /<repo>/issues/<eventId>
    if (
      routeSegments.length >= 2 &&
      routeSegments[0] === 'issues' &&
      routeSegments[1]
    ) {
      return { type: 'issue-detail', owner, repo, eventId: routeSegments[1] };
    }

    // /<repo>/issues
    if (routeSegments.length === 1 && routeSegments[0] === 'issues') {
      return { type: 'issues', owner, repo };
    }

    // /<repo>/pulls/<eventId>
    if (
      routeSegments.length >= 2 &&
      routeSegments[0] === 'pulls' &&
      routeSegments[1]
    ) {
      return { type: 'pull-detail', owner, repo, eventId: routeSegments[1] };
    }

    // /<repo>/pulls
    if (routeSegments.length === 1 && routeSegments[0] === 'pulls') {
      return { type: 'pulls', owner, repo };
    }

    // /<repo>/ — bare repo route, resolve default ref
    if (routeSegments.length === 0) {
      return { type: 'tree', owner, repo, ref: '', path: '' };
    }
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

  // Branch selector navigation (delegated — no inline JS needed)
  container.addEventListener('change', (e: Event) => {
    const target = e.target as HTMLSelectElement;
    if (target.dataset.branchNav && target.value) {
      navigateTo(target.value);
    }
  });

  // Clone URL: click-to-select and copy button (delegated)
  container.addEventListener('click', (e: Event) => {
    const target = e.target as HTMLElement;

    // Click-to-select on clone URL input
    const input = target.closest('[data-clone-url]') as HTMLInputElement | null;
    if (input) {
      input.select();
      return;
    }

    // Copy button
    const copyBtn = target.closest('[data-copy-url]') as HTMLElement | null;
    if (copyBtn) {
      const urlInput = container.querySelector(
        '[data-clone-url]'
      ) as HTMLInputElement | null;
      if (urlInput) {
        void navigator.clipboard.writeText(urlInput.value);
      }
    }
  });

  // Listen for popstate (back/forward)
  if (onNavigate) {
    window.addEventListener('popstate', () => {
      const route = parseRoute(window.location.pathname);
      onNavigate(route);
    });
  }
}

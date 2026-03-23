/**
 * Forge-UI main entry point.
 *
 * Initializes the app, sets up routing, and renders the initial view.
 * This is a static SPA — no backend, no SDK dependency.
 */

import { renderLayout } from './layout.js';
import { renderRepoList } from './templates.js';
import { parseRelayUrl, parseRoute, initRouter } from './router.js';
import {
  queryRelay,
  buildRepoListFilter,
  buildProfileFilter,
} from './relay-client.js';
import { parseRepoAnnouncement } from './nip34-parsers.js';
import { ProfileCache } from './profile-cache.js';
import type { Route } from './router.js';
import type { RepoMetadata } from './nip34-parsers.js';

const profileCache = new ProfileCache();

/**
 * Fetch and cache kind:0 profiles for repo owners, then return a
 * display-name lookup function.
 */
async function enrichProfiles(
  repos: RepoMetadata[],
  relayUrl: string
): Promise<void> {
  const pubkeys = repos.map((r) => r.ownerPubkey);
  const pending = profileCache.getPendingPubkeys(pubkeys);
  if (pending.length === 0) return;

  try {
    const profileEvents = await queryRelay(
      relayUrl,
      buildProfileFilter(pending),
      5000
    );
    for (const evt of profileEvents) {
      try {
        const profile = JSON.parse(evt.content) as {
          name?: string;
          display_name?: string;
          picture?: string;
        };
        profileCache.setProfile(evt.pubkey, {
          name: profile.name,
          displayName: profile.display_name,
          picture: profile.picture,
        });
      } catch {
        // Ignore malformed profile JSON
      }
    }
    profileCache.markRequested(pending);
  } catch {
    // Profile enrichment is best-effort; mark as requested to avoid retries
    profileCache.markRequested(pending);
  }
}

/**
 * Render a route into the app container.
 */
async function renderRoute(route: Route, relayUrl: string): Promise<void> {
  const app = document.getElementById('app');
  if (!app) return;

  let content: string;

  switch (route.type) {
    case 'repo-list': {
      content = renderLayout(
        'Forge',
        '<div class="loading">Loading repositories...</div>',
        relayUrl
      );
      app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method

      // Fetch repos from relay
      try {
        const events = await queryRelay(relayUrl, buildRepoListFilter());
        const repos: RepoMetadata[] = events
          .map((e) => parseRepoAnnouncement(e))
          .filter((r): r is RepoMetadata => r !== null);

        // Enrich with profile data (best-effort)
        await enrichProfiles(repos, relayUrl);

        const repoListHtml = renderRepoList(repos, profileCache);
        content = renderLayout('Forge', repoListHtml, relayUrl);
      } catch {
        content = renderLayout(
          'Forge',
          '<div class="empty-state"><div class="empty-state-title">Connection Error</div><div class="empty-state-message">Could not connect to relay. Check the relay URL and try again.</div></div>',
          relayUrl
        );
      }
      break;
    }
    case 'file-tree':
      content = renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">File Tree</div><p>File tree view for this repository — coming in Story 8.2.</p></div>',
        relayUrl
      );
      break;
    case 'commit':
      content = renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">Commit</div><p>Commit diff view — coming in Story 8.4.</p></div>',
        relayUrl
      );
      break;
    case 'blame':
      content = renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">Blame</div><p>Blame view — coming in Story 8.5.</p></div>',
        relayUrl
      );
      break;
    case 'not-found':
    default:
      content = renderLayout(
        'Forge',
        '<div class="stub-page"><div class="stub-page-title">404</div><p>Page not found.</p></div>',
        relayUrl
      );
      break;
  }

  app.innerHTML = content; // nosemgrep: javascript.browser.security.insecure-document-method.insecure-document-method
}

/**
 * Initialize the Forge-UI application.
 */
function init(): void {
  const relayUrl = parseRelayUrl(window.location.search);
  const app = document.getElementById('app');
  if (!app) return;

  // Set up router
  initRouter(app, (route) => {
    void renderRoute(route, relayUrl);
  });

  // Render initial route
  const initialRoute = parseRoute(window.location.pathname);
  void renderRoute(initialRoute, relayUrl);
}

// Start the app when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

/**
 * Per-repo Rig pointer — the permanent Arweave page that RENDERS a pushed
 * repo in place, deployed by `rig push` the way GitHub Pages tracks a repo.
 * User-facing name: the repo's "Rig page".
 *
 * The pointer boots the FULL React Rig from its Arweave deployment: it pins
 * `window.__RIG_CONFIG__ = {relay, owner, repo}`, presets the HashRouter
 * route in its own URL fragment, and loads rig-web's entry css/js from the
 * deployment's path manifest (`rig-web/scripts/deploy-arweave.mjs` — every
 * build output uploaded GZIPPED under ArDrive Turbo's free tier with a
 * `Content-Encoding` tag the gateways serve as a header, so the whole app
 * fits without a funded wallet). Module-relative imports resolve against the
 * MODULE's URL, so the entire chunk graph loads from the manifest while the
 * address bar stays on the pointer.
 *
 * A `<noscript>`/delayed fallback links to the Pages deployment
 * ({@link DEFAULT_RIG_WEB_URL}). The earlier single-file rig-lite build
 * (`rig-web/lite/rig-lite.js`) remains in-tree as the ultra-light option.
 *
 * The generated HTML is DETERMINISTIC for a given (bundle, gateway,
 * rigWebUrl, relay, owner, repoId) so `rig push` can content-address it:
 * the pointer uploads once and every later push skips the fee until one of
 * those inputs changes (../cli/rig-pointer-record.ts).
 */

/** One released Arweave deployment of rig-web (manifest + entry assets). */
export interface RigWebBundle {
  /** The ar.io path-manifest txId (`https://<gateway>/<tx>/` serves the app). */
  manifestTx: string;
  /** Entry module path inside the manifest (hashed per build). */
  entryJs: string;
  /** Entry stylesheet path inside the manifest (hashed per build). */
  entryCss: string;
}

/**
 * The current rig-web deployment on Arweave (deployed 2026-07-17 via
 * `deploy-arweave.mjs`, 122 files, free tier). Override per-field with
 * `RIG_WEB_TX` / `RIG_WEB_ENTRY_JS` / `RIG_WEB_ENTRY_CSS`.
 */
export const DEFAULT_RIG_WEB_BUNDLE: RigWebBundle = {
  manifestTx: 'Iy8sHYVnoevSpwDC2lqUoIg8BWdes9NmMbgmPd81UpU',
  entryJs: 'assets/index-BuKzYubR.js',
  entryCss: 'assets/index-H5D6cmfa.css',
};

/** Env vars overriding the bundle (e.g. a newer deploy before release). */
export const RIG_WEB_TX_ENV = 'RIG_WEB_TX';
export const RIG_WEB_ENTRY_JS_ENV = 'RIG_WEB_ENTRY_JS';
export const RIG_WEB_ENTRY_CSS_ENV = 'RIG_WEB_ENTRY_CSS';

/** Pages deployment for the no-JS / delayed fallback link (tracks main). */
export const DEFAULT_RIG_WEB_URL =
  'https://toon-protocol.github.io/toon-client';

/** Env var overriding the fallback URL. */
export const RIG_WEB_URL_ENV = 'RIG_WEB_URL';

export interface RigPointerOptions {
  /** The Arweave rig-web deployment the pointer boots. */
  bundle: RigWebBundle;
  /** Gateway base the app loads from (no trailing /). */
  gateway: string;
  /** Fallback rig-web deployment for the no-JS link (no trailing /). */
  rigWebUrl: string;
  /** Relay the Rig should read the repo from (`wss://…`). */
  relay: string;
  /** Repo owner as npub (rig-web routes are `#/<npub>/<repo>`). */
  ownerNpub: string;
  /** Repository id (NIP-34 d-tag). */
  repoId: string;
}

/** The repo's HashRouter fragment, with the relay threaded through. */
export function repoHashRoute(
  options: Pick<RigPointerOptions, 'relay' | 'ownerNpub' | 'repoId'>
): string {
  const { relay, ownerNpub, repoId } = options;
  // Route + query INSIDE the fragment — rig-web's relay resolution reads
  // `[?&]relay=` from the fragment (rig-web/README.md "Relay resolution
  // order"), so this works on any static host with no rewrites.
  return `#/${encodeURIComponent(ownerNpub)}/${encodeURIComponent(repoId)}?relay=${encodeURIComponent(relay)}`;
}

/** The full-Rig fallback URL for a repo (Pages deployment). */
export function rigWebRoute(
  options: Pick<RigPointerOptions, 'rigWebUrl' | 'relay' | 'ownerNpub' | 'repoId'>
): string {
  return `${options.rigWebUrl.replace(/\/+$/, '')}/${repoHashRoute(options)}`;
}

/** Escape a string for safe embedding in an HTML attribute/text position. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Generate the pointer HTML: the full-Rig boot-in-place shell. Loads only
 * the immutable Arweave deployment it exists to boot; degrades to a
 * fallback link with JS disabled.
 */
export function generateRigPointerHtml(options: RigPointerOptions): string {
  const gateway = options.gateway.replace(/\/+$/, '');
  const base = `${gateway}/${options.bundle.manifestTx}`;
  const cssHref = `${base}/${options.bundle.entryCss}`;
  const jsSrc = `${base}/${options.bundle.entryJs}`;
  const fallback = rigWebRoute(options);
  const safeFallback = escapeHtml(fallback);
  const title = escapeHtml(`${options.repoId} — Rig`);

  // Escape `<` so hostile config values can never break out of the script.
  const config = JSON.stringify({
    relay: options.relay,
    owner: options.ownerNpub,
    repo: options.repoId,
  }).replace(/</g, '\\u003c');
  const hashRoute = JSON.stringify(repoHashRoute(options)).replace(
    /</g,
    '\\u003c'
  );

  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Decentralized Git on Nostr &amp; TOON Protocol">
  <title>${title}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x2692;</text></svg>">
  <script>window.__RIG_CONFIG__=${config};if(!location.hash||location.hash==="#")location.replace(${hashRoute})</script>
  <link rel="stylesheet" href="${escapeHtml(cssHref)}">
  <script type="module" crossorigin src="${escapeHtml(jsSrc)}"></script>
</head><body>
  <div id="app"></div>
  <noscript><p>JavaScript is off — open <a href="${safeFallback}">${title}</a> in the hosted Rig.</p></noscript>
  <p hidden data-fallback>If nothing loads, open <a href="${safeFallback}">${title}</a> in the hosted Rig.</p>
  <script>setTimeout(function(){var p=document.querySelector("[data-fallback]");var app=document.getElementById("app");if(p&&(!app||!app.childElementCount))p.hidden=false},8000)</script>
</body></html>
`;
}

/**
 * Per-repo Rig pointer — the permanent Arweave page that opens a pushed repo
 * in the Rig (rig-web, the browser UI), deployed by `rig push` the way
 * GitHub Pages tracks a repo. User-facing name: the repo's "Rig page".
 *
 * STAGE 1 (this module): the pointer is a tiny self-contained REDIRECT shell.
 * Its Arweave txId is the repo's permanent Rig-page URL on any ar.io gateway;
 * opening it forwards to the CURRENT rig-web deployment (the GitHub Pages
 * build today — `packages/rig-web/README.md` "Deploying") with the repo
 * route + relay in the URL hash, which rig-web's HashRouter and relay
 * resolution already understand. A redirect — rather than booting assets in
 * place — is deliberate while the canonical rig-web bundle is NOT yet on
 * Arweave (README "currently blocked"): the Pages build's hashed asset
 * filenames change on every deploy, so a pointer that hardcoded them would
 * rot, while the Pages ORIGIN and rig-web's hash-route contract are stable.
 *
 * STAGE 2 (rig-web on Arweave/ArNS — see `rig-web/src/web/rig-pointer-html.ts`
 * and `arns-deploy.ts`): once an immutable bundle txId / ArNS name exists,
 * pointer generation switches to that boot-in-place shell (assets loaded from
 * the immutable base via the ar.io gateway, repo pinned via
 * `window.__RIG_CONFIG__`) and this redirect mode becomes the fallback.
 *
 * The generated HTML is DETERMINISTIC for a given (rigWebUrl, relay, owner,
 * repoId) so `rig push` can content-address it: the pointer uploads once and
 * every later push skips the fee until one of those inputs changes
 * (../cli/rig-pointer-record.ts).
 */

/** Default rig-web deployment the pointer forwards to (Pages, tracks main). */
export const DEFAULT_RIG_WEB_URL =
  'https://toon-protocol.github.io/toon-client';

/** Env var overriding the rig-web URL (e.g. a future ArNS gateway URL). */
export const RIG_WEB_URL_ENV = 'RIG_WEB_URL';

export interface RigPointerOptions {
  /** rig-web deployment origin/path the pointer forwards to (no trailing /). */
  rigWebUrl: string;
  /** Relay the Rig should read the repo from (`wss://…`). */
  relay: string;
  /** Repo owner as npub (rig-web routes are `#/<npub>/<repo>`). */
  ownerNpub: string;
  /** Repository id (NIP-34 d-tag). */
  repoId: string;
}

/** The rig-web hash route for a repo, with the relay threaded through. */
export function rigWebRoute(options: RigPointerOptions): string {
  const { rigWebUrl, relay, ownerNpub, repoId } = options;
  const base = rigWebUrl.replace(/\/+$/, '');
  // HashRouter route + query INSIDE the fragment — rig-web's relay resolution
  // reads `[?&]relay=` from the fragment (rig-web/README.md "Relay
  // resolution order"), so this works on any static host with no rewrites.
  return `${base}/#/${encodeURIComponent(ownerNpub)}/${encodeURIComponent(repoId)}?relay=${encodeURIComponent(relay)}`;
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
 * Generate the pointer HTML (stage-1 redirect shell). Self-contained, no
 * external assets, works with JS disabled (meta refresh + visible link).
 */
export function generateRigPointerHtml(options: RigPointerOptions): string {
  const target = rigWebRoute(options);
  const safeTarget = escapeHtml(target);
  // Escape `<` so a hostile repoId/relay can never break out of the script.
  const jsTarget = JSON.stringify(target).replace(/</g, '\\u003c');
  const title = escapeHtml(`${options.repoId} — Rig`);

  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Decentralized Git on Nostr &amp; TOON Protocol">
  <meta http-equiv="refresh" content="0; url=${safeTarget}">
  <title>${title}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x2692;</text></svg>">
  <script>location.replace(${jsTarget})</script>
</head><body>
  <p>Opening <a href="${safeTarget}">${title}</a>…</p>
</body></html>
`;
}

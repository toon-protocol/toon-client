/**
 * Per-repo Rig pointer — the permanent Arweave page that RENDERS a pushed
 * repo in place, deployed by `rig push` the way GitHub Pages tracks a repo.
 * User-facing name: the repo's "Rig page".
 *
 * The pointer is a tiny boot shell (same contract as rig-web's
 * `rig-pointer-html.ts`): it pins the repo via `window.__RIG_CONFIG__` and
 * loads **rig-lite** — the single-file, free-tier build of the Rig
 * (`packages/rig-web/lite/rig-lite.js`, uploaded to Arweave through the
 * TOON store) — as a module script from its immutable txId. Everything
 * renders from Arweave + the relay; the address bar stays on the pointer.
 * A `<noscript>`/fallback link opens the repo in the full React Rig
 * deployment ({@link DEFAULT_RIG_WEB_URL}).
 *
 * Once the FULL rig-web bundle lands on Arweave/ArNS (blocked on funding a
 * Turbo JWK for its 4 over-105KiB chunks — see rig-web README "Deploying"),
 * `RIG_LITE_TX`/`RIG_WEB_URL` point this at the rich build with no code
 * change here.
 *
 * The generated HTML is DETERMINISTIC for a given (liteTx, gateway,
 * rigWebUrl, relay, owner, repoId) so `rig push` can content-address it:
 * the pointer uploads once and every later push skips the fee until one of
 * those inputs changes (../cli/rig-pointer-record.ts).
 */

/**
 * Arweave txId of the current rig-lite build (uploaded via the TOON store,
 * 2026-07-17; themed with the full Rig's design tokens). Override with
 * `RIG_LITE_TX` (e.g. a newer build or an ArNS name-resolved tx).
 */
export const DEFAULT_RIG_LITE_TX = 'yI6KAbrGJXLwduYnuMIQTgtmCrhnEJ7jXd25-ZgLvJc';

/** Env var overriding the rig-lite txId the pointer boots. */
export const RIG_LITE_TX_ENV = 'RIG_LITE_TX';

/** Full React-Rig deployment for the fallback link (Pages, tracks main). */
export const DEFAULT_RIG_WEB_URL =
  'https://toon-protocol.github.io/toon-client';

/** Env var overriding the full-Rig URL (e.g. a future ArNS gateway URL). */
export const RIG_WEB_URL_ENV = 'RIG_WEB_URL';

export interface RigPointerOptions {
  /** Arweave txId of the rig-lite module the pointer boots. */
  rigLiteTx: string;
  /** Gateway base the module script loads from (no trailing /). */
  gateway: string;
  /** Full-Rig deployment for the fallback link (no trailing /). */
  rigWebUrl: string;
  /** Relay the Rig should read the repo from (`wss://…`). */
  relay: string;
  /** Repo owner as npub (rig-web routes are `#/<npub>/<repo>`). */
  ownerNpub: string;
  /** Repository id (NIP-34 d-tag). */
  repoId: string;
}

/** The full-Rig hash route for a repo, with the relay threaded through. */
export function rigWebRoute(
  options: Pick<RigPointerOptions, 'rigWebUrl' | 'relay' | 'ownerNpub' | 'repoId'>
): string {
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
 * Generate the pointer HTML: the rig-lite boot-in-place shell. Self-contained
 * except the one immutable module script it exists to load; degrades to a
 * visible full-Rig link with JS disabled.
 */
export function generateRigPointerHtml(options: RigPointerOptions): string {
  const gateway = options.gateway.replace(/\/+$/, '');
  const liteSrc = `${gateway}/${options.rigLiteTx}`;
  const fullRig = rigWebRoute(options);
  const safeFullRig = escapeHtml(fullRig);
  const title = escapeHtml(`${options.repoId} — Rig`);

  // Escape `<` so hostile config values can never break out of the script.
  const config = JSON.stringify({
    relay: options.relay,
    owner: options.ownerNpub,
    repo: options.repoId,
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Decentralized Git on Nostr &amp; TOON Protocol">
  <title>${title}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x2692;</text></svg>">
  <script>window.__RIG_CONFIG__=${config}</script>
  <script type="module" src="${escapeHtml(liteSrc)}"></script>
</head><body>
  <noscript><p>JavaScript is off — open <a href="${safeFullRig}">${title}</a> in the full Rig.</p></noscript>
  <p hidden data-fallback>If nothing loads, open <a href="${safeFullRig}">${title}</a> in the full Rig.</p>
  <script>setTimeout(function(){var p=document.querySelector("[data-fallback]");if(p&&!document.querySelector("header"))p.hidden=false},8000)</script>
</body></html>
`;
}

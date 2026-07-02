/**
 * Rig-UI pointer HTML generation.
 *
 * Pure function for generating the thin HTML shell that bootstraps
 * the canonical Rig-UI from Arweave with embedded relay config.
 * Extracted here for testability; also used by scripts/deploy-rig-pointer.mjs.
 */

const GATEWAY = 'https://ar-io.dev';

export interface PointerConfig {
  relay: string;
  repo?: string;
  owner?: string;
}

export interface PointerHtmlOptions {
  relay: string;
  repo?: string;
  owner?: string;
  rigTx: string;
  jsPath: string;
  cssPath: string;
}

/**
 * Generate the pointer HTML shell.
 */
export function generatePointerHtml({
  relay,
  repo,
  owner,
  rigTx,
  jsPath,
  cssPath,
}: PointerHtmlOptions): string {
  const config: PointerConfig = { relay };
  if (repo) config.repo = repo;
  if (owner) config.owner = owner;

  // Escape < as \u003c to prevent </script> breakout XSS
  const safeConfig = JSON.stringify(config).replace(/</g, '\\u003c');

  const title = repo ? `${repo} — Rig` : 'Rig';
  const baseUrl = `${GATEWAY}/${rigTx}`;

  return `<!DOCTYPE html>
<html lang="en"><head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="description" content="Decentralized Git on Nostr &amp; TOON Protocol">
  <meta http-equiv="Content-Security-Policy" content="default-src 'self' ${GATEWAY}; script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' ${GATEWAY}; style-src 'self' 'unsafe-inline' ${GATEWAY}; connect-src 'self' ws: wss: ${GATEWAY} *.ar-io.dev https://arweave.net *.arweave.net https://permagate.io *.permagate.io; img-src 'self' data: https:">
  <title>${title}</title>
  <link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>&#x2692;</text></svg>">
  <script>window.__RIG_CONFIG__=${safeConfig}</script>
  <link rel="stylesheet" href="${baseUrl}/${cssPath}">
</head><body>
  <div id="app"></div>
  <script type="module" src="${baseUrl}/${jsPath}"></script>
</body></html>
`;
}

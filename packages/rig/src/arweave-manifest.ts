/**
 * Arweave path manifest builder for `rig site` permaweb deploys (#368).
 *
 * MIRROR of `@toon-protocol/rig-web`'s
 * `packages/rig-web/src/web/deploy-manifest.ts` — copied rather than imported
 * because `rig` (a CLI) must not take a runtime dependency on `rig-web` (a
 * browser-only frontend). The two are intentionally kept in sync; this copy
 * additionally supports the manifest spec's optional `fallback` field (SPA
 * routing), which the site verb needs but the rig-web deploy script does not.
 *
 * Generates the JSON manifest ar.io gateways use to serve a multi-file
 * Arweave deployment as a virtual path-routed site: one manifest transaction
 * whose id becomes the site's canonical `https://<gateway>/<txid>/` URL.
 *
 * spec: https://specs.ar.io/arweave-standards/ao/index-1/manifest
 */

export interface ArweaveManifest {
  manifest: 'arweave/paths';
  version: '0.2.0';
  index: { path: string };
  /**
   * Optional SPA fallback: the transaction served for any path not present in
   * `paths` (e.g. client-routed `/about` on a single-page app). Omitted for a
   * plain static site.
   */
  fallback?: { id: string };
  paths: Record<string, { id: string }>;
}

export interface ManifestEntry {
  /** Relative URL path, e.g. `index.html` or `assets/main.js`. */
  path: string;
  /** Arweave transaction id the file's bytes are stored under. */
  txId: string;
}

const DEFAULT_INDEX = 'index.html';

/**
 * Build an Arweave path manifest from a list of uploaded files.
 *
 * Each entry maps a relative URL path to the Arweave transaction id where
 * that file was uploaded. The resulting manifest is uploaded as its own
 * Arweave transaction; its id becomes the canonical URL for the deployment.
 *
 * @param entries    path → txId for every file the site serves.
 * @param indexPath  the path served at `/` (default `index.html`).
 * @param fallbackTxId  optional SPA fallback transaction id (spec `fallback`).
 */
export function buildArweaveManifest(
  entries: ManifestEntry[],
  indexPath = DEFAULT_INDEX,
  fallbackTxId?: string
): ArweaveManifest {
  const paths: Record<string, { id: string }> = {};
  for (const { path, txId } of entries) {
    paths[path] = { id: txId };
  }
  return {
    manifest: 'arweave/paths',
    version: '0.2.0',
    index: { path: indexPath },
    ...(fallbackTxId ? { fallback: { id: fallbackTxId } } : {}),
    paths,
  };
}

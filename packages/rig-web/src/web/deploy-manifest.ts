/**
 * Arweave path manifest builder for Rig-UI deployment.
 *
 * Generates the JSON manifest required by ar.io gateways to serve a
 * multi-file Arweave deployment as a virtual path-routed site.
 *
 * spec: https://specs.ar.io/arweave-standards/ao/index-1/manifest
 */

export interface ArweaveManifest {
  manifest: 'arweave/paths';
  version: '0.2.0';
  index: { path: string };
  paths: Record<string, { id: string }>;
}

export interface ManifestEntry {
  path: string;
  txId: string;
}

const DEFAULT_INDEX = 'index.html';

/**
 * Build an Arweave path manifest from a list of uploaded files.
 *
 * Each entry maps a relative URL path to the Arweave transaction ID where
 * that file was uploaded. The resulting manifest is uploaded as its own
 * Arweave transaction; its ID becomes the canonical URL for the deployment.
 */
export function buildArweaveManifest(
  entries: ManifestEntry[],
  indexPath = DEFAULT_INDEX
): ArweaveManifest {
  const paths: Record<string, { id: string }> = {};
  for (const { path, txId } of entries) {
    paths[path] = { id: txId };
  }
  return {
    manifest: 'arweave/paths',
    version: '0.2.0',
    index: { path: indexPath },
    paths,
  };
}

/**
 * Local record of the last-published site manifest per (repo, ref) — the
 * lookup `rig site url` reads for FREE (#368).
 *
 * A site manifest's txId is only knowable AFTER the paid manifest upload (it
 * is the hash of the signed Arweave data item), and it changes every publish.
 * There is no free network lookup for "the current manifest of this repo"
 * until an ArNS name points at it (#367). So `rig site publish` records what
 * it just published here, and `rig site url` reads it back — no client start,
 * no relay query, no payment.
 *
 * Stored under `TOON_CLIENT_HOME` (default `~/.toon-client`) as
 * `site-manifests.json`, keyed by `<repoId>\0<ref>` (local, single-user
 * scope — the owner pubkey is stored as a field, not part of the key). A
 * corrupt/unreadable file is treated as empty for reads and overwritten on
 * write, never fatal to a free lookup.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const SITE_MANIFEST_FILENAME = 'site-manifests.json';

/** One recorded site publish. */
export interface SiteManifestRecord {
  repoId: string;
  /** Full refname the site was built from, e.g. `refs/heads/main`. */
  ref: string;
  /** Owner pubkey (hex) the manifest was published under. */
  owner: string;
  /** The manifest transaction id (43-char base64url). */
  manifestTxId: string;
  /** Gateway base the printed URL used, e.g. `https://arweave.net`. */
  gateway: string;
  /** Unix milliseconds of the publish. */
  updatedAt: number;
}

type SiteManifestFile = Record<string, SiteManifestRecord>;

function storeDir(env: NodeJS.ProcessEnv): string {
  return env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
}

function storePath(env: NodeJS.ProcessEnv): string {
  return join(storeDir(env), SITE_MANIFEST_FILENAME);
}

function keyOf(repoId: string, ref: string): string {
  return `${repoId}\0${ref}`;
}

function readFile(env: NodeJS.ProcessEnv): SiteManifestFile {
  try {
    const parsed = JSON.parse(readFileSync(storePath(env), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as SiteManifestFile;
    return {};
  } catch {
    // Missing or corrupt → empty (a free lookup must never throw on this).
    return {};
  }
}

/** The recorded manifest for (repoId, ref), or `undefined` if none. */
export function readSiteRecord(
  env: NodeJS.ProcessEnv,
  repoId: string,
  ref: string
): SiteManifestRecord | undefined {
  return readFile(env)[keyOf(repoId, ref)];
}

/** Record (or overwrite) the manifest just published for (repoId, ref). */
export function writeSiteRecord(
  env: NodeJS.ProcessEnv,
  record: SiteManifestRecord
): void {
  const dir = storeDir(env);
  mkdirSync(dir, { recursive: true });
  const file = readFile(env);
  file[keyOf(record.repoId, record.ref)] = record;
  writeFileSync(storePath(env), `${JSON.stringify(file, null, 2)}\n`, 'utf8');
}

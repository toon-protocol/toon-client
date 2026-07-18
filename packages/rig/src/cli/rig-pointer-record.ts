/**
 * Local record of the last-published Rig pointer per repo — what lets
 * `rig push` keep the per-repo Rig page (../rig-pointer.ts) current like
 * GitHub Pages WITHOUT re-paying on every push.
 *
 * The pointer HTML is deterministic for (rigWebUrl, relay, owner, repoId),
 * so its sha-256 is recorded alongside the uploaded txId: while the hash
 * matches, later pushes reuse the recorded URL for free; when any input
 * changes (relay moved, rig-web base flipped to the Arweave bundle), the
 * next push uploads a fresh pointer and the record rolls forward.
 *
 * Same storage conventions as ./site-record.ts: a JSON file under
 * `TOON_CLIENT_HOME` (default `~/.toon-client`), keyed by repoId (local,
 * single-user scope); corrupt/missing files are treated as empty for reads
 * and overwritten on write.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const RIG_POINTER_FILENAME = 'rig-pointers.json';

/** One recorded Rig-pointer publish. */
export interface RigPointerRecord {
  repoId: string;
  /** Owner pubkey (hex) the pointer was published under. */
  owner: string;
  /** The pointer transaction id (43-char base64url). */
  pointerTxId: string;
  /** sha-256 (hex) of the pointer HTML that was uploaded. */
  contentHash: string;
  /** Unix milliseconds of the publish. */
  updatedAt: number;
}

type RigPointerFile = Record<string, RigPointerRecord>;

function storeDir(env: NodeJS.ProcessEnv): string {
  return env['TOON_CLIENT_HOME'] ?? join(homedir(), '.toon-client');
}

function storePath(env: NodeJS.ProcessEnv): string {
  return join(storeDir(env), RIG_POINTER_FILENAME);
}

function readAll(env: NodeJS.ProcessEnv): RigPointerFile {
  try {
    const parsed = JSON.parse(readFileSync(storePath(env), 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as RigPointerFile;
    return {};
  } catch {
    // Missing or corrupt → empty (never fatal to a push).
    return {};
  }
}

/** The recorded pointer for a repo, if any. */
export function readRigPointerRecord(
  env: NodeJS.ProcessEnv,
  repoId: string
): RigPointerRecord | undefined {
  return readAll(env)[repoId];
}

/** Record a pointer publish (overwrites the repo's previous record). */
export function writeRigPointerRecord(
  env: NodeJS.ProcessEnv,
  record: RigPointerRecord
): void {
  const all = readAll(env);
  all[record.repoId] = record;
  mkdirSync(storeDir(env), { recursive: true });
  writeFileSync(storePath(env), `${JSON.stringify(all, null, 2)}\n`);
}

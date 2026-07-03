/**
 * The shared clone/fetch object-collection engine (#278).
 *
 * Given the remote's ref tips and its kind:30618 sha→Arweave-txId map, gather
 * every object the refs need:
 *
 *   1. download the mapped objects the destination repo doesn't already have
 *      (parallel, gateway fallback chain, SHA-verified — ./object-fetch.ts);
 *   2. walk the object graph from the tips (./object-fetch.ts walkClosure) —
 *      the local repository's objects count as present (git fetch's own
 *      assumption: a consistent repo carries its own closure);
 *   3. SHAs the map doesn't cover are resolved through the Arweave GraphQL
 *      Git-SHA resolver (RemoteState.resolveMissing) and downloaded, looping
 *      until the closure is complete or no progress can be made.
 *
 * The result separates FATAL gaps (reachable objects that could not be
 * obtained — usually Arweave gateway propagation lag, 10–20 min for fresh
 * pushes) from harmless ones (mapped-but-unreachable objects, e.g. history
 * that was force-pushed away). Corrupt objects throw ObjectIntegrityError
 * from the download layer and never surface here.
 */

import {
  downloadGitObjects,
  walkClosure,
  type DownloadOptions,
  type FetchedObject,
} from './object-fetch.js';
import { EMPTY_BLOB_SHA } from './objects.js';

/** A reachable object that could not be obtained. */
export interface MissingObject {
  sha: string;
  /** The txId that failed on every gateway, or null when no txId resolved. */
  txId: string | null;
}

export interface CollectRepoObjectsOptions extends DownloadOptions {
  /** Ref tip SHAs (commits or annotated tags) the closure must reach. */
  tips: string[];
  /** kind:30618 `arweave` tag map: git SHA → Arweave txId. */
  shaToTxId: ReadonlyMap<string, string>;
  /** GraphQL fallback for SHAs the map doesn't cover (RemoteState.resolveMissing). */
  resolveMissing: (shas: string[]) => Promise<Map<string, string>>;
  /** SHAs already present in the destination repository (fetch delta). */
  presentLocally?: ReadonlySet<string>;
}

export interface CollectRepoObjectsResult {
  /** Verified objects to write, keyed by SHA. */
  objects: Map<string, FetchedObject>;
  /** Reachable SHAs that could not be obtained — FATAL for clone/fetch. */
  missing: MissingObject[];
  /** Mapped-but-unreachable SHAs that failed to download — warn only. */
  skippedUnavailable: { sha: string; txId: string }[];
}

/** Iteration cap: closure depth of NEW unmapped SHAs per pass; generous. */
const MAX_PASSES = 64;

/** Collect (download + verify + close over) the objects the ref tips need. */
export async function collectRepoObjects(
  options: CollectRepoObjectsOptions
): Promise<CollectRepoObjectsResult> {
  const { tips, shaToTxId, resolveMissing } = options;
  const present = options.presentLocally ?? new Set<string>();

  /** All txId knowledge: the 30618 map + GraphQL-resolved additions. */
  const txIds = new Map<string, string>(shaToTxId);
  /** SHAs we already asked the GraphQL resolver about (avoid re-queries). */
  const resolverAsked = new Set<string>();
  /** SHAs whose download failed on every gateway. */
  const undownloadable = new Map<string, string>();
  const objects = new Map<string, FetchedObject>();

  // Pass 0: bulk-download everything the map covers that isn't local yet.
  const initial: [string, string][] = [];
  for (const [sha, txId] of txIds) {
    if (!present.has(sha)) initial.push([sha, txId]);
  }
  const bulk = await downloadGitObjects(initial, options);
  for (const [sha, object] of bulk.objects) objects.set(sha, object);
  for (const { sha, txId } of bulk.unavailable) undownloadable.set(sha, txId);

  // Iterate: close over the tips; resolve + download whatever is still open.
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const closure = walkClosure(tips, objects, present);
    const open = closure.missing.filter((sha) => !undownloadable.has(sha));
    if (open.length === 0) break;

    // Resolve txIds for open SHAs we haven't asked the resolver about.
    const toResolve = open.filter(
      (sha) => !txIds.has(sha) && !resolverAsked.has(sha)
    );
    for (const sha of toResolve) resolverAsked.add(sha);
    if (toResolve.length > 0) {
      const resolved = await resolveMissing(toResolve);
      for (const [sha, txId] of resolved) txIds.set(sha, txId);
    }

    // Download open SHAs that now have a txId and no failed attempt yet.
    const batch: [string, string][] = [];
    for (const sha of open) {
      const txId = txIds.get(sha);
      if (txId !== undefined && !objects.has(sha)) batch.push([sha, txId]);
    }
    if (batch.length === 0) break; // no progress possible
    const result = await downloadGitObjects(batch, options);
    for (const [sha, object] of result.objects) objects.set(sha, object);
    for (const { sha, txId } of result.unavailable)
      undownloadable.set(sha, txId);
    if (result.objects.size === 0) break; // every attempt failed — stop
  }

  // The git empty blob is never uploaded (the store rejects zero-byte
  // content; `rig push` skips it), so a tree that references it reports it
  // "missing" here even though it is a git constant. Synthesize it locally —
  // a zero-byte blob body always hashes to EMPTY_BLOB_SHA — instead of
  // erroring, so an empty file reconstructs bit-identically (git fsck clean).
  // Keyed off the EXACT constant SHA: the honest lag-error still fires for any
  // genuinely-missing non-empty object.
  let finalClosure = walkClosure(tips, objects, present);
  if (
    finalClosure.missing.includes(EMPTY_BLOB_SHA) &&
    !present.has(EMPTY_BLOB_SHA)
  ) {
    objects.set(EMPTY_BLOB_SHA, {
      sha: EMPTY_BLOB_SHA,
      type: 'blob',
      body: Buffer.alloc(0),
    });
    finalClosure = walkClosure(tips, objects, present);
  }

  // Final accounting.
  const missing: MissingObject[] = finalClosure.missing.map((sha) => ({
    sha,
    txId: txIds.get(sha) ?? null,
  }));
  const reachable = finalClosure.reachable;
  const skippedUnavailable = [...undownloadable]
    .filter(
      ([sha]) => !reachable.has(sha) && !finalClosure.missing.includes(sha)
    )
    .map(([sha, txId]) => ({ sha, txId }));

  return { objects, missing, skippedUnavailable };
}

/**
 * The honest propagation-lag error text: which SHAs are unobtainable and why
 * retrying later is the expected remedy.
 */
export function missingObjectsMessage(
  missing: MissingObject[],
  context: string
): string {
  const listed = missing
    .slice(0, 20)
    .map(
      (m) =>
        `  ${m.sha}${m.txId ? `  (tx ${m.txId})` : '  (no Arweave tx found)'}`
    )
    .join('\n');
  const more =
    missing.length > 20 ? `\n  … and ${missing.length - 20} more` : '';
  return (
    `${context}: ${missing.length} required object(s) could not be downloaded:\n` +
    `${listed}${more}\n` +
    'Recently pushed objects can take 10-20 minutes to become fetchable from ' +
    'Arweave gateways — if this repo was just pushed, retry in a few minutes. ' +
    'Nothing was written.'
  );
}

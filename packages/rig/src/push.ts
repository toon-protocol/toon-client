/**
 * Push planner/executor — the core of `rig push` (epic #222, ticket #226).
 *
 * `planPush` is network-free (relay/Arweave-wise — it only runs local git
 * plumbing through GitRepoReader plus one injectable async resolver step):
 * it classifies every ref update, computes the object delta against what the
 * remote already stores, hard-errors on oversize objects, and prices the
 * push. The returned {@link PushPlan} carries everything a confirm UI needs.
 *
 * `executePush` spends money: it uploads the planned objects through a
 * {@link Publisher} (ref-tip objects last, so a crashed push never leads to
 * a state where a discoverable tip's history is missing), then publishes ONE
 * cumulative kind:30618 whose `arweave` tags are the MERGE of the remote's
 * existing sha→txId map and the new uploads — kind:30618 is NIP-33
 * replaceable, so dropping prior tags would orphan earlier hints — and whose
 * `r` tags are the full new ref state. On a first push it publishes the
 * kind:30617 announcement before the refs event.
 *
 * Resume safety: uploads are content-addressed (Git-SHA-tagged), so re-running
 * `executePush` after a crash is safe — it consults the merged
 * remote + planned sha→txId map before paying for any upload, and a re-plan
 * with fresh remote state (whose `resolveMissing` finds the already-uploaded
 * objects via GraphQL) skips them entirely.
 */

import { buildRepoAnnouncement, buildRepoRefs } from './nip34-events.js';
import {
  EMPTY_BLOB_SHA,
  MAX_OBJECT_SIZE,
  type GitObjectType,
} from './objects.js';
import type {
  FeeRates,
  PublishReceipt,
  Publisher,
} from './publisher.js';
import { GitError, type GitRef, type GitRepoReader } from './repo-reader.js';
import type { RemoteState } from './remote-state.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A ref update rejected because it is not a fast-forward. */
export interface RejectedRefUpdate {
  refname: string;
  localSha: string;
  remoteSha: string;
}

/** Thrown by {@link planPush} when a non-fast-forward update lacks `force`. */
export class NonFastForwardError extends Error {
  constructor(
    /** The refs that would need `--force` to update. */
    public readonly refs: RejectedRefUpdate[]
  ) {
    super(
      `non-fast-forward update rejected for ${refs
        .map((r) => r.refname)
        .join(', ')} — re-run with force to overwrite the remote ref(s)`
    );
    this.name = 'NonFastForwardError';
  }
}

/** One object exceeding {@link MAX_OBJECT_SIZE}. */
export interface OversizeObject {
  sha: string;
  type: GitObjectType;
  /** Body size in bytes. */
  size: number;
  /** Path the object was reached by (blobs / non-root trees), if known. */
  path?: string;
}

/**
 * Thrown by {@link planPush} when any object in the delta exceeds the 95KB
 * upload limit (hard error in v1 — the paid blob path is a follow-up spike).
 */
export class OversizeObjectsError extends Error {
  constructor(
    /** The offending objects with paths and sizes. */
    public readonly objects: OversizeObject[]
  ) {
    super(
      `${objects.length} object(s) exceed the ${MAX_OBJECT_SIZE} byte upload limit: ` +
        objects
          .map((o) => `${o.path ?? o.sha} (${o.size} bytes)`)
          .join(', ')
    );
    this.name = 'OversizeObjectsError';
  }
}

// ---------------------------------------------------------------------------
// Plan types
// ---------------------------------------------------------------------------

/** How a ref moves relative to the remote. */
export type RefUpdateKind =
  /** Ref does not exist on the remote yet. */
  | 'new'
  /** Remote tip is an ancestor of the local tip. */
  | 'fast-forward'
  /** Non-fast-forward, allowed because `force` was set. */
  | 'forced'
  /** Local and remote tips already match — nothing to push. */
  | 'up-to-date';

/** One planned ref update (deletions are out of scope in v1). */
export interface RefUpdate {
  /** Full refname, e.g. `refs/heads/main`. */
  refname: string;
  /** Local tip SHA (tag object SHA for annotated tags). */
  localSha: string;
  /** Remote tip SHA, or null when the ref is new. */
  remoteSha: string | null;
  kind: RefUpdateKind;
}

/** One object scheduled for upload. */
export interface PlannedObject {
  sha: string;
  type: GitObjectType;
  /** Body size in bytes (what the upload fee is charged on). */
  size: number;
  /** Path the object was reached by, if any (blobs / non-root trees). */
  path?: string;
  /** True when this SHA is the tip of a planned ref update (uploaded last). */
  isRefTip: boolean;
}

/** Pre-push fee estimate — render this in the confirm table. */
export interface PushFeeEstimate {
  /** Number of objects to upload. */
  objectCount: number;
  /** Total bytes across all planned object bodies. */
  totalObjectBytes: number;
  /** Σ size × uploadFeePerByte (smallest asset unit). */
  uploadFee: bigint;
  /** Number of events to publish (refs event + announcement on first push). */
  eventCount: number;
  /** eventCount × eventFee (smallest asset unit). */
  eventFees: bigint;
  /** uploadFee + eventFees. */
  totalFee: bigint;
  /**
   * Objects excluded from the upload because their body is zero bytes — the
   * git empty blob, which the store rejects as malformed (F00). Reconstructed
   * locally on clone/fetch, so nothing is lost; surfaced here so the fee table
   * can report the skip honestly.
   */
  skippedEmptyCount: number;
}

/** Everything `executePush` (and a confirm UI) needs. */
export interface PushPlan {
  repoId: string;
  /** Every considered ref with its classification (incl. up-to-date). */
  refUpdates: RefUpdate[];
  /**
   * Full new ref state to publish as `r` tags: the remote's refs overlaid
   * with the planned updates (refs not being pushed are preserved — v1
   * never deletes). Ordered with the HEAD target first, which is what
   * `buildRepoRefs` derives the HEAD symref tag from.
   */
  newRefs: Record<string, string>;
  /** HEAD symref target for the new state (first key of {@link newRefs}). */
  headSymref: string | null;
  /**
   * Objects to upload, dependency-safe order: ref-tip objects last so a
   * crashed push never uploads a tip whose history is missing.
   */
  objects: PlannedObject[];
  /**
   * Zero-byte objects (the git empty blob) excluded from {@link objects}: the
   * store rejects a zero-byte kind:5094 upload as malformed (F00), so `rig`
   * never uploads it — the commit/tree still references it and clone/fetch
   * synthesizes it locally. Kept for honest receipts, never uploaded.
   */
  skippedEmptyObjects: PlannedObject[];
  /**
   * sha→txId hints known WITHOUT uploading: the remote's `arweave` tags
   * plus anything `resolveMissing` found. Merged into the published
   * kind:30618 so prior hints are never dropped.
   */
  knownShaToTxId: Map<string, string>;
  /** True when no kind:30617 exists yet — executePush announces first. */
  announceNeeded: boolean;
  /** Announcement metadata used when {@link announceNeeded}. */
  announcement: { name: string; description: string };
  estimate: PushFeeEstimate;
}

export interface PlanPushOptions {
  repoReader: GitRepoReader;
  remoteState: RemoteState;
  /** Fee rates from `Publisher.getFeeRates()`. */
  feeRates: FeeRates;
  /** Repository identifier (NIP-34 `d` tag). */
  repoId: string;
  /**
   * Full refnames to push (e.g. `['refs/heads/main']`). Defaults to every
   * local branch and tag. Refs that don't exist locally are an error
   * (deletions are out of scope in v1).
   */
  refs?: string[];
  /** Allow non-fast-forward updates (default false → hard error). */
  force?: boolean;
  /** Repo name/description for the first-push announcement. */
  announcement?: { name?: string; description?: string };
  /**
   * Async resolver for SHAs the remote's `arweave` tags don't cover —
   * consulted before deciding to re-upload. Defaults to
   * `remoteState.resolveMissing` (GraphQL fallback); injectable so the
   * planner core stays testable without network.
   */
  resolveMissing?: (shas: string[]) => Promise<Map<string, string>>;
}

// ---------------------------------------------------------------------------
// planPush
// ---------------------------------------------------------------------------

/**
 * Classify ref updates, compute the object delta, enforce the size limit,
 * and price the push. Throws {@link NonFastForwardError} /
 * {@link OversizeObjectsError} (both carry structured data for UIs).
 */
export async function planPush(options: PlanPushOptions): Promise<PushPlan> {
  const { repoReader, remoteState, feeRates, repoId, force = false } = options;
  const resolveMissing =
    options.resolveMissing ?? remoteState.resolveMissing.bind(remoteState);

  // 1. Select and classify refs. -------------------------------------------
  const { head, refs: localRefs } = await repoReader.listRefs();
  const localByName = new Map(localRefs.map((r) => [r.refname, r]));

  let selected: GitRef[];
  if (options.refs !== undefined) {
    selected = options.refs.map((name) => {
      const ref = localByName.get(name);
      if (!ref) {
        throw new Error(
          `ref ${JSON.stringify(name)} does not exist locally ` +
            '(ref deletion is out of scope in v1)'
        );
      }
      return ref;
    });
  } else {
    selected = localRefs;
  }

  const refUpdates: RefUpdate[] = [];
  const rejected: RejectedRefUpdate[] = [];
  for (const ref of selected) {
    const remoteSha = remoteState.refs.get(ref.refname) ?? null;
    if (remoteSha === null) {
      refUpdates.push({ refname: ref.refname, localSha: ref.sha, remoteSha, kind: 'new' });
      continue;
    }
    if (remoteSha === ref.sha) {
      refUpdates.push({ refname: ref.refname, localSha: ref.sha, remoteSha, kind: 'up-to-date' });
      continue;
    }
    let fastForward = false;
    try {
      fastForward = await repoReader.isAncestor(remoteSha, ref.sha);
    } catch (err) {
      // Remote tip unknown locally (never fetched) or not a commit-ish —
      // we can't prove ancestry, so treat it as non-fast-forward.
      if (!(err instanceof GitError)) throw err;
      fastForward = false;
    }
    if (fastForward) {
      refUpdates.push({ refname: ref.refname, localSha: ref.sha, remoteSha, kind: 'fast-forward' });
    } else if (force) {
      refUpdates.push({ refname: ref.refname, localSha: ref.sha, remoteSha, kind: 'forced' });
    } else {
      rejected.push({ refname: ref.refname, localSha: ref.sha, remoteSha });
    }
  }
  if (rejected.length > 0) throw new NonFastForwardError(rejected);

  const updates = refUpdates.filter((u) => u.kind !== 'up-to-date');

  // 2. Object delta: reachable from the new tips, minus what the remote has.
  const wantTips = [...new Set(updates.map((u) => u.localSha))];
  const haveTips = [...new Set(remoteState.refs.values())];
  const delta =
    wantTips.length > 0
      ? await repoReader.objectsBetweenWithPaths(wantTips, haveTips)
      : [];

  const knownShaToTxId = new Map(remoteState.shaToTxId);
  let candidates = delta.filter((o) => !knownShaToTxId.has(o.sha));
  if (candidates.length > 0) {
    // The remote's `arweave` tags may lag reality (e.g. a crashed push
    // uploaded objects but never published the refs event) — resolve the
    // gaps before paying to re-upload content-addressed data.
    const resolved = await resolveMissing(candidates.map((o) => o.sha));
    for (const [sha, txId] of resolved) knownShaToTxId.set(sha, txId);
    candidates = candidates.filter((o) => !knownShaToTxId.has(o.sha));
  }

  // 3. Sizes + oversize hard error. -----------------------------------------
  const pathBySha = new Map(candidates.map((c) => [c.sha, c.path]));
  const { objects: stats, missing } = await repoReader.statObjects(
    candidates.map((c) => c.sha)
  );
  if (missing.length > 0) {
    throw new Error(
      `objects vanished from the local repository during planning: ${missing.join(', ')}`
    );
  }

  const oversize: OversizeObject[] = [];
  for (const stat of stats) {
    if (stat.size > MAX_OBJECT_SIZE) {
      const path = pathBySha.get(stat.sha);
      oversize.push({ ...stat, ...(path ? { path } : {}) });
    }
  }
  if (oversize.length > 0) throw new OversizeObjectsError(oversize);

  // 4. Split off the empty blob, then order the rest ref-tips-last. ----------
  // The git empty blob uploads as an empty kind:5094 `i` value, which the
  // store rejects as malformed (F00). Skip it: it is reconstructed locally on
  // clone/fetch. Keyed off the EXACT empty-blob constant SHA — NOT a
  // `size === 0` heuristic, which would also match the (distinct, valid) empty
  // TREE object `4b825dc6…` and silently drop it (it is not synthesized on
  // read). An object whose SHA is EMPTY_BLOB_SHA is provably the empty blob.
  const tipShas = new Set(updates.map((u) => u.localSha));
  const planned: PlannedObject[] = [];
  const skippedEmptyObjects: PlannedObject[] = [];
  for (const stat of stats) {
    const path = pathBySha.get(stat.sha);
    const object: PlannedObject = {
      ...stat,
      ...(path ? { path } : {}),
      isRefTip: tipShas.has(stat.sha),
    };
    if (stat.sha === EMPTY_BLOB_SHA) skippedEmptyObjects.push(object);
    else planned.push(object);
  }
  const objects = [
    ...planned.filter((o) => !o.isRefTip),
    ...planned.filter((o) => o.isRefTip),
  ];

  // 5. Full new ref state (remote refs overlaid with updates), HEAD first. --
  const newRefsMap = new Map(remoteState.refs);
  for (const update of updates) newRefsMap.set(update.refname, update.localSha);

  const headSymref =
    head && newRefsMap.has(head)
      ? head
      : remoteState.headSymref && newRefsMap.has(remoteState.headSymref)
        ? remoteState.headSymref
        : ([...newRefsMap.keys()][0] ?? null);

  const newRefs: Record<string, string> = {};
  const headSha = headSymref ? newRefsMap.get(headSymref) : undefined;
  if (headSymref && headSha) newRefs[headSymref] = headSha;
  for (const [refname, sha] of newRefsMap) {
    if (refname !== headSymref) newRefs[refname] = sha;
  }

  // 6. Fee estimate. ---------------------------------------------------------
  const announceNeeded = !remoteState.announced;
  const totalObjectBytes = objects.reduce((sum, o) => sum + o.size, 0);
  const uploadFee = BigInt(totalObjectBytes) * feeRates.uploadFeePerByte;
  const eventCount = 1 + (announceNeeded ? 1 : 0);
  const eventFees = BigInt(eventCount) * feeRates.eventFee;

  return {
    repoId,
    refUpdates,
    newRefs,
    headSymref,
    objects,
    skippedEmptyObjects,
    knownShaToTxId,
    announceNeeded,
    announcement: {
      name: options.announcement?.name ?? repoId,
      description: options.announcement?.description ?? '',
    },
    estimate: {
      objectCount: objects.length,
      totalObjectBytes,
      uploadFee,
      eventCount,
      eventFees,
      totalFee: uploadFee + eventFees,
      skippedEmptyCount: skippedEmptyObjects.length,
    },
  };
}

// ---------------------------------------------------------------------------
// executePush
// ---------------------------------------------------------------------------

/** Result of one object-upload step. */
export interface UploadStepResult {
  sha: string;
  txId: string;
  /** 0n when skipped (already uploaded — content-addressed resume). */
  feePaid: bigint;
  /** True when the object was already on Arweave and nothing was paid. */
  skipped: boolean;
}

/** Result of the whole push. */
export interface PushResult {
  /** Per-object results, in plan order. */
  uploads: UploadStepResult[];
  /** kind:30617 receipt, or null when the repo was already announced. */
  announceReceipt: PublishReceipt | null;
  /** kind:30618 (cumulative refs + arweave map) receipt. */
  refsReceipt: PublishReceipt;
  /**
   * The full sha→txId map published in the refs event: remote hints +
   * resolver finds + this push's uploads.
   */
  arweaveMap: Map<string, string>;
  /** Total fees actually paid (uploads + events), smallest asset unit. */
  totalFeePaid: bigint;
}

export interface ExecutePushOptions {
  plan: PushPlan;
  publisher: Publisher;
  /**
   * Remote state — pass a FRESH fetch when resuming after a crash so its
   * `shaToTxId` (and `announced`) reflect what the previous attempt already
   * paid for.
   */
  remoteState: RemoteState;
  repoReader: GitRepoReader;
  /** Relay URLs to publish events to (plural from day one; size 1 today). */
  relayUrls: string[];
}

/** How many object bodies to hold in memory at once between read and upload. */
const READ_BATCH_SIZE = 100;

/**
 * Execute a {@link PushPlan}: upload objects (ref tips last), then publish
 * the kind:30617 announcement (first push only) and ONE cumulative
 * kind:30618 whose `arweave` tags merge every known sha→txId hint with the
 * new uploads and whose `r` tags carry the full new ref state.
 *
 * Safe to re-run after a crash: SHAs already present in the merged
 * remote + plan map are skipped without paying.
 */
export async function executePush(
  options: ExecutePushOptions
): Promise<PushResult> {
  const { plan, publisher, remoteState, repoReader, relayUrls } = options;

  // Merged sha→txId map: remote hints (fresh on resume) + plan-time finds.
  // Consulted before every upload — this is the resume-safety check.
  const merged = new Map([...remoteState.shaToTxId, ...plan.knownShaToTxId]);

  const resultBySha = new Map<string, UploadStepResult>();
  let totalFeePaid = 0n;

  const pending: PlannedObject[] = [];
  for (const object of plan.objects) {
    const knownTxId = merged.get(object.sha);
    if (knownTxId !== undefined) {
      resultBySha.set(object.sha, {
        sha: object.sha,
        txId: knownTxId,
        feePaid: 0n,
        skipped: true,
      });
    } else {
      pending.push(object);
    }
  }

  // Upload in plan order (ref tips are already last), reading bodies in
  // batches so memory stays bounded on large pushes.
  for (let i = 0; i < pending.length; i += READ_BATCH_SIZE) {
    const batch = pending.slice(i, i + READ_BATCH_SIZE);
    const { objects: read, missing } = await repoReader.readObjects(
      batch.map((o) => o.sha)
    );
    if (missing.length > 0) {
      throw new Error(
        `objects vanished from the local repository during push: ${missing.join(', ')}`
      );
    }
    const bodyBySha = new Map(read.map((r) => [r.sha, r.body]));
    for (const object of batch) {
      const body = bodyBySha.get(object.sha);
      if (!body) {
        throw new Error(
          `internal: cat-file returned no body for ${object.sha}`
        );
      }
      const receipt = await publisher.uploadGitObject({
        sha: object.sha,
        type: object.type,
        body,
        repoId: plan.repoId,
        // #368: the path the blob was reached by drives its Content-Type; a
        // non-blob object (no path) uploads as octet-stream.
        ...(object.path ? { path: object.path } : {}),
      });
      merged.set(object.sha, receipt.txId);
      totalFeePaid += receipt.feePaid;
      resultBySha.set(object.sha, {
        sha: object.sha,
        txId: receipt.txId,
        feePaid: receipt.feePaid,
        skipped: false,
      });
    }
  }

  // Announcement (first push only) goes before the refs event so a repo is
  // never referenced by an `a` tag before its kind:30617 exists. Re-check
  // the (fresh-on-resume) remote state so a crashed push doesn't announce
  // twice.
  let announceReceipt: PublishReceipt | null = null;
  if (plan.announceNeeded && !remoteState.announced) {
    const announceEvent = buildRepoAnnouncement(
      plan.repoId,
      plan.announcement.name,
      plan.announcement.description
    );
    announceReceipt = await publisher.publishEvent(announceEvent, relayUrls);
    totalFeePaid += announceReceipt.feePaid;
  }

  // ONE cumulative kind:30618: full ref state + MERGED arweave map (NIP-33
  // replaceable — dropping prior tags would orphan earlier sha→txId hints).
  const refsEvent = buildRepoRefs(
    plan.repoId,
    plan.newRefs,
    Object.fromEntries(merged)
  );
  const refsReceipt = await publisher.publishEvent(refsEvent, relayUrls);
  totalFeePaid += refsReceipt.feePaid;

  const uploads = plan.objects.map((o) => {
    const step = resultBySha.get(o.sha);
    if (!step) {
      throw new Error(`internal: no upload result recorded for ${o.sha}`);
    }
    return step;
  });

  return {
    uploads,
    announceReceipt,
    refsReceipt,
    arweaveMap: merged,
    totalFeePaid,
  };
}

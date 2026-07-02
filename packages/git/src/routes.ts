/**
 * Wire shapes of the toon-clientd `/git/*` control routes (epic #222).
 *
 * These are the JSON request/response types the daemon serves (bigints as
 * decimal strings, Maps as plain records) — defined HERE, in the dependency
 * root, so both sides of the route can share them: the `rig` CLI (#229)
 * consumes them as a plain-fetch client, and `@toon-protocol/client-mcp`
 * (which depends on this package for the planner — the reverse import would
 * be circular) can adopt them for its `control-api.ts` declarations. TYPES
 * ONLY plus two pure serializers; no transport code lives here.
 *
 * Keep in byte-for-byte sync with
 * `packages/client-mcp/src/control-api.ts` (`Git*` shapes) and
 * `packages/client-mcp/src/daemon/routes.ts` (error envelopes: 409
 * `non_fast_forward` carries `refs`, 413 `oversize_objects` carries
 * `objects`, 503 `bootstrapping` / 402 `insufficient_gas` are retryable).
 */

import type { PlannedObject, PushPlan, PushResult, RefUpdate } from './push.js';

/** One planned ref update (JSON-safe as-is). */
export type GitRefUpdate = RefUpdate;

/** One object scheduled for upload (JSON-safe as-is). */
export type GitPlannedObject = PlannedObject;

/**
 * `POST /git/estimate` — plan a push (local git plumbing + remote-state read)
 * and price it WITHOUT paying anything. The same body (plus `confirm`) drives
 * `POST /git/push`.
 */
export interface GitEstimateRequest {
  /** Path to the local git repository (worktree or .git dir). Must exist. */
  repoPath: string;
  /** Repository identifier (NIP-34 `d` tag). The daemon identity is the owner. */
  repoId: string;
  /**
   * Full refnames to push (e.g. `["refs/heads/main"]`). Default: every local
   * branch and tag.
   */
  refspecs?: string[];
  /** Allow non-fast-forward updates (default false → 409 `non_fast_forward`). */
  force?: boolean;
  /**
   * Relay URLs to read remote state from and publish to. Plural from day one
   * (forward-compat); defaults to the daemon's config-seeded relay.
   */
  relayUrls?: string[];
  /** Repo name/description for the first-push kind:30617 announcement. */
  announcement?: { name?: string; description?: string };
}

/** Pre-push fee table (all fees in base/micro units, decimal strings). */
export interface GitFeeEstimate {
  objectCount: number;
  totalObjectBytes: number;
  /** Σ size × uploadFeePerByte. */
  uploadFee: string;
  /** Events to publish (refs event + announcement on first push). */
  eventCount: number;
  /** eventCount × per-event fee. */
  eventFees: string;
  /** uploadFee + eventFees. */
  totalFee: string;
}

/** Serialized `PushPlan` — everything a confirm UI needs. */
export interface GitEstimateResponse {
  repoId: string;
  refUpdates: GitRefUpdate[];
  /** Full new ref state to publish (HEAD target first). */
  newRefs: Record<string, string>;
  headSymref: string | null;
  objects: GitPlannedObject[];
  /** sha→txId hints known WITHOUT uploading (remote tags + resolver finds). */
  knownShaToTxId: Record<string, string>;
  /** True when no kind:30617 exists yet — the push announces first. */
  announceNeeded: boolean;
  announcement: { name: string; description: string };
  estimate: GitFeeEstimate;
}

/**
 * `POST /git/push` — plan + execute: upload the delta to Arweave and publish
 * the cumulative kind:30618 (+ kind:30617 on first push). PERMANENT + PAID.
 */
export interface GitPushRequest extends GitEstimateRequest {
  /** Must be literally `true` — a push spends channel funds irreversibly. */
  confirm: boolean;
}

/** One object-upload step result. */
export interface GitUploadStep {
  sha: string;
  txId: string;
  /** '0' when skipped (already on Arweave — content-addressed resume). */
  feePaid: string;
  skipped: boolean;
}

/** Receipt for one published event. */
export interface GitPublishReceipt {
  eventId: string;
  feePaid: string;
}

/** Serialized `PushResult` — per-step receipts + total fees actually paid. */
export interface GitPushResponse {
  repoId: string;
  refUpdates: GitRefUpdate[];
  /** Per-object results, in plan order. */
  uploads: GitUploadStep[];
  /** kind:30617 receipt, or null when the repo was already announced. */
  announceReceipt: GitPublishReceipt | null;
  /** kind:30618 (cumulative refs + arweave map) receipt. */
  refsReceipt: GitPublishReceipt;
  /** Full sha→txId map published in the refs event. */
  arweaveMap: Record<string, string>;
  /** Total fees actually paid (uploads + events), base units, decimal. */
  totalFeePaid: string;
  /** The pre-push estimate the push ran under (compare against totalFeePaid). */
  estimate: GitFeeEstimate;
}

/**
 * Uniform error envelope of non-2xx control-route responses. Structured
 * errors put extra fields at the top level: `non_fast_forward` (409) adds
 * `refs`, `oversize_objects` (413) adds `objects`.
 */
export interface GitErrorEnvelope {
  error: string;
  detail?: string;
  /** True when the caller should retry (e.g. daemon still bootstrapping). */
  retryable?: boolean;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Serializers (pure) — the exact mapping the daemon routes apply; used by the
// CLI's standalone mode so both surfaces emit identical wire JSON.
// ---------------------------------------------------------------------------

/** Serialize a plan's fee estimate onto the wire (bigints → strings). */
export function serializeFeeEstimate(plan: PushPlan): GitFeeEstimate {
  return {
    objectCount: plan.estimate.objectCount,
    totalObjectBytes: plan.estimate.totalObjectBytes,
    uploadFee: plan.estimate.uploadFee.toString(),
    eventCount: plan.estimate.eventCount,
    eventFees: plan.estimate.eventFees.toString(),
    totalFee: plan.estimate.totalFee.toString(),
  };
}

/** Serialize a PushPlan onto the wire (bigints → strings, Maps → records). */
export function serializePushPlan(plan: PushPlan): GitEstimateResponse {
  return {
    repoId: plan.repoId,
    refUpdates: plan.refUpdates,
    newRefs: plan.newRefs,
    headSymref: plan.headSymref,
    objects: plan.objects,
    knownShaToTxId: Object.fromEntries(plan.knownShaToTxId),
    announceNeeded: plan.announceNeeded,
    announcement: plan.announcement,
    estimate: serializeFeeEstimate(plan),
  };
}

/** Serialize a PushResult onto the wire (bigints → strings, Maps → records). */
export function serializePushResult(
  plan: PushPlan,
  result: PushResult
): GitPushResponse {
  return {
    repoId: plan.repoId,
    refUpdates: plan.refUpdates,
    uploads: result.uploads.map((u) => ({
      sha: u.sha,
      txId: u.txId,
      feePaid: u.feePaid.toString(),
      skipped: u.skipped,
    })),
    announceReceipt: result.announceReceipt
      ? {
          eventId: result.announceReceipt.eventId,
          feePaid: result.announceReceipt.feePaid.toString(),
        }
      : null,
    refsReceipt: {
      eventId: result.refsReceipt.eventId,
      feePaid: result.refsReceipt.feePaid.toString(),
    },
    arweaveMap: Object.fromEntries(result.arweaveMap),
    totalFeePaid: result.totalFeePaid.toString(),
    estimate: serializeFeeEstimate(plan),
  };
}

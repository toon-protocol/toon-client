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

import type { PublishReceipt } from './publisher.js';
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
  /**
   * Zero-byte objects (the git empty blob) excluded from the upload — the
   * store rejects zero-byte content as malformed, so they are skipped on push
   * and reconstructed on clone/fetch. Optional for wire compatibility with
   * daemons predating the empty-blob handling. Default 0.
   */
  skippedEmptyCount?: number;
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

// ---------------------------------------------------------------------------
// Single-event git publishes (`/git/issue|comment|patch|status`, #231)
// ---------------------------------------------------------------------------

/** NIP-34 repository address: the owner+id pair behind `a` tags. */
export interface GitRepoAddr {
  /** Repository owner's Nostr pubkey (64-char hex) — author of kind:30617/30618. */
  ownerPubkey: string;
  /** Repository identifier (NIP-34 `d` tag). */
  repoId: string;
}

/** `POST /git/issue` — publish a kind:1621 issue against a repo. PAID. */
export interface GitIssueRequest {
  repoAddr: GitRepoAddr;
  /** Issue title (`subject` tag). */
  title: string;
  /** Issue body (Markdown content). */
  body: string;
  /** Labels (`t` tags). */
  labels?: string[];
}

/** `POST /git/comment` — publish a kind:1622 comment on an issue/patch. PAID. */
export interface GitCommentRequest {
  repoAddr: GitRepoAddr;
  /** Event id of the issue or patch being commented on. */
  rootEventId: string;
  /** Comment body (Markdown content). */
  body: string;
  /**
   * Pubkey of the TARGET event's author (NIP-34 `p` threading tag — not the
   * comment author). Defaults to the repo owner.
   */
  parentAuthorPubkey?: string;
  /** `e`-tag marker (default 'root': commenting directly on the issue/patch). */
  marker?: 'root' | 'reply';
}

/**
 * `POST /git/patch` — publish a kind:1617 patch. Supply EXACTLY ONE of
 * `patchText` (literal `git format-patch` output) or `repoPath`+`range`
 * (the daemon runs `git format-patch --stdout <range>` locally). PAID.
 */
export interface GitPatchRequest {
  repoAddr: GitRepoAddr;
  /** Patch/PR title (`subject` tag). */
  title: string;
  /**
   * PR body/cover text (`description` tag). Kept OUT of the event content so
   * `git am` still consumes the patch text verbatim (#280).
   */
  description?: string;
  /** Literal patch text. Mutually exclusive with `repoPath`+`range`. */
  patchText?: string;
  /** Local repository to run format-patch in. Requires `range`. */
  repoPath?: string;
  /** Revision range for format-patch (`<rev>`, `<rev>..<rev>`, `<rev>...<rev>`). */
  range?: string;
  /** Commit/parent pairs for `commit`/`parent-commit` tags. */
  commits?: { sha: string; parentSha: string }[];
  /** Branch name for the `t` tag. */
  branch?: string;
}

export type GitStatusValue = 'open' | 'applied' | 'closed' | 'draft';

/** `POST /git/status` — publish a kind:1630-1633 status event. PAID. */
export interface GitStatusRequest {
  repoAddr: GitRepoAddr;
  /** Event id of the issue/patch whose status is being set. */
  targetEventId: string;
  /** open → 1630, applied → 1631, closed → 1632, draft → 1633. */
  status: GitStatusValue;
  /** Pubkey of the target event's author (`p` tag), when known. */
  targetPubkey?: string;
}

/**
 * Response of the single-event git publishes (issue/comment/patch/status):
 * a publish receipt plus the NIP-34 kind that was published. Daemon
 * responses extend the full `POST /publish` receipt, so the channel fields
 * (`channelId`/`nonce`/…) are present there; they are optional here because
 * the CLI's standalone path publishes through the embedded client and has
 * no channel wire shape to report.
 */
export interface GitEventResponse {
  /** Event ID as accepted by the relay. */
  eventId: string;
  /** Fee actually paid for this publish, base units, decimal string. */
  feePaid: string;
  /** The NIP-34 kind that was published. */
  kind: number;
  /** Channel the claim was signed against (daemon responses). */
  channelId?: string;
  /** Channel nonce after this publish (daemon responses). */
  nonce?: number;
  /** FULFILL response data (base64), when the backend returned any. */
  data?: string;
  /** Spendable channel balance after this write, when known. */
  channelBalanceAfter?: string;
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
    ...(plan.estimate.skippedEmptyCount > 0
      ? { skippedEmptyCount: plan.estimate.skippedEmptyCount }
      : {}),
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

/**
 * Serialize a standalone {@link PublishReceipt} into the wire shape the
 * daemon's single-event `/git/*` routes answer with, so `--json` consumers
 * see one `GitEventResponse` shape regardless of publisher mode.
 */
export function serializeEventReceipt(
  kind: number,
  receipt: PublishReceipt
): GitEventResponse {
  return {
    eventId: receipt.eventId,
    feePaid: receipt.feePaid.toString(),
    kind,
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

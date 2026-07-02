/**
 * @toon-protocol/git — Git-to-TOON write path core.
 *
 * Pure builders for git objects (blob/tree/commit/tag with SHA-1 envelope
 * hashing) and NIP-34 events (repo announcement/refs, issues, comments,
 * patches, statuses), plus GitRepoReader (execFile git plumbing for reading
 * a local repo), the remote-state reader (kind:30617/30618 relay fetch +
 * Arweave Git-SHA resolution), and the push planner/executor
 * (planPush/executePush) behind the Publisher interface. No signing or
 * payment code lives here — the daemon (#227) and standalone (#228)
 * Publisher implementations arrive in the follow-up tickets of epic
 * toon-client#222.
 */

export {
  MAX_OBJECT_SIZE,
  createGitBlob,
  createGitCommit,
  createGitTag,
  createGitTree,
  hashGitObject,
  type GitObject,
  type GitObjectType,
} from './objects.js';

export {
  COMMENT_KIND,
  REPOSITORY_STATE_KIND,
  buildComment,
  buildIssue,
  buildPatch,
  buildRepoAnnouncement,
  buildRepoRefs,
  buildStatus,
  type StatusKind,
  type UnsignedEvent,
} from './nip34-events.js';

export { GitError, GitRepoReader, type GitRef, type ObjectStat, type ObjectWithPath, type ReadGitObject, type ReadObjectsResult, type RepoRefs, type StatObjectsResult } from './repo-reader.js';
export { fetchRemoteState, type FetchRemoteStateOptions, type NostrEvent, type RemoteState, type WebSocketFactory, type WebSocketLike } from './remote-state.js';

export {
  type FeeRates,
  type GitObjectUpload,
  type PublishReceipt,
  type Publisher,
  type UploadReceipt,
} from './publisher.js';

export {
  serializeFeeEstimate,
  serializePushPlan,
  serializePushResult,
  type GitErrorEnvelope,
  type GitEstimateRequest,
  type GitEstimateResponse,
  type GitFeeEstimate,
  type GitPlannedObject,
  type GitPublishReceipt,
  type GitPushRequest,
  type GitPushResponse,
  type GitRefUpdate,
  type GitUploadStep,
} from './routes.js';

export {
  NonFastForwardError,
  OversizeObjectsError,
  executePush,
  planPush,
  type ExecutePushOptions,
  type OversizeObject,
  type PlanPushOptions,
  type PlannedObject,
  type PushFeeEstimate,
  type PushPlan,
  type PushResult,
  type RefUpdate,
  type RefUpdateKind,
  type RejectedRefUpdate,
  type UploadStepResult,
} from './push.js';

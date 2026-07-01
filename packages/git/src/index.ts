/**
 * @toon-protocol/git — Git-to-TOON write path core.
 *
 * Pure builders for git objects (blob/tree/commit/tag with SHA-1 envelope
 * hashing) and NIP-34 events (repo announcement/refs, issues, comments,
 * patches, statuses), plus GitRepoReader (execFile git plumbing for reading
 * a local repo) and the remote-state reader (kind:30617/30618 relay fetch +
 * Arweave Git-SHA resolution). No signing or payment code lives here — push
 * planning and publishing arrive in the follow-up tickets of epic
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

export { GitError, GitRepoReader, type GitRef, type ReadGitObject, type ReadObjectsResult, type RepoRefs } from './repo-reader.js';
export { fetchRemoteState, type FetchRemoteStateOptions, type NostrEvent, type RemoteState, type WebSocketFactory, type WebSocketLike } from './remote-state.js';

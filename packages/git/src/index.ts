/**
 * @toon-protocol/git — Git-to-TOON write path core.
 *
 * Pure builders for git objects (blob/tree/commit/tag with SHA-1 envelope
 * hashing) and NIP-34 events (repo announcement/refs, issues, comments,
 * patches, statuses). No network, signing, or payment code lives here —
 * repo reading, remote state, push planning, and publishing arrive in the
 * follow-up tickets of epic toon-client#222.
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

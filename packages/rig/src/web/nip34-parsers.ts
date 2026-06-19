/**
 * NIP-34 parsers for Rig-UI.
 *
 * The parser corpus now lives in `@toon-protocol/views` so this browser frontend
 * and the MCP-app bundle share ONE implementation (add a NIP once, both surfaces
 * light up). This module re-exports them to preserve rig's existing import paths.
 */

export type {
  NostrEvent,
  NostrFilter,
  RepoMetadata,
  RepoRefs,
  IssueMetadata,
  PRMetadata,
  CommentMetadata,
} from '@toon-protocol/views';

export {
  parseRepoAnnouncement,
  parseRepoRefs,
  parseIssue,
  parsePR,
  parseComment,
  resolvePRStatus,
  resolveIssueStatus,
} from '@toon-protocol/views';

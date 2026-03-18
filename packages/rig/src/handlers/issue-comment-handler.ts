/**
 * Issue and comment handlers for @toon-protocol/rig.
 *
 * Stub: Will be implemented as part of the rig epic.
 * Handles kind:1621 (issues) and kind:1622 (comments) NIP-34 events.
 */

export interface IssueHandlerConfig {
  repoStore: unknown;
}

/**
 * Creates an issue handler for kind:1621 events.
 */
export function createIssueHandler(
  _config: IssueHandlerConfig
): (ctx: unknown) => Promise<void> {
  throw new Error('createIssueHandler is not yet implemented');
}

/**
 * Creates a comment handler for kind:1622 events.
 */
export function createCommentHandler(
  _config: IssueHandlerConfig
): (ctx: unknown) => Promise<void> {
  throw new Error('createCommentHandler is not yet implemented');
}

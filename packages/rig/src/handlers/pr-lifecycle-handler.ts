/**
 * PR lifecycle handler for @toon-protocol/rig.
 *
 * Stub: Will be implemented as part of the rig epic.
 * Handles kind:1630 (Open), kind:1631 (Merged), kind:1632 (Closed),
 * kind:1633 (Draft) PR status events.
 */

export interface PrLifecycleHandlerConfig {
  repoStore: unknown;
  fetchRepoEvent: (repoIdentifier: string) => Promise<unknown>;
}

/**
 * Creates a PR lifecycle handler.
 */
export function createPrLifecycleHandler(
  _config: PrLifecycleHandlerConfig
): (ctx: unknown) => Promise<void> {
  throw new Error('createPrLifecycleHandler is not yet implemented');
}

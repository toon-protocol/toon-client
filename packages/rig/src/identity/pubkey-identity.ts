/**
 * Pubkey identity utilities for @toon-protocol/rig.
 *
 * Stub: Will be implemented as part of the rig epic.
 * Maps Nostr pubkeys to git author identities and checks maintainer authorization.
 */

export interface AuthorizationResult {
  authorized: boolean;
  rejectCode?: string;
  rejectMessage?: string;
}

export interface GitAuthorIdentity {
  name: string;
  email: string;
  env: {
    GIT_AUTHOR_NAME: string;
    GIT_AUTHOR_EMAIL: string;
  };
}

export interface PubkeyProfile {
  displayName: string;
  picture?: string;
  isEnriched: boolean;
}

/**
 * Checks whether a pubkey is authorized as a maintainer based on a
 * kind:30617 repository announcement event.
 */
export function checkMaintainerAuthorization(
  _pubkey: string,
  _repoEvent: unknown
): AuthorizationResult {
  throw new Error('checkMaintainerAuthorization is not yet implemented');
}

/**
 * Converts a Nostr pubkey to a git author identity.
 */
export function toGitAuthorIdentity(_pubkey: string): GitAuthorIdentity {
  throw new Error('toGitAuthorIdentity is not yet implemented');
}

/**
 * Enriches a pubkey with profile data from kind:0 events.
 * Falls back to truncated npub on failure.
 */
export async function enrichPubkeyProfile(
  _pubkey: string,
  _options: { relayClient: unknown }
): Promise<PubkeyProfile> {
  throw new Error('enrichPubkeyProfile is not yet implemented');
}

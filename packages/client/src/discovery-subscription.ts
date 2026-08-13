import { ILP_PEER_INFO_KIND } from '@toon-protocol/core';
import type { DiscoveryTracker } from '@toon-protocol/core';
import type { NostrEvent } from 'nostr-tools/pure';

/** A live subscription feeding a {@link DiscoveryTracker}. Tears down on `close()`. */
export interface DiscoverySubscription {
  close(): void;
}

/**
 * Subscribes to `relayUrl` for kind:10032 (`ILP_PEER_INFO_KIND`) announces
 * and hands every one to `tracker.processEvent()` (toon-client#550).
 *
 * `createDiscoveryTracker` (`@toon-protocol/core`) does not own a
 * subscription by design — its doc comment says callers "feed events in via
 * processEvent()", precisely so it can be driven from a relay subscription,
 * an ILP handler, or a test harness. Nothing in this package ever called it,
 * so `getAllDiscoveredPeers()` stayed permanently empty on a fully-started
 * client and `ToonClient.resolveTerminatorEndpoint` failed closed
 * (`TERMINATOR_UNRESOLVED`) on every paid write past the peer(s) bootstrap
 * itself negotiated with directly. This is that feed.
 *
 * Mirrors `keys/BackupService.ts`'s dynamic `import('nostr-tools/pool')` —
 * keeps `nostr-tools/pool` out of bundles that never start a client.
 */
export async function subscribeToDiscovery(
  relayUrl: string,
  tracker: Pick<DiscoveryTracker, 'processEvent'>
): Promise<DiscoverySubscription> {
  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  const sub = pool.subscribeMany(
    [relayUrl],
    { kinds: [ILP_PEER_INFO_KIND] },
    {
      onevent: (event: NostrEvent) => tracker.processEvent(event),
    }
  );
  return {
    close: () => {
      sub.close();
      pool.close([relayUrl]);
    },
  };
}

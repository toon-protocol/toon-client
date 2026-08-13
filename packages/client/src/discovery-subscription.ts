import { ILP_PEER_INFO_KIND } from '@toon-protocol/core';
import type { DiscoveryTracker } from '@toon-protocol/core';
import type { NostrEvent } from 'nostr-tools/pure';

/** A live subscription feeding a {@link DiscoveryTracker}. Tears down on `close()`. */
export interface DiscoverySubscription {
  close(): void;
}

/**
 * Subscribes to `relayUrls` for kind:10032 (`ILP_PEER_INFO_KIND`) announces
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
 * Takes a LIST, not a single URL: rig's standalone push pins
 * `config.relayUrl` to `''` and carries the relay its announces actually
 * live on per peer, in `knownPeers[].relayUrl` (`standalone-mode.ts`), so
 * `ToonClient.start()` passes both sources in. (`toon-clientd` pins BOTH to
 * empty — `daemon/config.ts` sets `relayUrl: ''` AND `knownPeers: []` — so
 * its clients still have no relay to subscribe to and their trackers stay
 * unfed; threading a relay into the daemon's `toonClientConfig` is a
 * client-mcp change tracked separately on toon-client#550.)
 *
 * Empty strings are dropped and the list is deduped before subscribing; an
 * empty/unset `relayUrl` must never reach `SimplePool.subscribeMany`, which
 * throws synchronously (`Invalid URL: wss://`) on one. When the deduped set
 * is empty this is a deliberate no-op (a tracker with nothing to subscribe
 * to still falls back via `resolveTerminatorEndpoint`'s existing
 * no-tracker-content path), not a start() failure.
 *
 * Mirrors `keys/BackupService.ts`'s dynamic `import('nostr-tools/pool')` —
 * keeps `nostr-tools/pool` out of bundles that never start a client.
 */
export async function subscribeToDiscovery(
  relayUrls: readonly string[],
  tracker: Pick<DiscoveryTracker, 'processEvent'>
): Promise<DiscoverySubscription> {
  const urls = Array.from(new Set(relayUrls.filter((url) => url !== '')));
  if (urls.length === 0) {
    return { close: () => undefined };
  }

  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  const sub = pool.subscribeMany(
    urls,
    { kinds: [ILP_PEER_INFO_KIND] },
    {
      onevent: (event: NostrEvent) => tracker.processEvent(event),
    }
  );
  return {
    close: () => {
      sub.close();
      pool.close(urls);
    },
  };
}

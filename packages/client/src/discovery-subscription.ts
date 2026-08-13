import { ILP_PEER_INFO_KIND } from '@toon-protocol/core';
import type { DiscoveryTracker } from '@toon-protocol/core';
import type { NostrEvent } from 'nostr-tools/pure';

/** A live subscription feeding a {@link DiscoveryTracker}. Tears down on `close()`. */
export interface DiscoverySubscription {
  close(): void;
  /**
   * The `requiredTransport` value an announcer's kind:10032 most recently
   * declared, keyed by its pubkey. `undefined` when that announcer has never
   * published one, or its latest announce dropped it (toon-client#558).
   *
   * Read directly off the raw event content rather than through
   * `tracker.processEvent`'s parsed `IlpPeerInfo`: the installed
   * `@toon-protocol/core`'s `parseIlpPeerInfo` destructures a fixed field
   * list and drops anything else — the same gap toon-client#544 hit for the
   * `notice` field — so `requiredTransport` never survives into what
   * `DiscoveryTracker.getAllDiscoveredPeers()` reports.
   *
   * Applies the same monotonic `created_at` guard per pubkey that
   * `tracker.processEvent` applies internally (toon-client#558 correction):
   * on a multi-relay subscription a stale replay can race in behind a fresh
   * announce, and without the guard an older, field-absent replay would
   * silently clear a live `requiredTransport` and misroute paid writes back
   * onto HTTP-ILP until the peer's next fresh announce.
   */
  requiredTransportFor(pubkey: string): string | undefined;
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
 * `ToonClient.start()` passes both sources in. (`toon-clientd` carries its
 * own resolved relay in `toonClientConfig.relayUrl` and pins
 * `knownPeers: []` — see `daemon/config.ts`.)
 *
 * Empty strings are dropped and the list is deduped before subscribing; an
 * empty/unset `relayUrl` must never reach `SimplePool.subscribeMany`, which
 * throws synchronously (`Invalid URL: wss://`) on one. When the deduped set
 * is empty this is a deliberate no-op rather than a `start()` failure: a
 * client configured with no relay at all has nothing to ingest, so its
 * tracker simply stays empty and paid writes resolve exactly as they did
 * before this feed existed.
 *
 * Mirrors `keys/BackupService.ts`'s dynamic `import('nostr-tools/pool')` —
 * keeps `nostr-tools/pool` out of bundles that never start a client.
 */
export async function subscribeToDiscovery(
  relayUrls: readonly string[],
  tracker: Pick<DiscoveryTracker, 'processEvent'>
): Promise<DiscoverySubscription> {
  const urls = Array.from(new Set(relayUrls.filter((url) => url !== '')));
  const requiredTransports = new Map<string, string>();
  const requiredTransportSeenAt = new Map<string, number>();
  const requiredTransportFor = (pubkey: string): string | undefined =>
    requiredTransports.get(pubkey);

  if (urls.length === 0) {
    return { close: () => undefined, requiredTransportFor };
  }

  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  const sub = pool.subscribeMany(
    urls,
    { kinds: [ILP_PEER_INFO_KIND] },
    {
      onevent: (event: NostrEvent) => {
        tracker.processEvent(event);
        const lastSeen = requiredTransportSeenAt.get(event.pubkey) ?? 0;
        if (event.created_at <= lastSeen) return;
        requiredTransportSeenAt.set(event.pubkey, event.created_at);
        const requiredTransport = extractRequiredTransport(event);
        if (requiredTransport === undefined) {
          requiredTransports.delete(event.pubkey);
        } else {
          requiredTransports.set(event.pubkey, requiredTransport);
        }
      },
    }
  );
  return {
    close: () => {
      sub.close();
      pool.close(urls);
    },
    requiredTransportFor,
  };
}

/**
 * Read the raw `requiredTransport` value off an announce's content,
 * independent of `parseIlpPeerInfo` — see {@link DiscoverySubscription.requiredTransportFor}.
 * Returns `undefined` on any parse failure or non-string value.
 */
function extractRequiredTransport(event: NostrEvent): string | undefined {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    const value = (parsed as Record<string, unknown>)['requiredTransport'];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

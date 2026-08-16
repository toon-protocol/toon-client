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
  /**
   * The `swapVerifyingContracts` map a swap MAKER's kind:10032 most recently
   * announced (chain key → deployed `RollingSwapChannel` address), keyed by
   * its pubkey. `undefined` when that announcer has never published one, or
   * its latest announce dropped it (toon-client#583).
   *
   * This is the **leg-B** contract — the EIP-712 `verifyingContract` a
   * received balance-proof claim must be verified under. It is deliberately
   * NOT `tokenNetworks`, which is **leg A** (the `TokenNetwork` the client
   * opens its own payment channel against). swap#134 split the two apart in
   * the announce precisely because they are different contracts.
   *
   * Read off the raw event content for the SAME reason as
   * {@link requiredTransportFor}: `@toon-protocol/core`'s `parseIlpPeerInfo`
   * destructures a fixed field list (`core@3.4.0` still has no
   * `swapVerifyingContracts` field), so the maker's leg-B map never survives
   * into `DiscoveryTracker.getAllDiscoveredPeers()`.
   *
   * Same monotonic `created_at` guard, for the same reason: a stale replay
   * must never clear a live map.
   */
  swapVerifyingContractsFor(pubkey: string): Record<string, string> | undefined;
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
  const swapVerifyingContracts = new Map<string, Record<string, string>>();
  const rawFieldsSeenAt = new Map<string, number>();
  const requiredTransportFor = (pubkey: string): string | undefined =>
    requiredTransports.get(pubkey);
  const swapVerifyingContractsFor = (
    pubkey: string
  ): Record<string, string> | undefined => swapVerifyingContracts.get(pubkey);
  /**
   * Apply one announce's raw-content extension fields, newest-wins per pubkey
   * — the same monotonic `created_at` guard `tracker.processEvent` applies
   * internally, so the two can never disagree about which announce is
   * current. All fields advance together off the SAME announce: a fresh
   * announce that drops a field clears it, a stale replay changes nothing.
   */
  const recordRawFields = (event: NostrEvent): void => {
    const lastSeen = rawFieldsSeenAt.get(event.pubkey) ?? 0;
    if (event.created_at <= lastSeen) return;
    rawFieldsSeenAt.set(event.pubkey, event.created_at);
    const content = parseContent(event);
    const requiredTransport = extractStringField(content, 'requiredTransport');
    if (requiredTransport === undefined) {
      requiredTransports.delete(event.pubkey);
    } else {
      requiredTransports.set(event.pubkey, requiredTransport);
    }
    const verifyingContracts = extractStringMapField(
      content,
      'swapVerifyingContracts'
    );
    if (verifyingContracts === undefined) {
      swapVerifyingContracts.delete(event.pubkey);
    } else {
      swapVerifyingContracts.set(event.pubkey, verifyingContracts);
    }
  };

  if (urls.length === 0) {
    return {
      close: () => undefined,
      requiredTransportFor,
      swapVerifyingContractsFor,
    };
  }

  const { SimplePool } = await import('nostr-tools/pool');
  const pool = new SimplePool();
  const sub = pool.subscribeMany(
    urls,
    { kinds: [ILP_PEER_INFO_KIND] },
    {
      onevent: (event: NostrEvent) => {
        tracker.processEvent(event);
        recordRawFields(event);
      },
    }
  );
  return {
    close: () => {
      sub.close();
      pool.close(urls);
    },
    requiredTransportFor,
    swapVerifyingContractsFor,
  };
}

/**
 * An announce's content as a plain object, or `undefined` when it is not
 * parseable JSON / not an object. The raw-content seam every extension field
 * `parseIlpPeerInfo` drops is read through — see
 * {@link DiscoverySubscription.requiredTransportFor}.
 */
function parseContent(event: NostrEvent): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(event.content);
    if (typeof parsed !== 'object' || parsed === null) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** A raw string field off an announce's content; `undefined` if absent/wrong type. */
function extractStringField(
  content: Record<string, unknown> | undefined,
  field: string
): string | undefined {
  const value = content?.[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * A raw `Record<string, string>` field off an announce's content. Non-string
 * entries are dropped rather than failing the whole map (one malformed chain
 * key must not blind the client to the others), and an empty/entry-less map
 * reads as `undefined` — "announced nothing usable" and "announced nothing"
 * are the same fact to a caller that has to fall back either way.
 */
function extractStringMapField(
  content: Record<string, unknown> | undefined,
  field: string
): Record<string, string> | undefined {
  const value = content?.[field];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry !== '') out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

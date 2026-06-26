/**
 * Discover an apex's settlement negotiation by reading its `kind:10032`
 * (`ILP_PEER_INFO_KIND`) announcement off a relay, rather than making the caller
 * hand-supply chain/settlement params. An apex (town node) publishes its
 * `IlpPeerInfo` — `btpEndpoint`, `supportedChains`, `settlementAddresses`,
 * `preferredTokens`, `tokenNetworks` — to its relay; this module subscribes for
 * it, parses via core's `parseIlpPeerInfo`, and maps it onto the daemon's
 * `ApexNegotiationConfig` so the runner can stand up a `ToonClient` against it.
 *
 * The relay is injected as a `RelaySubscription` (already started) so this is
 * unit-testable with a fake WS and reuses a relay the runner already manages.
 */

import {
  ILP_PEER_INFO_KIND,
  parseIlpPeerInfo,
  isEventExpired,
} from '@toon-protocol/core';
import type { NostrEvent } from 'nostr-tools/pure';
import type { RelaySubscription } from '../relay-subscription.js';
import type { ApexNegotiationConfig } from './config.js';
import type { SettlementChain } from '../control-api.js';

export interface DiscoverApexParams {
  /** A started relay subscription to query for the apex's kind:10032. */
  relay: RelaySubscription;
  /** ILP address of the apex to match (e.g. `g.proxy`). */
  ilpAddress: string;
  /** Optional apex Nostr pubkey to narrow the REQ filter (64-char hex). */
  pubkey?: string;
  /** Preferred settlement chain family; defaults to the first supported chain. */
  chain?: SettlementChain;
  /** Child peers reached via this apex's channel (e.g. `["dvm","mill"]`). */
  childPeers?: string[];
  /** Max time to wait for the announcement, ms. Default 15000. */
  timeoutMs?: number;
  /** Poll interval against the relay buffer, ms. Default 250. */
  pollMs?: number;
}

export interface DiscoveredApex {
  btpUrl: string;
  negotiation: ApexNegotiationConfig;
  apexChildPeers?: string[];
}

/**
 * Thrown when discovery fails. `retryable` is true for a TIMEOUT (the apex may
 * just be slow/offline — the caller can retry once it's reachable) and false
 * for a malformed announcement (retrying won't help until the apex republishes).
 */
export class ApexDiscoveryError extends Error {
  constructor(
    message: string,
    readonly retryable = false
  ) {
    super(message);
    this.name = 'ApexDiscoveryError';
  }
}

/**
 * Subscribe for the apex's `kind:10032`, wait for a match, and map it to an
 * `ApexNegotiationConfig` + `btpUrl`. Rejects with {@link ApexDiscoveryError}
 * on timeout or when the announcement lacks settlement params for any chain.
 */
export async function discoverApex(
  params: DiscoverApexParams
): Promise<DiscoveredApex> {
  const { relay, ilpAddress, pubkey, chain, childPeers } = params;
  const timeoutMs = params.timeoutMs ?? 15_000;
  const pollMs = params.pollMs ?? 250;

  const subId = relay.subscribe(
    [
      {
        kinds: [ILP_PEER_INFO_KIND],
        ...(pubkey ? { authors: [pubkey] } : {}),
      },
    ],
    `apex-discovery-${ilpAddress}`
  );

  try {
    const deadline = Date.now() + timeoutMs;
    let cursor = 0;
    while (Date.now() < deadline) {
      // Scan the WHOLE relay buffer (no subId filter), not just our discovery
      // subscription. `RelaySubscription` de-dups by event.id globally, so if a
      // pre-existing subscription already buffered the announcement, the relay's
      // replay to our fresh REQ is dropped and would never appear under our
      // subId — buffer-wide reads find it regardless of which sub received it.
      const { events, cursor: next } = relay.getEvents({ cursor });
      cursor = next;
      const match = events.find((e) => matchesApex(e, ilpAddress, pubkey));
      if (match) return mapAnnouncement(match, { chain, childPeers });
      await delay(pollMs);
    }
    throw new ApexDiscoveryError(
      `Timed out after ${timeoutMs}ms waiting for the apex kind:${ILP_PEER_INFO_KIND} ` +
        `announcement for "${ilpAddress}" on the relay. Is the relay reachable and the apex online?`,
      true // retryable: the apex may just be slow/offline
    );
  } finally {
    relay.unsubscribe(subId);
  }
}

/**
 * Whether a kind:10032 event announces the target apex's ILP address. When a
 * `pubkey` is given it must also match the event author — multiple nodes can
 * advertise the same ILP address (e.g. `g.proxy`), so the pubkey is how
 * the caller disambiguates which one to add. (Buffer-wide scanning means we can
 * no longer rely on the REQ's `authors` filter to do this for us.)
 */
function matchesApex(
  event: NostrEvent,
  ilpAddress: string,
  pubkey?: string
): boolean {
  if (event.kind !== ILP_PEER_INFO_KIND) return false;
  if (pubkey && event.pubkey !== pubkey) return false;
  // A NIP-40-expired announcement means the apex stopped re-publishing — it is
  // offline and its advertised BTP endpoint is unreachable, so don't match it
  // (issue #261). Discovery keeps waiting for a fresh, unexpired announcement.
  if (isEventExpired(event)) return false;
  try {
    const info = parseIlpPeerInfo(event);
    const addrs = info.ilpAddresses ?? [info.ilpAddress];
    return addrs.includes(ilpAddress) || info.ilpAddress === ilpAddress;
  } catch {
    return false;
  }
}

/** Map a parsed kind:10032 announcement onto the daemon's negotiation config. */
function mapAnnouncement(
  event: NostrEvent,
  opts: { chain?: SettlementChain; childPeers?: string[] }
): DiscoveredApex {
  const info = parseIlpPeerInfo(event);
  const chains = info.supportedChains ?? [];
  if (chains.length === 0) {
    throw new ApexDiscoveryError(
      `Apex "${info.ilpAddress}" announced no supportedChains — cannot settle.`
    );
  }

  // Pick the chainKey: prefer one whose family matches the requested chain,
  // else the first advertised chain.
  const chainKey =
    (opts.chain
      ? chains.find((c) => c.split(':')[0] === opts.chain)
      : undefined) ?? chains[0];
  if (!chainKey) {
    throw new ApexDiscoveryError(
      `Apex "${info.ilpAddress}" announced no usable settlement chain.`
    );
  }
  const family = chainKey.split(':')[0] as SettlementChain;
  const settlementAddress = info.settlementAddresses?.[chainKey];
  if (!settlementAddress) {
    throw new ApexDiscoveryError(
      `Apex "${info.ilpAddress}" announced no settlementAddress for chain "${chainKey}".`
    );
  }

  const btpUrl = info.btpEndpoint;
  if (!btpUrl) {
    throw new ApexDiscoveryError(
      `Apex "${info.ilpAddress}" announced an empty btpEndpoint — cannot open a BTP session.`
    );
  }

  const negotiation: ApexNegotiationConfig = {
    destination: info.ilpAddress,
    peerId: info.ilpAddress.split('.').at(-1) ?? info.ilpAddress,
    chain: family,
    chainKey,
    // EVM chainKeys are `evm:<network>:<chainId>`; non-EVM carry no numeric id.
    // Tolerate the 2-part `evm:<chainId>` form some connectors advertise.
    chainId:
      family === 'evm'
        ? Number(chainKey.split(':')[2] ?? chainKey.split(':')[1] ?? 0)
        : 0,
    settlementAddress,
    ...(info.preferredTokens?.[chainKey]
      ? { tokenAddress: info.preferredTokens[chainKey] }
      : {}),
    ...(info.tokenNetworks?.[chainKey]
      ? { tokenNetwork: info.tokenNetworks[chainKey] }
      : {}),
  };

  return {
    btpUrl,
    negotiation,
    ...(opts.childPeers && opts.childPeers.length > 0
      ? { apexChildPeers: opts.childPeers }
      : {}),
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

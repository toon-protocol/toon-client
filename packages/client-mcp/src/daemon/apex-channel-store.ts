/**
 * Persists the apex payment-channel id (+ its chain context) per
 * (destination, chain) so a daemon RESTART can resume the EXISTING on-chain
 * channel instead of opening a new one.
 *
 * Why this is needed: `ChannelManager` persists the off-chain nonce/cumulative
 * watermark (keyed by channelId) but NOT the peer→channelId mapping. So after a
 * restart `openChannel()` would open + re-deposit into a fresh channel, which
 * reverts on a chain where the deposit already exists. With the channelId saved
 * here, the runner instead calls `trackChannel(channelId, context)` — which
 * rehydrates the nonce from the channel store — and signs against the live
 * channel with zero on-chain writes.
 *
 * COUNTERPARTY: the key is `destination|chain` — an ILP NAME, not a node, and
 * an ILP name can change hands (the devnet apex `g.toon` was retired and other
 * nodes took over the names under it). Both key fields kept matching, so the
 * runner resumed — and re-bound — a channel opened against the retired node,
 * and every paid write came back `F01 - claim rejected: names a channel this
 * connector has no record of`. A record carries the counterparty it was opened
 * against (`context.recipient`), which the runner re-checks against the
 * destination's announced settlement address before resuming;
 * {@link supersedeApexChannel} retires the record when they disagree.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Chain context needed to re-track a channel (matches ChannelManager.trackChannel). */
export interface PersistedChannelContext {
  chainType: string;
  chainId: number;
  tokenNetworkAddress: string;
  tokenAddress?: string;
  recipient?: string;
}

export interface PersistedApexChannel {
  channelId: string;
  context: PersistedChannelContext;
  /**
   * ISO timestamp this record was RETIRED because the destination now
   * announces a different settlement address than the channel was opened
   * against (see {@link supersedeApexChannel}). Never resumed again; kept so
   * the deposit it may still hold stays findable.
   */
  supersededAt?: string;
}

type Store = Record<string, PersistedApexChannel>;

function key(destination: string, chain: string): string {
  return `${destination}|${chain}`;
}

/**
 * Archive key a superseded record moves to: the live key plus the channel id,
 * so the retired record survives the re-resolved channel being written under
 * the live key and repeated supersessions of one route never collide.
 */
function supersededKey(
  destination: string,
  chain: string,
  channelId: string
): string {
  return `${key(destination, chain)}|superseded:${channelId}`;
}

function readStore(path: string): Store {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Store;
  } catch {
    return {};
  }
}

/**
 * Load the saved apex channel for (destination, chain), or null. A superseded
 * record reads as absent: it is retired from the resume path for good.
 */
export function loadApexChannel(
  path: string,
  destination: string,
  chain: string
): PersistedApexChannel | null {
  const record = readStore(path)[key(destination, chain)];
  if (!record || record.supersededAt !== undefined) return null;
  return record;
}

/** Save the apex channel for (destination, chain) with mode 0o600. */
export function saveApexChannel(
  path: string,
  destination: string,
  chain: string,
  record: PersistedApexChannel
): void {
  const store = readStore(path);
  store[key(destination, chain)] = record;
  writeStore(path, store);
}

/**
 * Retire the saved apex channel for (destination, chain) — the node
 * terminating that ILP name has been REPLACED, so the channel it records is
 * dead to whoever answers now (`F01 - claim rejected`).
 *
 * MOVES the record to an archive key rather than deleting it: it may still
 * hold an on-chain deposit, and deleting it would strand those funds behind
 * hand-editing the JSON. Moving it also frees the live key for the re-resolved
 * channel. Idempotent, and a no-op when there is nothing recorded.
 */
export function supersedeApexChannel(
  path: string,
  destination: string,
  chain: string
): void {
  const store = readStore(path);
  const live = key(destination, chain);
  const existing = store[live];
  if (!existing || existing.supersededAt !== undefined) return;
  const { [live]: _retired, ...rest } = store;
  writeStore(path, {
    ...rest,
    [supersededKey(destination, chain, existing.channelId)]: {
      ...existing,
      supersededAt: new Date().toISOString(),
    },
  });
}

function writeStore(path: string, store: Store): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

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
}

type Store = Record<string, PersistedApexChannel>;

function key(destination: string, chain: string): string {
  return `${destination}|${chain}`;
}

function readStore(path: string): Store {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as Store;
  } catch {
    return {};
  }
}

/** Load the saved apex channel for (destination, chain), or null. */
export function loadApexChannel(
  path: string,
  destination: string,
  chain: string
): PersistedApexChannel | null {
  return readStore(path)[key(destination, chain)] ?? null;
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
}

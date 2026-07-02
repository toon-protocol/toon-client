/**
 * Publish wrapper with ILP claim signing and retry for E2E seed scripts.
 *
 * Wraps ToonClient.publishEvent() with:
 * - Balance proof signing (channelId from bootstrap, cumulative amount)
 * - Retry logic (3 attempts, 2s delay) for transient payment errors
 * - Cumulative amount tracking per client (SeedPublishState)
 *
 * AC-1.3: Publish Wrapper
 */

import type { NostrEvent } from 'nostr-tools/pure';
import { encodeEventToToon } from '@toon-protocol/relay';
import type { ToonClient } from '@toon-protocol/client';
export type { PublishEventResult } from '@toon-protocol/client';
import { PEER1_DESTINATION } from './constants.js';

// ---------------------------------------------------------------------------
// Cumulative state tracking
// ---------------------------------------------------------------------------

/**
 * Tracks cumulative ILP amount per client for monotonic claim signing.
 * Key is a client identifier (e.g., 'alice'), value is cumulative bigint.
 */
export type SeedPublishState = Map<string, bigint>;

/**
 * Create a new empty publish state tracker.
 */
export function createPublishState(): SeedPublishState {
  return new Map();
}

// ---------------------------------------------------------------------------
// Publish with retry
// ---------------------------------------------------------------------------

/**
 * Publish an event via ToonClient with claim signing and retry.
 *
 * Before each publish:
 * 1. Obtains channelId from client.getTrackedChannels()[0]
 * 2. Encodes event to TOON format to get byte length
 * 3. Computes amount for this event: BigInt(toonEncodedLength) * 10n
 * 4. Signs balance proof via client.signBalanceProof(channelId, amount)
 *    (ChannelManager auto-accumulates cumulative amount internally)
 * 5. Passes claim to client.publishEvent(event, { claim })
 *
 * Note: ToonClient.publishEvent() internally recalculates the per-packet
 * ILP amount (basePricePerByte=10 * TOON byte length). The claim provides
 * the signed balance proof for BTP transport — we do NOT duplicate the
 * amount calculation for the ILP packet itself.
 *
 * WARNING: Each retry re-signs a new balance proof, incrementing the nonce
 * and cumulative amount. If the ILP packet was delivered but the response
 * was lost, retrying will double-charge. This is acceptable for E2E seed
 * scripts where Anvil funds are free, but production code should track
 * delivery confirmation before re-signing.
 *
 * @param client - ToonClient instance (must be started/bootstrapped)
 * @param event - Signed NostrEvent to publish
 * @param maxAttempts - Maximum retry attempts (default: 3)
 * @param delayMs - Delay between retries in ms (default: 2000)
 * @returns PublishEventResult
 */
export async function publishWithRetry(
  client: ToonClient,
  event: NostrEvent,
  maxAttempts = 3,
  delayMs = 2000
): Promise<PublishEventResult> {
  const channels = client.getTrackedChannels();
  if (channels.length === 0) {
    return {
      success: false,
      error: 'No payment channels available. Client may not be bootstrapped.',
    };
  }
  const channelId = channels[0]!;

  // Compute amount for balance proof
  const toonBytes = encodeEventToToon(event);
  const amount = BigInt(toonBytes.length) * 10n;

  let lastError: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // Sign balance proof (ChannelManager tracks cumulative amount internally)
      const claim = await client.signBalanceProof(channelId, amount);

      const result = await client.publishEvent(event, {
        destination: PEER1_DESTINATION,
        claim,
      });

      if (result.success) {
        return result;
      }

      lastError = result.error;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }

    // Wait before retry (skip delay on last attempt)
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  return {
    success: false,
    error: `Failed after ${maxAttempts} attempts: ${lastError}`,
  };
}

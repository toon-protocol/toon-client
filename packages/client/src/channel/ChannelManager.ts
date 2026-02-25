import type { EvmSigner } from '../signing/evm-signer.js';
import type { SignedBalanceProof } from '../types.js';

interface ChannelTracking {
  nonce: number;
  cumulativeAmount: bigint;
}

/**
 * Local nonce tracking and claim signing.
 *
 * Does NOT make any network calls — it only manages state
 * and delegates signing to EvmSigner.
 */
export class ChannelManager {
  private readonly evmSigner: EvmSigner;
  private readonly channels = new Map<string, ChannelTracking>();

  constructor(evmSigner: EvmSigner) {
    this.evmSigner = evmSigner;
  }

  /**
   * Start tracking a channel.
   * Called after bootstrap returns a channelId.
   *
   * @param channelId - Payment channel identifier
   * @param initialNonce - Starting nonce (default: 0)
   * @param initialAmount - Starting cumulative amount (default: 0n)
   */
  trackChannel(channelId: string, initialNonce = 0, initialAmount = 0n): void {
    this.channels.set(channelId, {
      nonce: initialNonce,
      cumulativeAmount: initialAmount,
    });
  }

  /**
   * Signs a balance proof for the given channel.
   * Auto-increments nonce and adds to cumulative amount.
   *
   * @param channelId - Payment channel identifier
   * @param additionalAmount - Amount to add to cumulative transferred amount
   * @returns Signed balance proof
   * @throws Error if channel is not being tracked
   */
  async signBalanceProof(channelId: string, additionalAmount: bigint): Promise<SignedBalanceProof> {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked. Call trackChannel() first.`);
    }

    tracking.nonce += 1;
    tracking.cumulativeAmount += additionalAmount;

    // Note: chainId and tokenNetworkAddress are needed for EIP-712 signing.
    // In the full flow, these would come from the channel context.
    // For now, we use placeholder values that the caller can override.
    return this.evmSigner.signBalanceProof({
      channelId,
      nonce: tracking.nonce,
      transferredAmount: tracking.cumulativeAmount,
      lockedAmount: 0n,
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      chainId: 31337, // Default — will be configurable via channel context
      tokenNetworkAddress: '0x0000000000000000000000000000000000000000',
    });
  }

  /**
   * Gets the current nonce for a tracked channel.
   */
  getNonce(channelId: string): number {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }
    return tracking.nonce;
  }

  /**
   * Gets the cumulative transferred amount for a tracked channel.
   */
  getCumulativeAmount(channelId: string): bigint {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }
    return tracking.cumulativeAmount;
  }

  /**
   * Gets all tracked channel IDs.
   */
  getTrackedChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  /**
   * Returns true if the channel is being tracked.
   */
  isTracking(channelId: string): boolean {
    return this.channels.has(channelId);
  }
}

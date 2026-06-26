import { EvmSigner } from '../signing/evm-signer.js';
import type { ChainSigner, ChainMetadata } from '../signing/types.js';
import type { SignedBalanceProof } from '../types.js';
import type { ChannelStore } from './ChannelStore.js';
import type { ConnectorChannelClient } from '@toon-protocol/core';

interface ChannelTracking {
  nonce: number;
  cumulativeAmount: bigint;
  chainType: string;
  chainId: number;
  tokenNetworkAddress: string;
  tokenAddress?: string;
  /**
   * Counterparty settlement address on this channel's chain. Required to sign
   * Solana/Mina balance proofs (folded into the canonical message); unused for
   * the EVM EIP-712 path.
   */
  recipient?: string;
  /**
   * On-chain channel `depositTotal` (base units), captured at channel-open time
   * (#220). Threaded into the Mina signer so it binds `balanceB = depositTotal −
   * balanceA` (toon-protocol/connector#133); the Solana signer ignores it and
   * the EVM path never reads it. When unset (e.g. a channel RESUMED via
   * `trackChannel` rather than opened, or an idempotent re-open that didn't
   * surface it), the Mina signer self-resolves it from chain via its GraphQL URL
   * (#223).
   */
  depositTotal?: bigint;
  /** Withdraw flow (unix SECONDS): set when close is initiated / becomes settleable / settled. */
  closedAt?: bigint;
  settleableAt?: bigint;
  settledAt?: bigint;
}

export interface ChannelManagerConfig {
  initialDeposit?: string;
  settlementTimeout?: number;
}

export interface PeerNegotiation {
  chain: string;
  chainType: string;
  chainId: number | string;
  settlementAddress: string;
  tokenAddress?: string;
  tokenNetwork?: string;
  initialDeposit?: string;
  settlementTimeout?: number;
}

/**
 * Local nonce tracking, multi-chain signing, and lazy channel opening.
 *
 * Supports multiple ChainSigner implementations (EVM, Solana, Mina).
 * The ensureChannel() method provides idempotent lazy channel opening.
 */
export class ChannelManager {
  private readonly channels = new Map<string, ChannelTracking>();
  private readonly chainSigners = new Map<string, ChainSigner>();
  private readonly peerChannels = new Map<string, string>();
  private readonly pendingOpens = new Map<string, Promise<string>>();
  private readonly store?: ChannelStore;
  private readonly defaultInitialDeposit: string;
  private readonly defaultSettlementTimeout: number;
  private channelClient?: ConnectorChannelClient;

  // Legacy: keep EvmSigner reference for backwards compatibility
  private readonly evmSigner?: EvmSigner;

  constructor(
    evmSigner?: EvmSigner,
    store?: ChannelStore,
    config?: ChannelManagerConfig
  ) {
    this.evmSigner = evmSigner;
    this.store = store;
    this.defaultInitialDeposit = config?.initialDeposit ?? '100000';
    this.defaultSettlementTimeout = config?.settlementTimeout ?? 86400;
  }

  /**
   * Register a chain-specific signer.
   */
  registerChainSigner(chainType: string, signer: ChainSigner): void {
    this.chainSigners.set(chainType, signer);
  }

  /**
   * Set the on-chain channel client for lazy channel opening.
   */
  setChannelClient(client: ConnectorChannelClient): void {
    this.channelClient = client;
  }

  /**
   * Get the signer for a tracked channel's chain type.
   * For EVM, returns an adapter wrapping the EvmSigner.
   */
  getSignerForChannel(channelId: string): ChainSigner {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }

    // Check non-EVM signers first
    const signer = this.chainSigners.get(tracking.chainType);
    if (signer) return signer;

    // EVM: wrap EvmSigner as ChainSigner adapter
    if (tracking.chainType === 'evm' && this.evmSigner) {
      const evmSigner = this.evmSigner;
      return {
        chainType: 'evm' as const,
        signerIdentifier: evmSigner.address,
        async signBalanceProof(params) {
          if (params.metadata.chainType !== 'evm')
            throw new Error('Expected EVM metadata');
          return evmSigner.signBalanceProof({
            channelId: params.channelId,
            nonce: params.nonce,
            transferredAmount: params.transferredAmount,
            lockedAmount: params.lockedAmount,
            locksRoot: params.locksRoot,
            chainId: params.metadata.chainId,
            tokenNetworkAddress: params.metadata.tokenNetworkAddress,
            tokenAddress: params.metadata.tokenAddress,
          });
        },
        buildClaimMessage(proof, senderId) {
          return EvmSigner.buildClaimMessage(proof, senderId);
        },
      };
    }

    throw new Error(
      `No signer registered for chain type: ${tracking.chainType}`
    );
  }

  /**
   * Lazily open a channel for a peer. Idempotent — returns existing channel
   * if already open. Deduplicates concurrent opens for the same peer.
   */
  async ensureChannel(
    peerId: string,
    negotiation: PeerNegotiation
  ): Promise<string> {
    // Return existing channel
    const existing = this.peerChannels.get(peerId);
    if (existing) return existing;

    // Deduplicate concurrent opens
    const pending = this.pendingOpens.get(peerId);
    if (pending) return pending;

    if (!this.channelClient) {
      throw new Error(
        'No channel client configured — cannot open payment channel'
      );
    }

    const openPromise = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- channelClient checked in constructor
        const result = await this.channelClient!.openChannel({
          peerId,
          chain: negotiation.chain,
          token: negotiation.tokenAddress,
          tokenNetwork: negotiation.tokenNetwork,
          peerAddress: negotiation.settlementAddress,
          initialDeposit:
            negotiation.initialDeposit ?? this.defaultInitialDeposit,
          settlementTimeout:
            negotiation.settlementTimeout ?? this.defaultSettlementTimeout,
        });

        this.trackChannel(result.channelId, {
          chainType: negotiation.chainType,
          chainId:
            typeof negotiation.chainId === 'number' ? negotiation.chainId : 0,
          tokenNetworkAddress: negotiation.tokenNetwork ?? '',
          tokenAddress: negotiation.tokenAddress,
          recipient: negotiation.settlementAddress,
          // On-chain depositTotal (Mina only) — needed so the Mina signer binds
          // balanceB = depositTotal − balanceA (connector#133).
          depositTotal: result.depositTotal,
        });
        this.peerChannels.set(peerId, result.channelId);
        return result.channelId;
      } finally {
        this.pendingOpens.delete(peerId);
      }
    })();

    this.pendingOpens.set(peerId, openPromise);
    return openPromise;
  }

  /**
   * Get channel ID for a peer (if any).
   */
  getChannelForPeer(peerId: string): string | undefined {
    return this.peerChannels.get(peerId);
  }

  /**
   * Start tracking a channel.
   * Called after bootstrap returns a channelId.
   *
   * @param channelId - Payment channel identifier
   * @param chainContext - Chain context for signing (chainType + chainId + tokenNetworkAddress)
   * @param initialNonce - Starting nonce (default: 0)
   * @param initialAmount - Starting cumulative amount (default: 0n)
   */
  trackChannel(
    channelId: string,
    chainContext?: {
      chainType?: string;
      chainId: number;
      tokenNetworkAddress: string;
      tokenAddress?: string;
      recipient?: string;
      depositTotal?: bigint;
    },
    initialNonce = 0,
    initialAmount = 0n
  ): void {
    const cId = chainContext?.chainId ?? 31337;
    const tnAddr =
      chainContext?.tokenNetworkAddress ??
      '0x0000000000000000000000000000000000000000';

    // If store has persisted state for this channel, resume from it
    if (this.store) {
      const persisted = this.store.load(channelId);
      if (persisted) {
        this.channels.set(channelId, {
          nonce: persisted.nonce,
          cumulativeAmount: persisted.cumulativeAmount,
          chainType: chainContext?.chainType ?? 'evm',
          chainId: cId,
          tokenNetworkAddress: tnAddr,
          tokenAddress: chainContext?.tokenAddress,
          recipient: chainContext?.recipient,
          depositTotal: chainContext?.depositTotal,
          // Resume the withdraw-flow timers so a daemon restart mid-grace
          // doesn't strand funds (the gate can't be evaluated without them).
          ...(persisted.closedAt !== undefined ? { closedAt: persisted.closedAt } : {}),
          ...(persisted.settleableAt !== undefined ? { settleableAt: persisted.settleableAt } : {}),
          ...(persisted.settledAt !== undefined ? { settledAt: persisted.settledAt } : {}),
        });
        return;
      }
    }

    this.channels.set(channelId, {
      nonce: initialNonce,
      cumulativeAmount: initialAmount,
      chainType: chainContext?.chainType ?? 'evm',
      chainId: cId,
      tokenNetworkAddress: tnAddr,
      tokenAddress: chainContext?.tokenAddress,
      recipient: chainContext?.recipient,
      depositTotal: chainContext?.depositTotal,
    });
  }

  /**
   * Signs a balance proof for the given channel.
   * Auto-increments nonce and adds to cumulative amount.
   * Routes to the correct ChainSigner based on the channel's chain type.
   *
   * @param channelId - Payment channel identifier
   * @param additionalAmount - Amount to add to cumulative transferred amount
   * @returns Signed balance proof
   * @throws Error if channel is not being tracked
   */
  async signBalanceProof(
    channelId: string,
    additionalAmount: bigint
  ): Promise<SignedBalanceProof> {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(
        `Channel "${channelId}" is not being tracked. Call trackChannel() first.`
      );
    }

    tracking.nonce += 1;
    tracking.cumulativeAmount += additionalAmount;

    // Persist updated state (preserving any withdraw-flow timers).
    this.persist(channelId);

    // Route to appropriate signer for non-EVM chains
    const signer = this.chainSigners.get(tracking.chainType);
    if (signer && tracking.chainType !== 'evm') {
      if (!tracking.recipient) {
        throw new Error(
          `Channel "${channelId}" (${tracking.chainType}) has no recipient settlement address; ` +
            'cannot sign a Solana/Mina balance proof. Ensure the peer negotiation supplied a settlementAddress.'
        );
      }
      const metadata = this.buildMetadata(tracking);
      return signer.signBalanceProof({
        channelId,
        nonce: tracking.nonce,
        transferredAmount: tracking.cumulativeAmount,
        lockedAmount: 0n,
        locksRoot:
          '0x0000000000000000000000000000000000000000000000000000000000000000',
        recipient: tracking.recipient,
        metadata,
        // On-chain depositTotal captured at open time (#220) — the Mina signer
        // binds balanceB = depositTotal − balanceA (connector#133); the Solana
        // signer ignores it. When undefined (resume / idempotent re-open) the
        // Mina signer self-resolves it from chain (#223).
        depositTotal: tracking.depositTotal,
      });
    }

    // EVM path (backwards compatible — uses EvmSigner directly)
    if (!this.evmSigner) {
      throw new Error('No EVM signer configured for EVM channel signing.');
    }
    return this.evmSigner.signBalanceProof({
      channelId,
      nonce: tracking.nonce,
      transferredAmount: tracking.cumulativeAmount,
      lockedAmount: 0n,
      locksRoot:
        '0x0000000000000000000000000000000000000000000000000000000000000000',
      chainId: tracking.chainId,
      tokenNetworkAddress: tracking.tokenNetworkAddress,
      tokenAddress: tracking.tokenAddress,
    });
  }

  private buildMetadata(tracking: ChannelTracking): ChainMetadata {
    switch (tracking.chainType) {
      case 'solana':
        return { chainType: 'solana', programId: tracking.tokenNetworkAddress };
      case 'mina':
        return {
          chainType: 'mina',
          zkAppAddress: tracking.tokenNetworkAddress,
        };
      default:
        return {
          chainType: 'evm',
          chainId: tracking.chainId,
          tokenNetworkAddress: tracking.tokenNetworkAddress,
          tokenAddress: tracking.tokenAddress,
        };
    }
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
   * Gets the on-chain deposit total (collateral locked at open / via deposits)
   * for a tracked channel, or `0n` when none was captured. The available
   * (spendable) balance is `depositTotal - cumulativeAmount`.
   */
  getDepositTotal(channelId: string): bigint {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }
    return tracking.depositTotal ?? 0n;
  }

  /**
   * Update the tracked on-chain deposit total after a successful deposit, so the
   * available balance (`depositTotal - cumulativeAmount`) reflects the new
   * collateral on the next read.
   */
  setDepositTotal(channelId: string, total: bigint): void {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }
    tracking.depositTotal = total;
  }

  /** Persist a channel's full nonce/amount + withdraw-timer state to the store. */
  private persist(channelId: string): void {
    if (!this.store) return;
    const t = this.channels.get(channelId);
    if (!t) return;
    this.store.save(channelId, {
      nonce: t.nonce,
      cumulativeAmount: t.cumulativeAmount,
      ...(t.closedAt !== undefined ? { closedAt: t.closedAt } : {}),
      ...(t.settleableAt !== undefined ? { settleableAt: t.settleableAt } : {}),
      ...(t.settledAt !== undefined ? { settledAt: t.settledAt } : {}),
    });
  }

  /**
   * Record that a channel was closed (withdraw flow): stores `closedAt` +
   * `settleableAt` (unix SECONDS) so the grace timer survives a daemon restart.
   */
  setChannelClosed(channelId: string, closedAt: bigint, settleableAt: bigint): void {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }
    tracking.closedAt = closedAt;
    tracking.settleableAt = settleableAt;
    this.persist(channelId);
  }

  /** Record that a channel was settled (collateral released). */
  setChannelSettled(channelId: string, settledAt: bigint): void {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }
    tracking.settledAt = settledAt;
    this.persist(channelId);
  }

  /** The `settleableAt` timestamp (unix seconds) for a closed channel, if set. */
  getSettleableAt(channelId: string): bigint | undefined {
    return this.channels.get(channelId)?.settleableAt;
  }

  /**
   * Where a channel sits in the withdraw journey, from the tracked timers:
   * `open` (never closed) → `closing` (closed, grace not elapsed) →
   * `settleable` (grace elapsed) → `settled`. `nowSec` is injectable for tests.
   */
  getChannelCloseState(
    channelId: string,
    nowSec = BigInt(Math.floor(Date.now() / 1000))
  ): 'open' | 'closing' | 'settleable' | 'settled' {
    const t = this.channels.get(channelId);
    if (!t || t.closedAt === undefined) return 'open';
    if (t.settledAt !== undefined) return 'settled';
    if (t.settleableAt !== undefined && nowSec >= t.settleableAt) return 'settleable';
    return 'closing';
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

import { EvmSigner } from '../signing/evm-signer.js';
import type { ChainSigner, ChainMetadata } from '../signing/types.js';
import type { SignedBalanceProof } from '../types.js';
import { ChannelResumeError } from '../errors.js';
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
  /**
   * Collateral (base units) locked on-chain by {@link ChannelManager.ensureChannel}
   * when it opens a channel, on every settlement chain. Default `'100000'`
   * (0.1 USDC at 6 decimals); a peer's negotiated `initialDeposit` wins over it.
   */
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
   * The key a peer's channel binding is persisted under: the peer, the
   * negotiated chain, and the token network the channel lives on. All three
   * matter — the same peer on a second chain (or a redeployed token network) is
   * a DIFFERENT channel.
   */
  private static bindingKey(
    peerId: string,
    negotiation: PeerNegotiation
  ): string {
    return `${peerId}|${negotiation.chain}|${negotiation.tokenNetwork ?? ''}`;
  }

  /**
   * Lazily open a channel for a peer. Idempotent — returns existing channel
   * if already open. Deduplicates concurrent opens for the same peer.
   *
   * RESUME (#489): before opening anything on-chain, the persisted peer→channel
   * binding is consulted, so a restarted process re-attaches to the channel it
   * already holds instead of locking a second lot of collateral. Solana got this
   * for free (its channel id is a deterministic PDA, so a re-open re-derived the
   * same channel); EVM mints a fresh `bytes32` per `openChannel` call, so every
   * restart stranded a deposit until this binding existed.
   */
  async ensureChannel(
    peerId: string,
    negotiation: PeerNegotiation
  ): Promise<string> {
    // Keyed by peer AND chain AND token network: one peer can be settled with
    // on several chains, and each is a separate channel. (Keying the in-memory
    // map by peer alone handed the EVM channel back for a Solana negotiation.)
    const key = ChannelManager.bindingKey(peerId, negotiation);

    // Return existing channel
    const existing = this.peerChannels.get(key);
    if (existing) return existing;

    // Deduplicate concurrent opens
    const pending = this.pendingOpens.get(key);
    if (pending) return pending;

    // Resume a channel this identity already holds with the peer.
    const resumed = this.resumeChannel(peerId, negotiation);
    if (resumed) return resumed;

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

        const context = {
          chainType: negotiation.chainType,
          chainId:
            typeof negotiation.chainId === 'number' ? negotiation.chainId : 0,
          tokenNetworkAddress: negotiation.tokenNetwork ?? '',
          tokenAddress: negotiation.tokenAddress,
          recipient: negotiation.settlementAddress,
        };
        this.trackChannel(result.channelId, {
          ...context,
          // On-chain depositTotal, reported by every opener since issue #565
          // (it was Mina-only before, so an EVM channel's collateral read back
          // as 0). The Mina signer needs it to bind balanceB = depositTotal −
          // balanceA (connector#133); every chain needs it for the spendable
          // balance `depositTotal - cumulativeAmount`.
          depositTotal: result.depositTotal,
        });
        this.peerChannels.set(key, result.channelId);
        // Remember WHICH channel this peer holds, and seed its watermark, so
        // the next process resumes it instead of opening a second one (#489).
        this.bindChannel(key, result.channelId, context, {
          ...(result.depositTotal !== undefined
            ? { depositTotal: result.depositTotal }
            : {}),
        });
        return result.channelId;
      } finally {
        this.pendingOpens.delete(key);
      }
    })();

    this.pendingOpens.set(key, openPromise);
    return openPromise;
  }

  /**
   * Adopt an ALREADY-OPEN channel as this peer's channel: track it (rehydrating
   * its watermark from the store), bind it so later lazy opens RESUME it rather
   * than opening a second one, and hand the on-chain client its context back.
   *
   * For a host that persisted the channel id itself before the client could
   * (the MCP daemon's apex-channel store, rig's channel map): those hosts used
   * to `trackChannel` on restart, which left `ensureChannel` unaware — so the
   * first paid write opened a SECOND on-chain channel anyway (#489).
   */
  adoptChannel(
    peerId: string,
    negotiation: PeerNegotiation,
    channelId: string
  ): void {
    const key = ChannelManager.bindingKey(peerId, negotiation);
    const context = {
      chainType: negotiation.chainType,
      chainId:
        typeof negotiation.chainId === 'number' ? negotiation.chainId : 0,
      tokenNetworkAddress: negotiation.tokenNetwork ?? '',
      tokenAddress: negotiation.tokenAddress,
      recipient: negotiation.settlementAddress,
    };
    // Carry the collateral the binding already recorded (issue #565). Adopting
    // is a RESTART path: the deposit was locked in a previous process, so
    // without this the adopted channel reports 0 spendable on a funded channel
    // until something re-reads it from chain (which only the MCP daemon does).
    const bound = this.store?.loadBinding?.(key);
    const deposited =
      bound?.channelId === channelId ? bound.depositTotal : undefined;
    this.trackChannel(channelId, {
      ...context,
      ...(deposited !== undefined ? { depositTotal: deposited } : {}),
    });
    this.peerChannels.set(key, channelId);
    this.bindChannel(key, channelId, context, {
      ...(deposited !== undefined ? { depositTotal: deposited } : {}),
    });
    this.adoptOnChainContext(channelId, negotiation);
  }

  /**
   * Re-attach to the channel this identity already holds with `peerId`, from the
   * store's peer→channel binding. Returns the resumed channel id, or undefined
   * when there is nothing to resume (no store, no binding, or a binding whose
   * channel is closing/settled — a spent channel must not be reused).
   *
   * `trackChannel` rehydrates the nonce/cumulative watermark from the store, so
   * the resumed channel keeps signing ABOVE the last claim the connector saw.
   *
   * @throws {ChannelResumeError} when the binding's watermark is missing —
   *   resuming would silently reset the nonce and every later claim would be
   *   rejected (F01), so the caller is told loudly instead.
   */
  private resumeChannel(
    peerId: string,
    negotiation: PeerNegotiation
  ): string | undefined {
    const store = this.store;
    if (!store?.loadBinding) return undefined;

    const key = ChannelManager.bindingKey(peerId, negotiation);
    const binding = store.loadBinding(key);
    if (!binding) return undefined;

    const watermark = store.load(binding.channelId);
    if (!watermark) {
      throw new ChannelResumeError(
        `Payment channel "${binding.channelId}" is bound to peer "${peerId}" on ` +
          `${negotiation.chain}, but its claim watermark is missing from the ` +
          'channel store. Resuming would restart the nonce at 0 and the ' +
          'connector would reject every claim; opening a new channel would ' +
          'strand the collateral already locked in this one. Restore the ' +
          'channel store file, or settle the channel on-chain and remove its ' +
          `binding (key "${key}") before retrying.`
      );
    }

    // A channel in the withdraw flow is spent, not resumable: its collateral is
    // being released, so bind nothing and let the caller open a fresh channel.
    if (watermark.closedAt !== undefined || watermark.settledAt !== undefined) {
      store.deleteBinding?.(key);
      return undefined;
    }

    this.trackChannel(binding.channelId, {
      ...binding.context,
      ...(binding.depositTotal !== undefined
        ? { depositTotal: binding.depositTotal }
        : {}),
    });
    this.peerChannels.set(key, binding.channelId);
    // Hand the on-chain client back the context it only kept in memory, so
    // deposit/close/state reads work on a channel this process never opened.
    this.adoptOnChainContext(binding.channelId, negotiation);
    return binding.channelId;
  }

  /**
   * Persist a freshly opened channel as this peer's binding, and SEED its
   * watermark entry (`nonce 0`) so a later resume can tell "never claimed
   * against" apart from "watermark lost" (which is a hard
   * {@link ChannelResumeError}).
   */
  private bindChannel(
    key: string,
    channelId: string,
    context: {
      chainType: string;
      chainId: number;
      tokenNetworkAddress: string;
      tokenAddress?: string;
      recipient?: string;
    },
    extra: { depositTotal?: bigint }
  ): void {
    const store = this.store;
    if (!store?.saveBinding) return;
    if (!store.load(channelId)) {
      const tracking = this.channels.get(channelId);
      store.save(channelId, {
        nonce: tracking?.nonce ?? 0,
        cumulativeAmount: tracking?.cumulativeAmount ?? 0n,
      });
    }
    store.saveBinding(key, {
      channelId,
      context,
      ...(extra.depositTotal !== undefined
        ? { depositTotal: extra.depositTotal }
        : {}),
    });
  }

  /**
   * Re-seed the on-chain client's per-channel context for a RESUMED channel.
   * `OnChainChannelClient` caches `chain`/`tokenNetwork`/`token` only for
   * channels it opened in this process, so without this a resumed channel
   * cannot be deposited into or closed. Optional capability — a channel client
   * that doesn't implement `adoptChannel` is simply left alone.
   */
  private adoptOnChainContext(
    channelId: string,
    negotiation: PeerNegotiation
  ): void {
    const client = this.channelClient as
      | (ConnectorChannelClient & {
          adoptChannel?: (
            channelId: string,
            ctx: {
              chain: string;
              tokenNetworkAddress: string;
              tokenAddress?: string;
            }
          ) => void;
        })
      | undefined;
    if (!client?.adoptChannel || !negotiation.tokenNetwork) return;
    client.adoptChannel(channelId, {
      chain: negotiation.chain,
      tokenNetworkAddress: negotiation.tokenNetwork,
      ...(negotiation.tokenAddress
        ? { tokenAddress: negotiation.tokenAddress }
        : {}),
    });
  }

  /**
   * Get channel ID for a peer (if any). Channels are held per peer AND chain
   * AND token network, so a peer settled with on two chains has two — this
   * returns the first one tracked for the peer.
   */
  getChannelForPeer(peerId: string): string | undefined {
    for (const [key, channelId] of this.peerChannels) {
      if (key === peerId || key.startsWith(`${peerId}|`)) return channelId;
    }
    return undefined;
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
          ...(persisted.closedAt !== undefined
            ? { closedAt: persisted.closedAt }
            : {}),
          ...(persisted.settleableAt !== undefined
            ? { settleableAt: persisted.settleableAt }
            : {}),
          ...(persisted.settledAt !== undefined
            ? { settledAt: persisted.settledAt }
            : {}),
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
   *
   * Also written through to the peer BINDING (issue #565) — the deposit is an
   * on-chain fact, so a restart must resume with the collateral that is
   * actually locked, not the amount recorded when the channel was first opened.
   */
  setDepositTotal(channelId: string, total: bigint): void {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }
    tracking.depositTotal = total;
    this.persistDepositTotal(channelId, total);
  }

  /**
   * Write `total` into whichever peer binding names `channelId`. No-op without
   * a store that persists bindings, or when no binding names this channel (an
   * untracked/foreign channel has no collateral of ours to record).
   */
  private persistDepositTotal(channelId: string, total: bigint): void {
    const store = this.store;
    if (!store?.saveBinding || !store.loadBinding) return;
    for (const [key, bound] of this.peerChannels) {
      if (bound !== channelId) continue;
      const binding = store.loadBinding(key);
      if (!binding) continue;
      store.saveBinding(key, { ...binding, depositTotal: total });
      return;
    }
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
  setChannelClosed(
    channelId: string,
    closedAt: bigint,
    settleableAt: bigint
  ): void {
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
    if (t.settleableAt !== undefined && nowSec >= t.settleableAt)
      return 'settleable';
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

  /**
   * The chain context a tracked channel was opened/resumed with — the
   * chainType/chainId/tokenNetworkAddress a caller needs to build a
   * `POST /ilp/claim-state` request (toon-client#494) without re-deriving
   * them from the peer negotiation. `undefined` when `channelId` is not
   * tracked.
   */
  getChannelContext(channelId: string):
    | {
        chainType: string;
        chainId: number;
        tokenNetworkAddress: string;
        tokenAddress?: string;
        recipient?: string;
      }
    | undefined {
    const tracking = this.channels.get(channelId);
    if (!tracking) return undefined;
    return {
      chainType: tracking.chainType,
      chainId: tracking.chainId,
      tokenNetworkAddress: tracking.tokenNetworkAddress,
      ...(tracking.tokenAddress !== undefined
        ? { tokenAddress: tracking.tokenAddress }
        : {}),
      ...(tracking.recipient !== undefined ? { recipient: tracking.recipient } : {}),
    };
  }
}

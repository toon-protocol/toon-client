/**
 * The claim watermark: which channel this client holds with a connector, what
 * nonce and cumulative amount it has signed on that channel, and how to sign the
 * next one.
 *
 * ## What a watermark is, and why losing one is fatal
 *
 * A claim is cumulative and its nonce must strictly advance the figure the
 * connector has already banked (`client-edge-spec.md` §1.3 steps 2 and 3). The
 * connector keeps its own copy; this class keeps ours, and the two agree exactly
 * as long as every claim we sign is either accepted or rolled back. So the
 * watermark is not a cache — it is the only thing standing between a restart and
 * a channel whose every future claim is refused, which is why an in-memory store
 * is a footgun and {@link ../client/config.js!resolveConfig} warns about it.
 *
 * ## Signing advances it, and a refusal must put it back
 *
 * {@link ChannelManager.signBalanceProof} advances and PERSISTS the nonce and the
 * cumulative amount before the packet goes out, because a claim that is signed
 * and then sent must never be signable again at the same nonce. That ordering is
 * correct and the alternative is worse — but it leaves a debt: when the connector
 * then refuses the claim (an underpayment, an unknown channel, a rejected
 * `claimAck`), nothing was banked on its side, and our cumulative is now inflated
 * by value it never admitted. Every later claim would then overpay by that amount
 * against a deposit that is being spent down for nothing.
 * {@link ChannelManager.rollbackAmount} is the repayment, and
 * {@link ../client/send.js} calls it on every refusal path — including a thrown
 * transport error, where nothing is known to have arrived at all.
 *
 * ## The binding
 *
 * A binding says "this is the channel I hold with THAT connector, on THAT chain,
 * at THAT settlement contract", keyed by all three: the same connector on a
 * second chain, or at a redeployed token network, is a different channel. It is
 * persisted so a restart resumes the channel it already funded instead of locking
 * a second lot of collateral.
 */
import { EvmSigner } from '../signing/evm-signer.js';
import type { ChainSigner, ChainMetadata } from '../signing/types.js';
import type { SignedBalanceProof } from '../client/types.js';
import { ChannelResumeError } from '../client/errors.js';
import type { ChannelStore } from './ChannelStore.js';
import { counterpartyMatch } from './counterparty.js';
import type { ChannelClient, ChannelTerms } from './types.js';

interface ChannelTracking {
  nonce: number;
  cumulativeAmount: bigint;
  chainType: string;
  chainId: number;
  tokenNetworkAddress: string;
  tokenAddress?: string;
  /**
   * The counterparty's settlement address on this channel's chain. Carried
   * through signing so it reaches the claim message; neither chain's signed
   * bytes fold it in, because which side gets paid is fixed by the channel's own
   * participants rather than by the proof.
   */
  recipient?: string;
  /**
   * On-chain `depositTotal` (base units), as captured at open or deposit time.
   * The spendable balance is `depositTotal - cumulativeAmount`, and the connector
   * refuses a cumulative above the deposit outright (`client-edge-spec.md` §1.3
   * step 5), so this is what a caller should show as runway.
   */
  depositTotal?: bigint;
  /** Withdraw flow (unix SECONDS): set when close is initiated / becomes settleable / settled. */
  closedAt?: bigint;
  settleableAt?: bigint;
  settledAt?: bigint;
}

export interface ChannelManagerConfig {
  /**
   * Collateral (base units) {@link ChannelManager.ensureChannel} locks when it
   * opens a channel. Default `'100000'` (0.1 USDC at 6 decimals); a per-call
   * `initialDeposit` wins over it.
   */
  initialDeposit?: string;
  settlementTimeout?: number;
}

/** Per-open overrides, when a caller wants something other than the defaults. */
export interface EnsureChannelOptions {
  initialDeposit?: bigint;
  settlementTimeout?: number;
}

/**
 * The settlement contract a channel lives at: the `TokenNetwork` on EVM, the
 * settlement program on Solana. One field in the binding key, because they play
 * the same role — a channel at a redeployed one is a different channel.
 */
function settlementNetwork(terms: ChannelTerms): string {
  return (terms.kind === 'evm' ? terms.tokenNetwork : terms.programId) ?? '';
}

/** The persisted context a resumed channel is re-tracked from. */
function trackingContext(terms: ChannelTerms): {
  chainType: string;
  chainId: number;
  tokenNetworkAddress: string;
  tokenAddress?: string;
  recipient?: string;
} {
  return {
    chainType: terms.kind,
    chainId: terms.chainId ?? 0,
    tokenNetworkAddress: settlementNetwork(terms),
    ...(terms.token ? { tokenAddress: terms.token } : {}),
    ...(terms.counterparty ? { recipient: terms.counterparty } : {}),
  };
}

export class ChannelManager {
  private readonly channels = new Map<string, ChannelTracking>();
  private readonly chainSigners = new Map<string, ChainSigner>();
  private readonly connectorChannels = new Map<string, string>();
  private readonly pendingOpens = new Map<string, Promise<string>>();
  private readonly store?: ChannelStore;
  private readonly defaultInitialDeposit: string;
  private readonly defaultSettlementTimeout: number;
  private channelClient?: ChannelClient;
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

  /** Register a chain-specific signer (`'solana'`; EVM is wrapped from `EvmSigner`). */
  registerChainSigner(chainType: string, signer: ChainSigner): void {
    this.chainSigners.set(chainType, signer);
  }

  /** Set the on-chain channel client used for lazy channel opening. */
  setChannelClient(client: ChannelClient): void {
    this.channelClient = client;
  }

  /**
   * The signer for a tracked channel's chain. EVM is adapted from
   * {@link EvmSigner} rather than registered, because that class predates the
   * {@link ChainSigner} port and is also the on-chain transaction signer.
   */
  getSignerForChannel(channelId: string): ChainSigner {
    const tracking = this.channels.get(channelId);
    if (!tracking) {
      throw new Error(`Channel "${channelId}" is not being tracked.`);
    }

    const signer = this.chainSigners.get(tracking.chainType);
    if (signer) return signer;

    if (tracking.chainType === 'evm' && this.evmSigner) {
      const evmSigner = this.evmSigner;
      return {
        chainType: 'evm' as const,
        signerIdentifier: evmSigner.address,
        async signBalanceProof(params) {
          if (params.metadata.chainType !== 'evm') {
            throw new Error('Expected EVM metadata');
          }
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

    throw new Error(`No signer registered for chain type: ${tracking.chainType}`);
  }

  /**
   * The key a connector's channel binding is persisted under: the connector, the
   * chain, and the settlement contract the channel lives at. All three matter —
   * the same connector on a second chain, or at a redeployed token network, is a
   * DIFFERENT channel.
   */
  private static bindingKey(connector: string, terms: ChannelTerms): string {
    return `${connector}|${terms.chain}|${settlementNetwork(terms)}`;
  }

  /**
   * The channel this client holds with `connector` on these terms, opening one on
   * chain only if there is none.
   *
   * Resolution order, cheapest first: an in-memory binding, an open already in
   * flight (so concurrent sends share one), the persisted binding, and only then
   * the chain. Nothing here forces a fresh open — the on-chain opener adopts an
   * already-open channel where one exists (ADR 0059), so even a client with no
   * store at all normally lands on the channel it already funded.
   */
  async ensureChannel(
    connector: string,
    terms: ChannelTerms,
    options: EnsureChannelOptions = {}
  ): Promise<string> {
    const key = ChannelManager.bindingKey(connector, terms);

    const pending = this.pendingOpens.get(key);
    if (pending) return pending;

    const existing = this.resolveChannel(connector, terms);
    if (existing) return existing;

    if (!this.channelClient) {
      throw new Error('No channel client configured — cannot open a payment channel');
    }
    const channelClient = this.channelClient;

    const openPromise = (async () => {
      try {
        const result = await channelClient.openChannel({
          terms,
          initialDeposit: options.initialDeposit ?? BigInt(this.defaultInitialDeposit),
          settlementTimeout: options.settlementTimeout ?? this.defaultSettlementTimeout,
        });

        const context = trackingContext(terms);
        this.trackChannel(result.channelId, {
          ...context,
          ...(result.depositTotal !== undefined
            ? { depositTotal: result.depositTotal }
            : {}),
        });
        this.connectorChannels.set(key, result.channelId);
        this.bindChannel(key, result.channelId, context, {
          ...(result.depositTotal !== undefined
            ? { depositTotal: result.depositTotal }
            : {}),
        });
        // A channel that was ADOPTED rather than opened has an on-chain history
        // this process did not write, so hand the chain client its context back
        // exactly as the resume path does.
        this.adoptOnChainContext(result.channelId, terms);
        return result.channelId;
      } finally {
        this.pendingOpens.delete(key);
      }
    })();

    this.pendingOpens.set(key, openPromise);
    return openPromise;
  }

  /**
   * The channel already held with `connector` on these terms — from memory, or
   * resumed from the store — WITHOUT opening anything.
   *
   * Exists because "open one if there is none" is a policy a caller may not
   * want: a consumer running with `autoOpenChannel: false` needs to know that
   * paying would lock collateral on chain, and needs to know it without a chain
   * round trip and without the side effect it is trying to avoid. This is the
   * whole of {@link ChannelManager.ensureChannel} up to the point where it would
   * transact.
   *
   * @throws {ChannelResumeError} when a binding names a channel whose watermark
   *   is missing — the same hard failure `ensureChannel` raises, because the
   *   answer "there is no channel" would be a lie that opens a second one.
   */
  resolveChannel(connector: string, terms: ChannelTerms): string | undefined {
    const key = ChannelManager.bindingKey(connector, terms);
    return this.connectorChannels.get(key) ?? this.resumeChannel(connector, terms);
  }

  /**
   * Adopt an ALREADY-OPEN channel as this connector's channel: track it
   * (rehydrating its watermark from the store), bind it so later opens resume it
   * rather than opening a second one, and hand the on-chain client its context.
   *
   * For a host that persisted the channel id itself before this client could.
   * Tracking alone is not enough: the lazy-open path keys off the binding, so a
   * host that only re-tracked its saved channel still opened a second one on the
   * first paid request.
   */
  adoptChannel(connector: string, terms: ChannelTerms, channelId: string): void {
    const key = ChannelManager.bindingKey(connector, terms);
    const context = trackingContext(terms);
    // Carry the collateral the binding already recorded: adopting is a RESTART
    // path, so the deposit was locked in a previous process and without this a
    // funded channel reports zero spendable until something re-reads the chain.
    const bound = this.store?.loadBinding?.(key);
    const deposited = bound?.channelId === channelId ? bound.depositTotal : undefined;
    this.trackChannel(channelId, {
      ...context,
      ...(deposited !== undefined ? { depositTotal: deposited } : {}),
    });
    this.connectorChannels.set(key, channelId);
    this.bindChannel(key, channelId, context, {
      ...(deposited !== undefined ? { depositTotal: deposited } : {}),
    });
    this.adoptOnChainContext(channelId, terms);
  }

  /**
   * Re-attach to the channel this identity already holds with `connector`, from
   * the store's binding. `undefined` when there is nothing to resume — no store,
   * no binding, or a binding whose channel is closing/settled, since a spent
   * channel must not be reused.
   *
   * COUNTERPARTY: the binding key names a connector URL and a chain, and a URL
   * can change hands. All three key fields keep matching while the node behind
   * them is replaced, so a resume would sign claims on a channel the node now
   * answering holds no record of and every write would be refused `F01`. The
   * recorded counterparty is therefore re-checked against the address the node
   * publishes TODAY ({@link counterpartyMatch}) before anything is resumed.
   *
   * @throws {ChannelResumeError} when the binding's watermark is missing —
   *   resuming would restart the nonce and every later claim would be refused,
   *   so the caller is told loudly instead.
   */
  private resumeChannel(connector: string, terms: ChannelTerms): string | undefined {
    const store = this.store;
    if (!store?.loadBinding) return undefined;

    const key = ChannelManager.bindingKey(connector, terms);
    const binding = store.loadBinding(key);
    if (!binding) return undefined;

    // The counterparty rotated: retire the binding and let the caller re-resolve.
    // ARCHIVED, not dropped — the old channel may still hold an on-chain deposit.
    const announced = terms.counterparty;
    const counterparty = counterpartyMatch(binding.context, announced);
    if (counterparty === 'mismatch') {
      console.warn(
        `[ChannelManager] channel ${binding.channelId} bound to "${connector}" on ` +
          `${terms.chain} was opened against counterparty ` +
          `${binding.context.recipient}, but that connector now publishes ` +
          `${announced} — the node terminating that URL was replaced. Re-resolving ` +
          'the channel; the old binding is kept (superseded) so its on-chain ' +
          'deposit stays reclaimable.'
      );
      store.supersedeBinding?.(key);
      return undefined;
    }

    const watermark = store.load(binding.channelId);
    if (!watermark) {
      throw new ChannelResumeError(
        `Payment channel "${binding.channelId}" is bound to "${connector}" on ` +
          `${terms.chain}, but its claim watermark is missing from the channel ` +
          'store. Resuming would restart the nonce at 0 and the connector would ' +
          'refuse every claim; opening a new channel would strand the collateral ' +
          'already locked in this one. Restore the channel store file, or settle ' +
          `the channel on chain and remove its binding (key "${key}") before retrying.`
      );
    }

    // A channel in the withdraw flow is spent, not resumable: its collateral is
    // being released, so bind nothing and let the caller open a fresh channel.
    if (watermark.closedAt !== undefined || watermark.settledAt !== undefined) {
      store.deleteBinding?.(key);
      return undefined;
    }

    // MIGRATION: bindings written before the counterparty was validated carry no
    // `context.recipient`. There is nothing to contradict, so the resume
    // proceeds — but with the published address filled in, both for this run
    // (a Solana proof needs a recipient) and written back, so the NEXT run is
    // verifiable rather than unverifiable forever.
    const context =
      counterparty === 'unrecorded' && announced
        ? { ...binding.context, recipient: announced }
        : binding.context;

    this.trackChannel(binding.channelId, {
      ...context,
      ...(binding.depositTotal !== undefined ? { depositTotal: binding.depositTotal } : {}),
    });
    if (context !== binding.context) {
      store.saveBinding?.(key, { ...binding, context });
    }
    this.connectorChannels.set(key, binding.channelId);
    this.adoptOnChainContext(binding.channelId, terms);
    return binding.channelId;
  }

  /**
   * Retire the binding that produced `channelId`, because the connector answered
   * a claim drawn on it with `F01 — names a channel this connector has no record
   * of`.
   *
   * This is the GROUND-TRUTH counterpart to {@link resumeChannel}'s counterparty
   * check. That check is a prediction and only catches a record that visibly
   * disagrees with what is published; a node that keeps its settlement address
   * but loses its channel state (a wiped connector, a restored-from-backup box, a
   * redeployed contract) passes the prediction and fails on the wire. The reject
   * IS the answer, so the binding it names is retired and the caller re-resolves.
   *
   * SUPERSEDED, NOT DELETED — the channel may still hold an on-chain deposit, and
   * an archived record keeps it reclaimable. The channel also stays TRACKED (its
   * watermark is untouched) so close/settle still work on it; only the binding is
   * dropped.
   *
   * Refuses to act when the binding names a DIFFERENT channel than the one that
   * failed — a concurrent request may already have re-resolved it, and retiring
   * the replacement would open a third channel.
   *
   * @returns true when a binding was retired.
   */
  evictBinding(connector: string, terms: ChannelTerms, channelId: string): boolean {
    const key = ChannelManager.bindingKey(connector, terms);
    const inMemory = this.connectorChannels.get(key);
    if (inMemory !== undefined && inMemory !== channelId) return false;
    const persisted = this.store?.loadBinding?.(key);
    if (persisted && persisted.channelId !== channelId) return false;
    if (inMemory === undefined && !persisted) return false;

    this.connectorChannels.delete(key);
    this.pendingOpens.delete(key);
    this.store?.supersedeBinding?.(key);
    return true;
  }

  /**
   * Persist a freshly bound channel, and SEED its watermark entry (`nonce 0`) so
   * a later resume can tell "never claimed against" apart from "watermark lost",
   * which is a hard {@link ChannelResumeError}.
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
      ...(extra.depositTotal !== undefined ? { depositTotal: extra.depositTotal } : {}),
    });
  }

  /**
   * Re-seed the on-chain client's per-channel context for a channel it did not
   * open in this process. `OnChainChannelClient` caches the chain, settlement
   * contract and token per channel, so without this a resumed channel can be paid
   * on but not deposited into, closed or read. Optional capability — a channel
   * client that does not implement `adoptChannel` is simply left alone.
   */
  private adoptOnChainContext(channelId: string, terms: ChannelTerms): void {
    const client = this.channelClient as
      | (ChannelClient & {
          adoptChannel?: (
            channelId: string,
            ctx: { chain: string; tokenNetworkAddress: string; tokenAddress?: string }
          ) => void;
        })
      | undefined;
    const network = settlementNetwork(terms);
    if (!client?.adoptChannel || !network) return;
    client.adoptChannel(channelId, {
      chain: terms.chain,
      tokenNetworkAddress: network,
      ...(terms.token ? { tokenAddress: terms.token } : {}),
    });
  }

  /**
   * The channel bound to `connector`, if any — the first one tracked for it, since
   * a connector settled with on two chains has two.
   */
  getChannelForConnector(connector: string): string | undefined {
    for (const [key, channelId] of this.connectorChannels) {
      if (key === connector || key.startsWith(`${connector}|`)) return channelId;
    }
    return undefined;
  }

  /**
   * Start tracking a channel, resuming its watermark from the store when one is
   * persisted. `initialNonce`/`initialAmount` seed a channel the store has never
   * seen — never a channel it has, because a store entry is by definition ahead
   * of any figure a caller could pass.
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
    const cId = chainContext?.chainId ?? 0;
    const tnAddr = chainContext?.tokenNetworkAddress ?? '';

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
          // Resume the withdraw-flow timers so a restart mid-grace doesn't
          // strand funds (the settle gate can't be evaluated without them).
          ...(persisted.closedAt !== undefined ? { closedAt: persisted.closedAt } : {}),
          ...(persisted.settleableAt !== undefined
            ? { settleableAt: persisted.settleableAt }
            : {}),
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
   * Sign the next claim on `channelId`, advancing the nonce by one and the
   * cumulative amount by `additionalAmount`.
   *
   * **The advance is persisted BEFORE the signature is returned**, and therefore
   * before the packet goes out. That ordering is deliberate: a signed claim is a
   * bearer instrument, and re-issuing one at a nonce already spent is how a client
   * double-spends against itself. The cost is that a refusal leaves the local
   * figure ahead of the connector's — see {@link ChannelManager.rollbackAmount},
   * which every refusal path must call.
   *
   * @throws {Error} if the channel is not tracked.
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
    this.persist(channelId);

    const signer = this.chainSigners.get(tracking.chainType);
    if (signer && tracking.chainType !== 'evm') {
      if (!tracking.recipient) {
        throw new Error(
          `Channel "${channelId}" (${tracking.chainType}) has no counterparty ` +
            'settlement address recorded, so its balance proof cannot be built.'
        );
      }
      return signer.signBalanceProof({
        channelId,
        nonce: tracking.nonce,
        transferredAmount: tracking.cumulativeAmount,
        lockedAmount: 0n,
        locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
        recipient: tracking.recipient,
        metadata: this.buildMetadata(tracking),
      });
    }

    if (!this.evmSigner) {
      throw new Error('No EVM signer configured for EVM channel signing.');
    }
    return this.evmSigner.signBalanceProof({
      channelId,
      nonce: tracking.nonce,
      transferredAmount: tracking.cumulativeAmount,
      lockedAmount: 0n,
      locksRoot: '0x0000000000000000000000000000000000000000000000000000000000000000',
      chainId: tracking.chainId,
      tokenNetworkAddress: tracking.tokenNetworkAddress,
      tokenAddress: tracking.tokenAddress,
    });
  }

  /**
   * Give back cumulative amount the connector never admitted.
   *
   * Call this on EVERY path where a signed claim did not become value the
   * connector banked: a refused claim (`F03` underpayment or over-deposit, `F01`
   * unknown channel or non-advancing nonce), a `claimAck.result === 'rejected'`
   * riding beside any verdict, and a transport error where nothing is known to
   * have arrived. Without it the local cumulative runs permanently ahead of the
   * connector's watermark and every subsequent claim overpays by the difference —
   * spending the channel's deposit down for nothing, and eventually breaching the
   * deposit ceiling of `client-edge-spec.md` §1.3 step 5.
   *
   * **The nonce is deliberately NOT rolled back.** Only the amount is. A nonce is
   * a strictly-increasing sequence number, not a resource: the connector accepts
   * any claim whose nonce is above its watermark, so a gap costs nothing, whereas
   * reusing a nonce risks presenting two different claims under one number.
   * Re-signing at the next nonce with the restored cumulative is exactly what the
   * spec's own remedy for an over-deposit refusal describes.
   *
   * Clamped at zero, and a no-op for an untracked channel: this runs on error
   * paths, and an error path that throws its own error hides the original.
   */
  rollbackAmount(channelId: string, amount: bigint): void {
    const tracking = this.channels.get(channelId);
    if (!tracking || amount <= 0n) return;
    tracking.cumulativeAmount =
      tracking.cumulativeAmount > amount ? tracking.cumulativeAmount - amount : 0n;
    this.persist(channelId);
  }

  private buildMetadata(tracking: ChannelTracking): ChainMetadata {
    if (tracking.chainType === 'solana') {
      return { chainType: 'solana', programId: tracking.tokenNetworkAddress };
    }
    return {
      chainType: 'evm',
      chainId: tracking.chainId,
      tokenNetworkAddress: tracking.tokenNetworkAddress,
      tokenAddress: tracking.tokenAddress,
    };
  }

  /** The last nonce signed on a tracked channel. */
  getNonce(channelId: string): number {
    return this.require(channelId).nonce;
  }

  /** The cumulative transferred amount signed on a tracked channel. */
  getCumulativeAmount(channelId: string): bigint {
    return this.require(channelId).cumulativeAmount;
  }

  /**
   * The on-chain deposit total, or `0n` when none was captured. The spendable
   * balance is this minus {@link getCumulativeAmount}.
   */
  getDepositTotal(channelId: string): bigint {
    return this.require(channelId).depositTotal ?? 0n;
  }

  /**
   * Record new collateral after a deposit. Written through to the BINDING too:
   * the deposit is an on-chain fact, so a restart must resume with the collateral
   * that is actually locked rather than the amount recorded at open.
   */
  setDepositTotal(channelId: string, total: bigint): void {
    this.require(channelId).depositTotal = total;
    this.persistDepositTotal(channelId, total);
  }

  /** Write `total` into whichever binding names `channelId`. */
  private persistDepositTotal(channelId: string, total: bigint): void {
    const store = this.store;
    if (!store?.saveBinding || !store.loadBinding) return;
    for (const [key, bound] of this.connectorChannels) {
      if (bound !== channelId) continue;
      const binding = store.loadBinding(key);
      if (!binding) continue;
      store.saveBinding(key, { ...binding, depositTotal: total });
      return;
    }
  }

  /** Persist a channel's watermark and withdraw timers. */
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
   * Record that a channel was closed: `closedAt` + `settleableAt` (unix SECONDS),
   * persisted so the challenge timer survives a restart.
   */
  setChannelClosed(channelId: string, closedAt: bigint, settleableAt: bigint): void {
    const tracking = this.require(channelId);
    tracking.closedAt = closedAt;
    tracking.settleableAt = settleableAt;
    this.persist(channelId);
  }

  /** Record that a channel was settled (collateral released). */
  setChannelSettled(channelId: string, settledAt: bigint): void {
    this.require(channelId).settledAt = settledAt;
    this.persist(channelId);
  }

  /** The `settleableAt` timestamp (unix seconds) for a closed channel, if set. */
  getSettleableAt(channelId: string): bigint | undefined {
    return this.channels.get(channelId)?.settleableAt;
  }

  /**
   * Where a channel sits in the withdraw journey, from the tracked timers:
   * `open` → `closing` → `settleable` → `settled`. `nowSec` is injectable.
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

  /** Every channel id this manager is tracking. */
  getTrackedChannels(): string[] {
    return Array.from(this.channels.keys());
  }

  /** Whether `channelId` is tracked. */
  isTracking(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  /**
   * The chain context a tracked channel was opened or resumed with — what a
   * caller needs to build a `POST /ilp/claim-state` request without re-deriving
   * it. `undefined` when the channel is not tracked.
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
      ...(tracking.tokenAddress !== undefined ? { tokenAddress: tracking.tokenAddress } : {}),
      ...(tracking.recipient !== undefined ? { recipient: tracking.recipient } : {}),
    };
  }

  private require(channelId: string): ChannelTracking {
    const tracking = this.channels.get(channelId);
    if (!tracking) throw new Error(`Channel "${channelId}" is not being tracked.`);
    return tracking;
  }
}

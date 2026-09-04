/**
 * The channel, as a caller sees it: open, deposit, close, settle, inspect.
 *
 * Every method here spends the caller's own gas on the caller's own transaction.
 * A connector has no endpoint that opens a channel (`self-description-spec.md`
 * ND-03) — it reads the chain
 * ([ADR 0052](https://github.com/toon-protocol/connector/blob/main/docs/adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md))
 * — so there is nobody to ask and nothing to be granted. That is what makes
 * paying permissionless, and it is also why this facade is where a client first
 * touches a chain at all: {@link ToonClient.create} does not.
 *
 * ## Which chain
 *
 * {@link ChannelFacade.ensure} picks the settlement from the node's OWN
 * `settlements[]`, never from a preset: the node proved each entry against a live
 * chain when it booted (ND-07), and two declarations of one fact is how a mainnet
 * node comes to be described as devnet. The pick is `config.chain` when the caller
 * named one, else the first chain in the node's published order that this client
 * holds a key for, else a {@link ChainUnavailableError} naming what the node does
 * offer.
 *
 * ## Opening is never a side effect
 *
 * With `autoOpenChannel: false`, {@link ChannelFacade.ensure} resolves an
 * existing channel and otherwise raises {@link ChannelNotOpenError} — it does not
 * read the chain and it certainly does not transact. A consumer that must not
 * lock collateral behind the user's back (the CLI's `send`) relies on that being
 * the *whole* behaviour of the flag, not merely a preference the opener consults.
 */
import type {
  ChainKind,
  ChannelFacade,
  ChannelState,
  OpenChannelOptions,
  TxRef,
} from './types.js';
import type { ChannelTerms, OnChainChannelStatus } from '../channel/types.js';
import type { NodeSelfDescription } from '../connector/self-description.js';
import type { ConnectorChainSettlementTerms } from '../connector/ConnectorEdgeClient.js';
import type { ChannelManager } from '../channel/ChannelManager.js';
import type { OnChainChannelClient } from '../channel/OnChainChannelClient.js';
import { parseEvmChainId } from '../channel/evm/TokenNetworkClient.js';
import {
  ChainUnavailableError,
  ChannelNotOpenError,
  chainUnavailableMessage,
} from './errors.js';
import type { ResolvedConfig } from './config.js';

/** What the facade needs from the client around it. */
export interface ChannelFacadeDeps {
  config: ResolvedConfig;
  channels: ChannelManager;
  /** The node's `GET /ilp`, cached. */
  describe: () => Promise<NodeSelfDescription>;
  /** Built lazily on the first chain operation, so `create()` touches no chain. */
  onChainClient: () => OnChainChannelClient;
  /** Told which chain was picked, so the client can report it and label claims. */
  onChainSelected?: (chain: ChainKind, terms: ChannelTerms) => void;
}

export class ClientChannelFacade implements ChannelFacade {
  private readonly deps: ChannelFacadeDeps;
  /** The channel in use, and the terms it lives under. Set by {@link ensure}. */
  private current: { channelId: string; terms: ChannelTerms } | undefined;

  constructor(deps: ChannelFacadeDeps) {
    this.deps = deps;
  }

  get id(): string | undefined {
    return this.current?.channelId;
  }

  /**
   * The settlement terms in use, once a chain has been picked. Exposed so the
   * client can report the chain it settles on without re-picking.
   */
  get terms(): ChannelTerms | undefined {
    return this.current?.terms;
  }

  /**
   * Ensure a usable channel exists, and return its id.
   *
   * @throws {ChainUnavailableError} the node settles on no chain this client can
   *   pay on.
   * @throws {ChannelNotOpenError} `autoOpenChannel` is off and no channel is held.
   */
  /**
   * Teach the chain client the context of a channel this process did not open.
   *
   * A channel outlives the process that opened it — that is the point of the
   * store — but the chain client's knowledge of it does not: which chain it is
   * on, and which contract or program holds it, live in memory and start empty.
   * Paying needs none of that (a claim is signed from the channel's recorded
   * terms), which is why the gap only shows up the first time a resumed channel
   * is deposited into, closed or settled — and shows up there as a channel this
   * client "neither opened nor adopted".
   *
   * Adoption is bookkeeping and nothing else: no transaction, no chain read.
   */
  private adoptOnChain(channelId: string, terms: ChannelTerms): void {
    this.deps.onChainClient().adoptChannel(channelId, {
      chain: terms.chain,
      tokenNetworkAddress:
        terms.kind === 'evm' ? (terms.tokenNetwork ?? '') : (terms.programId ?? ''),
      ...(terms.token !== '' ? { tokenAddress: terms.token } : {}),
    });
  }

  async ensure(description?: NodeSelfDescription): Promise<string> {
    const desc = description ?? (await this.deps.describe());
    const terms = this.pickSettlement(desc);
    const { config, channels } = this.deps;

    const existing = channels.resolveChannel(config.connector, terms);
    if (existing !== undefined) {
      this.current = { channelId: existing, terms };
      // A channel resolved from the store was resumed, not opened, and the
      // manager could not hand the chain client its context on the way — the
      // chain client does not exist yet on this path (it is built lazily by
      // `onChainClient()`, which nothing above has called). `requireChannel`
      // adopts for exactly this reason, but it returns `current` untouched
      // when it is already set, and `ensure()` is what sets it. Without this
      // line a resumed channel could be paid on but never deposited into,
      // closed or settled: "neither opened nor adopted".
      this.adoptOnChain(existing, terms);
      return existing;
    }

    if (!config.autoOpenChannel) {
      throw new ChannelNotOpenError(
        `No payment channel is open with ${config.connector} on ${terms.chain}, ` +
          'and `autoOpenChannel` is off, so nothing will be opened on your behalf. ' +
          'Open one explicitly first — it locks collateral on chain and spends gas, ' +
          'which is exactly why it is not done as a side effect of sending.'
      );
    }

    // Opening reaches the chain, and the manager only holds a chain client once
    // this has been called — it is lazy so that `create()` and every free read
    // stay chain-free. Calling it before `ensureChannel` is what makes the
    // manager able to open at all.
    this.deps.onChainClient();

    const channelId = await channels.ensureChannel(config.connector, terms, {
      initialDeposit: config.deposit,
      settlementTimeout: config.settlementTimeout,
    });
    this.current = { channelId, terms };
    return channelId;
  }

  /**
   * Open a channel, or adopt the one already open with this connector.
   *
   * Adoption is the normal outcome and costs nothing: a channel's id is derived
   * from its participants on both chains (EVM since ADR 0059, Solana always), so
   * the chain itself answers "do I already have one with this counterparty?".
   */
  async open(options: OpenChannelOptions = {}): Promise<ChannelState> {
    const desc = await this.deps.describe();
    const terms = this.pickSettlement(desc);
    const { config, channels } = this.deps;

    // As in `ensure`: the manager has no chain client until this lazy getter
    // has run, and opening is precisely the operation that needs one.
    this.deps.onChainClient();

    const channelId = await channels.ensureChannel(config.connector, terms, {
      initialDeposit: options.deposit !== undefined ? BigInt(options.deposit) : config.deposit,
      settlementTimeout: options.settlementTimeout ?? config.settlementTimeout,
    });
    this.current = { channelId, terms };
    // Covers the resumed case: `ensureChannel` returns a channel it found in the
    // store without opening one, and the chain client has never heard of it.
    this.adoptOnChain(channelId, terms);
    return this.state();
  }

  /**
   * Add collateral. Monotonic on both chains — a deposit can never decrease
   * (`setTotalDeposit` reverts on a decrease; the Solana handler only adds) — so
   * a connector that read a deposit earlier holds a permanent lower bound and can
   * never under-credit a claim because of a stale read.
   */
  async deposit(amount: bigint | string): Promise<ChannelState> {
    const { channelId } = await this.requireChannel('deposit into');
    const delta = BigInt(amount);
    if (delta <= 0n) throw new RangeError('Deposit amount must be positive.');

    const { channels } = this.deps;
    const result = await this.deps
      .onChainClient()
      .depositToChannel(channelId, delta, {
        currentDeposit: channels.getDepositTotal(channelId),
      });
    channels.setDepositTotal(channelId, result.depositTotal);
    return this.state();
  }

  /**
   * Start the challenge period.
   *
   * The deadline is read back from the chain rather than computed here: the
   * contract stamps `closedAt` with the block timestamp, and a local clock that
   * disagreed by a few seconds would have a caller settle early and pay gas for a
   * revert.
   */
  async close(): Promise<TxRef & { closedAt?: bigint; settleableAt?: bigint }> {
    const { channelId } = await this.requireChannel('close');
    const result = await this.deps.onChainClient().closeChannel(channelId);
    this.deps.channels.setChannelClosed(channelId, result.closedAt, result.settleableAt);
    return {
      ...(result.txHash !== undefined ? { txHash: result.txHash } : {}),
      closedAt: result.closedAt,
      settleableAt: result.settleableAt,
    };
  }

  /**
   * Pay out and finish.
   *
   * The time guard is enforced HERE, before any gas is spent: the contract
   * reverts before `closedAt + settlementTimeout` anyway, and a caller learning
   * that from a failed transaction has paid to be told something this client
   * already knew.
   */
  async settle(): Promise<TxRef> {
    const { channelId } = await this.requireChannel('settle');
    const settleableAt = this.deps.channels.getSettleableAt(channelId);
    if (settleableAt === undefined) {
      throw new ChannelNotOpenError(
        `Channel ${channelId} has not been closed, so there is nothing to settle. ` +
          'Call close() first; it starts the challenge period.'
      );
    }
    const nowSec = BigInt(Math.floor(Date.now() / 1000));
    if (nowSec < settleableAt) {
      throw new ChannelNotOpenError(
        `Channel ${channelId} is not settleable yet — ${(settleableAt - nowSec).toString()}s ` +
          `of its challenge period remain (settleable at ${settleableAt.toString()}). ` +
          'The contract would revert; refusing before spending gas.'
      );
    }
    const result = await this.deps.onChainClient().settleChannel(channelId);
    this.deps.channels.setChannelSettled(channelId, nowSec);
    return { ...(result.txHash !== undefined ? { txHash: result.txHash } : {}) };
  }

  /**
   * The channel as this client and (optionally) the chain jointly see it.
   *
   * `spent`/`nonce` are always the LOCAL watermark — what this client has signed.
   * The connector keeps its own and is the one that decides; the two agree unless
   * a claim was signed and never accepted. `client.claimState()` asks the
   * connector for its side, and `{ onChain: true }` asks the chain for its.
   */
  async state(options: { onChain?: boolean } = {}): Promise<ChannelState> {
    const { channelId, terms } = await this.requireChannel('read');
    const { channels } = this.deps;

    const spent = channels.getCumulativeAmount(channelId);
    const depositTotal = channels.getDepositTotal(channelId);
    const nonce = channels.getNonce(channelId);

    let onChain: OnChainChannelStatus | undefined;
    if (options.onChain === true) {
      onChain = await this.deps.onChainClient().getChannelState(channelId);
    }

    const status = onChain?.status ?? localStatus(channels.getChannelCloseState(channelId));
    const deposit = onChain?.deposit ?? depositTotal;

    return {
      chain: terms.kind,
      channelId,
      counterparty: terms.counterparty,
      status,
      depositTotal: deposit,
      spent,
      nonce,
      available: deposit > spent ? deposit - spent : 0n,
      ...(onChain !== undefined
        ? {
            onChain: {
              ...(onChain.deposit !== undefined ? { deposit: onChain.deposit } : {}),
              ...(onChain.closedAt !== undefined ? { closedAt: onChain.closedAt } : {}),
              ...(onChain.settleableAt !== undefined
                ? { settleableAt: onChain.settleableAt }
                : {}),
            },
          }
        : {}),
      domain: terms,
    };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * The channel every lifecycle method needs, resolved without opening one.
   *
   * `deposit`/`close`/`settle`/`state` operate on a channel that must already
   * exist, so this never opens: a `deposit` that quietly opened a channel first
   * would lock the configured collateral *plus* the requested amount.
   */
  private async requireChannel(
    verb: string
  ): Promise<{ channelId: string; terms: ChannelTerms }> {
    if (this.current) return this.current;

    const desc = await this.deps.describe();
    const terms = this.pickSettlement(desc);
    const existing = this.deps.channels.resolveChannel(this.deps.config.connector, terms);
    if (existing === undefined) {
      throw new ChannelNotOpenError(
        `No payment channel is open with ${this.deps.config.connector} on ` +
          `${terms.chain}, so there is nothing to ${verb}. Call channel.open() first.`
      );
    }
    this.current = { channelId: existing, terms };
    // Resolved from the store, so this process has never opened it and the
    // chain client has no context for it. Every caller of this method is about
    // to reach the chain, which is exactly when that matters.
    this.adoptOnChain(existing, terms);
    return this.current;
  }

  /**
   * Choose the chain to settle on, from the node's own published settlements.
   *
   * @throws {ChainUnavailableError} naming the chains the node DOES offer, since
   *   the remedy is always to pick one of them or to hold a key for one.
   */
  private pickSettlement(description: NodeSelfDescription): ChannelTerms {
    const offered = description.settlements.map((s) => s.chain);
    const { config } = this.deps;

    if (description.settlements.length === 0) {
      throw new ChainUnavailableError(
        chainUnavailableMessage(config.chain, offered, 'none'),
        offered
      );
    }

    if (config.chain !== undefined) {
      const match = description.settlements.find((s) => s.kind === config.chain);
      if (!match) {
        throw new ChainUnavailableError(
          chainUnavailableMessage(config.chain, offered, 'not-offered'),
          offered
        );
      }
      return this.adopt(match);
    }

    // The node's own order is the preference order: it published these, and the
    // first one it lists is the one it expects to be paid on.
    const match = description.settlements.find(
      (s) => config.identity[s.kind] !== undefined
    );
    if (!match) {
      throw new ChainUnavailableError(
        chainUnavailableMessage(undefined, offered, 'no-key'),
        offered
      );
    }
    return this.adopt(match);
  }

  /** Read one published settlement entry as the terms a channel opens under. */
  private adopt(entry: ConnectorChainSettlementTerms): ChannelTerms {
    const terms = settlementToTerms(entry);
    this.deps.onChainSelected?.(terms.kind, terms);
    return terms;
  }
}

/**
 * A node's published settlement entry, as {@link ChannelTerms}.
 *
 * The EVM `chainId` is parsed out of the chain key (`evm:84532`) rather than
 * published separately, and it matters: it is the EIP-712 domain's `chainId`, so
 * a claim signed under the wrong one verifies against nothing.
 */
export function settlementToTerms(entry: ConnectorChainSettlementTerms): ChannelTerms {
  if (entry.kind === 'solana') {
    return {
      kind: 'solana',
      chain: entry.chain,
      counterparty: entry.settlementAddress,
      token: entry.tokenAddress,
      decimals: entry.decimals,
      programId: entry.programId,
    };
  }
  return {
    kind: 'evm',
    chain: entry.chain,
    chainId: parseEvmChainId(entry.chain),
    counterparty: entry.settlementAddress,
    token: entry.tokenAddress,
    decimals: entry.decimals,
    tokenNetwork: entry.tokenNetwork,
    tokenNetworkRegistry: entry.tokenNetworkRegistry,
  };
}

/**
 * The channel's status from the local withdraw timers alone.
 *
 * `closing` and `settleable` are both `closed` on chain — the difference between
 * them is only whether the challenge period has elapsed, which is a timer rather
 * than a state the contract holds.
 */
function localStatus(
  state: 'open' | 'closing' | 'settleable' | 'settled'
): ChannelState['status'] {
  if (state === 'settled') return 'settled';
  if (state === 'open') return 'open';
  return 'closed';
}

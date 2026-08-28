/**
 * One {@link ChannelClient} over both settlement chains: a dispatcher, and
 * nothing else.
 *
 * The lifecycle itself lives per chain — {@link ./evm/TokenNetworkClient.js} for
 * EVM, {@link ./solana/SolanaChannelClient.js} for Solana — because the two have almost
 * nothing in common beyond the shape of this interface: one is a contract call
 * against a deployment shared by every pair, the other is a program instruction
 * against a PDA that only ever belongs to one pair. What they DO share is that
 * every method here is the client's own transaction, signed with the client's own
 * key and paid for with the client's own gas. A connector has no endpoint that
 * opens a channel (`self-description-spec.md` ND-03); it reads the chain
 * ([ADR 0052](https://github.com/toon-protocol/connector/blob/main/docs/adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md)),
 * which is what makes paying it permissionless.
 *
 * This class holds one piece of state, and it is worth naming: a per-channel
 * record of WHICH chain, token network/program and token a channel was opened
 * under. Deposit, close, settle and read all need it, and none of them can
 * re-derive it from a channel id alone — so a channel resumed from the store
 * (rather than opened in this process) must be handed that context back through
 * {@link OnChainChannelClient.adoptChannel} before anything but paying works on
 * it.
 */
import type { EvmSigner } from '../signing/evm-signer.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '../utils/base58.js';
import { ChannelNotOpenError, ConfigError } from '../client/errors.js';
import type {
  ChannelClient,
  ChannelStatus,
  ChannelTerms,
  OnChainChannelStatus,
  OpenChannelParams,
  OpenChannelResult,
} from './types.js';
import {
  TokenNetworkClient,
  type EvmReadConsistencyConfig,
} from './evm/TokenNetworkClient.js';
import { SolanaChannelClient } from './solana/SolanaChannelClient.js';

export type { EvmReadConsistencyConfig };

export interface SolanaChannelConfig {
  rpcUrl: string;
  /**
   * Ed25519 keypair material. Accepts either a 32-byte seed or a 64-byte
   * `secretKey` (seed ‖ pubkey, as produced by `deriveFullIdentity`). The first
   * 32 bytes are the signing seed; the public key is derived from it.
   */
  keypair: Uint8Array;
  /**
   * DEFAULT settlement program id (base58). The channel's own negotiated program
   * — the `programId` the connector published for this chain — takes precedence
   * whenever there is one, because ADR 0053 binds that program into the signed
   * balance proof: opening against one program and signing under another
   * produces claims no channel of ours lives under.
   */
  programId: string;
  /** DEFAULT SPL mint for PDA derivation. The negotiated token wins when present. */
  tokenMint?: string;
  /** Challenge-period duration in seconds. Defaults to the caller's, else 86400. */
  challengeDuration?: number;
  /**
   * OVERRIDE for the deposit made at open time: `amount` in base units and/or
   * `payerTokenAccount`, the payer's funded SPL token account (derived from
   * owner + mint when left empty). Normally unset — the open deposits the
   * negotiated collateral, the same amount the EVM opener locks.
   */
  deposit?: { amount: string; payerTokenAccount: string };
}

export interface OnChainChannelClientConfig {
  evmSigner: EvmSigner;
  /** Chain key → RPC URL. A chain absent from this map cannot be transacted on. */
  chainRpcUrls: Record<string, string>;
  solanaConfig?: SolanaChannelConfig;
  /** How hard the EVM opener works to survive a stale-read RPC (#489). */
  readConsistency?: EvmReadConsistencyConfig;
}

/** What this class remembers about a channel it opened or adopted. */
interface ChannelContext {
  chain: string;
  /** The `TokenNetwork` on EVM; the settlement program id on Solana. */
  tokenNetworkAddress: string;
  tokenAddress?: string;
}

export class OnChainChannelClient implements ChannelClient {
  private readonly evmSigner: EvmSigner;
  private readonly chainRpcUrls: Record<string, string>;
  private solanaConfig?: SolanaChannelConfig;
  private readonly readConsistency: EvmReadConsistencyConfig | undefined;
  private readonly channelContext = new Map<string, ChannelContext>();
  private readonly evmClients = new Map<string, TokenNetworkClient>();
  private readonly solanaClients = new Map<string, SolanaChannelClient>();

  constructor(config: OnChainChannelClientConfig) {
    this.evmSigner = config.evmSigner;
    this.chainRpcUrls = config.chainRpcUrls;
    this.solanaConfig = config.solanaConfig;
    this.readConsistency = config.readConsistency;
  }

  /**
   * Late-bind the Solana config. The Ed25519 keypair is derived asynchronously
   * from the mnemonic after this client is constructed, and it must be the SAME
   * keypair the Solana signer holds — the channel-open key and the claim-signing
   * key are one key or the channel is not ours.
   */
  setSolanaConfig(config: SolanaChannelConfig): void {
    this.solanaConfig = config;
  }

  /**
   * Give a channel this process did NOT open its on-chain context back — the
   * restart path (#489), where the chain, token network and token came from the
   * channel store rather than from an `openChannel` call. Without it a resumed
   * channel can be paid on but not deposited into, closed or read.
   */
  adoptChannel(channelId: string, ctx: ChannelContext): void {
    this.channelContext.set(channelId, {
      chain: ctx.chain,
      tokenNetworkAddress: ctx.tokenNetworkAddress,
      ...(ctx.tokenAddress ? { tokenAddress: ctx.tokenAddress } : {}),
    });
  }

  /** The chain/token-network/token a channel is tracked under, if any. */
  getChannelContext(channelId: string): ChannelContext | undefined {
    return this.channelContext.get(channelId);
  }

  /**
   * The `TokenNetworkClient` for one chain key, built once and reused.
   *
   * @throws {ConfigError} when no RPC URL is configured for that chain — a
   *   condition no retry fixes, and one that must be reported before a caller
   *   believes it has an on-chain client that works.
   */
  evmClientFor(chain: string): TokenNetworkClient {
    const existing = this.evmClients.get(chain);
    if (existing) return existing;
    const rpcUrl = this.chainRpcUrls[chain];
    if (!rpcUrl) {
      throw new ConfigError(
        `No RPC URL configured for chain "${chain}". Configured: ` +
          `${Object.keys(this.chainRpcUrls).join(', ') || '(none)'}.`
      );
    }
    const client = new TokenNetworkClient({
      chain,
      rpcUrl,
      signer: this.evmSigner,
      ...(this.readConsistency ? { readConsistency: this.readConsistency } : {}),
    });
    this.evmClients.set(chain, client);
    return client;
  }

  // ─── ChannelClient ────────────────────────────────────────────────────────

  /**
   * Open a channel with the connector, or adopt the one already open with it.
   *
   * Adoption is the normal case on both chains and comes free from the id
   * derivation each uses: EVM derives `keccak256(p1, p2, epoch)` over the sorted
   * pair (ADR 0059), Solana derives the channel PDA from the same sorted pair
   * plus the mint. Neither needs a local record of what was opened before.
   */
  async openChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
    const { terms } = params;
    if (terms.kind === 'solana') return this.openSolanaChannel(params);

    const client = this.evmClientFor(terms.chain);
    const result = await client.openOrAdopt({
      terms,
      ...(params.initialDeposit !== undefined
        ? { initialDeposit: params.initialDeposit }
        : {}),
      ...(params.settlementTimeout !== undefined
        ? { settlementTimeout: params.settlementTimeout }
        : {}),
    });
    this.rememberEvm(result.channelId, terms);
    return result;
  }

  /**
   * Add collateral. `amount` is the DELTA; `currentDeposit` is what the channel
   * already holds, which EVM needs because `setTotalDeposit` takes the new
   * cumulative figure rather than a delta.
   */
  async depositToChannel(
    channelId: string,
    amount: bigint,
    opts: { currentDeposit: bigint }
  ): Promise<{ txHash?: string; depositTotal: bigint }> {
    if (amount <= 0n) throw new RangeError('Deposit amount must be positive.');
    const ctx = this.requireContext(channelId, 'deposit into');
    if (isSolanaChain(ctx.chain)) {
      // Incremental on chain (the program adds `amount`), so the new total is
      // the caller-tracked current plus the delta.
      const { txSignature } = await this.solanaClientForChannel(ctx).deposit(channelId, amount);
      return { txHash: txSignature, depositTotal: opts.currentDeposit + amount };
    }
    return this.evmClientFor(ctx.chain).deposit(ctx.tokenNetworkAddress, channelId, amount, {
      currentDeposit: opts.currentDeposit,
      ...(ctx.tokenAddress ? { token: ctx.tokenAddress } : {}),
    });
  }

  /** Start the challenge period. */
  async closeChannel(channelId: string): Promise<{
    txHash?: string;
    closedAt: bigint;
    settlementTimeout: bigint;
    settleableAt: bigint;
  }> {
    const ctx = this.requireContext(channelId, 'close');
    if (isSolanaChain(ctx.chain)) {
      const client = this.solanaClientForChannel(ctx);
      const { txSignature } = await client.close(channelId);
      // The deadline comes from the account the program just stamped, never
      // from this process's clock: `settle` is gated on the chain's own
      // `close_timestamp + challenge_duration`.
      const after = await client.read(channelId);
      const closedAt = after.closeTimestamp ?? 0n;
      const challenge = after.challengeDuration ?? 0n;
      return {
        txHash: txSignature,
        closedAt,
        settlementTimeout: challenge,
        settleableAt: after.settleableAt ?? closedAt + challenge,
      };
    }
    return this.evmClientFor(ctx.chain).close(ctx.tokenNetworkAddress, channelId);
  }

  /** Pay out and finish. Only permitted once the challenge period has elapsed. */
  async settleChannel(channelId: string): Promise<{ txHash?: string }> {
    const ctx = this.requireContext(channelId, 'settle');
    if (isSolanaChain(ctx.chain)) {
      const { txSignature } = await this.solanaClientForChannel(ctx).settle(channelId);
      return { txHash: txSignature };
    }
    return this.evmClientFor(ctx.chain).settle(ctx.tokenNetworkAddress, channelId);
  }

  /** The channel's lifecycle position, as the chain reports it. */
  async getChannelState(channelId: string): Promise<OnChainChannelStatus> {
    const ctx = this.requireContext(channelId, 'read');
    if (isSolanaChain(ctx.chain)) {
      const account = await this.solanaClientForChannel(ctx).read(channelId);
      // A SETTLED channel's account is zeroed by the program, so `!exists` is
      // reported as `missing`: "there is nothing there" is what was read, and
      // claiming to know it settled would be inventing a fact.
      const status: ChannelStatus = !account.exists
        ? 'missing'
        : account.state === 'opened'
          ? 'open'
          : account.state === 'closed'
            ? 'closed'
            : 'settled';
      return {
        channelId,
        status,
        chain: ctx.chain,
        // Our OWN collateral, not the vault's balance: the program bounds a
        // claim by the claimer's own deposit, so a peer-funded vault can look
        // amply funded while this client's headroom is nil.
        deposit: account.ownDeposit,
        ...(account.closeTimestamp !== undefined && account.closeTimestamp > 0n
          ? { closedAt: account.closeTimestamp }
          : {}),
        ...(account.settleableAt !== undefined ? { settleableAt: account.settleableAt } : {}),
      };
    }
    return this.evmClientFor(ctx.chain).getChannelState(ctx.tokenNetworkAddress, channelId);
  }

  /**
   * Read the EVM channel's close-relevant fields from chain, so a restarted
   * process recomputes the grace timer from the authority rather than from a
   * remembered number.
   */
  async getChannelCloseInfo(channelId: string): Promise<{
    status: ChannelStatus;
    closedAt: bigint;
    settlementTimeout: bigint;
    settleableAt: bigint;
  }> {
    const ctx = this.requireContext(channelId, 'read');
    if (isSolanaChain(ctx.chain)) {
      const account = await this.solanaClientForChannel(ctx).read(channelId);
      if (!account.exists) {
        throw new ChannelNotOpenError(
          `Solana channel ${channelId} does not exist on chain — a settled ` +
            "channel's account is zeroed by the program, so there is nothing left to read."
        );
      }
      const closedAt = account.closeTimestamp ?? 0n;
      const challenge = account.challengeDuration ?? 0n;
      return {
        status:
          account.state === 'opened' ? 'open' : account.state === 'closed' ? 'closed' : 'settled',
        closedAt,
        settlementTimeout: challenge,
        settleableAt: account.settleableAt ?? closedAt + challenge,
      };
    }
    const record = await this.evmClientFor(ctx.chain).readChannel(
      ctx.tokenNetworkAddress,
      channelId
    );
    return {
      status: record.status,
      closedAt: record.closedAt,
      settlementTimeout: record.settlementTimeout,
      settleableAt: record.closedAt + record.settlementTimeout,
    };
  }

  /**
   * A participant's on-chain `deposit`/`nonce`/`transferredAmount`. Takes the
   * chain and token network explicitly so it works for a channel that was resumed
   * from disk and has no in-memory context yet — which is exactly when a caller
   * needs to re-hydrate the collateral it did not persist.
   */
  async readEvmParticipantState(opts: {
    chain: string;
    tokenNetworkAddress: string;
    channelId: string;
    participant: string;
  }): Promise<{ deposit: bigint; nonce: bigint; transferredAmount: bigint }> {
    return this.evmClientFor(opts.chain).readParticipant(
      opts.tokenNetworkAddress,
      opts.channelId,
      opts.participant
    );
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private requireContext(channelId: string, verb: string): ChannelContext {
    const ctx = this.channelContext.get(channelId);
    if (!ctx) {
      throw new ConfigError(
        `No on-chain context for channel "${channelId}" — this client cannot ` +
          `${verb} a channel it neither opened nor adopted. Call adoptChannel() ` +
          'with the chain and token network it lives on.'
      );
    }
    return ctx;
  }

  private rememberEvm(channelId: string, terms: ChannelTerms): void {
    this.channelContext.set(channelId, {
      chain: terms.chain,
      tokenNetworkAddress: terms.tokenNetwork ?? '',
      ...(terms.token ? { tokenAddress: terms.token } : {}),
    });
  }

  /**
   * Open (or re-derive) the Solana channel PDA and collateralise it.
   *
   * Both PDA seeds are NEGOTIATED rather than configured: the mint is the
   * connector's published `tokenAddress` and the program its published
   * `programId`, each falling back to the config default only when the node named
   * none. That is what keeps the channel this opens and the channel the signed
   * claim asserts the same object — ADR 0053 binds the program into the signed
   * message, so a stale preset silently overriding it would produce claims that
   * verify against nothing.
   *
   * Idempotent by construction: the PDA is a pure function of the sorted pair and
   * the mint, so re-opening re-derives the same account and the on-chain
   * initialisation is skipped when it already exists.
   */
  private async openSolanaChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
    const { terms } = params;
    const cfg = this.requireSolanaConfig();
    const client = this.solanaClientFor(terms.programId, terms.token, params.settlementTimeout);
    // The collateral an open locks is ONE policy for every settlement chain: the
    // negotiated `initialDeposit`, the same figure the EVM opener locks.
    // `solanaConfig.deposit` remains an explicit operator override of the amount
    // and/or the funded token account it is pulled from.
    const deposit = BigInt(cfg.deposit?.amount ?? params.initialDeposit ?? 0n);
    const result = await client.open({
      counterparty: terms.counterparty,
      deposit,
      ...(cfg.deposit?.payerTokenAccount
        ? { payerTokenAccount: cfg.deposit.payerTokenAccount }
        : {}),
    });

    // Record BOTH seeds the channel was actually opened with, so a later deposit
    // addresses THIS channel's vault and THIS channel's payer ATA rather than
    // re-deriving either from config.
    this.channelContext.set(result.channelId, {
      chain: terms.chain,
      tokenNetworkAddress: terms.programId ?? cfg.programId,
      tokenAddress: terms.token || cfg.tokenMint || '',
    });

    return {
      channelId: result.channelId,
      // Deliberately conservative rather than asserted: this call submitted (or
      // adopted) a channel account, and its lifecycle position is a fact only a
      // read establishes. `getChannelState` is that read.
      status: 'opening',
      ...(result.depositTotal !== undefined ? { depositTotal: result.depositTotal } : {}),
    };
  }

  /**
   * The Solana lifecycle client for one (program, mint) pair, built once.
   *
   * Keyed by both because both are PDA seeds: the same connector on a second
   * mint is a different channel account, and a redeployed program is a different
   * channel entirely.
   */
  private solanaClientFor(
    programId: string | undefined,
    tokenMint: string | undefined,
    settlementTimeout?: number
  ): SolanaChannelClient {
    const cfg = this.requireSolanaConfig();
    const program = programId ?? cfg.programId;
    const mint = tokenMint || cfg.tokenMint;
    if (!mint) {
      throw new ConfigError(
        'A Solana channel PDA is seeded on the SPL mint, and neither the ' +
          'connector nor this config named one.'
      );
    }
    const key = `${program}|${mint}`;
    const existing = this.solanaClients.get(key);
    if (existing) return existing;

    const payerSeed = cfg.keypair.slice(0, 32);
    const client = new SolanaChannelClient({
      rpcUrl: cfg.rpcUrl,
      programId: program,
      tokenMint: mint,
      payerSeed,
      payerPubkey: base58Encode(new Uint8Array(ed25519.getPublicKey(payerSeed))),
      challengeDuration: BigInt(cfg.challengeDuration ?? settlementTimeout ?? 86400),
    });
    this.solanaClients.set(key, client);
    return client;
  }

  /** The Solana client for a channel already tracked, from its recorded seeds. */
  private solanaClientForChannel(ctx: ChannelContext): SolanaChannelClient {
    return this.solanaClientFor(ctx.tokenNetworkAddress, ctx.tokenAddress);
  }

  private requireSolanaConfig(): SolanaChannelConfig {
    if (!this.solanaConfig) {
      throw new ConfigError(
        'Solana channel config not provided — cannot act on a Solana channel. ' +
          'Supply a mnemonic or a solanaSecretKey.'
      );
    }
    return this.solanaConfig;
  }
}

/** `solana`, `solana:devnet`, … — the family, not the network. */
function isSolanaChain(chain: string): boolean {
  return chain.split(':')[0] === 'solana';
}

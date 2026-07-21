import {
  createPublicClient,
  createWalletClient,
  http,
  maxUint256,
  decodeEventLog,
  defineChain,
  type Hex,
  type TransactionReceipt,
} from 'viem';
import type {
  ConnectorChannelClient,
  OpenChannelParams,
  OpenChannelResult,
  ChannelState,
} from '@toon-protocol/core';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Encode } from '@toon-protocol/core';
import type { EvmSigner } from '../signing/evm-signer.js';
import { ChannelFundingError, isInsufficientGasError } from '../errors.js';
import {
  openSolanaChannel as openSolanaChannelOnChain,
  getChannelAccountState as getSolanaChannelAccountState,
  depositSolanaChannel,
  deriveAssociatedTokenAccount,
} from './solana-payment-channel.js';
import { openMinaChannelOnChain } from './mina-channel-open.js';

// TokenNetwork ABI — only the functions we need
const TOKEN_NETWORK_ABI = [
  {
    name: 'openChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'participant2', type: 'address' },
      { name: 'settlementTimeout', type: 'uint256' },
    ],
    outputs: [{ type: 'bytes32' }],
  },
  {
    name: 'setTotalDeposit',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'channelId', type: 'bytes32' },
      { name: 'participant', type: 'address' },
      { name: 'totalDeposit', type: 'uint256' },
    ],
    outputs: [],
  },
  {
    name: 'closeChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'settleChannel',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'channelId', type: 'bytes32' }],
    outputs: [],
  },
  {
    name: 'channels',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }],
    outputs: [
      { name: 'settlementTimeout', type: 'uint256' },
      { name: 'state', type: 'uint8' },
      { name: 'closedAt', type: 'uint256' },
      { name: 'openedAt', type: 'uint256' },
      { name: 'participant1', type: 'address' },
      { name: 'participant2', type: 'address' },
    ],
  },
  {
    name: 'participants',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'bytes32' }, { type: 'address' }],
    outputs: [
      { name: 'deposit', type: 'uint256' },
      { name: 'nonce', type: 'uint256' },
      { name: 'transferredAmount', type: 'uint256' },
    ],
  },
  {
    name: 'ChannelOpened',
    type: 'event',
    inputs: [
      { name: 'channelId', type: 'bytes32', indexed: true },
      { name: 'participant1', type: 'address', indexed: true },
      { name: 'participant2', type: 'address', indexed: true },
      { name: 'settlementTimeout', type: 'uint256', indexed: false },
    ],
  },
] as const;

// ERC20 ABI — only approve and allowance
const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
] as const;

/** Maps on-chain state uint8 to ChannelState status */
const STATE_MAP: Record<number, ChannelState['status']> = {
  0: 'settled',
  1: 'open',
  2: 'closed',
  3: 'settled',
};

export interface SolanaChannelConfig {
  rpcUrl: string;
  /**
   * Ed25519 keypair material. Accepts either a 32-byte seed or a 64-byte
   * `secretKey` (seed || pubkey, as produced by `deriveFullIdentity`). The first
   * 32 bytes are the signing seed; the public key is derived from it.
   */
  keypair: Uint8Array;
  programId: string;
  /**
   * SPL token mint (base58) for PDA derivation. Optional — the per-channel
   * negotiated token (`OpenChannelParams.token`) takes precedence when present.
   */
  tokenMint?: string;
  /**
   * Challenge-period duration in seconds for `initialize_channel`. Defaults to
   * `OpenChannelParams.settlementTimeout` or 86400.
   */
  challengeDuration?: number;
  /**
   * Optional deposit amount (base units, string) + the payer's funded SPL token
   * account (ATA, base58). When omitted, the channel is opened (initialized)
   * without an on-chain deposit — the connector accepts the claim on channel
   * `opened` status + participant membership; deposit is only consumed at
   * on-chain claim/settle time.
   */
  deposit?: { amount: string; payerTokenAccount: string };
}

export interface MinaChannelConfig {
  graphqlUrl: string;
  privateKey: string;
  /**
   * Deployed payment-channel zkApp address (B62). Optional when `autoDeploy`
   * is set — the open path then resolves (or deploys) a pair-owned zkApp
   * itself; see `mina-channel-deploy.ts`.
   */
  zkAppAddress?: string;
  /**
   * Per-pair zkApp auto-deploy (the Mina `PaymentChannel` zkApp is
   * single-pair: one deployment serves exactly one client↔connector pair).
   * When set, `openMinaChannel` first resolves a zkApp that is provably OURS
   * — the recorded `deployed` one, or `zkAppAddress` when its on-chain
   * channelHash matches this pair — and deploys a fresh one otherwise
   * (compile ≈1-3 min; inclusion ≈3-6 min; costs ~1.1 MINA + fees).
   * Without it, behavior is exactly the pre-autoDeploy contract: the
   * configured `zkAppAddress` is required and used verbatim.
   */
  autoDeploy?: {
    /** A previously recorded own deployment for this identity, if any. */
    deployed?: { zkAppAddress: string; zkAppPrivateKey: string };
    /**
     * Persist hook — called with the zkApp address + key BEFORE the deploy tx
     * is sent (and before the circuit compiles), so a crash between send and
     * on-chain confirmation reuses the SAME zkApp next run instead of
     * deploying (and paying ~1.1 MINA for) a second one.
     */
    onDeploying?: (record: {
      zkAppAddress: string;
      zkAppPrivateKey: string;
      feePayer: string;
    }) => void | Promise<void>;
    /** Persist hook — called BEFORE the open proceeds on a fresh deploy. */
    onDeployed?: (record: {
      zkAppAddress: string;
      zkAppPrivateKey: string;
      feePayer: string;
      deployTxHash?: string;
      vkHash?: string;
    }) => void | Promise<void>;
    /** Progress lines (compile/deploy/inclusion phases take minutes). */
    onProgress?: (line: string) => void;
  };
  /**
   * Channel settlement timeout in slots for `initializeChannel`. Defaults to
   * `OpenChannelParams.settlementTimeout` or 86400.
   */
  challengeDuration?: number;
  /**
   * Mina token id field (decimal string) for `initializeChannel`. Default '1'
   * (native MINA). The connector reads this only as on-chain channel metadata.
   */
  tokenId?: string;
  /**
   * Optional on-chain deposit (base units, string) submitted after the channel
   * is initialized. When omitted, the channel is opened (OPEN state) without a
   * deposit — the connector accepts the claim on `opened` status; deposit is
   * only consumed at on-chain settle time.
   */
  deposit?: { amount: string };
  /** Mina network id for the account/Schnorr prefix. Default 'devnet'. */
  networkId?: 'devnet' | 'mainnet';
}

export interface OnChainChannelClientConfig {
  evmSigner: EvmSigner;
  chainRpcUrls: Record<string, string>;
  solanaConfig?: SolanaChannelConfig;
  minaConfig?: MinaChannelConfig;
}

/**
 * Implements ConnectorChannelClient using viem for direct on-chain
 * interaction with TokenNetwork smart contract.
 *
 * Fully non-custodial — the client deposits its own funds on-chain.
 */
export class OnChainChannelClient implements ConnectorChannelClient {
  private readonly evmSigner: EvmSigner;
  private readonly chainRpcUrls: Record<string, string>;
  private solanaConfig?: SolanaChannelConfig;
  private minaConfig?: MinaChannelConfig;
  private readonly channelContext = new Map<
    string,
    { chain: string; tokenNetworkAddress: string; tokenAddress?: string }
  >();

  constructor(config: OnChainChannelClientConfig) {
    this.evmSigner = config.evmSigner;
    this.chainRpcUrls = config.chainRpcUrls;
    this.solanaConfig = config.solanaConfig;
    this.minaConfig = config.minaConfig;
  }

  /**
   * Late-binds the Solana channel config.
   *
   * `ToonClient.start()` derives the Solana Ed25519 keypair from the client's
   * mnemonic asynchronously (after this client is constructed), so the keypair
   * is injected here rather than at construction. Same keypair as the
   * registered Solana signer — guarantees the channel-open key and the
   * claim-signing key match.
   */
  setSolanaConfig(config: SolanaChannelConfig): void {
    this.solanaConfig = config;
  }

  /**
   * Late-binds the Mina channel config.
   *
   * Parallel to `setSolanaConfig`: `ToonClient.start()` derives the Mina private
   * key from the client's mnemonic asynchronously (after this client is
   * constructed), so the key is injected here rather than at construction. Same
   * key as the registered Mina signer.
   */
  setMinaConfig(config: MinaChannelConfig): void {
    this.minaConfig = config;
  }

  /**
   * Parse chain identifier to extract chainId.
   * Format: "evm:{network}:{chainId}" e.g., "evm:anvil:31337"
   */
  private parseChainId(chain: string): number {
    const parts = chain.split(':');
    if (parts.length < 2) {
      throw new Error(
        `Invalid chain format: "${chain}". Expected "evm:{network}:{chainId}" or "evm:{chainId}".`
      );
    }
    // Accept both the canonical 3-part `evm:{network}:{chainId}` and the 2-part
    // `evm:{chainId}` form some connectors advertise (e.g. `evm:31337`).
    const chainIdStr = parts.length >= 3 ? parts[2] : parts[1];
    if (!chainIdStr) {
      throw new Error(
        `Invalid chain format: "${chain}". Expected "evm:{network}:{chainId}".`
      );
    }
    const chainId = parseInt(chainIdStr, 10);
    if (isNaN(chainId)) {
      throw new Error(`Invalid chainId in chain "${chain}".`);
    }
    return chainId;
  }

  /**
   * Create viem clients for a given chain.
   */
  private createClients(chain: string) {
    const rpcUrl = this.chainRpcUrls[chain];
    if (!rpcUrl) {
      throw new Error(
        `No RPC URL configured for chain "${chain}". Available: ${Object.keys(this.chainRpcUrls).join(', ')}`
      );
    }

    const chainId = this.parseChainId(chain);

    const viemChain = defineChain({
      id: chainId,
      name: chain,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    });

    const publicClient = createPublicClient({
      transport: http(rpcUrl),
      chain: viemChain,
    });

    const walletClient = createWalletClient({
      account: this.evmSigner.account,
      transport: http(rpcUrl),
      chain: viemChain,
    });

    return { publicClient, walletClient };
  }

  /**
   * Opens a new payment channel on-chain.
   *
   * 1. Approve token spend if needed
   * 2. Call TokenNetwork.openChannel()
   * 3. Extract channelId from ChannelOpened event
   * 4. Deposit initial funds if specified
   */
  async openChannel(params: OpenChannelParams): Promise<OpenChannelResult> {
    const chainPrefix = params.chain.split(':')[0];

    // Dispatch to chain-specific opener
    if (chainPrefix === 'solana') return this.openSolanaChannel(params);
    if (chainPrefix === 'mina') return this.openMinaChannel(params);

    // EVM path (default)
    return this.openEvmChannel(params);
  }

  /**
   * Deposit additional collateral into an already-open channel. `amount` is the
   * DELTA to add (base units). Dispatches by the channel's cached chain context;
   * `currentDeposit` is the channel's current locked total (tracked off-chain by
   * the caller) — required for EVM, whose `setTotalDeposit` takes the new
   * cumulative total, not a delta. Returns the new on-chain deposit total.
   *
   * Non-custodial: the client deposits its OWN funds and signs its OWN tx.
   * EVM is live; Solana/Mina deposit extraction is a follow-up (PR B.1).
   */
  async depositToChannel(
    channelId: string,
    amount: bigint,
    opts: { currentDeposit: bigint }
  ): Promise<{ txHash?: string; depositTotal: bigint }> {
    if (amount <= 0n) throw new Error('Deposit amount must be positive.');
    const ctx = this.channelContext.get(channelId);
    if (!ctx) {
      throw new Error(
        `No on-chain context for channel "${channelId}" — it must be opened by this client first.`
      );
    }
    const chainPrefix = ctx.chain.split(':')[0];
    if (chainPrefix === 'solana') {
      return this.depositSolana(channelId, amount, opts.currentDeposit);
    }
    if (chainPrefix === 'mina') {
      throw new Error(
        'Deposit on mina is not yet supported (EVM + Solana today; Mina follow-up).'
      );
    }
    return this.depositEvm(channelId, amount, opts.currentDeposit, ctx);
  }

  /**
   * Solana deposit: fire the standalone `deposit` instruction against the channel
   * vault. Incremental on-chain (the program adds `amount`), so the new total is
   * the caller-tracked current plus the delta. Requires the funded payer token
   * account (the funded ATA) from the Solana channel config.
   */
  private async depositSolana(
    channelId: string,
    amount: bigint,
    currentDeposit: bigint
  ): Promise<{ txHash: string; depositTotal: bigint }> {
    if (!this.solanaConfig) {
      throw new Error('Solana channel config not set — cannot deposit.');
    }
    const cfg = this.solanaConfig;
    const payerSeed = cfg.keypair.slice(0, 32);
    const payerPubkey = base58Encode(
      new Uint8Array(ed25519.getPublicKey(payerSeed))
    );
    // The funded token account is deterministically the payer's ATA for the
    // channel mint, so derive it when the caller didn't pass one explicitly
    // (config need not carry payerTokenAccount — it's owner+mint, both known here).
    let payerTokenAccount = cfg.deposit?.payerTokenAccount;
    if (!payerTokenAccount) {
      if (!cfg.tokenMint) {
        throw new Error(
          'Solana deposit requires solanaConfig.deposit.payerTokenAccount or solanaConfig.tokenMint to derive the payer ATA.'
        );
      }
      payerTokenAccount = deriveAssociatedTokenAccount(
        payerPubkey,
        cfg.tokenMint
      );
    }
    const { depositTxSignature } = await depositSolanaChannel({
      rpcUrl: cfg.rpcUrl,
      programId: cfg.programId,
      channelPDA: channelId,
      payerSeed,
      payerPubkey,
      payerTokenAccount,
      amount,
    });
    return {
      txHash: depositTxSignature,
      depositTotal: currentDeposit + amount,
    };
  }

  /**
   * EVM deposit: approve the token-network for the delta if the allowance is
   * short, then `setTotalDeposit(channelId, participant, current + delta)` —
   * the contract takes the new cumulative total, so we add the delta to the
   * caller-supplied current locked amount.
   */
  private async depositEvm(
    channelId: string,
    amount: bigint,
    currentDeposit: bigint,
    ctx: { chain: string; tokenNetworkAddress: string; tokenAddress?: string }
  ): Promise<{ txHash: string; depositTotal: bigint }> {
    const { publicClient, walletClient } = this.createClients(ctx.chain);
    const tokenNetworkAddr = ctx.tokenNetworkAddress as Hex;
    const myAddress = this.evmSigner.address as Hex;
    const newTotal = currentDeposit + amount;

    // Approve the additional collateral if the current allowance can't cover it.
    if (ctx.tokenAddress) {
      const tokenAddr = ctx.tokenAddress as Hex;
      const allowance = await publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [myAddress, tokenNetworkAddr],
      });
      if ((allowance as bigint) < amount) {
        const approveHash = await walletClient.writeContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [tokenNetworkAddr, maxUint256],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    const depositHash = await walletClient.writeContract({
      address: tokenNetworkAddr,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'setTotalDeposit',
      args: [channelId as Hex, myAddress, newTotal],
    });
    await publicClient.waitForTransactionReceipt({ hash: depositHash });
    return { txHash: depositHash, depositTotal: newTotal };
  }

  /**
   * Close a channel to begin the settlement grace period. Dispatches by the
   * channel's cached chain context. EVM `closeChannel` is unilateral (channelId
   * only); after it confirms we read the `channels()` view for the AUTHORITATIVE
   * `closedAt` + `settlementTimeout` (block-timestamp seconds) and compute
   * `settleableAt = closedAt + settlementTimeout`. Solana/Mina are follow-ups.
   */
  async closeChannel(
    channelId: string
  ): Promise<{
    txHash?: string;
    closedAt: bigint;
    settlementTimeout: bigint;
    settleableAt: bigint;
  }> {
    const ctx = this.channelContext.get(channelId);
    if (!ctx) {
      throw new Error(
        `No on-chain context for channel "${channelId}" — it must be opened by this client first.`
      );
    }
    const chainPrefix = ctx.chain.split(':')[0];
    if (chainPrefix === 'solana' || chainPrefix === 'mina') {
      throw new Error(
        `Close on ${chainPrefix} is not yet supported (EVM today; Solana/Mina follow-up).`
      );
    }
    const { publicClient, walletClient } = this.createClients(ctx.chain);
    const tokenNetworkAddr = ctx.tokenNetworkAddress as Hex;
    const closeHash = await walletClient.writeContract({
      address: tokenNetworkAddr,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'closeChannel',
      args: [channelId as Hex],
    });
    await publicClient.waitForTransactionReceipt({ hash: closeHash });

    const info = await this.readEvmChannel(
      publicClient,
      tokenNetworkAddr,
      channelId
    );
    return {
      txHash: closeHash,
      closedAt: info.closedAt,
      settlementTimeout: info.settlementTimeout,
      settleableAt: info.closedAt + info.settlementTimeout,
    };
  }

  /**
   * Settle a closed channel after its grace period to release collateral. EVM
   * `settleChannel` is unilateral (channelId only); the contract itself reverts
   * before `closedAt + settlementTimeout`, so an early call surfaces as a tx
   * revert here — but the caller (ToonClient/daemon) enforces the time guard
   * BEFORE spending gas. Solana/Mina are follow-ups.
   */
  async settleChannel(channelId: string): Promise<{ txHash?: string }> {
    const ctx = this.channelContext.get(channelId);
    if (!ctx) {
      throw new Error(
        `No on-chain context for channel "${channelId}" — it must be opened by this client first.`
      );
    }
    const chainPrefix = ctx.chain.split(':')[0];
    if (chainPrefix === 'solana' || chainPrefix === 'mina') {
      throw new Error(
        `Settle on ${chainPrefix} is not yet supported (EVM today; Solana/Mina follow-up).`
      );
    }
    const { publicClient, walletClient } = this.createClients(ctx.chain);
    const settleHash = await walletClient.writeContract({
      address: ctx.tokenNetworkAddress as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'settleChannel',
      args: [channelId as Hex],
    });
    await publicClient.waitForTransactionReceipt({ hash: settleHash });
    return { txHash: settleHash };
  }

  /**
   * Read the EVM channel's close-relevant fields so a restarted daemon can
   * recompute the grace timer from chain (chain is authoritative). EVM-only.
   */
  async getChannelCloseInfo(channelId: string): Promise<{
    status: ChannelState['status'];
    closedAt: bigint;
    settlementTimeout: bigint;
    settleableAt: bigint;
  }> {
    const ctx = this.channelContext.get(channelId);
    if (!ctx)
      throw new Error(`No on-chain context for channel "${channelId}".`);
    const chainPrefix = ctx.chain.split(':')[0];
    if (chainPrefix === 'solana' || chainPrefix === 'mina') {
      throw new Error(
        `getChannelCloseInfo on ${chainPrefix} is not supported.`
      );
    }
    const { publicClient } = this.createClients(ctx.chain);
    const info = await this.readEvmChannel(
      publicClient,
      ctx.tokenNetworkAddress as Hex,
      channelId
    );
    return {
      status: STATE_MAP[info.state] ?? 'open',
      closedAt: info.closedAt,
      settlementTimeout: info.settlementTimeout,
      settleableAt: info.closedAt + info.settlementTimeout,
    };
  }

  /** Read + destructure the EVM `channels(bytes32)` view. */
  private async readEvmChannel(
    publicClient: ReturnType<
      OnChainChannelClient['createClients']
    >['publicClient'],
    tokenNetworkAddr: Hex,
    channelId: string
  ): Promise<{ settlementTimeout: bigint; state: number; closedAt: bigint }> {
    const res = (await publicClient.readContract({
      address: tokenNetworkAddr,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'channels',
      args: [channelId as Hex],
    })) as readonly [bigint, number, bigint, bigint, string, string];
    return {
      settlementTimeout: res[0],
      state: Number(res[1]),
      closedAt: res[2],
    };
  }

  /**
   * Read a participant's on-chain channel state — `deposit` (locked collateral),
   * `nonce`, and `transferredAmount` — straight from the `participants` mapping.
   * Takes the chain + token-network explicitly so it works for a channel that
   * was RESUMED from disk (no in-memory `channelContext` yet), which is exactly
   * when the daemon needs to re-hydrate the deposit it doesn't persist.
   */
  async readEvmParticipantState(opts: {
    chain: string;
    tokenNetworkAddress: string;
    channelId: string;
    participant: string;
  }): Promise<{ deposit: bigint; nonce: bigint; transferredAmount: bigint }> {
    const { publicClient } = this.createClients(opts.chain);
    const res = (await publicClient.readContract({
      address: opts.tokenNetworkAddress as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'participants',
      args: [opts.channelId as Hex, opts.participant as Hex],
    })) as readonly [bigint, bigint, bigint];
    return { deposit: res[0], nonce: res[1], transferredAmount: res[2] };
  }

  /**
   * Opens a REAL on-chain Solana payment channel.
   *
   * Derives the connector-parity channel PDA
   * (`[b"channel", min_pubkey, max_pubkey, token_mint]`), submits the
   * `initialize_channel` instruction (+ optional `deposit`) to the deployed
   * payment-channel program, and returns the base58 PDA as the channel id. That
   * PDA is what the claim carries as `channelAccount`, and the on-chain channel
   * is what the connector's `verifySolanaClaim` reads via
   * `provider.getChannelState` before accepting the claim.
   *
   * Mirrors `openEvmChannel`'s open(+deposit) structure. Idempotent: if the
   * channel account already exists on-chain, returns its PDA without
   * re-initializing.
   */
  private async openSolanaChannel(
    params: OpenChannelParams
  ): Promise<OpenChannelResult> {
    if (!this.solanaConfig) {
      throw new Error(
        'Solana channel config not provided — cannot open Solana channel'
      );
    }

    const cfg = this.solanaConfig;
    // First 32 bytes are the Ed25519 signing seed (config may pass a 64-byte
    // secretKey of seed||pubkey, or a bare 32-byte seed).
    const payerSeed = cfg.keypair.slice(0, 32);
    const payerPubkey = base58Encode(
      new Uint8Array(ed25519.getPublicKey(payerSeed))
    );

    // PDA mint: per-channel negotiated token takes precedence over config default.
    const tokenMint = params.token ?? cfg.tokenMint;
    if (!tokenMint) {
      throw new Error(
        'Solana channel requires a token mint (OpenChannelParams.token or solanaConfig.tokenMint)'
      );
    }
    if (!params.peerAddress) {
      throw new Error(
        'Solana channel requires peerAddress (apex settlement pubkey, base58)'
      );
    }

    const challengeDuration = BigInt(
      cfg.challengeDuration ?? params.settlementTimeout ?? 86400
    );

    const deposit = cfg.deposit
      ? {
          amount: BigInt(cfg.deposit.amount),
          // Derive the payer ATA (owner + channel mint) when not supplied — it is
          // deterministic, so the caller need not thread payerTokenAccount through.
          payerTokenAccount:
            cfg.deposit.payerTokenAccount ||
            deriveAssociatedTokenAccount(payerPubkey, tokenMint),
        }
      : undefined;

    const { channelPDA } = await openSolanaChannelOnChain({
      rpcUrl: cfg.rpcUrl,
      programId: cfg.programId,
      tokenMint,
      payerSeed,
      payerPubkey,
      peerPubkey: params.peerAddress,
      challengeDuration,
      deposit,
    });

    // Cache context (PDA is the channel id / channelAccount).
    this.channelContext.set(channelPDA, {
      chain: params.chain,
      tokenNetworkAddress: cfg.programId,
    });

    return { channelId: channelPDA, status: 'opening' };
  }

  /**
   * Opens a REAL on-chain Mina payment channel on the deployed `PaymentChannel`
   * zkApp.
   *
   * The zkApp is deployed out-of-band (the operator/e2e harness deploys it
   * deterministically and advertises its B62 address). This client then calls
   * `initializeChannel` on that zkApp so its on-chain `channelState` becomes
   * `OPEN` — which is what the connector's `MinaPaymentChannelSDK.getChannelState`
   * reads to return status `'opened'` (claim verification otherwise fails with
   * `mina_claim_verification_failed`). The deployed zkApp address IS the channel
   * id: `MinaClaimMessage.zkAppAddress` is both the claim's channel identifier
   * AND the channel-hash preimage the off-chain proof binds to (see
   * `mina-payment-channel.ts`), so the channel-open id and the claim's channel id
   * are guaranteed identical.
   *
   * This is the Mina analog of `openSolanaChannel` (connector#105): the client
   * opens its own per-channel on-chain state (initialize + optional deposit). The
   * heavyweight o1js + `@toon-protocol/mina-zkapp` proof work is lazily imported
   * inside `openMinaChannelOnChain` so npm consumers who never open a Mina
   * channel don't pay the o1js cost.
   *
   * Idempotent: if the on-chain channel is already `OPEN`, the opener returns
   * without re-initializing.
   *
   * NOTE: full on-chain Mina SETTLE remains gated by the connector-side
   * settlement-executor (the same blocker that stops the Solana SETTLE); reaching
   * `opened` + a stored claim is parity with Solana.
   */
  private async openMinaChannel(
    params: OpenChannelParams
  ): Promise<OpenChannelResult> {
    if (!this.minaConfig) {
      throw new Error(
        'Mina channel config not provided — cannot open Mina channel'
      );
    }
    // The apex's Mina settlement B62 (participantB) is REQUIRED so the channel is
    // opened TWO-party. The off-chain claim is signed in participant form
    // (`Poseidon([client.x, apex.x, 0])`); without participantB the on-chain
    // channel records empty/duplicate participants and the connector's
    // participant-form verification fails on settle (`Invalid balance proof
    // signature`, `participants:["",""]`). Mirrors the Solana peerAddress guard.
    // (Checked before auto-deploy too — the pair hash needs participantB.)
    if (!params.peerAddress) {
      throw new Error(
        'Mina channel requires peerAddress (apex Mina settlement B62) so the ' +
          'on-chain channel is opened two-party — the participant-form claim ' +
          'cannot settle against a single-party channel'
      );
    }
    // The deployed zkApp address IS the channel id (claim `zkAppAddress`).
    // With autoDeploy, resolve a zkApp that is provably OURS for this pair
    // (reusing the recorded/configured one when its on-chain channelHash
    // matches; deploying a dedicated one otherwise) — the Mina PaymentChannel
    // zkApp is single-pair, so a shared/announced address can never serve a
    // second identity. Lazily imported: only autoDeploy users pay the cost.
    let zkAppAddress = this.minaConfig.zkAppAddress;
    if (this.minaConfig.autoDeploy) {
      const { ensureOwnedMinaZkApp } = await import('./mina-channel-deploy.js');
      const ensured = await ensureOwnedMinaZkApp({
        graphqlUrl: this.minaConfig.graphqlUrl,
        payerPrivateKey: this.minaConfig.privateKey,
        peerPublicKey: params.peerAddress,
        ...(this.minaConfig.autoDeploy.deployed
          ? { deployed: this.minaConfig.autoDeploy.deployed }
          : {}),
        ...(zkAppAddress ? { candidateZkAppAddress: zkAppAddress } : {}),
        ...(this.minaConfig.autoDeploy.onDeploying
          ? { onDeploying: this.minaConfig.autoDeploy.onDeploying }
          : {}),
        ...(this.minaConfig.autoDeploy.onDeployed
          ? { onDeployed: this.minaConfig.autoDeploy.onDeployed }
          : {}),
        ...(this.minaConfig.autoDeploy.onProgress
          ? { onProgress: this.minaConfig.autoDeploy.onProgress }
          : {}),
      });
      zkAppAddress = ensured.zkAppAddress;
    }
    if (!zkAppAddress) {
      throw new Error(
        'Mina channel requires a deployed zkAppAddress (minaConfig.zkAppAddress)'
      );
    }

    const timeout = BigInt(
      this.minaConfig.challengeDuration ?? params.settlementTimeout ?? 86400
    );
    const deposit = this.minaConfig.deposit
      ? { amount: BigInt(this.minaConfig.deposit.amount) }
      : undefined;

    const openResult = await openMinaChannelOnChain({
      graphqlUrl: this.minaConfig.graphqlUrl,
      zkAppAddress,
      payerPrivateKey: this.minaConfig.privateKey,
      // params.peerAddress is the apex Mina settlement B62 pubkey (participantB).
      peerPublicKey: params.peerAddress,
      timeout,
      tokenId: this.minaConfig.tokenId,
      deposit,
      networkId: this.minaConfig.networkId,
    });

    // The deployed zkApp address IS the channel id (claim `zkAppAddress`).
    this.channelContext.set(zkAppAddress, {
      chain: params.chain,
      tokenNetworkAddress: zkAppAddress,
    });

    // Surface the CURRENT on-chain depositTotal so the Mina signer can bind
    // `balanceB = depositTotal − balanceA` (connector#133). Read at open time so
    // a re-deposited channel signs against the live value, not a stale config.
    return {
      channelId: zkAppAddress,
      status: 'opening',
      depositTotal: openResult.depositTotal,
    };
  }

  /**
   * Opens an EVM payment channel on-chain, remapping the one-time
   * insufficient-native-gas revert into an actionable {@link ChannelFundingError}
   * so callers surface "fund the wallet" instead of the raw viem
   * "...exceeds the balance of the account" string (toon-meta#65). Only the gas
   * case is remapped; every other error propagates unchanged.
   */
  private async openEvmChannel(
    params: OpenChannelParams
  ): Promise<OpenChannelResult> {
    try {
      return await this.openEvmChannelUnchecked(params);
    } catch (err) {
      if (!isInsufficientGasError(err)) throw err;
      // `chain` is a CAIP-ish id (e.g. "evm:anvil:31337"); surface just the
      // family so the remedy reads "no gas on evm", not the full slug.
      const chainFamily = params.chain.split(':')[0] || params.chain;
      throw new ChannelFundingError(
        `Settlement wallet ${this.evmSigner.address} has no gas on ` +
          `${chainFamily} to open a payment channel. Run toon_fund_wallet ` +
          `(or fund the wallet) and retry.`,
        err instanceof Error ? err : undefined
      );
    }
  }

  /**
   * Raw EVM channel-open (no gas-error remapping — see {@link openEvmChannel}).
   *
   * 1. Approve token spend if needed
   * 2. Call TokenNetwork.openChannel()
   * 3. Extract channelId from ChannelOpened event
   * 4. Deposit initial funds if specified
   */
  private async openEvmChannelUnchecked(
    params: OpenChannelParams
  ): Promise<OpenChannelResult> {
    const {
      chain,
      tokenNetwork,
      peerAddress,
      initialDeposit,
      settlementTimeout,
    } = params;

    if (!tokenNetwork) {
      throw new Error(
        'tokenNetwork address is required for on-chain channel opening'
      );
    }

    const { publicClient, walletClient } = this.createClients(chain);
    const tokenNetworkAddr = tokenNetwork as Hex;
    const deposit = initialDeposit ? BigInt(initialDeposit) : 0n;

    // If deposit > 0, ensure token approval
    if (deposit > 0n && params.token) {
      const tokenAddr = params.token as Hex;
      const myAddress = this.evmSigner.address as Hex;

      const currentAllowance = await publicClient.readContract({
        address: tokenAddr,
        abi: ERC20_ABI,
        functionName: 'allowance',
        args: [myAddress, tokenNetworkAddr],
      });

      if ((currentAllowance as bigint) < deposit) {
        const approveHash = await walletClient.writeContract({
          address: tokenAddr,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [tokenNetworkAddr, maxUint256],
        });
        await publicClient.waitForTransactionReceipt({ hash: approveHash });
      }
    }

    // Open channel
    const timeout = BigInt(settlementTimeout ?? 86400);
    const openHash = await walletClient.writeContract({
      address: tokenNetworkAddr,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'openChannel',
      args: [peerAddress as Hex, timeout],
    });

    const receipt: TransactionReceipt =
      await publicClient.waitForTransactionReceipt({ hash: openHash });

    // Extract channelId from ChannelOpened event
    let channelId: string | undefined;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: TOKEN_NETWORK_ABI,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === 'ChannelOpened') {
          channelId = (decoded.args as Record<string, unknown>)[
            'channelId'
          ] as string;
          break;
        }
      } catch {
        // Not our event, skip
      }
    }

    if (!channelId) {
      throw new Error('Failed to extract channelId from ChannelOpened event');
    }

    // Cache context for getChannelState + later deposits (the token address is
    // needed to approve additional collateral on a standalone deposit).
    this.channelContext.set(channelId, {
      chain,
      tokenNetworkAddress: tokenNetwork,
      ...(params.token ? { tokenAddress: params.token } : {}),
    });

    // Deposit initial funds if specified
    if (deposit > 0n) {
      const depositHash = await walletClient.writeContract({
        address: tokenNetworkAddr,
        abi: TOKEN_NETWORK_ABI,
        functionName: 'setTotalDeposit',
        args: [channelId as Hex, this.evmSigner.address as Hex, deposit],
      });
      await publicClient.waitForTransactionReceipt({ hash: depositHash });
    }

    return { channelId, status: 'opening' };
  }

  /**
   * Gets the current state of a payment channel from on-chain data.
   */
  async getChannelState(channelId: string): Promise<ChannelState> {
    const context = this.channelContext.get(channelId);
    if (!context) {
      throw new Error(
        `No context for channel "${channelId}". Channel must be opened via this client first.`
      );
    }

    // Mina channels are opened/deployed out-of-band; the connector performs the
    // authoritative on-chain `getChannelState(zkAppAddress)` check at claim
    // verification. Reading zkApp state client-side would require the o1js WASM
    // runtime, which the lightweight client intentionally avoids. Report `open`
    // for the configured deployed zkApp.
    if (context.chain.split(':')[0] === 'mina') {
      return { channelId, status: 'open', chain: context.chain };
    }

    // Solana channels read on-chain state from the PDA account, not an EVM contract.
    if (context.chain.split(':')[0] === 'solana' && this.solanaConfig) {
      const account = await getSolanaChannelAccountState(
        this.solanaConfig.rpcUrl,
        channelId
      );
      const status: ChannelState['status'] = !account.exists
        ? 'settled'
        : account.state === 'opened'
          ? 'open'
          : account.state === 'closed'
            ? 'closed'
            : 'settled';
      return { channelId, status, chain: context.chain };
    }

    const { publicClient } = this.createClients(context.chain);

    const result = await publicClient.readContract({
      address: context.tokenNetworkAddress as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'channels',
      args: [channelId as Hex],
    });

    const [, state] = result as [
      bigint,
      number,
      bigint,
      bigint,
      string,
      string,
    ];
    const status = STATE_MAP[state] ?? 'settled';

    return {
      channelId,
      status,
      chain: context.chain,
    };
  }
}

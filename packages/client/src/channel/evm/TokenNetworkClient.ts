/**
 * The EVM half of the channel lifecycle: open (or adopt), fund, close, settle,
 * read.
 *
 * Everything here is a transaction or a read the **client** makes, on its own
 * gas, directly against a `TokenNetwork`. A connector has no endpoint that opens
 * a channel (`self-description-spec.md` ND-03); it discovers the channel by
 * reading the chain
 * ([ADR 0052](https://github.com/toon-protocol/connector/blob/main/docs/adr/0052-permissionless-payment-is-guaranteed-and-a-claim-is-what-authorises.md)),
 * which is what makes paying it permissionless rather than an arrangement with
 * its operator.
 *
 * ## Adopting beats opening
 *
 * The interesting method is {@link TokenNetworkClient.openOrAdopt}, and its
 * default answer is *do nothing on chain*. Since ADR 0059 a channel's id is
 * `keccak256(p1, p2, channelEpoch[p1][p2])` over the sorted pair, so this client
 * can compute the id of the channel it would have with a given connector and ask
 * whether it is already open — with no event log and no local record. Where one
 * is open it is adopted, which is not merely an optimisation: `openChannel`
 * reverts `ChannelAlreadyExists` against a live channel, and a client that opened
 * blindly would either fail or (before ADR 0059's global counter was removed)
 * lock a second lot of collateral in a channel it then had to remember forever.
 *
 * The epoch read is allowed to fail. The deployed Base Sepolia `TokenNetwork` at
 * the time of writing still carries the pre-ADR-0059 global `channelCounter` and
 * REVERTS on `channelEpoch` (ADR 0059's own status note records the redeploy as
 * pending), so a client that treated the revert as fatal could not open a channel
 * on the live devnet at all. A revert is read as "this deployment cannot tell me",
 * and the opener falls back to the `ChannelOpened` log — the pre-0059 behaviour,
 * unchanged.
 *
 * ## The registry is the authority on the token network
 *
 * A node publishes both a `tokenNetworkRegistry` and a `tokenNetwork`, and this
 * client checks the second against the first. The registry *mints* a token
 * network (`createTokenNetwork`), so its `getTokenNetwork(token)` is the
 * definition rather than a second opinion. A disagreement is a
 * {@link ../../client/errors.js!ConfigError} raised before any collateral moves:
 * the token network is the EIP-712 `verifyingContract` every claim on the channel
 * is signed under, so signing against the wrong one produces claims that verify
 * against nothing, whose only symptom is a refused claim.
 */
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
import type { EvmSigner } from '../../signing/evm-signer.js';
import {
  ChannelFundingError,
  ChannelNotOpenError,
  ConfigError,
  StaleRpcReadError,
  isInsufficientGasError,
} from '../../client/errors.js';
import type {
  ChannelStatus,
  ChannelTerms,
  OnChainChannelStatus,
  OpenChannelResult,
} from '../types.js';
import { ERC20_ABI, TOKEN_NETWORK_ABI, TOKEN_NETWORK_REGISTRY_ABI } from './abi.js';
import { deriveEvmChannelId } from './channel-id.js';

/** Read-after-write polling knobs for the open path (#489). */
export interface EvmReadConsistencyConfig {
  /** Reads of the freshly opened channel before giving up. Default 12. */
  attempts?: number;
  /** Delay between those reads, ms. Default 1000. */
  delayMs?: number;
  /** `setTotalDeposit` retries on `InvalidChannelState()`. Default 3. */
  depositRetries?: number;
}

const DEFAULT_READ_CONSISTENCY: Required<EvmReadConsistencyConfig> = {
  attempts: 12,
  delayMs: 1000,
  depositRetries: 3,
};

/**
 * The one-hour floor `TokenNetwork.openChannel` enforces
 * (`MIN_SETTLEMENT_TIMEOUT`). A shorter request reverts
 * `InvalidSettlementTimeout`, so it is raised to the floor here rather than
 * spending gas to be told.
 */
export const MIN_SETTLEMENT_TIMEOUT_SECONDS = 3600;

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** The `TokenNetwork` channel state enum, as this client names it. */
const STATE_MAP: Record<number, ChannelStatus> = {
  0: 'missing',
  1: 'open',
  2: 'closed',
  3: 'settled',
};

export interface TokenNetworkClientConfig {
  /** The chain key exactly as the node publishes it: `evm:84532`. */
  chain: string;
  rpcUrl: string;
  signer: EvmSigner;
  readConsistency?: EvmReadConsistencyConfig;
}

/** What one channel's `channels(id)` view says. */
export interface EvmChannelRecord {
  settlementTimeout: bigint;
  state: number;
  status: ChannelStatus;
  closedAt: bigint;
  openedAt: bigint;
  participant1: string;
  participant2: string;
}

export interface OpenOrAdoptParams {
  terms: ChannelTerms;
  /** Collateral to lock, base units. `0n` opens an uncollateralised channel. */
  initialDeposit?: bigint;
  /** Challenge period in seconds. Raised to {@link MIN_SETTLEMENT_TIMEOUT_SECONDS}. */
  settlementTimeout?: number;
}

export class TokenNetworkClient {
  readonly chain: string;
  private readonly rpcUrl: string;
  private readonly signer: EvmSigner;
  private readonly readConsistency: Required<EvmReadConsistencyConfig>;
  private readonly publicClient: ReturnType<typeof createPublicClient>;
  private readonly walletClient: ReturnType<typeof createWalletClient>;

  constructor(config: TokenNetworkClientConfig) {
    this.chain = config.chain;
    this.rpcUrl = config.rpcUrl;
    this.signer = config.signer;
    this.readConsistency = { ...DEFAULT_READ_CONSISTENCY, ...config.readConsistency };

    const viemChain = defineChain({
      id: parseEvmChainId(config.chain),
      name: config.chain,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrl] } },
    });
    this.publicClient = createPublicClient({ transport: http(config.rpcUrl), chain: viemChain });
    this.walletClient = createWalletClient({
      account: config.signer.account,
      transport: http(config.rpcUrl),
      chain: viemChain,
    });
  }

  /** This client's participant address — the one a channel is opened in the name of. */
  get address(): string {
    return this.signer.address;
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * The `TokenNetwork` the registry says serves `token`, or `undefined` when it
   * says none does (the zero address).
   */
  async resolveTokenNetwork(registry: string, token: string): Promise<string | undefined> {
    const resolved = (await this.publicClient.readContract({
      address: registry as Hex,
      abi: TOKEN_NETWORK_REGISTRY_ABI,
      functionName: 'getTokenNetwork',
      args: [token as Hex],
    })) as string;
    return resolved.toLowerCase() === ZERO_ADDRESS ? undefined : resolved;
  }

  /**
   * Check the node's published `tokenNetwork` against the registry it also
   * published, and refuse the pair if they disagree.
   *
   * Skipped when the node published no registry: there is then only one
   * declaration of the fact and nothing to check it against, which is a thinner
   * guarantee but not a contradiction. A registry the RPC cannot reach is also
   * not a contradiction — an unreachable endpoint would otherwise make every
   * channel unopenable — so a failed READ is re-thrown as itself, while a
   * successful read that disagrees is a {@link ConfigError}.
   *
   * @throws {ConfigError} the registry names a different token network, or names
   *   none at all for a token the node claims to settle in.
   */
  async assertTokenNetworkMatchesRegistry(terms: ChannelTerms): Promise<void> {
    const registry = terms.tokenNetworkRegistry;
    const published = terms.tokenNetwork;
    if (!registry || !published) return;

    const resolved = await this.resolveTokenNetwork(registry, terms.token);
    if (resolved === undefined) {
      throw new ConfigError(
        `The TokenNetworkRegistry at ${registry} on ${terms.chain} has no token ` +
          `network for token ${terms.token}, but this connector publishes ` +
          `${published} as one. A claim signed under a token network the registry ` +
          'does not recognise verifies against nothing. Check the connector\'s ' +
          'settlement configuration, or that both are on the chain you think.'
      );
    }
    if (resolved.toLowerCase() !== published.toLowerCase()) {
      throw new ConfigError(
        `This connector publishes tokenNetwork ${published} for token ` +
          `${terms.token} on ${terms.chain}, but its own registry ${registry} ` +
          `resolves that token to ${resolved}. The registry mints token networks, ` +
          'so it is the authority; the published address is wrong. Refusing before ' +
          'locking collateral, because every claim on such a channel would be ' +
          'signed under the wrong EIP-712 verifyingContract and be refused.'
      );
    }
  }

  /**
   * This pair's `channelEpoch`, or `undefined` when this deployment cannot answer
   * — a pre-ADR-0059 `TokenNetwork` has no such function and the call reverts.
   *
   * `undefined` is a fact about the CONTRACT, never about the pair: epoch `0n` is
   * a real, common answer (a pair that has never settled a channel), so the two
   * must not be conflated.
   */
  async channelEpoch(
    tokenNetwork: string,
    a: string,
    b: string
  ): Promise<bigint | undefined> {
    const [p1, p2] = a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a];
    try {
      return (await this.publicClient.readContract({
        address: tokenNetwork as Hex,
        abi: TOKEN_NETWORK_ABI,
        functionName: 'channelEpoch',
        args: [p1 as Hex, p2 as Hex],
      })) as bigint;
    } catch {
      return undefined;
    }
  }

  /**
   * The id of the channel this client would have with `counterparty` right now,
   * derived off chain, or `undefined` when the deployment cannot report an epoch.
   */
  async deriveChannelId(
    tokenNetwork: string,
    counterparty: string
  ): Promise<string | undefined> {
    const epoch = await this.channelEpoch(tokenNetwork, this.address, counterparty);
    if (epoch === undefined) return undefined;
    return deriveEvmChannelId(this.address, counterparty, epoch);
  }

  /** The `channels(id)` view, destructured. */
  async readChannel(tokenNetwork: string, channelId: string): Promise<EvmChannelRecord> {
    const res = (await this.publicClient.readContract({
      address: tokenNetwork as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'channels',
      args: [channelId as Hex],
    })) as readonly [bigint, number, bigint, bigint, string, string];
    const state = Number(res[1]);
    return {
      settlementTimeout: res[0],
      state,
      status: STATE_MAP[state] ?? 'missing',
      closedAt: res[2],
      openedAt: res[3],
      participant1: res[4],
      participant2: res[5],
    };
  }

  /**
   * A participant's own `deposit` / `nonce` / `transferredAmount`, straight from
   * the `participants` mapping. `participant` defaults to this client.
   */
  async readParticipant(
    tokenNetwork: string,
    channelId: string,
    participant: string = this.address
  ): Promise<{ deposit: bigint; nonce: bigint; transferredAmount: bigint }> {
    const res = (await this.publicClient.readContract({
      address: tokenNetwork as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'participants',
      args: [channelId as Hex, participant as Hex],
    })) as readonly [bigint, bigint, bigint];
    return { deposit: res[0], nonce: res[1], transferredAmount: res[2] };
  }

  /** The lifecycle position of one channel, as the chain reports it. */
  async getChannelState(
    tokenNetwork: string,
    channelId: string
  ): Promise<OnChainChannelStatus> {
    const record = await this.readChannel(tokenNetwork, channelId);
    const participant = await this.readParticipant(tokenNetwork, channelId).catch(
      () => undefined
    );
    return {
      channelId,
      status: record.status,
      chain: this.chain,
      ...(participant ? { deposit: participant.deposit } : {}),
      ...(record.closedAt > 0n
        ? {
            closedAt: record.closedAt,
            settleableAt: record.closedAt + record.settlementTimeout,
          }
        : {}),
    };
  }

  // ─── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Return the channel this client already holds with the connector, opening one
   * only if there is none.
   *
   * @throws {ConfigError} the published token network disagrees with its registry.
   * @throws {ChannelNotOpenError} the pair's current channel is CLOSED. Nothing
   *   can be done with it and nothing can replace it: the epoch advances on
   *   `settleChannel`, so this pair's next channel does not exist until the
   *   current one is settled, and `openChannel` would revert
   *   `ChannelAlreadyExists`.
   * @throws {ChannelFundingError} the wallet has no native gas for the open.
   */
  async openOrAdopt(params: OpenOrAdoptParams): Promise<OpenChannelResult> {
    const { terms } = params;
    const tokenNetwork = terms.tokenNetwork;
    if (!tokenNetwork) {
      throw new ConfigError(
        `This connector's ${terms.chain} settlement entry publishes no ` +
          'tokenNetwork, so there is no contract to open a channel at.'
      );
    }
    await this.assertTokenNetworkMatchesRegistry(terms);

    const derived = await this.deriveChannelId(tokenNetwork, terms.counterparty);
    if (derived !== undefined) {
      const adopted = await this.adoptDerived(tokenNetwork, derived, terms);
      if (adopted) return adopted;
    }

    try {
      return await this.openChannel(params, tokenNetwork, derived);
    } catch (err) {
      if (!isInsufficientGasError(err)) throw err;
      throw new ChannelFundingError(
        `Settlement wallet ${this.address} has no gas on ${terms.chain} to open a ` +
          'payment channel. Fund the wallet (`toon faucet`, or send it native ' +
          'currency) and retry — this is the one-time on-chain open; paying for a ' +
          'request never spends gas.',
        err instanceof Error ? err : undefined
      );
    }
  }

  /**
   * Read the derived id and decide whether it is already ours to use.
   * `undefined` means "nothing there — open one".
   */
  private async adoptDerived(
    tokenNetwork: string,
    channelId: string,
    terms: ChannelTerms
  ): Promise<OpenChannelResult | undefined> {
    const record = await this.readChannel(tokenNetwork, channelId);
    if (record.status === 'missing' || record.status === 'settled') return undefined;

    if (record.status === 'closed') {
      throw new ChannelNotOpenError(
        `The channel this client holds with ${terms.counterparty} on ` +
          `${terms.chain} (${channelId}) is CLOSED: its challenge period is ` +
          'running and it can no longer carry claims. Settle it once the period ' +
          'elapses — settling advances this pair\'s channelEpoch, which is what ' +
          'makes a new channel between the same two addresses possible.'
      );
    }

    const { deposit } = await this.readParticipant(tokenNetwork, channelId);
    return { channelId, status: 'open', depositTotal: deposit };
  }

  /**
   * Open a channel and collateralise it: `openChannel`, then (when there is a
   * deposit) `approve` + `setTotalDeposit`.
   *
   * `expectedId`, when the chain could report an epoch, is asserted against the
   * id the `ChannelOpened` log carries. The two are computed by different parties
   * from the same rule, so a disagreement means this client's idea of the pair —
   * or of the contract — is wrong, and it must not go on to sign claims naming an
   * id the chain does not hold.
   */
  private async openChannel(
    params: OpenOrAdoptParams,
    tokenNetwork: string,
    expectedId: string | undefined
  ): Promise<OpenChannelResult> {
    const { terms } = params;
    const deposit = params.initialDeposit ?? 0n;
    const timeout = BigInt(
      Math.max(params.settlementTimeout ?? 86400, MIN_SETTLEMENT_TIMEOUT_SECONDS)
    );

    if (deposit > 0n && terms.token) {
      await this.ensureAllowance(terms.token, tokenNetwork, deposit);
    }

    const openHash = await this.walletClient.writeContract({
      address: tokenNetwork as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'openChannel',
      args: [terms.counterparty as Hex, timeout],
      chain: this.walletClient.chain,
      account: this.signer.account,
    });
    const receipt: TransactionReceipt = await this.publicClient.waitForTransactionReceipt({
      hash: openHash,
    });

    const channelId = readOpenedChannelId(receipt);
    if (channelId === undefined) {
      throw new ConfigError(
        `openChannel at ${tokenNetwork} on ${terms.chain} confirmed in ${openHash} ` +
          'but emitted no ChannelOpened event this client could decode. The address ' +
          'may not be a TokenNetwork.'
      );
    }
    if (expectedId !== undefined && expectedId.toLowerCase() !== channelId.toLowerCase()) {
      throw new ConfigError(
        `The channel just opened at ${tokenNetwork} is ${channelId}, but this ` +
          `client derived ${expectedId} for the same pair and epoch. A claim is ` +
          'routed by its channel id, so signing against a derived id the chain ' +
          'disagrees with would be refused on every write. Refusing rather than ' +
          'guessing which of the two is right.'
      );
    }

    if (deposit > 0n) {
      // READ-AFTER-WRITE (#489): the open receipt is confirmed, but a
      // load-balanced RPC (`sepolia.base.org`) can route this next call to a
      // replica that has not seen the open, which reverts `InvalidChannelState()`
      // and strands the just-opened channel with no collateral.
      await this.waitForChannelVisible(tokenNetwork, channelId);
      await this.setTotalDepositWithRetry(tokenNetwork, channelId, deposit);
    }

    return { channelId, status: 'opening', txHash: openHash, depositTotal: deposit };
  }

  /**
   * Add collateral. `setTotalDeposit` takes the new CUMULATIVE total rather than
   * a delta — a contract shape that makes a lost or duplicated call harmless — so
   * the caller's current total is added to.
   */
  async deposit(
    tokenNetwork: string,
    channelId: string,
    amount: bigint,
    opts: { currentDeposit: bigint; token?: string }
  ): Promise<{ txHash: string; depositTotal: bigint }> {
    if (amount <= 0n) throw new RangeError('Deposit amount must be positive.');
    const newTotal = opts.currentDeposit + amount;
    if (opts.token) await this.ensureAllowance(opts.token, tokenNetwork, amount);

    const hash = await this.walletClient.writeContract({
      address: tokenNetwork as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'setTotalDeposit',
      args: [channelId as Hex, this.address as Hex, newTotal],
      chain: this.walletClient.chain,
      account: this.signer.account,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash, depositTotal: newTotal };
  }

  /**
   * Start the challenge period. Unilateral (channel id only); afterwards the
   * `channels()` view is re-read for the AUTHORITATIVE `closedAt` +
   * `settlementTimeout` in block-timestamp seconds, because the deadline that
   * matters is the chain's and not this process's clock.
   */
  async close(
    tokenNetwork: string,
    channelId: string
  ): Promise<{
    txHash: string;
    closedAt: bigint;
    settlementTimeout: bigint;
    settleableAt: bigint;
  }> {
    const hash = await this.walletClient.writeContract({
      address: tokenNetwork as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'closeChannel',
      args: [channelId as Hex],
      chain: this.walletClient.chain,
      account: this.signer.account,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    const record = await this.readChannel(tokenNetwork, channelId);
    return {
      txHash: hash,
      closedAt: record.closedAt,
      settlementTimeout: record.settlementTimeout,
      settleableAt: record.closedAt + record.settlementTimeout,
    };
  }

  /**
   * Pay out and finish. The contract itself reverts before
   * `closedAt + settlementTimeout`, so the caller enforces the time guard first
   * rather than spending gas to be told.
   */
  async settle(tokenNetwork: string, channelId: string): Promise<{ txHash: string }> {
    const hash = await this.walletClient.writeContract({
      address: tokenNetwork as Hex,
      abi: TOKEN_NETWORK_ABI,
      functionName: 'settleChannel',
      args: [channelId as Hex],
      chain: this.walletClient.chain,
      account: this.signer.account,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { txHash: hash };
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** Approve `spender` for at least `amount`, if the standing allowance is short. */
  private async ensureAllowance(
    token: string,
    spender: string,
    amount: bigint
  ): Promise<void> {
    const allowance = (await this.publicClient.readContract({
      address: token as Hex,
      abi: ERC20_ABI,
      functionName: 'allowance',
      args: [this.address as Hex, spender as Hex],
    })) as bigint;
    if (allowance >= amount) return;
    const hash = await this.walletClient.writeContract({
      address: token as Hex,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [spender as Hex, maxUint256],
      chain: this.walletClient.chain,
      account: this.signer.account,
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  /**
   * Poll until the RPC reports the just-opened channel (non-zero `participant1`).
   * Tolerates a read that throws or returns nothing — a stale replica does both.
   */
  private async waitForChannelVisible(
    tokenNetwork: string,
    channelId: string
  ): Promise<void> {
    const { attempts, delayMs } = this.readConsistency;
    let lastError: Error | undefined;
    for (let i = 0; i < attempts; i++) {
      if (i > 0) await sleep(delayMs);
      try {
        const record = await this.readChannel(tokenNetwork, channelId);
        if (record.participant1.toLowerCase() !== ZERO_ADDRESS) return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }
    throw new StaleRpcReadError(
      `Channel ${channelId} was opened on ${this.chain} but ${this.rpcUrl} still ` +
        `does not report it after ${attempts} reads. This is the stale-read ` +
        'failure of a load-balanced endpoint (e.g. `https://sepolia.base.org`) — ' +
        'point `rpcUrl` at a read-after-write consistent RPC such as ' +
        '`https://base-sepolia-rpc.publicnode.com` and retry. The channel IS open ' +
        'on chain; it just has no collateral yet.',
      lastError
    );
  }

  /**
   * `setTotalDeposit`, retried on `InvalidChannelState()` — the revert a stale
   * replica produces for a channel it has not observed. Every other revert
   * propagates immediately (an under-funded wallet must not be retried).
   */
  private async setTotalDepositWithRetry(
    tokenNetwork: string,
    channelId: string,
    total: bigint
  ): Promise<void> {
    const { depositRetries, delayMs } = this.readConsistency;
    for (let attempt = 0; ; attempt++) {
      try {
        const hash = await this.walletClient.writeContract({
          address: tokenNetwork as Hex,
          abi: TOKEN_NETWORK_ABI,
          functionName: 'setTotalDeposit',
          args: [channelId as Hex, this.address as Hex, total],
          chain: this.walletClient.chain,
          account: this.signer.account,
        });
        await this.publicClient.waitForTransactionReceipt({ hash });
        return;
      } catch (err) {
        if (attempt >= depositRetries || !isInvalidChannelStateRevert(err)) throw err;
        await sleep(delayMs);
        await this.waitForChannelVisible(tokenNetwork, channelId);
      }
    }
  }
}

/**
 * The numeric chain id inside a chain key.
 *
 * Accepts both the canonical `evm:{chainId}` a self-description carries and the
 * three-part `evm:{network}:{chainId}` some deployments still spell.
 */
export function parseEvmChainId(chain: string): number {
  const parts = chain.split(':');
  const raw = parts.length >= 3 ? parts[2] : parts[1];
  const chainId = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(chainId)) {
    throw new ConfigError(
      `"${chain}" is not an EVM chain key. Expected "evm:{chainId}" (e.g. "evm:84532").`
    );
  }
  return chainId;
}

/** The `channelId` a receipt's `ChannelOpened` log carries, if it has one. */
function readOpenedChannelId(receipt: TransactionReceipt): string | undefined {
  for (const log of receipt.logs) {
    try {
      const decoded = decodeEventLog({
        abi: TOKEN_NETWORK_ABI,
        data: log.data,
        topics: log.topics,
      });
      if (decoded.eventName === 'ChannelOpened') {
        return (decoded.args as Record<string, unknown>)['channelId'] as string;
      }
    } catch {
      // Not our event.
    }
  }
  return undefined;
}

/**
 * `InvalidChannelState()` — the `TokenNetwork` revert a stale replica produces
 * when `setTotalDeposit` runs against a channel it has not observed yet. viem
 * surfaces the raw selector and/or the decoded name depending on whether the ABI
 * carried the error, so both markers are matched.
 */
function isInvalidChannelStateRevert(err: unknown): boolean {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 10 && cur != null; i++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? (cur as { cause?: unknown }).cause : undefined;
  }
  const text = parts.join(' | ').toLowerCase();
  return text.includes('0xf806e9d9') || text.includes('invalidchannelstate');
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

/**
 * The public shape of `@toon-protocol/client`: what you configure, what you
 * send, and what comes back.
 *
 * One idea underlies all of it. A **connector** is a paid reverse proxy: it
 * fronts an ordinary HTTP app, charges a flat price per route, and hands the app
 * a request that was already paid for. So the client's central operation is not
 * "publish" or "post" — it is {@link ToonClientLike.send}, which puts one HTTP
 * request through a connector and gives you back the app's HTTP response, having
 * paid for it with a signed payment-channel claim that travels *with* the packet
 * (connector ADR 0042).
 */
import type { ChainKind, ChannelStatus, ChannelTerms } from '../channel/types.js';
import type { KeyDerivationScheme } from '../keys/KeyDerivation.js';
import type { ClaimAck } from '../ilp/types.js';
import type { ChannelStore } from '../channel/ChannelStore.js';
import type { NodeSelfDescription, RequiredTransport } from '../connector/self-description.js';
import type {
  ClaimStateResult,
  ConnectorRoutePrice,
} from '../connector/ConnectorEdgeClient.js';
import type { WalletChainBalances } from '../wallet/balances.js';
import type { SendTransferParams, SendTransferResult } from '../wallet/transfer.js';
import type { FundWalletResult } from '../wallet/faucet.js';

export type { ChainKind, ChannelTerms, ChannelStatus };

// ─── Configuration ──────────────────────────────────────────────────────────

/** Which carriage to pay over. */
export type TransportPreference = 'auto' | 'http' | 'btp';

/**
 * How a mnemonic becomes keys.
 *
 * `standard` is BIP-44 as every wallet implements it — EVM at `m/44'/60'/0'/0/i`,
 * so the channel wallet can be imported into MetaMask or a hardware wallet to be
 * inspected or topped up. `legacy` is what this client derived before 1.0: the
 * EVM key sat on Nostr's coin type, `m/44'/1237'/0'/0/i`, because one key served
 * both roles. Existing keystores keep working — a keystore written before 1.0
 * records no derivation and is read as `legacy`, so its addresses, and the
 * channels funded at them, do not move.
 *
 * Re-exported from the module that *implements* the two paths rather than
 * redeclared here: two structurally identical declarations of one union are two
 * things to keep in step, and `src/index.ts` re-exports both barrels, so a second
 * declaration is also an ambiguous export.
 */
export type { KeyDerivationScheme };

export interface ToonClientConfig {
  /**
   * The connector's client-edge base URL. A trailing `/ilp` is normalized away,
   * so both `https://node.example` and `https://node.example/ilp` work.
   *
   * This is the whole of bootstrapping. There is no discovery, no relay and no
   * peer list: one free `GET` on this URL returns every fact needed to transact
   * with the node (`GET /ilp`, connector ADR 0050).
   */
  connector: string;

  /** BIP-39 phrase. Derives both an EVM and a Solana key. */
  mnemonic?: string;
  /** A raw EVM key, when you are not deriving from a mnemonic. */
  evmPrivateKey?: string | Uint8Array;
  /** A raw Solana key: 32-byte seed or 64-byte secret key, bytes or base58. */
  solanaSecretKey?: Uint8Array | string;
  /** BIP-44 account index. Default `0`. */
  accountIndex?: number;
  /** Which derivation a mnemonic uses. Default `'standard'`. */
  keyDerivation?: KeyDerivationScheme;

  /**
   * Which settlement chain to pay on.
   *
   * Default: the first chain in the connector's own `settlements[]` for which
   * this client holds a key. Set it explicitly when a node settles on several
   * and you care which one your money moves on.
   */
  chain?: ChainKind;
  /** Chain RPC URL. Defaults to this package's devnet preset for the selected chain. */
  rpcUrl?: string;

  /**
   * Which carriage to pay over. `'auto'` (default) honours the node's own
   * `requiredTransport` and otherwise prefers HTTP, which is the one-shot,
   * stateless path. Choose `'btp'` when streaming many paid requests: one
   * ordered socket cannot race its own claim nonces, which parallel HTTP
   * requests can.
   */
  transport?: TransportPreference;

  /**
   * Where the channel's nonce watermark is persisted — a path, or your own
   * store. **Default is in-memory, which is almost never what you want**: a
   * process that forgets its watermark re-signs claims at nonces the connector
   * has already banked, and every one of them is refused.
   */
  channelStore?: string | ChannelStore;

  /**
   * The `senderId` written into every claim. Defaults to your address on the
   * selected chain. It is a label the connector echoes, never an authority —
   * a claim is authorised by its signature against the channel's on-chain
   * counterparty and by nothing else (connector ADR 0052).
   */
  senderId?: string;

  /** Collateral for the first channel this client opens, in base units. Default `100000n`. */
  deposit?: bigint | string;
  /** Challenge period in seconds. Default `86400`; floored at `3600` on EVM. */
  settlementTimeout?: number;
  /** Open a channel on the first {@link ToonClientLike.send} when none exists. Default `true`. */
  autoOpenChannel?: boolean;

  /** Per-packet timeout in milliseconds. Default `30000`. */
  timeoutMs?: number;

  /** BTP carriage tuning. */
  btp?: {
    maxReconnectAttempts?: number;
    reconnectDelay?: number;
    /**
     * Declare channel control at auth, binding this session to a channel before
     * it has ever presented a claim. EVM only. Default `true`.
     */
    declareChannel?: boolean;
  };

  /** Faucet base URL for {@link WalletFacade.faucet}. Devnet only. */
  faucetUrl?: string;

  /** Injected `fetch`, for tests and non-standard runtimes. */
  fetch?: typeof fetch;
  /** Injected websocket factory, for tests and runtimes without a global `WebSocket`. */
  createWebSocket?: (url: string) => unknown;
}

// ─── Sending ────────────────────────────────────────────────────────────────

/**
 * The HTTP request to make of the app behind a route.
 *
 * `target` is resolved strictly *beneath* the route's configured handler path
 * and can never replace it (connector ADR 0025): `''` and `'/'` both address the
 * handler itself, and an absolute path, a `..` segment, a scheme or an authority
 * is refused with `F00` before the app is touched.
 */
export interface SendRequest {
  /** Default `'POST'`. */
  method?: string;
  /** Path beneath the handler. Default `''`. */
  target?: string;
  headers?: Record<string, string> | [string, string][];
  /** A string and a plain object are encoded UTF-8; an object also sets `content-type: application/json`. */
  body?: string | Uint8Array | object;
}

export interface SendOptions {
  /**
   * Override the amount to send. Defaults to the route's price. On a *forwarded*
   * route an amount above the price is refused `F03` before the claim is even
   * read, so raising this does not buy priority.
   */
  amount?: bigint;
  /**
   * Seal to a different connector's identity: its `GET /ilp` URL, or the raw
   * key. Needed only when paying a route the addressed node **forwards**, since
   * a payload must be sealed to the connector that *terminates* it and no hop
   * may name that key on its behalf (`self-description-spec.md` ND-13/ND-14).
   */
  sealTo?: Uint8Array | string;
  timeoutMs?: number;
}

/** What one claim spent. */
export interface ClaimSummary {
  channelId: string;
  chain: ChainKind;
  /** The nonce this claim carried. Strictly increasing per channel. */
  nonce: number;
  /** The channel's cumulative transferred amount after this claim. */
  cumulative: bigint;
  /** What this packet cost — the difference this claim advanced by. */
  amount: bigint;
}

/**
 * The app answered, and you paid for it.
 *
 * `status` is the **app's** HTTP status. A `404` from the app is a real answer:
 * it rides home on a FULFILL and costs exactly what a `200` costs. Only a
 * refusal short of the app produces {@link SendRefused}.
 */
export interface SendFulfilled {
  fulfilled: true;
  transport: 'http' | 'btp';
  status: number;
  /** Response headers, in order, duplicates preserved — the wire is a sequence, not a map. */
  headers: [string, string][];
  body: Uint8Array;
  /** The body decoded as UTF-8. */
  text(): string;
  /** The body parsed as JSON. Throws if it is not JSON. */
  json<T = unknown>(): T;
  /** The 32-byte fulfilment, proof this packet reached its intended receiver. */
  fulfillment: Uint8Array;
  /**
   * What this request paid, and on which channel.
   *
   * **Absent for a route priced at zero**, which is deliberately free and takes
   * no claim at all — there is no channel, no nonce and no amount to report, and
   * reporting a zero-valued one would be a fiction. Present on every paid send.
   */
  claim?: ClaimSummary;
  /**
   * The connector's separate verdict on the claim, when it gave one.
   *
   * Present on a FULFILL because the two verdicts are **independent**: a
   * connector can deliver the work and still refuse the claim that was supposed
   * to pay for it, which is the single most load-bearing case in the connector's
   * own vector set. Never infer either from the other — a `fulfilled: true`
   * carrying `{ result: 'rejected' }` means the app answered and nothing was
   * banked, and this client repays its own watermark accordingly.
   */
  claimAck?: ClaimAck;
}

/**
 * The packet was refused. **Never thrown** — a refusal is an outcome, not an
 * error, and the difference matters: everything this client throws happened
 * before the packet went out or on chain.
 */
export interface SendRefused {
  fulfilled: false;
  transport: 'http' | 'btp';
  /**
   * Who refused.
   *
   * `'destination'` when the reject came back sealed — only the terminating
   * connector holds the secret to seal one, so a sealed reject is proof the
   * destination itself said no. `'path'` when it arrived in plaintext, which
   * identifies nobody: a hop short of the termination refused, or the
   * termination could not open the wrap. `'edge'` for a refusal the connector
   * we are attached to made before routing at all (a greeting, a wrong
   * carriage).
   */
  refusedBy: 'destination' | 'path' | 'edge';
  /** An ILP reject code (`F03`, `F01`, `T05`, …), or `'PAYMENT_REQUIRED'` / `'TRANSPORT_REQUIRED'`. */
  code: string;
  /** Diagnostic text. Never branch on it — branch on {@link code}. */
  message: string;
  /**
   * What the path cost, when the connector reported it. On an **underpayment**
   * this is the route's price — the cheapest way to learn a price, since the
   * refusal's whole subject is the figure you did not cover.
   */
  accumulatedCost?: bigint;
  /** The connector's separate verdict on the claim, when it gave one. */
  claimAck?: ClaimAck;
  /** The route's terms, when the refusal was a greeting (`402`, or `F06`/`F02` on BTP). */
  terms?: PaymentTerms;
  /** A sealed reject's own payload, when the destination sent one. */
  detail?: Uint8Array;
  /** The claim that was spent, when one was. Absent when nothing was signed. */
  claim?: ClaimSummary;
}

export type SendResult = SendFulfilled | SendRefused;

/**
 * A route's terms, as stated by the greeting the connector answers an unpaid
 * request with. A projection of the node's self-description — the two cannot
 * disagree (`self-description-spec.md` ND-11) — plus what this particular route
 * costs right now.
 */
export interface PaymentTerms {
  destination: string;
  price: bigint;
  httpEndpoint?: string;
  btpEndpoint?: string;
  /** Set only when the route refuses the carriage the request arrived on. */
  requiredTransport?: RequiredTransport;
  settlements: NodeSelfDescription['settlements'];
  /** The connector's session lease TTL, published so a consumer need not guess it. */
  sessionLeaseTtlMs?: number;
  raw: unknown;
}

// ─── Channels ───────────────────────────────────────────────────────────────

/**
 * A channel, as this client and the chain jointly see it.
 *
 * `spent`/`nonce` are the **local watermark** — what this client has signed. The
 * connector keeps its own watermark and is the one that decides; they agree
 * unless a claim was signed and never accepted. {@link ToonClientLike.claimState}
 * asks the connector for its side.
 */
export interface ChannelState {
  chain: ChainKind;
  /** `0x…` 32 bytes on EVM; the channel account's base58 pubkey on Solana. */
  channelId: string;
  /** The connector's settlement address — the other participant. */
  counterparty: string;
  status: ChannelStatus;
  /** On-chain collateral, base units. */
  depositTotal: bigint;
  /** Cumulative amount claimed against it so far. */
  spent: bigint;
  /** The last nonce signed. */
  nonce: number;
  /** `depositTotal - spent`: what is still spendable. */
  available: bigint;
  onChain?: {
    deposit?: bigint;
    closedAt?: bigint;
    settleableAt?: bigint;
  };
  /** The domain a claim on this channel is signed under. */
  domain: ChannelTerms;
}

export interface OpenChannelOptions {
  deposit?: bigint | string;
  settlementTimeout?: number;
}

export interface TxRef {
  txHash?: string;
}

/** On-chain channel operations. Every one of these is your transaction, on your gas. */
export interface ChannelFacade {
  /** The current channel's id, or `undefined` before one is opened. */
  readonly id: string | undefined;
  /** Open a channel, or adopt the one already open with this connector. */
  open(options?: OpenChannelOptions): Promise<ChannelState>;
  /** Add collateral. Monotonic on both chains — a deposit can never decrease. */
  deposit(amount: bigint | string): Promise<ChannelState>;
  /** Start the challenge period. */
  close(): Promise<TxRef & { closedAt?: bigint; settleableAt?: bigint }>;
  /** Pay out and finish, once the challenge period has elapsed. */
  settle(): Promise<TxRef>;
  state(options?: { onChain?: boolean }): Promise<ChannelState>;
  /** Ensure a usable channel exists, opening one if configured to. Returns its id. */
  ensure(description?: NodeSelfDescription): Promise<string>;
}

/** Chain reads and transfers that have nothing to do with paying a connector. */
export interface WalletFacade {
  balances(chain?: ChainKind): Promise<WalletChainBalances[]>;
  transfer(params: SendTransferParams): Promise<SendTransferResult>;
  /** Devnet only. */
  faucet(chain?: ChainKind): Promise<FundWalletResult>;
}

/** The addresses this client holds. */
export interface ToonIdentity {
  evmAddress?: string;
  solanaPublicKey?: string;
  /** What claims are labelled with. */
  senderId: string;
}

export type { ClaimStateResult, ConnectorRoutePrice };

/**
 * The public surface of {@link ToonClient}, as an interface.
 *
 * Exists so a consumer — the CLI, a test — can be written against the client
 * without constructing one.
 */
export interface ToonClientLike {
  readonly connector: string;
  readonly chain: ChainKind;
  readonly identity: ToonIdentity;
  readonly channel: ChannelFacade;
  readonly wallet: WalletFacade;
  /** `GET /ilp`. Cached per instance; `fresh` re-reads. */
  describe(options?: { fresh?: boolean }): Promise<NodeSelfDescription>;
  /**
   * `GET /ilp/routes/price`, base price only. `null` means no route this node
   * serves matches. A metered route costs more — see
   * {@link ToonClientLike.routePrice}.
   */
  price(destination: string): Promise<bigint | null>;
  /** The same route's full terms, including a `pricePerKib` when it meters by size. */
  routePrice(destination: string): Promise<ConnectorRoutePrice | null>;
  /** `POST /ilp/probe`: learn a path's cost without buying the work. Needs an open channel. */
  probe(destination: string): Promise<{ accumulatedCost: bigint; code: string; message: string }>;
  /**
   * Pay for one HTTP request. The destination is optional — omitted, it goes to
   * {@link ToonClientLike.defaultDestination}.
   */
  send(request?: SendRequest, options?: SendOptions): Promise<SendResult>;
  send(destination: string, request?: SendRequest, options?: SendOptions): Promise<SendResult>;
  /** The address this node published for itself, and where an unrouted `send` goes. */
  readonly defaultDestination: string | undefined;
  /** `POST /ilp/claim-state`: the connector's own watermark for channels you control. */
  claimState(channelIds?: string[]): Promise<ClaimStateResult[]>;
  /** Release the BTP session and flush the channel store. Does not touch the channel. */
  close(): Promise<void>;
}

// ─── Balance proofs (the claim's signed core) ───────────────────────────────

/**
 * The fields a balance proof commits to.
 *
 * `lockedAmount` and `locksRoot` are always zero and always present: value moves
 * on the claim itself, so nothing is ever locked — but both are still hashed
 * into the EIP-712 struct, and omitting them computes a digest no connector
 * will accept.
 */
export interface BalanceProofParams {
  channelId: string;
  /** Strictly increasing. A claim whose nonce does not advance the payee's watermark is refused. */
  nonce: number;
  /** Cumulative, not per-packet: each claim supersedes the last. */
  transferredAmount: bigint;
  lockedAmount: bigint;
  locksRoot: string;
}

/** A balance proof plus the signature over it and the domain it was signed under. */
export interface SignedBalanceProof extends BalanceProofParams {
  /** EVM: 65-byte `r‖s‖v` hex. Solana: base64 of the 64-byte Ed25519 signature. */
  signature: string;
  /** EVM address, or Solana pubkey, of whoever signed. Carried on the wire; carries no authority. */
  signerAddress: string;
  /** EIP-712 domain `chainId`. Unused on Solana. */
  chainId: number;
  /**
   * EVM: the `TokenNetwork`, the EIP-712 `verifyingContract`.
   * Solana: the settlement **program id**, which ADR 0053 binds into the signed
   * message itself, so a claim can no longer be replayed against another
   * deployment of the same program.
   */
  tokenNetworkAddress: string;
  /** ERC-20 address or SPL mint, for a self-describing claim. */
  tokenAddress?: string;
  /**
   * The counterparty this proof is bound to.
   *
   * Neither chain's signed message folds it in — which side gets paid is fixed
   * by the channel's participants, not by the proof — so this is carried only so
   * it flows from signing through to the claim message.
   */
  recipient?: string;
  /** Solana only: the cluster the claim declares, cross-checked by the connector. */
  cluster?: string;
}

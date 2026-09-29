/**
 * The public shape of `@toon-protocol/client`: what you configure, what you
 * send, and what comes back.
 *
 * One idea underlies all of it. A **connector** is a paid reverse proxy: it
 * fronts an ordinary HTTP app, charges a flat price per route, and hands the app
 * a request that was already paid for. So the client's central operation is not
 * "publish" or "post" — it is {@link ToonClientLike.send}, which puts one HTTP
 * request through a connector and gives you back the app's HTTP response, having
 * paid for it with a voucher — a signed, cumulative claim on an x402
 * `batch-settlement` channel — that travels *with* the packet (connector ADRs
 * 0042, 0075).
 */
import type { BatchSettlementOffer } from '../channel/batch-settlement/offers.js';
import type {
  BatchChannelSummary,
  BatchExitResult,
  ChannelFacade,
} from './channel-facade.js';
import type { ChainKind } from '../channel/types.js';
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

export type { ChainKind, ChannelFacade, BatchExitResult };
/** One x402 channel this client pays a connector from, as it records it. */
export type ChannelState = BatchChannelSummary;

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
   * The `senderId` written into every voucher. Defaults to the voucher signer's
   * address. It is a label the connector echoes, never an authority — a voucher
   * is authorised by its signature against the channel's on-chain voucher
   * signer and by nothing else (connector ADR 0052).
   */
  senderId?: string;

  /**
   * What a channel is opened with, and topped up by, in base units. Default
   * `100000n`. A Solana channel is opened with at least the node's published
   * `minDeposit`.
   */
  deposit?: bigint | string;
  /**
   * Open, top up or replace a channel on the first {@link ToonClientLike.send}
   * that needs one. Default `true`. With `false`, that is `client.channel`'s
   * job, and a send that needs it throws {@link ChannelNotOpenError}.
   */
  autoOpenChannel?: boolean;

  /**
   * The x402 facilitator that submits a Base deposit and pays its gas, so a
   * wallet holding USDC and no ETH can open a channel. Defaults to the devnet's
   * own (`https://onboard.devnet.toonprotocol.dev`) on Base Sepolia; required on
   * any other EVM network. Solana needs none: the connector sponsors the open.
   */
  facilitatorUrl?: string;
  /**
   * How a Base deposit is authorized: `eip3009` (the default) for a token with
   * ERC-3009, gasless outright; `permit2` for one without, which needs the
   * payer's one-time Permit2 approval — a transaction of its own — first.
   */
  depositMethod?: 'eip3009' | 'permit2';
  /**
   * Who pays a Base deposit's gas, and a Permit2 token's one-time approval's.
   * `auto` (the default): the facilitator when there is one and it will,
   * otherwise this wallet when it holds ETH. `facilitator`: never this
   * wallet's ETH. `self`: always this wallet's, and no facilitator at all.
   */
  depositGas?: 'auto' | 'facilitator' | 'self';

  /** Per-packet timeout in milliseconds. Default `30000`. */
  timeoutMs?: number;

  /** BTP carriage tuning. */
  btp?: {
    maxReconnectAttempts?: number;
    reconnectDelay?: number;
    /**
     * Declare the channel at BTP auth with a voucher claim-state challenge
     * (`channelChallenge`), binding the session to it before it has presented
     * a voucher. Default `true`.
     */
    declareChannel?: boolean;
  };

  /** Faucet base URL for {@link WalletFacade.faucet}. Devnet only. */
  faucetUrl?: string;

  /**
   * The `socks5h://` proxy every byte this client sends goes through: a running
   * Anyone Protocol `anon` daemon's SOCKS port, e.g. `socks5h://127.0.0.1:9050`.
   *
   * Required when `connector` is a `.anyone` address. Beside a clearnet
   * connector it makes this client a hidden payer (TOON_Network#167): the
   * client edge, the BTP socket and each chain's RPC, on a pinned circuit per
   * chain, all ride it. Nothing falls back to a direct dial. `socks5://` is
   * refused either way. This library never starts a daemon itself; the `toon`
   * CLI will start one for you (ADR 0001).
   *
   * Node only: a browser cannot dial a hidden service by any route.
   */
  socksProxy?: string;
  /**
   * Send chain RPC through `socksProxy` as well as the packets. Default `true`.
   *
   * Set `false` only when the RPC endpoint is already private — your own node on
   * loopback or a private address, which no exit could reach anyway. Leaving it
   * on for a public provider is the point: see ADR 0002.
   */
  proxyRpc?: boolean;

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
  /**
   * The caller's last look before money moves. Return a string to refuse this
   * send — the string is the reason, and it arrives as a
   * {@link ../client/errors.js!BeforePayRefusedError}; return nothing to let it
   * proceed.
   *
   * It exists because **a paid route bills for an answer, and a refusal is an
   * answer.** A connector collects a route's price before the app behind it has
   * seen the request at all, so an app that rejects a body as malformed still
   * charges for having rejected it, and nothing is refunded (TOON_Network#115).
   * A caller that already knows a body is wrong wants to stop short of the
   * claim, not read about it on the bill.
   *
   * This client knows nothing about any particular app's bodies and should not:
   * what it can offer is the one check a caller cannot write for itself, at the
   * one moment that is too late to reach from outside `send`. Checking before
   * calling `send` is not the same thing, in two ways:
   *
   * - **The price is resolved here and nowhere earlier.** What a route costs is
   *   the connector's to state, and a metered route's price depends on the size
   *   of the *sealed* payload, which does not exist until this client has
   *   sealed it. A caller vetting the cost beforehand is guessing at the figure
   *   it is about to authorise; the hook is handed the real one.
   * - **The refusal provably precedes the signature.** A signed voucher is a
   *   bearer instrument: the channel's watermark is advanced and persisted
   *   *before* the packet leaves, and a voucher that went out cannot be taken
   *   back. When this runs, nothing has been signed, no channel has been opened
   *   and no packet has left.
   *
   * Called exactly once per `send`: it is a decision about a request, not about
   * an attempt. Throwing from it also
   * refuses the send, and the throw propagates unchanged — a caller's own check
   * failing is the caller's error to read, not one for this client to re-dress.
   *
   * Runs on a free route too. Free is not the only cost a wrong body carries:
   * it still spends the round trip, the app's work, and the answer.
   */
  beforePay?: (about: {
    /** The route the packet is addressed to. */
    destination: string;
    /** What it will cost: the route's resolved price, or an explicit {@link amount}. */
    amount: bigint;
    /**
     * The request as it was handed to `send`. Already sealed by the time this
     * runs, so mutating it changes nothing that travels — read it, don't edit it.
     */
    request: SendRequest;
    // `string | void` rather than `string | undefined` deliberately: only `void`
    // lets a callback whose body ends without a `return` be written as-is, which
    // is what "say nothing to let it through" has to mean if the safe answer is
    // to be the easy one to write.
    // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- see above
  }) => string | void;
}

/** What one voucher spent. */
export interface ClaimSummary {
  /** The x402 channel it was drawn on: `0x…` on EVM, the channel account on Solana. */
  channelId: string;
  chain: ChainKind;
  /** The channel's cumulative amount after this voucher. */
  cumulative: bigint;
  /** What this packet cost — the difference this voucher advanced by. */
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
  /** Per chain, the x402 `batch-settlement` offer a channel is opened on, priced for this request. */
  batchSettlements: BatchSettlementOffer[];
  /** The connector's session lease TTL, published so a consumer need not guess it. */
  sessionLeaseTtlMs?: number;
  raw: unknown;
}

// ─── Wallet ─────────────────────────────────────────────────────────────────

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
  /** What vouchers are labelled with. */
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
  /**
   * `POST /ilp/probe`: learn a path's cost without buying the work. Identifies
   * with the latest voucher, resent byte for byte, so it needs a channel this
   * client has already paid on.
   */
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

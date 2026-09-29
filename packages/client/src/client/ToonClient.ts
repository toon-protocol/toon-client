/**
 * The client: one object that knows a connector, holds the keys, and pays.
 *
 * Deliberately thin. It wires — {@link ./send.js!send} performs a request,
 * {@link ./channel-facade.js!ClientChannelFacade} owns the channels and
 * {@link ./wallet-facade.js!ClientWalletFacade} owns the wallet — and what it
 * contributes is the small set of decisions that must be made once and shared:
 * which chain, which carriage, which key labels a claim, and where the cached
 * self-description lives.
 *
 * ## What `create` does, and what it refuses to do
 *
 * It resolves the configuration, derives the keys, opens the channel store, and
 * makes exactly **one** free network call: `GET /ilp`, the node's
 * self-description. That call is the whole of bootstrapping — there is no
 * discovery, no relay and no peer list (connector ADR 0050) — and it is what
 * settles the chain to pay on, since the node's own `batchSettlements[]` is the
 * authority (`self-description-spec.md` ND-07) and a preset is not.
 *
 * It does **not** touch a chain. No RPC connection is opened, no channel is read
 * and certainly none is opened: a deposit locks the user's money, and a
 * constructor is not where that belongs. The first chain access happens when
 * something explicitly asks for it — `channel.open()`, or a `send()` on a client
 * left with the default `autoOpenChannel: true`.
 */
import { ConnectorEdgeClient, decodeConnectorPublicKey } from '../connector/ConnectorEdgeClient.js';
import type {
  ClaimStateOk,
  ClaimStateResult,
  ConnectorRoutePrice,
} from '../connector/ConnectorEdgeClient.js';
import {
  defaultDestinationFor,
  requiredTransportFor,
  type NodeSelfDescription,
} from '../connector/self-description.js';
import { selectTransport } from '../btp/transport-select.js';
import { isHiddenServiceUrl } from '../transport/hs-hostname.js';
import { HttpIlpClient } from '../http/HttpIlpClient.js';
import { BtpRuntimeClient, type BtpChannelDeclaration } from '../btp/BtpRuntimeClient.js';
import { BtpPaidWriteTransport } from '../btp/BtpPaidWriteTransport.js';

import { sealExchange } from '../wire/sealed-exchange.js';
import { toBase64 } from '../utils/binary.js';
import { resolveConfig, addressFor, type ResolvedConfig } from './config.js';
import { ClientChannelFacade } from './channel-facade.js';
import { ClientWalletFacade } from './wallet-facade.js';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, toHex } from 'viem';
import { rpcTransport } from '../transport/rpc.js';
import type { ContractReader } from '../channel/batch-settlement/evm.js';
import { evmWalletAccess } from '../channel/batch-settlement/deposit-gas.js';
import { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { base58Decode } from '../utils/base58.js';
import { BatchChannelManager } from '../channel/batch-settlement/manager.js';
import { send, type PaidWriteTransport, type SendContext } from './send.js';
import {
  ChainUnavailableError,
  ChannelNotOpenError,
  ConfigError,
  chainUnavailableMessage,
} from './errors.js';
import type {
  ChainKind,
  ChannelFacade,
  SendOptions,
  SendRequest,
  SendResult,
  ToonClientConfig,
  ToonClientLike,
  ToonIdentity,
  WalletFacade,
} from './types.js';

/**
 * How long a voucher claim-state challenge stays valid, in seconds: well inside
 * the 300 s a connector allows a BTP `channelChallenge`.
 */
const CHALLENGE_TTL_SECONDS = 120;

export class ToonClient implements ToonClientLike {
  readonly connector: string;
  readonly chain: ChainKind;
  readonly identity: ToonIdentity;
  readonly channel: ChannelFacade;
  readonly wallet: WalletFacade;

  private readonly config: ResolvedConfig;
  private readonly edge: ConnectorEdgeClient;
  private readonly manager: BatchChannelManager;
  /** Where every paid packet's voucher comes from. */
  private readonly payer: BatchSettlementPayer;
  private description: NodeSelfDescription;
  /**
   * One live carriage per kind, not one per client.
   *
   * A node pins carriages **per route** (connector ADR 0072), so one client can
   * legitimately owe one destination a BTP session and another an HTTP one-shot.
   * Keying by kind keeps each carriage chosen once and reused — which is the
   * point of caching at all — without letting the first destination decide for
   * every later one.
   */
  private carriages: Partial<
    Record<'http' | 'btp', { kind: 'http' | 'btp'; transport: PaidWriteTransport }>
  > = {};
  private btpSession: BtpRuntimeClient | undefined;
  private readonly hiddenService: { close(): Promise<void> } | undefined;
  private closed = false;

  private constructor(init: {
    config: ResolvedConfig;
    edge: ConnectorEdgeClient;
    description: NodeSelfDescription;
    chain: ChainKind;
    senderId: string;
    /** The proxy-bound transport, when this client talks to a hidden service. */
    hiddenService?: { close(): Promise<void> };
  }) {
    this.config = init.config;
    this.hiddenService = init.hiddenService;
    this.edge = init.edge;
    this.description = init.description;
    this.chain = init.chain;
    this.connector = init.config.connector;
    this.identity = {
      ...(init.config.identity.evm ? { evmAddress: init.config.identity.evm.address } : {}),
      ...(init.config.identity.solana
        ? { solanaPublicKey: init.config.identity.solana.publicKey }
        : {}),
      senderId: init.senderId,
    };

    this.manager = new BatchChannelManager(init.config.channelStore);
    const chains = chainAccess(init.config);
    this.payer = new BatchSettlementPayer({
      connector: init.config.connector,
      manager: this.manager,
      deposit: init.config.deposit,
      ...(chains.evm !== undefined
        ? {
            evm: {
              account: chains.evm.account,
              ...(init.config.facilitatorUrl !== undefined
                ? { facilitatorUrl: init.config.facilitatorUrl }
                : {}),
              ...(init.config.depositMethod !== undefined
                ? { depositMethod: init.config.depositMethod }
                : {}),
              depositGas: init.config.depositGas,
              reader: lazyEvmReader(init.config),
              wallet: evmWalletAccess({
                rpcUrl: init.config.rpcUrls.evm,
                account: chains.evm.account,
                dispatcher: init.config.chainRpc?.evm.dispatcher,
              }),
            },
          }
        : {}),
      ...(chains.solana !== undefined ? { solana: chains.solana } : {}),
      fetch: init.config.fetch,
      autoOpen: init.config.autoOpenChannel,
      connectorWatermark: (entry) => this.connectorWatermark(entry),
    });
    this.channel = new ClientChannelFacade({
      connector: init.config.connector,
      payer: this.payer,
      chain: init.chain,
      manager: this.manager,
      describe: () => this.describe(),
      ...(chains.evm !== undefined
        ? {
            evm: {
              privateKey: chains.evm.privateKey,
              rpcUrl: init.config.rpcUrls.evm,
              rpcDispatcher: init.config.chainRpc?.evm.dispatcher,
            },
          }
        : {}),
      ...(chains.solana !== undefined ? { solana: chains.solana } : {}),
    });
    this.wallet = new ClientWalletFacade({
      config: init.config,
      describe: () => this.describe(),
    });
  }

  /**
   * Build a client: resolve the configuration, derive the keys, read the node's
   * self-description, and settle which chain to pay on.
   *
   * @throws {ConfigError} the configuration cannot produce a working client.
   * @throws {ChainUnavailableError} the node settles on no chain this client
   *   holds a key for — checked here rather than at the first `send`, because it
   *   is a permanent fact about this pairing and finding it out mid-request is
   *   strictly worse.
   * @throws {NetworkError} the connector could not be reached.
   */
  static async create(config: ToonClientConfig): Promise<ToonClient> {
    const base = resolveConfig(config);
    // Before the first `GET`: a hidden-service connector is unreachable without
    // its proxy, and the very first thing this method does is dial. Building the
    // transport here also means `describe()` below already rides the overlay —
    // asking a node what it is must not be the request that exposes the asking.
    const hiddenService = await openHiddenService(base, config);
    const resolved = hiddenService?.config ?? base;
    const edge = new ConnectorEdgeClient({
      fetch: resolved.fetch,
      timeout: resolved.timeoutMs,
    });
    const description = await edge.describe(resolved.connector);
    const chain = pickChain(resolved, description);

    const senderId = resolved.senderId ?? addressFor(resolved.identity, chain);
    if (senderId === undefined) {
      throw new ConfigError(
        `This client holds no ${chain} key, so it has no address to label its ` +
          'vouchers with. Supply a `mnemonic`, the raw key for that chain, or an ' +
          'explicit `senderId`.'
      );
    }

    return new ToonClient({
      config: resolved,
      edge,
      description,
      chain,
      senderId,
      ...(hiddenService ? { hiddenService: hiddenService.transport } : {}),
    });
  }

  /**
   * The node's `GET /ilp`, cached for the life of this client.
   *
   * Cached because it is a description of a deployment, not a reading: the
   * settlement facts in it were proved against a live chain when the node booted
   * and do not change while it runs. `fresh` re-reads, which is what an operator
   * reconfiguring a node needs.
   */
  async describe(options: { fresh?: boolean } = {}): Promise<NodeSelfDescription> {
    if (options.fresh === true) {
      this.description = await this.edge.describe(this.connector, { forceRefresh: true });
    }
    return this.description;
  }

  /**
   * What `destination` costs at this node **before any per-size charge**, or
   * `null` when it prices no matching route.
   *
   * `null` is an ANSWER — "I do not terminate that" — and not a failure; a
   * connector that could not be asked throws instead, so the two are never
   * confused.
   *
   * A base price is flat per handler, but it is not always the whole bill: a
   * route may also publish a `pricePerKib` and meter by the size of the sealed
   * payload, in which case every packet costs strictly more than this figure.
   * {@link ToonClient.routePrice} reports both, and {@link ToonClient.send}
   * always pays the full charge without being asked.
   */
  async price(destination: string): Promise<bigint | null> {
    const result = await this.edge.getRoutePrice(this.connector, destination);
    return result === null ? null : result.price;
  }

  /**
   * The full terms for `destination` — base price and, when the route meters by
   * size, its per-kibibyte rate — or `null` when this node prices no matching
   * route.
   *
   * The counterpart to {@link ToonClient.price} for a caller who needs to know
   * what a packet will actually cost:
   * {@link ../connector/self-description.js!chargeFor} turns these terms plus a
   * sealed payload size into the figure that goes on the claim.
   */
  async routePrice(destination: string): Promise<ConnectorRoutePrice | null> {
    return this.edge.getRoutePrice(this.connector, destination);
  }

  /**
   * Learn what a path costs without buying the work behind it
   * (`client-edge-spec.md` §1.6, connector ADR 0011).
   *
   * A probe is free to traverse but not free to make: it must be identified by
   * a voucher on a channel this connector recognises, because free traversal
   * offered to anyone is an amplifier. It **identifies rather than pays**: the
   * latest voucher on the channel, resent byte for byte, is a retransmission
   * the connector accepts and records nothing for.
   *
   * @throws {ChannelNotOpenError} this client has not yet paid on a channel it
   *   could identify with.
   */
  async probe(
    destination: string
  ): Promise<{ accumulatedCost: bigint; code: string; message: string }> {
    const current = await this.channel.current();
    const latest = current && this.manager.lastVoucher(current.channel.channelId);
    if (latest === undefined) {
      throw new ChannelNotOpenError(
        `a probe identifies with the latest voucher on a channel, and this client has not yet ` +
          `paid ${this.connector} on one — pay for one request first`
      );
    }

    const key = await this.sealKey(this.description);
    const exchange = sealExchange({ method: 'GET', target: '', headers: [], body: new Uint8Array(0) }, key);

    const result = await this.edge.probe(
      this.connector,
      {
        destination,
        amount: '0',
        data: toBase64(exchange.data),
        expectedFulfillment: exchange.fulfillment,
        timeout: this.config.timeoutMs,
      },
      JSON.parse(latest) as Record<string, unknown>
    );
    return {
      accumulatedCost: result.accumulatedCost ?? 0n,
      code: result.code ?? (result.accepted ? 'FULFILL' : 'F00'),
      message: result.message ?? '',
    };
  }

  /**
   * Pay for one HTTP request through this connector, and return what the app
   * said.
   *
   * The destination is **optional**: omit it and the packet goes to
   * {@link ToonClient.defaultDestination}, the address this node published for
   * itself. Configuring a client is then just a URL — the thing a person
   * actually has — and the route comes from the node rather than from a string
   * the caller copied out of a document.
   *
   * ```ts
   * const client = await ToonClient.create({ connector: 'https://…', mnemonic });
   * await client.send({ body: 'hello' });              // the node's own address
   * await client.send('g.toon.relay.store', { … });    // or name one yourself
   * ```
   *
   * A REJECT comes back as `{ fulfilled: false }` and is never thrown — see
   * {@link ./types.js!SendRefused}.
   *
   * @throws {ConfigError} the destination was omitted and this node published no
   *   address to fall back on.
   */
  async send(request?: SendRequest, options?: SendOptions): Promise<SendResult>;
  async send(
    destination: string,
    request?: SendRequest,
    options?: SendOptions
  ): Promise<SendResult>;
  async send(
    destinationOrRequest?: string | SendRequest,
    requestOrOptions?: SendRequest | SendOptions,
    maybeOptions?: SendOptions
  ): Promise<SendResult> {
    // A destination is always a string and a request is always an object, so the
    // two forms are told apart without a sentinel.
    const named = typeof destinationOrRequest === 'string';
    const destination = named ? destinationOrRequest : this.defaultDestination;
    if (destination === undefined) {
      throw new ConfigError(
        `The connector at ${this.connector} published no \`ilpAddresses\`, so ` +
          'there is no route to send to. Name one explicitly: ' +
          "`send('g.example.route', { … })`."
      );
    }
    const request = (named ? requestOrOptions : destinationOrRequest) as SendRequest | undefined;
    const options = (named ? maybeOptions : requestOrOptions) as SendOptions | undefined;
    return send(this.sendContext(), destination, request ?? {}, options ?? {});
  }

  /**
   * Where {@link ToonClient.send} goes when the caller names no route: the first
   * address this node published for itself that it also prices.
   *
   * Read off the cached self-description, so it follows a
   * `describe({ fresh: true })`. `undefined` only from a node that claims no
   * address at all.
   */
  get defaultDestination(): string | undefined {
    return defaultDestinationFor(this.description);
  }

  /**
   * The connector's OWN watermark for channels this client controls
   * (`POST /ilp/claim-state`, `client-edge-spec.md` §1.10).
   *
   * The counterpart to `channel.channels()`, which reports what this client has
   * signed. The two agree unless a voucher was signed and never accepted, and
   * this is how a caller finds that out — the connector's figure is the one
   * that decides, so it is asked rather than derived.
   *
   * Control is proved with a voucher claim-state challenge: a signature by the
   * channel's voucher signer over a message DISTINCT from a voucher, so it
   * moves no value and can never be replayed as a payment.
   *
   * @param channelIds which channels to ask about; every channel this client
   *   holds with the connector when omitted.
   */
  async claimState(channelIds?: string[]): Promise<ClaimStateResult[]> {
    const held = this.manager
      .channels(this.connector)
      .map((c) => c.channel)
      .filter((c) => channelIds === undefined || channelIds.includes(c.channelId));
    if (held.length === 0) return [];
    const expires = BigInt(Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS);
    const entries = await Promise.all(held.map((c) => this.payer.challenge(c, expires)));
    return this.edge.getClaimState(this.connector, entries);
  }

  /**
   * Release the BTP session and stop using this client.
   *
   * Does **not** touch the channel: leaving a channel is an on-chain
   * transaction that starts a withdrawal window measured in hours, and
   * conflating it with releasing a socket would pull a user's deposit because
   * their script ended. `channel.close()` is that operation, and it is
   * deliberately spelled differently.
   *
   * The channel store is written through on every voucher, so there is no flush
   * to perform here — the watermark is already durable when this is called.
   */
  async close(): Promise<void> {
    this.closed = true;
    const session = this.btpSession;
    this.btpSession = undefined;
    this.carriages = {};
    if (session) await session.disconnect();
    // The dispatcher pools connections; without this a hidden-service client
    // holds circuits open and the process does not exit.
    if (this.hiddenService) await this.hiddenService.close();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Refuse an endpoint this client has no way to dial.
   *
   * A node's endpoints are its own strings, and a hidden-service node may publish
   * absolute `.anyone` ones. The configured client edge always wins on *whether*
   * we can reach the node — but a carriage resolved from the description can
   * still point somewhere the configured transport cannot go. Without a proxy
   * that address does not merely fail: the hostname goes out in a plaintext DNS
   * query first, which is precisely what a hidden service exists to prevent. So
   * this fails loudly, naming the proxy, before anything dials.
   */
  private assertEndpointReachable(endpoint: string): void {
    if (this.config.socksProxy !== undefined) return;
    if (!isHiddenServiceUrl(endpoint)) return;
    throw new ConfigError(
      `The connector published the endpoint ${JSON.stringify(endpoint)}, which is a ` +
        'hidden service, but this client has no `socksProxy` to reach it through. ' +
        'Set one to a running Anyone Protocol `anon` daemon (e.g. ' +
        '"socks5h://127.0.0.1:9050"), or ask the operator for a clearnet endpoint.'
    );
  }

  /** The port {@link send} runs against. */
  private sendContext(): SendContext {
    return {
      describe: () => this.describe(),
      sealKey: (description) => this.sealKey(description),
      sealKeyAt: (endpoint) => this.sealKeyAt(endpoint),
      routePrice: (destination) => this.routePrice(destination),
      vouchers: this.payer,
      transport: (description, destination) => this.transportFor(description, destination),
      chain: this.chain,
      timeoutMs: this.config.timeoutMs,
    };
  }

  /**
   * The key to seal a payload to.
   *
   * The self-description carries it (`edgeIdentity.publicKey`), which is one
   * fewer round trip; `GET /ilp/identity` is the fallback for a node whose
   * document omits it. Without a key a packet cannot be formed at all
   * (`self-description-spec.md` ND-06), so a node that publishes neither is
   * unusable rather than degraded.
   */
  private async sealKey(description: NodeSelfDescription): Promise<Uint8Array> {
    const published = description.edgeIdentity?.publicKey;
    if (published !== undefined) return decodeConnectorPublicKey(published);
    return this.sealKeyAt(this.connector);
  }

  /** The sealing key of a node named by its client-edge URL. */
  private async sealKeyAt(endpoint: string): Promise<Uint8Array> {
    const identity = await this.edge.getIdentity(endpoint);
    return identity.publicKey;
  }

  /**
   * The connector's own watermark for one channel, asked with its voucher
   * claim-state challenge — `undefined` when the connector cannot verify it
   * (`"unverified"` covers "no such channel" and "bad signature" alike, and
   * neither is a watermark).
   */
  private async connectorWatermark(entry: Record<string, unknown>): Promise<bigint | undefined> {
    const [answer] = await this.edge.getClaimState(this.connector, [entry]);
    return answer?.ok === true ? BigInt((answer as ClaimStateOk).cumulativeClaimed) : undefined;
  }

  /**
   * The carriage for `destination`, chosen once per kind and then reused.
   *
   * Reuse matters for BTP specifically: the whole reason to prefer it is that one
   * ordered socket cannot race its own claim nonces into `F01 NonceNotAdvancing`
   * (`client-edge-spec.md` §1.9), and a session rebuilt per request would give
   * that up while paying for the handshake.
   *
   * `destination` is what lets the node's **per-route** pin decide, rather than
   * only its node-wide summary — which is silent on any node that pins one of
   * its own addresses and not another (TOON_Network#111). The choice is made
   * before the first packet, so a pinned route is dialled correctly on the first
   * attempt and never learns its carriage from a refusal.
   */
  private async transportFor(
    description: NodeSelfDescription,
    destination?: string
  ): Promise<{
    kind: 'http' | 'btp';
    transport: PaidWriteTransport;
  }> {
    if (this.closed) {
      throw new ConfigError('This client has been closed; construct a new one to send again.');
    }

    const choice = selectTransport(description, this.config.transport, undefined, destination);
    const cached = this.carriages[choice.kind];
    if (cached) return cached;
    const httpEndpoint =
      choice.kind === 'http' ? choice.url : httpEndpointOf(description, this.connector);
    this.assertEndpointReachable(choice.url);
    this.assertEndpointReachable(httpEndpoint);
    const http = new HttpIlpClient({
      httpEndpoint,
      timeout: this.config.timeoutMs,
      httpClient: this.config.fetch,
      ...(this.config.createWebSocket
        ? { createWebSocket: this.config.createWebSocket as (url: string) => WebSocket }
        : {}),
    });

    if (choice.kind === 'http') {
      const carriage = { kind: 'http' as const, transport: http };
      this.carriages.http = carriage;
      return carriage;
    }

    const session = new BtpRuntimeClient({
      btpUrl: choice.url,
      // The client edge resolves a PRESENTED identity before it looks at the
      // route and answers `401` when it cannot authenticate one, so an anonymous
      // peer plus a valid claim is the supported permissionless path.
      peerId: this.identity.senderId,
      authToken: '',
      ...(this.config.btp.maxReconnectAttempts !== undefined
        ? { maxRetries: this.config.btp.maxReconnectAttempts }
        : {}),
      ...(this.config.btp.reconnectDelay !== undefined
        ? { retryDelay: this.config.btp.reconnectDelay }
        : {}),
      ...(this.config.createWebSocket
        ? { createWebSocket: this.config.createWebSocket as (url: string) => WebSocket }
        : {}),
      ...(this.config.btp.declareChannel
        ? { getChannelDeclaration: () => this.channelDeclaration() }
        : {}),
    });
    this.btpSession = session;

    const carriage = {
      kind: 'btp' as const,
      transport: new BtpPaidWriteTransport({
        session,
        // HTTP fallback only where the node did not REQUIRE btp *for this
        // destination*: falling back onto a carriage the route refuses would
        // turn a recoverable socket outage into a `402` per request. Read
        // through the same per-route resolution the choice above was made with,
        // so the fallback cannot be enabled against a route the node-wide field
        // happens not to describe (TOON_Network#111).
        ...(requiredTransportFor(description, destination) === 'btp' ? {} : { fallback: http }),
        ...(this.config.btp.maxReconnectAttempts !== undefined
          ? { maxReconnectAttempts: this.config.btp.maxReconnectAttempts }
          : {}),
        ...(this.config.btp.reconnectDelay !== undefined
          ? { reconnectDelay: this.config.btp.reconnectDelay }
          : {}),
      }),
    };
    this.carriages.btp = carriage;
    return carriage;
  }

  /**
   * Declare the channel this client pays from on the BTP auth frame, as a
   * voucher claim-state challenge (`channelChallenge`, ADR 0075), binding the
   * session to it before it has presented a voucher. `undefined` — no channel
   * yet — leaves the auth frame without one.
   */
  private async channelDeclaration(): Promise<BtpChannelDeclaration | undefined> {
    const current = await this.channel.current();
    if (current === undefined) return undefined;
    const expires = BigInt(Math.floor(Date.now() / 1000) + CHALLENGE_TTL_SECONDS);
    return this.payer.challenge(current.channel, expires);
  }
}

/**
 * Which chain this client will pay on: the caller's choice when they made one,
 * else the first chain the node offers an x402 channel on that this client
 * holds a key for.
 *
 * The node's ORDER is the preference order — it published these, and the first
 * one it lists is the one it expects to be paid on.
 */
function pickChain(config: ResolvedConfig, description: NodeSelfDescription): ChainKind {
  const offers = description.batchSettlements;
  const offered = offers.map((t) => t.network);
  if (offers.length === 0) {
    throw new ChainUnavailableError(chainUnavailableMessage(config.chain, offered, 'none'), offered);
  }
  if (config.chain !== undefined) {
    if (!offers.some((t) => t.chain === config.chain)) {
      throw new ChainUnavailableError(
        chainUnavailableMessage(config.chain, offered, 'not-offered'),
        offered
      );
    }
    return config.chain;
  }
  const match = offers.find((t) => config.identity[t.chain] !== undefined);
  if (!match) {
    throw new ChainUnavailableError(chainUnavailableMessage(undefined, offered, 'no-key'), offered);
  }
  return match.chain;
}

/**
 * The `POST /ilp` URL, for the HTTP fallback beneath a BTP session.
 *
 * Falls back to the client-edge base plus `/ilp` when the node published no
 * `httpEndpoint`: the fallback is only ever *tried* when BTP has already failed,
 * so a guess that turns out to be wrong costs one failed request rather than
 * suppressing a working carriage.
 */
function httpEndpointOf(description: NodeSelfDescription, connector: string): string {
  const published = description.httpEndpoint;
  if (published === undefined) return `${connector}/ilp`;
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(published)
    ? published
    : new URL(published, connector).toString();
}

/**
 * Builds everything that rides the proxy, or returns `undefined` when there is
 * no proxy.
 *
 * That is the client edge (`fetch`), the BTP socket (`createWebSocket`) and,
 * unless `proxyRpc` is `false`, each chain's RPC on a circuit of its own. It is
 * the same whether the connector is a `.anyone` hidden service or a clearnet
 * host. In the second case the payer is the one hiding, and a single byte sent
 * around the proxy would name it (TOON_Network#167).
 *
 * The import is dynamic on purpose: `../transport/socks.js` reaches for
 * `node:module` on its first line, and this module is bundled for browsers too.
 *
 * An explicitly injected `fetch` or `createWebSocket` wins over the proxy's for
 * the client edge. A caller who supplied their own transport has said something
 * specific about how bytes leave this process, and silently replacing it would
 * be a worse surprise than an unproxied request they chose. Chain RPC never
 * uses an injected `fetch` under a proxy: it rides its own circuit, or dials
 * directly only because `proxyRpc: false` said so.
 */
async function openHiddenService(
  resolved: ResolvedConfig,
  config: ToonClientConfig
): Promise<{ config: ResolvedConfig; transport: { close(): Promise<void> } } | undefined> {
  const socksProxy = resolved.socksProxy;
  if (socksProxy === undefined) return undefined;

  const { createChainRpcTransport, createHiddenServiceTransport, probeSocks5Proxy } =
    await import('../transport/socks.js');
  // Fail closed, and fail now. A missing daemon discovered at packet time costs
  // a signed claim; discovered here it costs nothing.
  await probeSocks5Proxy(socksProxy);
  const edge = createHiddenServiceTransport(socksProxy);
  const rpc = resolved.proxyRpc
    ? {
        evm: createChainRpcTransport(socksProxy, 'evm'),
        solana: createChainRpcTransport(socksProxy, 'solana'),
      }
    : undefined;

  return {
    transport: {
      async close(): Promise<void> {
        await Promise.all([edge.close(), rpc?.evm.close(), rpc?.solana.close()]);
      },
    },
    config: {
      ...resolved,
      fetch: config.fetch ?? edge.fetch,
      createWebSocket: config.createWebSocket ?? edge.createWebSocket,
      chainRpc:
        rpc === undefined
          ? undefined
          : {
              evm: { dispatcher: rpc.evm.dispatcher, fetch: rpc.evm.fetch },
              solana: { dispatcher: rpc.solana.dispatcher, fetch: rpc.solana.fetch },
            },
    },
  };
}

/**
 * This client's keys, in the shapes the x402 channel code signs with: a viem
 * account on EVM, and on Solana a keypair plus the JSON-RPC it reads the chain
 * through. Chain RPC rides the proxy under the same condition everywhere: there
 * is one, and the caller has not opted RPC out of it.
 */
function chainAccess(config: ResolvedConfig): {
  evm?: { account: ReturnType<typeof privateKeyToAccount>; privateKey: Uint8Array };
  solana?: {
    signer: { privateKey: Uint8Array; publicKey: Uint8Array };
    rpc: { url: string; fetchImpl?: typeof fetch };
  };
} {
  const evmKey = config.identity.evm?.privateKey;
  const solanaKey = config.identity.solana;
  return {
    ...(evmKey !== undefined
      ? { evm: { account: privateKeyToAccount(toHex(evmKey)), privateKey: evmKey } }
      : {}),
    ...(solanaKey !== undefined
      ? {
          solana: {
            signer: {
              privateKey: solanaKey.secretKey.slice(0, 32),
              publicKey: base58Decode(solanaKey.publicKey),
            },
            rpc: {
              url: config.rpcUrls.solana,
              ...(config.chainRpc !== undefined ? { fetchImpl: config.chainRpc.solana.fetch } : {}),
            },
          },
        }
      : {}),
  };
}

/**
 * A `readContract` over the client's EVM RPC, built on first use so a client
 * that never needs to read a batch-settlement channel back opens no connection.
 */
function lazyEvmReader(config: ResolvedConfig): ContractReader {
  let client: ReturnType<typeof createPublicClient> | undefined;
  return {
    readContract: (params: never) => {
      client ??= createPublicClient({
        transport: rpcTransport(config.rpcUrls.evm, config.chainRpc?.evm.dispatcher),
      });
      return client.readContract(params);
    },
  };
}

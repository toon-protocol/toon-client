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
  type NodeSelfDescription,
} from '../connector/self-description.js';
import { isHiddenServiceUrl } from '../transport/hs-hostname.js';
import { Carriage } from '../carriage/Carriage.js';
import type { BtpChannelDeclaration } from '../btp/BtpRuntimeClient.js';

import { sealExchange } from '../wire/sealed-exchange.js';
import { toBase64 } from '../utils/binary.js';
import { resolveConfig, addressFor, type ResolvedConfig } from './config.js';
import { ClientChannelFacade } from './channel-facade.js';
import { ClientWalletFacade } from './wallet-facade.js';
import { settlementNetworks } from './chain-access.js';
import { evmStoredForm } from '../channel/batch-settlement/evm-network.js';
import { solanaStoredForm } from '../channel/batch-settlement/solana-network.js';
import { BatchSettlementPayer } from '../channel/batch-settlement/payer.js';
import { BatchChannelManager } from '../channel/batch-settlement/manager.js';
import { send, type SendContext } from './send.js';
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
  private readonly carriage: Carriage;
  private readonly hiddenService: { close(): Promise<void> } | undefined;

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
    this.carriage = new Carriage({
      transport: init.config.transport,
      carriageEndpoints: init.config.carriageEndpoints,
      timeoutMs: init.config.timeoutMs,
      fetch: init.config.fetch,
      createWebSocket: init.config.createWebSocket,
      btp: init.config.btp,
      peerId: init.senderId,
      channelDeclaration: () => this.channelDeclaration(),
      assertReachable: (endpoint) =>
        assertReachableWithoutProxy(endpoint, init.config.socksProxy, 'published'),
    });

    this.manager = new BatchChannelManager(
      [evmStoredForm, solanaStoredForm],
      init.config.channelStore
    );
    const networks = settlementNetworks(init.config);
    this.payer = new BatchSettlementPayer({
      connector: init.config.connector,
      manager: this.manager,
      deposit: init.config.deposit,
      networks,
      autoOpen: init.config.autoOpenChannel,
      connectorWatermark: (entry) => this.connectorWatermark(entry),
    });
    this.channel = new ClientChannelFacade({
      connector: init.config.connector,
      payer: this.payer,
      chain: init.chain,
      manager: this.manager,
      describe: () => this.describe(),
      networks,
    });
    this.wallet = new ClientWalletFacade({
      config: init.config,
      describe: () => this.describe(),
      networks,
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
    // An override is the payer's own string, so a `.anyone` one with no proxy is
    // knowable now — before the first `GET` and before any DNS query.
    for (const override of Object.values(base.carriageEndpoints)) {
      assertReachableWithoutProxy(override, base.socksProxy, 'override');
    }
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
    await this.carriage.close();
    // The dispatcher pools connections; without this a hidden-service client
    // holds circuits open and the process does not exit.
    if (this.hiddenService) await this.hiddenService.close();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** The port {@link send} runs against. */
  private sendContext(): SendContext {
    return {
      describe: () => this.describe(),
      sealKey: (description) => this.sealKey(description),
      sealKeyAt: (endpoint) => this.sealKeyAt(endpoint),
      routePrice: (destination) => this.routePrice(destination),
      vouchers: this.payer,
      carriage: this.carriage,
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
 * Refuse a hidden-service endpoint when there is no proxy to reach it through,
 * naming who chose it: the connector, or the caller's `carriageEndpoints`.
 */
function assertReachableWithoutProxy(
  endpoint: string,
  socksProxy: string | undefined,
  chosenBy: 'published' | 'override'
): void {
  if (socksProxy !== undefined) return;
  if (!isHiddenServiceUrl(endpoint)) return;
  const [subject, alternative] =
    chosenBy === 'published'
      ? [
          'The connector published the endpoint',
          'ask the operator for a clearnet endpoint',
        ]
      : ['The carriage endpoint override', 'use a clearnet override'];
  throw new ConfigError(
    `${subject} ${JSON.stringify(endpoint)}, which is a ` +
      'hidden service, but this client has no `socksProxy` to reach it through. ' +
      'Set one to a running Anyone Protocol `anon` daemon (e.g. ' +
      `"socks5h://127.0.0.1:9050"), or ${alternative}.`
  );
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
  const { proveProxy } = await import('../transport/canary.js');
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
  const close = async (): Promise<void> => {
    await Promise.all([edge.close(), rpc?.evm.close(), rpc?.solana.close()]);
  };

  // Prove every hook is honoured before anything real is sent (ADR 0005). An
  // injected `fetch` or `createWebSocket` is the caller's own transport and is
  // outside the guarantee, but the proxy's own objects are still tested.
  try {
    await proveProxy({
      edge,
      ...(rpc !== undefined ? { rpc } : {}),
      ...(config.canaryPaths !== undefined ? { overrides: config.canaryPaths } : {}),
    });
  } catch (err) {
    await close().catch(() => undefined);
    throw err;
  }

  return {
    transport: { close },
    config: {
      ...resolved,
      fetch: config.fetch ?? edge.fetch,
      createWebSocket: config.createWebSocket ?? edge.createWebSocket,
      chainRpc:
        rpc === undefined
          ? undefined
          : {
              evm: { fetch: rpc.evm.fetch },
              solana: { fetch: rpc.solana.fetch },
            },
    },
  };
}

/**
 * The client: one object that knows a connector, holds the keys, and pays.
 *
 * Deliberately thin. It wires — {@link ./send.js!send} performs a request,
 * {@link ./channel-facade.js!ClientChannelFacade} owns the channel and
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
 * settles the chain to settle on, since the node's own `settlements[]` is the
 * authority (`self-description-spec.md` ND-07) and a preset is not.
 *
 * It does **not** touch a chain. No RPC connection is opened, no channel is read
 * and certainly none is opened: locking collateral is a transaction the user
 * pays gas for, and a constructor is not where that belongs. The first chain
 * access happens when something explicitly asks for it — `channel.open()`, or a
 * `send()` on a client left with the default `autoOpenChannel: true`.
 */
import { ConnectorEdgeClient, decodeConnectorPublicKey } from '../connector/ConnectorEdgeClient.js';
import type {
  ClaimStateRequestEntry,
  ClaimStateResult,
  ConnectorRoutePrice,
} from '../connector/ConnectorEdgeClient.js';
import {
  defaultDestinationFor,
  type NodeSelfDescription,
} from '../connector/self-description.js';
import { selectTransport } from '../btp/transport-select.js';
import { HttpIlpClient } from '../http/HttpIlpClient.js';
import { BtpRuntimeClient, type BtpChannelDeclaration } from '../btp/BtpRuntimeClient.js';
import { BtpPaidWriteTransport } from '../btp/BtpPaidWriteTransport.js';

import { ChannelManager } from '../channel/ChannelManager.js';
import { OnChainChannelClient } from '../channel/OnChainChannelClient.js';
import { EvmSigner } from '../signing/evm-signer.js';
import { SolanaSigner } from '../signing/solana-signer.js';
import { sealExchange } from '../wire/sealed-exchange.js';
import { toBase64 } from '../utils/binary.js';
import { resolveConfig, addressFor, type ResolvedConfig } from './config.js';
import { ClientChannelFacade } from './channel-facade.js';
import { ClientWalletFacade } from './wallet-facade.js';
import { send, type PaidWriteTransport, type SendContext } from './send.js';
import { ChainUnavailableError, ConfigError, chainUnavailableMessage } from './errors.js';
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

/** How long a claim-state challenge signature stays valid, in seconds. */
const CLAIM_STATE_CHALLENGE_TTL = 300;

export class ToonClient implements ToonClientLike {
  readonly connector: string;
  readonly chain: ChainKind;
  readonly identity: ToonIdentity;
  readonly channel: ChannelFacade;
  readonly wallet: WalletFacade;

  private readonly config: ResolvedConfig;
  private readonly edge: ConnectorEdgeClient;
  private readonly channels: ChannelManager;
  private readonly channelFacade: ClientChannelFacade;
  private description: NodeSelfDescription;
  private onChain: OnChainChannelClient | undefined;
  private carriage: { kind: 'http' | 'btp'; transport: PaidWriteTransport } | undefined;
  private btpSession: BtpRuntimeClient | undefined;
  private closed = false;

  private constructor(init: {
    config: ResolvedConfig;
    edge: ConnectorEdgeClient;
    channels: ChannelManager;
    description: NodeSelfDescription;
    chain: ChainKind;
    senderId: string;
  }) {
    this.config = init.config;
    this.edge = init.edge;
    this.channels = init.channels;
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

    this.channelFacade = new ClientChannelFacade({
      config: init.config,
      channels: init.channels,
      describe: () => this.describe(),
      onChainClient: () => this.onChainClient(),
    });
    this.channel = this.channelFacade;
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
    const resolved = resolveConfig(config);
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
          'claims with. Supply a `mnemonic`, the raw key for that chain, or an ' +
          'explicit `senderId`.'
      );
    }

    const channels = new ChannelManager(
      resolved.identity.evm ? new EvmSigner(resolved.identity.evm.privateKey) : undefined,
      resolved.channelStore,
      {
        initialDeposit: resolved.deposit.toString(),
        settlementTimeout: resolved.settlementTimeout,
      }
    );
    if (resolved.identity.solana) {
      channels.registerChainSigner(
        'solana',
        new SolanaSigner(
          resolved.identity.solana.secretKey.slice(0, 32),
          resolved.identity.solana.publicKey
        )
      );
    }

    return new ToonClient({ config: resolved, edge, channels, description, chain, senderId });
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
   * A probe is free to traverse but not free to make: it must carry a claim on a
   * channel this connector recognises, because free traversal offered to anyone
   * is an amplifier. The claim **identifies rather than pays** — it is validated
   * in full against a price of zero, so possession of the channel is proven and a
   * replay is still refused, but no value need advance.
   *
   * @throws {ChannelNotOpenError} there is no channel to identify with.
   */
  async probe(
    destination: string
  ): Promise<{ accumulatedCost: bigint; code: string; message: string }> {
    const channelId = await this.channelFacade.ensure(this.description);
    // Zero value, fresh nonce: the gate's freshness check still applies, so the
    // nonce must advance even though the cumulative does not.
    const proof = await this.channels.signBalanceProof(channelId, 0n);
    const signer = this.channels.getSignerForChannel(channelId);
    const claim = signer.buildClaimMessage(proof, this.identity.senderId);

    const key = await this.sealKey(this.description);
    const exchange = sealExchange({ method: 'GET', target: '', headers: [], body: new Uint8Array(0) }, key);

    const result = await this.edge.probe(
      this.connector,
      {
        destination,
        amount: '0',
        data: toBase64(exchange.data),
        executionCondition: exchange.condition,
        timeout: this.config.timeoutMs,
      },
      claim as unknown as Record<string, unknown>
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
   * The counterpart to `channel.state()`, which reports what this client has
   * signed. The two agree unless a claim was signed and never accepted, and this
   * is how a caller finds that out — the connector's figure is the one that
   * decides, so it is asked rather than derived.
   *
   * Ownership is proved with a signature over a challenge that is deliberately
   * DISTINCT from a balance proof, so it moves no value and can never be replayed
   * as a payment. A channel with no signer or no recorded context is skipped
   * rather than failing the batch.
   */
  async claimState(channelIds?: string[]): Promise<ClaimStateResult[]> {
    const ids = channelIds ?? this.channels.getTrackedChannels();
    if (ids.length === 0) return [];
    const expires = Math.floor(Date.now() / 1000) + CLAIM_STATE_CHALLENGE_TTL;

    const entries = await Promise.all(
      ids.map((channelId) => this.signClaimStateChallenge(channelId, expires))
    );
    const requests = entries.filter((e): e is ClaimStateRequestEntry => e !== undefined);
    if (requests.length === 0) return [];
    return this.edge.getClaimState(this.connector, requests);
  }

  /**
   * Release the BTP session and stop using this client.
   *
   * Does **not** touch the channel: closing a channel is an on-chain transaction
   * that starts a challenge period measured in hours, and conflating it with
   * releasing a socket would settle a user's collateral because their script
   * ended. `channel.close()` is that operation, and it is deliberately spelled
   * differently.
   *
   * The channel store is written through on every claim, so there is no flush to
   * perform here — the watermark is already durable when this is called.
   */
  async close(): Promise<void> {
    this.closed = true;
    const session = this.btpSession;
    this.btpSession = undefined;
    this.carriage = undefined;
    if (session) await session.disconnect();
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /** The port {@link send} runs against. */
  private sendContext(): SendContext {
    return {
      describe: () => this.describe(),
      sealKey: (description) => this.sealKey(description),
      sealKeyAt: (endpoint) => this.sealKeyAt(endpoint),
      routePrice: (destination) => this.routePrice(destination),
      ensureChannel: (description) => this.channelFacade.ensure(description),
      evictChannel: (channelId) => this.evictChannel(channelId),
      channels: this.channels,
      transport: (description) => this.transportFor(description),
      senderId: this.identity.senderId,
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
   * Retire the binding a refused claim was drawn on. `false` when there is
   * nothing to retire, which is {@link send}'s signal not to retry.
   */
  private evictChannel(channelId: string): boolean {
    const terms = this.channelFacade.terms;
    if (terms === undefined) return false;
    return this.channels.evictBinding(this.connector, terms, channelId);
  }

  /**
   * The on-chain client, built on first use.
   *
   * Lazy so `create()` opens no RPC connection. The RPC URL is keyed by the chain
   * the node actually publishes (`evm:84532`), not by a family name, because that
   * key is what the settlement entry names and what a channel is recorded under.
   */
  private onChainClient(): OnChainChannelClient {
    if (this.onChain) return this.onChain;
    const chainKeys = this.description.settlements.map((s) => s.chain);
    const chainRpcUrls: Record<string, string> = {};
    for (const entry of this.description.settlements) {
      chainRpcUrls[entry.chain] = this.config.rpcUrls[entry.kind];
    }
    if (chainKeys.length === 0) {
      throw new ChainUnavailableError(
        chainUnavailableMessage(this.config.chain, [], 'none'),
        []
      );
    }
    const client = new OnChainChannelClient({
      evmSigner: new EvmSigner(this.requireEvmKey()),
      chainRpcUrls,
      ...(this.config.identity.solana
        ? {
            solanaConfig: {
              rpcUrl: this.config.rpcUrls.solana,
              keypair: this.config.identity.solana.secretKey,
              // The DEFAULT only. Each channel opens under the program its own
              // terms name, because ADR 0053 binds that program into the signed
              // balance proof: opening under one and signing under another
              // produces claims no channel of ours lives under.
              programId: solanaProgramId(this.description) ?? '',
            },
          }
        : {}),
    });
    this.channels.setChannelClient(client);
    this.onChain = client;
    return client;
  }

  /**
   * The EVM key the on-chain client needs.
   *
   * `OnChainChannelClient` requires one even for a Solana-only deployment, since
   * it is the EVM transaction signer as well as the EVM claim signer. A
   * Solana-only client is a real configuration, so this reports the gap plainly
   * rather than constructing a signer over empty bytes.
   */
  private requireEvmKey(): Uint8Array {
    const key = this.config.identity.evm?.privateKey;
    if (key === undefined) {
      throw new ConfigError(
        'On-chain channel operations need an EVM key even on a Solana-only node ' +
          '(the same object drives both chains). Supply a `mnemonic`, which derives ' +
          'both, rather than a bare `solanaSecretKey`.'
      );
    }
    return key;
  }

  /**
   * The carriage, chosen once and then reused.
   *
   * Reuse matters for BTP specifically: the whole reason to prefer it is that one
   * ordered socket cannot race its own claim nonces into `F01 NonceNotAdvancing`
   * (`client-edge-spec.md` §1.9), and a session rebuilt per request would give
   * that up while paying for the handshake.
   */
  private async transportFor(description: NodeSelfDescription): Promise<{
    kind: 'http' | 'btp';
    transport: PaidWriteTransport;
  }> {
    if (this.closed) {
      throw new ConfigError('This client has been closed; construct a new one to send again.');
    }
    if (this.carriage) return this.carriage;

    const choice = selectTransport(description, this.config.transport);
    const http = new HttpIlpClient({
      httpEndpoint: choice.kind === 'http' ? choice.url : httpEndpointOf(description, this.connector),
      timeout: this.config.timeoutMs,
      httpClient: this.config.fetch,
      ...(this.config.createWebSocket
        ? { createWebSocket: this.config.createWebSocket as (url: string) => WebSocket }
        : {}),
    });

    if (choice.kind === 'http') {
      const carriage = { kind: 'http' as const, transport: http };
      this.carriage = carriage;
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
        // HTTP fallback only where the node did not REQUIRE btp: falling back
        // onto a carriage the route refuses would turn a recoverable socket
        // outage into a `402` per request.
        ...(description.requiredTransport === 'btp' ? {} : { fallback: http }),
        ...(this.config.btp.maxReconnectAttempts !== undefined
          ? { maxReconnectAttempts: this.config.btp.maxReconnectAttempts }
          : {}),
        ...(this.config.btp.reconnectDelay !== undefined
          ? { reconnectDelay: this.config.btp.reconnectDelay }
          : {}),
      }),
    };
    this.carriage = carriage;
    return carriage;
  }

  /**
   * Declare the channel on the BTP auth greeting, so a connector crediting
   * earned increments learns the association without this client ever paying
   * for the introduction. `undefined` — no channel yet, or a chain with no
   * signer — leaves the greeting exactly as it would have been.
   */
  private async channelDeclaration(): Promise<BtpChannelDeclaration | undefined> {
    const channelId = this.channelFacade.id;
    if (channelId === undefined) return undefined;
    const expires = Math.floor(Date.now() / 1000) + CLAIM_STATE_CHALLENGE_TTL;
    return this.signClaimStateChallenge(channelId, expires);
  }

  /**
   * Sign the channel-ownership challenge for one channel. `undefined` for a
   * channel this client has no signer or no recorded context for — skipping is
   * right because the batch is a best-effort read, not a payment.
   */
  private async signClaimStateChallenge(
    channelId: string,
    expires: number
  ): Promise<ClaimStateRequestEntry | undefined> {
    const context = this.channels.getChannelContext(channelId);
    if (!context) return undefined;

    if (context.chainType === 'evm' && this.config.identity.evm) {
      const signature = await new EvmSigner(
        this.config.identity.evm.privateKey
      ).signClaimStateChallenge({
        chainId: context.chainId,
        tokenNetworkAddress: context.tokenNetworkAddress,
        channelId,
        expires,
      });
      return { blockchain: 'evm', channelId, expires, signature };
    }

    if (context.chainType === 'solana' && this.config.identity.solana) {
      const signature = await new SolanaSigner(
        this.config.identity.solana.secretKey.slice(0, 32),
        this.config.identity.solana.publicKey
      ).signClaimStateChallenge({ channelAccount: channelId, expires });
      return { blockchain: 'solana', channelAccount: channelId, expires, signature };
    }

    return undefined;
  }
}

/**
 * Which chain this client will settle on: the caller's choice when they made
 * one, else the first chain the node publishes that this client holds a key for.
 *
 * The node's ORDER is the preference order — it published these, and the first
 * one it lists is the one it expects to be paid on.
 */
function pickChain(config: ResolvedConfig, description: NodeSelfDescription): ChainKind {
  const offered = description.settlements.map((s) => s.chain);
  if (description.settlements.length === 0) {
    throw new ChainUnavailableError(
      chainUnavailableMessage(config.chain, offered, 'none'),
      offered
    );
  }
  if (config.chain !== undefined) {
    if (!description.settlements.some((s) => s.kind === config.chain)) {
      throw new ChainUnavailableError(
        chainUnavailableMessage(config.chain, offered, 'not-offered'),
        offered
      );
    }
    return config.chain;
  }
  const match = description.settlements.find((s) => config.identity[s.kind] !== undefined);
  if (!match) {
    throw new ChainUnavailableError(
      chainUnavailableMessage(undefined, offered, 'no-key'),
      offered
    );
  }
  return match.kind;
}

/** The settlement program the node publishes for Solana, if it publishes one. */
function solanaProgramId(description: NodeSelfDescription): string | undefined {
  for (const entry of description.settlements) {
    if (entry.kind === 'solana') return entry.programId;
  }
  return undefined;
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

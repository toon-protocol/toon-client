/**
 * The node self-description: the one document a connector answers `GET` on its
 * own client-edge URL with, and the whole of what a stranger needs in order to
 * transact with it (`self-description-spec.md`, connector ADR 0050).
 *
 * This replaces peer discovery entirely. Earlier versions of this client learned
 * a node's addresses, endpoints, sealing key and settlement facts by subscribing
 * to a relay and reading announcements it published about itself; the Rust
 * connector publishes nothing (ADR 0046 removed the announce, ADR 0022 says a
 * connector *answers*, it never announces). One free, unauthenticated `GET` now
 * carries every fact that mechanism used to scatter:
 *
 * - **`ilpAddresses`** — what to address.
 * - **`httpEndpoint` / `btpEndpoint`** — where to reach it, and how.
 * - **`edgeIdentity`** — the key a packet's payload is sealed to. Without it a
 *   packet cannot be delivered at all (ND-06).
 * - **`settlements`** — per chain, what opening a channel takes. Each entry was
 *   *proved against a live chain* when the node booted (ND-07), which is why
 *   this is the source for channel opening and claim signing rather than any
 *   preset this package ships.
 * - **`routes`** — what each route costs.
 * - **`requiredTransport`** — when every route agrees on one carriage.
 *
 * Absent means absent: a field the node has nothing to say about is **omitted**,
 * never `null` and never an empty string, and `peerCarriages` is the sole field
 * always written even when empty ("this node exposes no peer carriage" is an
 * answer). The parser below preserves that distinction rather than substituting
 * defaults, because a substituted default is indistinguishable from a fact.
 */
import type {
  ConnectorChainSettlementTerms,
  ConnectorSettlementTerms,
  ConnectorSolanaSettlementTerms,
} from './ConnectorEdgeClient.js';

export type {
  ConnectorChainSettlementTerms,
  ConnectorSettlementTerms,
  ConnectorSolanaSettlementTerms,
};

/** The key a packet's payload is sealed to (ADR 0018). */
export interface EdgeIdentity {
  /** Opaque key id identifying which key this is. */
  keyId: string;
  /** Uncompressed secp256k1 public key, `0x04…`, exactly as published. */
  publicKey: string;
}

/** One route the node serves, and what it costs. */
export interface RoutePrice {
  /** The ILP address prefix. Longest matching prefix wins. */
  prefix: string;
  /**
   * The flat price per packet, in the settlement asset's base units.
   *
   * A `bigint` here, though the wire carries a decimal **string** — deliberately
   * so, because a price past 2^53 is a real amount and a JSON number would round
   * it. (`GET /ilp/routes/price` answers the same figure as a JSON *number*;
   * that inconsistency is the connector's, and both are normalized to `bigint`
   * by this client.)
   */
  price: bigint;
}

/** Which carriage a route insists on, when its routes agree on one. */
export type RequiredTransport = 'http' | 'btp';

/**
 * A connector's answer to `GET /ilp`.
 *
 * Every optional field below is optional *on the wire*: its absence is a fact
 * about the node, not a parse failure.
 */
export interface NodeSelfDescription {
  /** The addresses this node answers to. Self-asserted — nothing allocates one. */
  ilpAddresses: string[];
  /** The `POST /ilp` URL, when the node publishes one. */
  httpEndpoint?: string;
  /** The `GET /ilp/btp` websocket URL, when the node publishes one. */
  btpEndpoint?: string;
  /** Which peer carriages the node exposes: `btp`, `http`. Always present, possibly empty. */
  peerCarriages: string[];
  /** The sealing key. Absent only from a node whose signer is broken. */
  edgeIdentity?: EdgeIdentity;
  /** One entry per chain the node settles on. Absent — not empty — when it settles on none. */
  settlements: ConnectorChainSettlementTerms[];
  /** The node's routes and their prices. Absent — not empty — when it serves none. */
  routes: RoutePrice[];
  /** Set only when every route that covers this node's own addresses agrees on one carriage. */
  requiredTransport?: RequiredTransport;
  /** Client-edge versions this node serves. `[1]` today. */
  supportedVersions: number[];
  /** The version unversioned `POST /ilp` resolves to. Always `1` — the path is a permanent alias. */
  defaultVersion: number;
  /**
   * The normalized client-edge base URL this document was read from, when the
   * reader knew it.
   *
   * Not a field on the wire — the node cannot know the URL a client reached it
   * by. It is recorded because `httpEndpoint`/`btpEndpoint` are configured
   * strings a node MAY publish relative (the x402 greeting's sibling field is
   * literally `"/ilp"`), and a relative endpoint is only resolvable against the
   * origin that answered. {@link ../btp/transport-select.js}'s `selectTransport`
   * uses it for exactly that.
   */
  readFrom?: string;
  /** The document exactly as received, for facts this client does not yet name. */
  raw: unknown;
}

/** First defined non-empty string among `keys` on `obj`. */
function readString(obj: Record<string, unknown>, key: string): string | undefined {
  const v = obj[key];
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined;
}

/** Parse a decimal-string | number amount to bigint; `undefined` when unusable. */
export function readBaseUnits(value: unknown): bigint | undefined {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value));
  if (typeof value === 'string' && /^\d+$/.test(value.trim())) return BigInt(value.trim());
  return undefined;
}

/**
 * Read one `settlements[]` entry.
 *
 * The wire is **untagged** — the two shapes are told apart structurally, by
 * which contract-ish field they carry (`tokenNetworkRegistry` names EVM,
 * `programId` names Solana), exactly as the connector's own `#[serde(untagged)]`
 * enum does it. `kind` is this parser's addition and never appears on the wire.
 *
 * Note what is *not* here: a Solana entry publishes no `cluster`. The connector
 * knows its own cluster (it reads the genesis hash) and cross-checks the one a
 * claim declares, but it does not publish it — so a client must never expect to
 * learn the cluster from this document.
 */
export function parseSettlementEntry(raw: unknown): ConnectorChainSettlementTerms | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  const chain = readString(e, 'chain');
  const settlementAddress = readString(e, 'settlementAddress');
  const tokenAddress = readString(e, 'tokenAddress');
  const decimals = typeof e['decimals'] === 'number' ? (e['decimals'] as number) : undefined;
  if (!chain || !settlementAddress || !tokenAddress || decimals === undefined) return undefined;

  const programId = readString(e, 'programId');
  if (programId !== undefined) {
    const solana: ConnectorSolanaSettlementTerms = {
      chain,
      settlementAddress,
      programId,
      tokenAddress,
      decimals,
    };
    return { kind: 'solana', ...solana };
  }

  const tokenNetworkRegistry = readString(e, 'tokenNetworkRegistry');
  const tokenNetwork = readString(e, 'tokenNetwork');
  if (tokenNetworkRegistry !== undefined && tokenNetwork !== undefined) {
    const evm: ConnectorSettlementTerms = {
      chain,
      settlementAddress,
      tokenNetworkRegistry,
      tokenNetwork,
      tokenAddress,
      decimals,
    };
    return { kind: 'evm', ...evm };
  }
  return undefined;
}

/**
 * Parse a `GET /ilp` body.
 *
 * Never throws on a shape it does not recognise: an unreadable field is dropped
 * and the rest of the document survives, because a client that refuses to read a
 * node's price list over one unexpected key is a client that cannot be deployed
 * ahead of a connector release.
 */
export function parseSelfDescription(
  body: unknown,
  readFrom?: string
): NodeSelfDescription {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

  const ilpAddresses = Array.isArray(b['ilpAddresses'])
    ? (b['ilpAddresses'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];
  const peerCarriages = Array.isArray(b['peerCarriages'])
    ? (b['peerCarriages'] as unknown[]).filter((a): a is string => typeof a === 'string')
    : [];

  const rawIdentity = b['edgeIdentity'];
  let edgeIdentity: EdgeIdentity | undefined;
  if (typeof rawIdentity === 'object' && rawIdentity !== null) {
    const id = rawIdentity as Record<string, unknown>;
    const keyId = readString(id, 'keyId');
    const publicKey = readString(id, 'publicKey');
    if (publicKey !== undefined) edgeIdentity = { keyId: keyId ?? '', publicKey };
  }

  const settlements = Array.isArray(b['settlements'])
    ? (b['settlements'] as unknown[])
        .map(parseSettlementEntry)
        .filter((s): s is ConnectorChainSettlementTerms => s !== undefined)
    : [];

  const routes = Array.isArray(b['routes'])
    ? (b['routes'] as unknown[])
        .map((raw): RoutePrice | undefined => {
          if (typeof raw !== 'object' || raw === null) return undefined;
          const r = raw as Record<string, unknown>;
          const prefix = readString(r, 'prefix');
          const price = readBaseUnits(r['price']);
          return prefix !== undefined && price !== undefined ? { prefix, price } : undefined;
        })
        .filter((r): r is RoutePrice => r !== undefined)
    : [];

  const required = readString(b, 'requiredTransport');
  const requiredTransport: RequiredTransport | undefined =
    required === 'http' || required === 'btp' ? required : undefined;

  const supportedVersions = Array.isArray(b['supportedVersions'])
    ? (b['supportedVersions'] as unknown[]).filter((v): v is number => typeof v === 'number')
    : [1];
  const defaultVersion = typeof b['defaultVersion'] === 'number' ? (b['defaultVersion'] as number) : 1;

  const httpEndpoint = readString(b, 'httpEndpoint');
  const btpEndpoint = readString(b, 'btpEndpoint');

  return {
    ilpAddresses,
    ...(httpEndpoint !== undefined ? { httpEndpoint } : {}),
    ...(btpEndpoint !== undefined ? { btpEndpoint } : {}),
    peerCarriages,
    ...(edgeIdentity !== undefined ? { edgeIdentity } : {}),
    settlements,
    routes,
    ...(requiredTransport !== undefined ? { requiredTransport } : {}),
    supportedVersions,
    defaultVersion,
    ...(readFrom !== undefined ? { readFrom } : {}),
    raw: body,
  };
}

/**
 * The price of the longest configured prefix that governs `destination`, or
 * `undefined` when this document lists no route that does.
 *
 * Matching is the connector's own rule: a prefix governs a destination when the
 * destination is the prefix, or continues it at a label boundary — so
 * `g.example.app` governs `g.example.app.sub` but never `g.example.appendix`.
 */
export function routePriceFor(desc: NodeSelfDescription, destination: string): bigint | undefined {
  let best: RoutePrice | undefined;
  for (const route of desc.routes) {
    if (destination !== route.prefix && !destination.startsWith(`${route.prefix}.`)) continue;
    if (best === undefined || route.prefix.length > best.prefix.length) best = route;
  }
  return best?.price;
}

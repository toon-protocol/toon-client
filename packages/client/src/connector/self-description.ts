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

/**
 * What a route charges, independent of which endpoint reported it.
 *
 * Both `GET /ilp` (per entry in `routes`) and `GET /ilp/routes/price` answer
 * these two figures, so {@link chargeFor} takes this shape rather than either
 * concrete type.
 */
export interface RouteCharge {
  /**
   * The base price per packet, in the settlement asset's base units.
   *
   * A `bigint` here, though the wire carries a decimal **string** — deliberately
   * so, because a price past 2^53 is a real amount and a JSON number would round
   * it. (`GET /ilp/routes/price` answers the same figure as a JSON *number*;
   * that inconsistency is the connector's, and both are normalized to `bigint`
   * by this client.)
   *
   * This is the *base*, not the total: a route that also publishes
   * {@link RouteCharge.pricePerKib} charges more than this for every packet.
   * {@link chargeFor} is the only thing that should decide what to put on a
   * claim.
   */
  price: bigint;
  /**
   * Added per kibibyte of sealed payload, when the route meters by size.
   *
   * Absent on a flat-priced route, which is most of them. Published as
   * `pricePerKib` on `GET /ilp` and as `price_per_kib` on
   * `GET /ilp/routes/price` — the same inconsistency the price itself has.
   */
  pricePerKib?: bigint;
}

/** One route the node serves, and what it costs. */
export interface RoutePrice extends RouteCharge {
  /** The ILP address prefix. Longest matching prefix wins. */
  prefix: string;
}

/** How many bytes one step of `pricePerKib` buys — a kibibyte, as the name says. */
const BYTES_PER_KIB = 1024n;

/**
 * The ceiling every charge is clamped to: `u64::MAX`, the widest an ILP
 * packet's `amount` field can carry.
 *
 * The connector's `Price::charge` is saturating throughout — an operator can
 * write a slope that overflows a `u64` on a large payload, and the answer is
 * then `u64::MAX`, a charge no claim can cover, which refuses the packet. A
 * `bigint` does not overflow and so would not clamp on its own, which would put
 * this client above the connector's own answer and produce an amount that
 * cannot be encoded into the packet it is paying for. Pinned by the
 * `charge` vectors' `saturating_*` rows.
 */
const MAX_CHARGE = (1n << 64n) - 1n;

/** `amount`, clamped the way the connector's saturating arithmetic clamps it. */
function saturate(amount: bigint): bigint {
  return amount > MAX_CHARGE ? MAX_CHARGE : amount;
}

/**
 * What one packet actually costs on `terms`, given the size of its **sealed**
 * payload.
 *
 * The metered quantity is the gift-wrapped payload the PREPARE carries — the
 * bytes of `SealedExchange.data`, not the caller's request body, which is
 * smaller by the envelope and the wrap. So a charge can only be computed after
 * sealing, which is why {@link ../client/send.js!send} seals before it prices.
 * Those bytes are the PREPARE's `data` field verbatim on both carriages
 * (`HttpIlpClient.postPrepare`, `BtpRuntimeClient`), so `sealedBytes` is exactly
 * the `prepare.data.len()` the connector prices — no envelope, header or framing
 * sits between the two counts.
 *
 * The unit count is `ceil(bytes / 1024)`: whole kibibytes plus one for any
 * remainder, and **zero** for an empty payload, which pays the base alone. That
 * is the connector's own `Price::charge`
 * (`connector-domain/src/price.rs`, `bytes.div_ceil(1024)`, connector ADR 0065),
 * evaluated there against the same `prepare.data.len()` at every gate that
 * charges — the client edge, the peer price gate, and the termination.
 *
 * Measured against the deployed store node at `1000 + 10/KiB`, whose x402
 * greeting quotes the charge for the packet it was handed:
 * 0 bytes → 1000, 1 → 1010, 1023 → 1010, **1024 → 1010**, 1025 → 1020,
 * **2048 → 1020**, 2049 → 1030, 5161 → 1060.
 *
 * Saturating, like the connector's: the answer is never more than `u64::MAX`.
 *
 * This used to compute `floor(bytes / 1024) + 1` (toon-client#629), which agrees
 * with `ceil` everywhere except an exact multiple of 1024 and an empty payload,
 * where it charged one kibibyte too many. Every size that had actually been
 * measured was a non-multiple, so the fit held and the overpay — silent, since a
 * claim that advances more than the price is simply accepted — went unnoticed.
 */
export function chargeFor(terms: RouteCharge, sealedBytes: number): bigint {
  const perKib = terms.pricePerKib;
  if (perKib === undefined || perKib === 0n) return saturate(terms.price);
  const bytes = BigInt(Math.max(0, Math.trunc(sealedBytes)));
  const units = (bytes + BYTES_PER_KIB - 1n) / BYTES_PER_KIB;
  return saturate(terms.price + perKib * units);
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
          if (prefix === undefined || price === undefined) return undefined;
          // `pricePerKib` here, `price_per_kib` on GET /ilp/routes/price. Both
          // are read so neither endpoint silently under-quotes a metered route.
          const pricePerKib = readBaseUnits(r['pricePerKib'] ?? r['price_per_kib']);
          return {
            prefix,
            price,
            ...(pricePerKib !== undefined ? { pricePerKib } : {}),
          };
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
 * Where a packet goes when the caller named a node but not a route.
 *
 * A client is configured with a **URL** — the thing a person actually has — and
 * the node's own document says what to address it as. So there is no reason to
 * make a caller repeat a route string they just read off `GET /ilp`, and every
 * reason not to: a hand-copied destination is how you end up paying a node for a
 * route it does not serve.
 *
 * The first of `ilpAddresses` this node also PRICES wins. A node lists its own
 * addresses primary-first, but an address it serves without pricing cannot be
 * paid for, so pricing is the tie-break rather than order alone — and when none
 * of them is priced the first is still returned, because being refused with the
 * route's terms is a better answer than refusing to form a packet at all.
 *
 * `undefined` only when the node claims no address, which is a broken node.
 */
export function defaultDestinationFor(desc: NodeSelfDescription): string | undefined {
  const priced = desc.ilpAddresses.find((address) => routeFor(desc, address) !== undefined);
  return priced ?? desc.ilpAddresses[0];
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
  return routeFor(desc, destination)?.price;
}

/**
 * The whole matching route rather than just its base price, so a caller can see
 * a `pricePerKib` that {@link routePriceFor} necessarily hides.
 *
 * Same longest-prefix rule; {@link routePriceFor} is this with `.price` on the
 * end, kept because a flat-priced route is still the common case.
 */
export function routeFor(
  desc: NodeSelfDescription,
  destination: string
): RoutePrice | undefined {
  let best: RoutePrice | undefined;
  for (const route of desc.routes) {
    if (destination !== route.prefix && !destination.startsWith(`${route.prefix}.`)) continue;
    if (best === undefined || route.prefix.length > best.prefix.length) best = route;
  }
  return best;
}

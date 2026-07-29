/**
 * Payment-aware HTTP fetch over TOON (the "h402" flow).
 *
 * This adapter makes paying for an HTTP resource transparent: it issues an
 * ordinary HTTP request, and when the origin answers `402 Payment Required`
 * with an x402-style challenge that offers a `toon-channel` payment option, it
 * opens/reuses a payment channel, signs a balance-proof claim, and re-sends the
 * SAME HTTP request as a "transparent HTTP-in-ILP" packet to the connector's
 * `POST /ilp` endpoint (via {@link HttpIlpClient}). The connector terminates the
 * payment, forwards the request to the origin, and returns the origin's HTTP
 * response inside the ILP FULFILL `data`. We reconstruct a normal Web `Response`
 * from those bytes — the caller never sees ILP.
 *
 * ─── x402 wire contract (the 402 challenge body) ────────────────────────────
 * The shipped connector answers x402 **v2** terms (`client-edge-spec.md` §1.4,
 * `crates/connector-client-edge/src/lib.rs`), and that is the shape pinned by
 * `Http402Client.connectorTerms.test.ts`:
 *
 * ```jsonc
 * {
 *   "x402Version": 2,
 *   "resource": { "url": "g.example.app" },
 *   "accepts": [
 *     {
 *       "scheme": "toon-channel",
 *       "network": "g.example.app",
 *       "amount": "100",
 *       "payTo": "g.example.app",
 *       "maxTimeoutSeconds": 60,
 *       "httpEndpoint": "/ilp",          // RELATIVE to the resource's origin.
 *       "extra": { "ilpAddress": "g.example.app", "endpoint": "/ilp", "price": "100" }
 *     }
 *   ]
 * }
 * ```
 *
 * Two things that shape forces, both easy to get wrong:
 *   - The ILP address, the endpoint and the price live under **`extra`**. The
 *     top-level `payTo` happens to equal the destination today, so reading it
 *     appears to work — that is a coincidence of the connector's current code,
 *     not a contract, so `extra` is read first.
 *   - `httpEndpoint` is **relative**; it is resolved against the URL that
 *     answered `402` (`Response.url`, or `parseX402Body`'s `baseUrl` argument).
 *
 * Everything is still parsed DEFENSIVELY (mirroring `readDiscoveredIlpPeer` in
 * selectIlpTransport.ts): an unrecognised connector shape degrades to the
 * vanilla 402 rather than throwing. Field aliases (first present wins):
 *   - destination: `extra.ilpAddress` | `extra.destination` | `destination` |
 *     `ilpAddress` | `payTo`. (We do NOT invent a value — a missing
 *     destination makes the entry unusable and we fall back to the vanilla 402.)
 *   - amount:      `extra.price` | `extra.amount` | `amount` | `price` |
 *     `maxAmountRequired`.
 *   - httpEndpoint:`httpEndpoint` | `ilpEndpoint` | `extra.httpEndpoint` |
 *     `extra.endpoint` | `endpoint`.
 *   - upgrade:     `supportsUpgrade` | `upgradable`.
 *
 * ─── What the paid request is made of ───────────────────────────────────────
 * The paid re-send is an OER `EnvelopeRequest` sealed to the terminating
 * connector's identity, under a condition derived from the secret that seal
 * carries — the same `sealExchange` / `readExchangeOutcome` pair
 * `ToonClient.publishEvent` uses (ADR 0018/0019, toon-client#450, #451). This
 * adapter used to carry its own HTTP/1.1 codec; it does not any more, and
 * `packages/client` now has exactly one encoder.
 *
 * Two consequences of the envelope replacing HTTP text, both deliberate:
 *
 *   - **`Host` and `Content-Length` are not synthesised.** The old codec added
 *     both. The connector strips them either way and lets its HTTP client
 *     recompute them (`connector-runtime/src/app_client.rs` skips `host` and
 *     `content-length` by name), and the envelope already carries the body
 *     length as an OER length determinant, so emitting them was writing bytes
 *     the far side throws away. A caller that sets either explicitly still has
 *     it carried verbatim, and the connector still drops it.
 *   - **A response has no reason phrase.** An `EnvelopeResponse` status is two
 *     bytes; `HTTP/1.1 201 Created`'s "Created" has nowhere to live on this
 *     wire. `Response.statusText` is therefore empty, and the status is the
 *     fact to read.
 *
 * A malformed answer now fails the way it fails everywhere else in this
 * package — `SealedResponseError` from `readExchangeOutcome` — rather than
 * this file's old `ConnectorError` on a bad status line while `fulfill-http.ts`
 * quietly returned `{isHttp:false}` for the very same bytes.
 *
 * Claim signing/construction is owned by the CALLER (ToonClient wires the live
 * ChannelManager + signer). This adapter never builds or validates claims —
 * payment-claim validation lives ONLY in the connector.
 */

import type { IlpSendResult } from '@toon-protocol/core';
import { HttpIlpClient } from './HttpIlpClient.js';
import {
  selectIlpTransport,
  type DiscoveredIlpPeer,
  type IlpTransportChoice,
} from './selectIlpTransport.js';
import { ConnectorEdgeClient } from './ConnectorEdgeClient.js';
import { ConnectorError, ToonClientError } from '../errors.js';
import { toBase64, fromBase64, encodeUtf8 } from '../utils/binary.js';
import type { EnvelopeHeader, EnvelopeResponse } from '../wire/envelope.js';
import { readExchangeOutcome, sealExchange } from '../wire/sealed-exchange.js';

// ─── x402 challenge types (documented wire contract above) ──────────────────

/** A single parsed `accepts` entry that offers the `toon-channel` scheme. */
export interface ToonChannelAccept {
  /** Always `'toon-channel'` for a matched entry. */
  scheme: 'toon-channel';
  /** Optional chain key, e.g. `evm:base:8453` — informational. */
  network?: string;
  /** ILP destination address to pay (the connector route fronting the URL). */
  destination: string;
  /** Price in ILP base units. */
  amount: bigint;
  /** The connector's `POST /ilp` URL. */
  httpEndpoint: string;
  /** Whether the host accepts the BTP upgrade over the HTTP endpoint. */
  supportsUpgrade: boolean;
}

/** The parsed x402 402 body, with the selected `toon-channel` entry (if any). */
export interface ParsedX402Challenge {
  x402Version?: number;
  /** The first usable `toon-channel` accepts entry, or `undefined`. */
  toonChannel?: ToonChannelAccept;
}

// ─── h402Fetch options (PINNED PUBLIC CONTRACT) ─────────────────────────────

/** Options for {@link Http402Client.fetch} / `ToonClient.h402Fetch`. */
export interface H402FetchOptions {
  /** HTTP method. Default `'GET'`. */
  method?: string;
  /** Request headers. */
  headers?: Record<string, string>;
  /** Request body. */
  body?: string | Uint8Array;
  /** Request timeout in milliseconds. */
  timeout?: number;
  /** Optional explicit ILP destination override (else the x402 entry's value). */
  destination?: string;
}

/**
 * Caller-supplied hook that signs a balance-proof claim for `(destination,
 * amount)` and returns the chain-appropriate claim message to attach to the ILP
 * PREPARE. ToonClient wires this to its ChannelManager + per-chain signer (the
 * exact same plumbing as `publishEvent`). The returned value is forwarded
 * opaquely as the `ILP-Payment-Channel-Claim` header by {@link HttpIlpClient}.
 */
export type ClaimResolver = (
  destination: string,
  amount: bigint
) => Promise<unknown>;

/** Factory for an {@link HttpIlpClient} given a resolved `POST /ilp` endpoint. */
export type HttpIlpClientFactory = (httpEndpoint: string) => HttpIlpClient;

export interface Http402ClientConfig {
  /**
   * Underlying HTTP fetch for the INITIAL (un-paid) request that probes for a
   * 402. Default: global `fetch`.
   */
  fetch?: typeof fetch;
  /**
   * Resolves + signs the payment-channel claim. REQUIRED to pay; if omitted,
   * a 402 with a `toon-channel` offer is surfaced unchanged (vanilla challenge).
   */
  resolveClaim?: ClaimResolver;
  /**
   * Builds the {@link HttpIlpClient} for a resolved endpoint. Default: construct
   * a new `HttpIlpClient({ httpEndpoint })`. Injectable for tests.
   */
  createIlpClient?: HttpIlpClientFactory;
  /**
   * AC4: request a duplex transport for the paid send. When `true` and the
   * toon-channel entry advertises `supportsUpgrade`, {@link selectIlpTransport}
   * returns `http-upgradable` and the send path calls
   * {@link HttpIlpClient.upgradeToBtp} before writing — the wiring for
   * large/streaming responses. Default `false` (stateless one-shot HTTP).
   *
   * NOTE (v1 limitation): even on the upgrade path the actual write is still a
   * one-shot `sendIlpPacketWithClaim`; full duplex body streaming over the BTP
   * session is a documented follow-up. The selection + upgrade CALL PATH is
   * wired and exercised here so the streaming consumer can take over the
   * returned session in a later iteration.
   */
  needsDuplex?: boolean;
  /**
   * Asks the connector named by the 402 offer for its identity key, so the
   * paid request can be sealed to it. Default: a fresh
   * {@link ConnectorEdgeClient} over this config's `fetch`. Injectable so a
   * caller that already holds one shares its identity cache rather than
   * re-fetching a key per paid request.
   */
  connectorEdge?: ConnectorEdgeClient;
}

/**
 * Reusable h402 fetch engine. `ToonClient.h402Fetch` is a thin wrapper that
 * constructs this with the live claim/channel plumbing.
 */
export class Http402Client {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveClaim?: ClaimResolver;
  private readonly createIlpClient: HttpIlpClientFactory;
  private readonly needsDuplex: boolean;
  private readonly connectorEdge: ConnectorEdgeClient;

  constructor(config: Http402ClientConfig = {}) {
    this.fetchImpl = config.fetch ?? fetch;
    this.resolveClaim = config.resolveClaim;
    this.createIlpClient =
      config.createIlpClient ??
      ((httpEndpoint) => new HttpIlpClient({ httpEndpoint }));
    this.needsDuplex = config.needsDuplex ?? false;
    this.connectorEdge =
      config.connectorEdge ??
      new ConnectorEdgeClient({
        // Same `fetch` the probe uses: a host that installs its own (and a
        // test that swaps one in) must be the one the identity comes from.
        fetch: (input, init) => this.fetchImpl(input, init),
      });
  }

  /**
   * `fetch()`-like entry point. Issues the request; on `402` parses the x402
   * challenge and — when a usable `toon-channel` offer is present and a claim
   * resolver is configured — pays over TOON and returns the reconstructed
   * `Response`. Otherwise returns the original 402 unchanged (AC5).
   */
  async fetch(url: string, opts: H402FetchOptions = {}): Promise<Response> {
    const method = (opts.method ?? 'GET').toUpperCase();

    // 1. Probe: issue the ordinary HTTP request.
    const probe = await this.fetchImpl(url, {
      method,
      ...(opts.headers ? { headers: opts.headers } : {}),
      ...(opts.body !== undefined ? { body: opts.body as BodyInit } : {}),
      ...(opts.timeout !== undefined
        ? { signal: AbortSignal.timeout(opts.timeout) }
        : {}),
    });

    // 2. Pass-through anything that isn't a 402.
    if (probe.status !== 402) return probe;

    // 3. Parse the x402 challenge defensively. We must read the body to inspect
    //    `accepts`; clone first so we can still return the ORIGINAL 402 on
    //    fallback (a Response body is single-use).
    const challenge = await parseX402Challenge(probe.clone());
    const accept = challenge.toonChannel;

    // AC5: no toon-channel offer (or no signer) → surface the vanilla challenge.
    if (!accept || !this.resolveClaim) return probe;

    // 4. Pay over TOON and return the reconstructed Response.
    return this.payOverToon(url, method, opts, accept, this.resolveClaim);
  }

  /**
   * Open/reuse a channel (via the injected claim resolver), seal the request
   * envelope to the terminating connector, send it to `POST /ilp` with the
   * claim and the matching condition, and open the answer.
   *
   * The identity is fetched BEFORE a packet is formed, and there is no default
   * to fall back to: sealing to the wrong key is a confidentiality failure
   * that merely presents as an undeliverable packet (ADR 0018).
   */
  private async payOverToon(
    url: string,
    method: string,
    opts: H402FetchOptions,
    accept: ToonChannelAccept,
    resolveClaim: ClaimResolver
  ): Promise<Response> {
    const destination = opts.destination ?? accept.destination;

    // Sign the balance-proof claim for the demanded price (caller-owned).
    const claim = await resolveClaim(destination, accept.amount);

    // The key first — no packet exists without it. The 402 named the endpoint
    // to pay, so that is the connector whose identity must seal this.
    const identity = await this.connectorEdge.getIdentity(accept.httpEndpoint);

    // One call mints the seal and the condition that matches it, so the two
    // cannot drift apart.
    const exchange = sealExchange(
      toEnvelopeRequest(url, method, opts),
      identity.publicKey
    );

    // AC4: drive transport SELECTION through selectIlpTransport. A streaming
    // response (`needsDuplex`) selects the BTP upgrade path; the one-shot case
    // stays on stateless HTTP. Full duplex byte-streaming is a documented v1
    // limitation (see selectTransport below) — the selection + upgrade call path
    // is wired and unit-tested.
    const peer: DiscoveredIlpPeer = {
      httpEndpoint: accept.httpEndpoint,
      supportsUpgrade: accept.supportsUpgrade,
    };
    const choice = selectIlpTransport(peer, {
      needsDuplex: this.needsDuplex,
    });

    const ilpClient = this.createIlpClient(accept.httpEndpoint);

    const result = await this.sendOverChoice(
      ilpClient,
      choice,
      {
        destination,
        amount: String(accept.amount),
        data: toBase64(exchange.data),
        executionCondition: exchange.condition,
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      },
      claim
    );

    // Open the answer with the secret this packet sealed. A REJECT sealed at
    // the termination is the DESTINATION refusing; a plaintext one is somebody
    // on the path. Both are `ConnectorError` here — `fetch()` has one failure
    // channel — but they no longer read as the same event.
    const outcome = readExchangeOutcome(
      result,
      result.data === undefined ? undefined : fromBase64(result.data),
      exchange.sharedSecret
    );

    if (outcome.kind === 'destination-refused') {
      throw new ConnectorError(
        `h402 request refused by the destination: ${outcome.code} ${outcome.message}`.trim()
      );
    }
    if (outcome.kind === 'path-refused') {
      throw new ConnectorError(
        `h402 request refused by a connector on the path: ${outcome.code} ${outcome.message}`.trim()
      );
    }

    return toWebResponse(outcome.response);
  }

  /**
   * Send the sealed PREPARE over the selected transport.
   *
   * - `http` / `http-upgradable`: stateless one-shot `POST /ilp` with the claim.
   * - `http-upgradable` additionally exercises {@link HttpIlpClient.upgradeToBtp}
   *   for the duplex/streaming path (AC4). v1 still drives the actual write over
   *   the one-shot HTTP method even after upgrading — full duplex body streaming
   *   is a documented follow-up — but the upgrade call path is wired here.
   * - `btp`: not reachable from h402 (the x402 offer only carries an
   *   `httpEndpoint`); guarded for completeness.
   */
  private async sendOverChoice(
    ilpClient: HttpIlpClient,
    choice: IlpTransportChoice,
    params: {
      destination: string;
      amount: string;
      data: string;
      executionCondition: Uint8Array;
      timeout?: number;
    },
    claim: unknown
  ): Promise<IlpSendResult> {
    if (choice.kind === 'http-upgradable') {
      // Wire the upgrade path: obtain (and immediately release) a duplex BTP
      // session so a streaming consumer can take it over in a follow-up. The
      // one-shot write below still terminates the payment for v1.
      const btp = await ilpClient.upgradeToBtp();
      try {
        // BtpRuntimeClient types `claim` as Record<string, unknown>; the claim
        // message is an opaque forwarded envelope (same cast ToonClient uses).
        return await btp.sendIlpPacketWithClaim(
          params,
          claim as Record<string, unknown>
        );
      } finally {
        await btp.disconnect().catch(() => undefined);
      }
    }
    if (choice.kind === 'btp') {
      throw new ToonClientError(
        'h402 offer resolved to a BTP-only transport; the x402 toon-channel entry must advertise an httpEndpoint',
        'INVALID_STATE'
      );
    }
    // 'http'
    return ilpClient.sendIlpPacketWithClaim(params, claim);
  }
}

// ─── x402 challenge parsing (defensive) ─────────────────────────────────────

/** First defined string among the given keys on `obj`. */
function readString(
  obj: Record<string, unknown>,
  keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
  }
  return undefined;
}

/** First parseable bigint among the given keys (string|number) on `obj`. */
function readAmount(
  obj: Record<string, unknown>,
  keys: string[]
): bigint | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'bigint') return v;
    if (typeof v === 'number' && Number.isFinite(v))
      return BigInt(Math.trunc(v));
    if (typeof v === 'string' && /^\d+$/.test(v.trim()))
      return BigInt(v.trim());
  }
  return undefined;
}

/**
 * Turn an `httpEndpoint` into something fetchable.
 *
 * The Rust connector emits a RELATIVE endpoint (`"/ilp"`), because the terms
 * describe an endpoint on the origin that answered. Resolved against the
 * resource URL it becomes the absolute `POST /ilp` URL this adapter needs. An
 * already-absolute endpoint is returned unchanged; a relative one with no base
 * to resolve against is passed through as before, so nothing that worked
 * previously stops working.
 */
function resolveEndpoint(
  endpoint: string | undefined,
  baseUrl: string | undefined
): string | undefined {
  if (!endpoint || !baseUrl) return endpoint;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(endpoint)) return endpoint;
  try {
    return new URL(endpoint, baseUrl).toString();
  } catch {
    return endpoint;
  }
}

/**
 * Parse a 402 `Response` body into a {@link ParsedX402Challenge}, selecting the
 * first usable `toon-channel` entry. Reads every field defensively; a malformed
 * body, a non-JSON body, or an entry missing its `destination`/`httpEndpoint`
 * yields `{ toonChannel: undefined }` so the caller falls back to the vanilla
 * 402 rather than throwing.
 */
export async function parseX402Challenge(
  response: Response
): Promise<ParsedX402Challenge> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {};
  }
  // `response.url` is the resource that answered 402 — the base a relative
  // `httpEndpoint` (which is what the Rust connector actually emits: `/ilp`)
  // has to be resolved against.
  return parseX402Body(body, response.url || undefined);
}

/**
 * Pure parser over an already-decoded x402 body (testable without a Response).
 *
 * `baseUrl`, when given, is the absolute URL of the resource that answered
 * `402`; a relative `httpEndpoint` is resolved against it. Omitting it keeps
 * the old behaviour of passing the endpoint through verbatim.
 */
export function parseX402Body(
  body: unknown,
  baseUrl?: string
): ParsedX402Challenge {
  if (typeof body !== 'object' || body === null) return {};
  const b = body as Record<string, unknown>;

  const version =
    typeof b['x402Version'] === 'number'
      ? (b['x402Version'] as number)
      : undefined;

  const accepts = Array.isArray(b['accepts'])
    ? (b['accepts'] as unknown[])
    : [];

  for (const raw of accepts) {
    if (typeof raw !== 'object' || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const scheme = readString(entry, ['scheme']);
    if (scheme !== 'toon-channel') continue;

    // The Rust connector puts the ILP address, the endpoint and the price
    // under `extra` (`crates/connector-client-edge/src/lib.rs`, client-edge-spec
    // §1.4) — NOT at the entry's top level. `extra` is therefore read as a
    // first-class source, not a fallback: reading `payTo` instead only ever
    // worked because that connector happens to set it to the destination too,
    // which is a coincidence of today's code and not part of the contract.
    const extra =
      typeof entry['extra'] === 'object' && entry['extra'] !== null
        ? (entry['extra'] as Record<string, unknown>)
        : {};

    const destination =
      readString(extra, ['ilpAddress', 'destination']) ??
      readString(entry, ['destination', 'ilpAddress', 'payTo']);
    const rawEndpoint =
      readString(entry, ['httpEndpoint', 'ilpEndpoint']) ??
      readString(extra, ['httpEndpoint', 'endpoint']) ??
      readString(entry, ['endpoint']);
    const httpEndpoint = resolveEndpoint(rawEndpoint, baseUrl);
    const amount =
      readAmount(extra, ['price', 'amount']) ??
      readAmount(entry, ['amount', 'price', 'maxAmountRequired']);

    // A usable entry MUST carry where to pay, how much, and how to reach /ilp.
    if (!destination || !httpEndpoint || amount === undefined) continue;

    const network = readString(entry, ['network', 'chain']);
    const supportsUpgrade =
      entry['supportsUpgrade'] === true || entry['upgradable'] === true;

    return {
      ...(version !== undefined ? { x402Version: version } : {}),
      toonChannel: {
        scheme: 'toon-channel',
        ...(network !== undefined ? { network } : {}),
        destination,
        amount,
        httpEndpoint,
        supportsUpgrade,
      },
    };
  }

  return version !== undefined ? { x402Version: version } : {};
}

// ─── The one envelope, in and out ───────────────────────────────────────────

/** Normalize an optional string|Uint8Array body to bytes. */
function bodyToBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  return typeof body === 'string' ? encodeUtf8(body) : body;
}

/**
 * Turn a caller's `fetch`-shaped request into the `EnvelopeRequest` that is
 * sealed into the packet.
 *
 * The target is origin-form (`path` + `search`), which is what the connector
 * appends to the handler URL it forwards to — an absolute URL here would be
 * routed by the ILP destination anyway and only confuse the far side.
 *
 * Headers are carried in the caller's own order, names verbatim. The envelope
 * is a LIST of pairs, not a map, so order and duplicates both survive — which
 * the old `Map`-based serializer destroyed. Nothing is synthesised: `Host` and
 * `Content-Length` are the connector's to recompute (see the module docs).
 */
function toEnvelopeRequest(
  url: string,
  method: string,
  opts: H402FetchOptions
): {
  method: string;
  target: string;
  headers: EnvelopeHeader[];
  body: Uint8Array;
} {
  const u = new URL(url);
  const headers: EnvelopeHeader[] = Object.entries(opts.headers ?? {}).map(
    ([name, value]) => [name, value] as EnvelopeHeader
  );
  return {
    method: method.toUpperCase(),
    target: `${u.pathname}${u.search}` || '/',
    headers,
    body: bodyToBytes(opts.body),
  };
}

/**
 * Present a decoded {@link EnvelopeResponse} as the standard Web `Response`
 * this adapter's callers expect.
 *
 * An adaptation, not a codec: nothing is parsed here, because the status,
 * headers and body arrived already separated by the envelope decoder.
 *
 * `statusText` is left empty — the envelope carries a two-byte status and no
 * reason phrase, so there is no "Created" to report. `Headers.append` keeps
 * duplicates (`set-cookie`), and a null-body status never gets one, which
 * `Response` would throw over.
 */
function toWebResponse(envelope: EnvelopeResponse): Response {
  const headers = new Headers();
  for (const [name, value] of envelope.headers) {
    // Hop-by-hop framing headers describe an HTTP/1.1 connection that no
    // longer exists once the answer is an envelope; `Response` recomputes its
    // own body length regardless.
    if (name.toLowerCase() === 'content-length') continue;
    headers.append(name, value);
  }

  const status = envelope.status;
  const nullBodyStatus =
    status === 101 || status === 204 || status === 205 || status === 304;

  return new Response(
    nullBodyStatus || envelope.body.length === 0
      ? null
      : (envelope.body.slice() as unknown as BodyInit),
    { status, headers }
  );
}

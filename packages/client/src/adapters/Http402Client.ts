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
 * The connector side (the 402 greeting + the `accepts` entries) is a separate,
 * NOT-YET-BUILT dependency, so we parse DEFENSIVELY (mirroring
 * `readDiscoveredIlpPeer` in selectIlpTransport.ts): a slightly different
 * connector shape should degrade gracefully (fall back to the vanilla 402)
 * rather than throw.
 *
 * Expected 402 JSON body (x402 v1-ish):
 * ```jsonc
 * {
 *   "x402Version": 1,
 *   "accepts": [
 *     {
 *       "scheme": "toon-channel",      // REQUIRED — selects the TOON option.
 *       "network": "evm:base:8453",    // optional — chain key (informational).
 *       "destination": "g.toon.apex",  // ILP destination address to pay (the
 *                                      //   connector route that fronts the URL).
 *       "amount": "1000",              // price in ILP base units (string|number).
 *       "httpEndpoint": "https://apex/ilp", // the connector's POST /ilp URL.
 *       "supportsUpgrade": true        // optional — host accepts the BTP upgrade.
 *     }
 *   ]
 * }
 * ```
 *
 * Field aliases read defensively (first present wins):
 *   - destination: `destination` | `ilpAddress` | `payTo` | `maxAmountRequired`'s
 *     sibling `payTo`. (We do NOT invent a value — a missing destination makes
 *     the entry unusable and we fall back to the vanilla 402.)
 *   - amount:      `amount` | `price` | `maxAmountRequired`.
 *   - httpEndpoint:`httpEndpoint` | `ilpEndpoint` | `endpoint`.
 *   - upgrade:     `supportsUpgrade` | `upgradable`.
 *
 * ─── HTTP-in-ILP framing ────────────────────────────────────────────────────
 * The raw HTTP request/response is serialized as minimal HTTP/1.1 wire bytes
 * (request-line / status-line + headers + CRLFCRLF + body) and carried as the
 * ILP packet `data` (base64). See {@link serializeHttpRequest} /
 * {@link parseHttpResponse}. This keeps the connector free to forward the bytes
 * verbatim and lets us rebuild a standard `Response`.
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
import { ConnectorError, ToonClientError } from '../errors.js';
import {
  toBase64,
  fromBase64,
  encodeUtf8,
  decodeUtf8,
} from '../utils/binary.js';

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

  constructor(config: Http402ClientConfig = {}) {
    this.fetchImpl = config.fetch ?? fetch;
    this.resolveClaim = config.resolveClaim;
    this.createIlpClient =
      config.createIlpClient ??
      ((httpEndpoint) => new HttpIlpClient({ httpEndpoint }));
    this.needsDuplex = config.needsDuplex ?? false;
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
   * Open/reuse a channel (via the injected claim resolver), serialize the HTTP
   * request into the ILP packet `data`, send it to `POST /ilp` with the claim,
   * and reconstruct the origin `Response` from the FULFILL `data`.
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

    // Serialize the raw HTTP request into HTTP/1.1 wire bytes for `data`.
    const requestBytes = serializeHttpRequest({
      method,
      url,
      headers: opts.headers,
      body: opts.body,
    });

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
        data: toBase64(requestBytes),
        ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      },
      claim
    );

    if (!result.accepted) {
      throw new ConnectorError(
        `h402 payment rejected by connector: ${result.code ?? 'F00'} ${
          result.message ?? ''
        }`.trim()
      );
    }
    if (!result.data) {
      throw new ConnectorError(
        'h402 FULFILL carried no data (expected an HTTP response payload)'
      );
    }

    // Reconstruct the standard Response from the FULFILL `data` bytes.
    return parseHttpResponse(fromBase64(result.data));
  }

  /**
   * Send the serialized HTTP-in-ILP PREPARE over the selected transport.
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
    if (typeof v === 'number' && Number.isFinite(v)) return BigInt(Math.trunc(v));
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return BigInt(v.trim());
  }
  return undefined;
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
  return parseX402Body(body);
}

/** Pure parser over an already-decoded x402 body (testable without a Response). */
export function parseX402Body(body: unknown): ParsedX402Challenge {
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

    const destination = readString(entry, [
      'destination',
      'ilpAddress',
      'payTo',
    ]);
    const httpEndpoint = readString(entry, [
      'httpEndpoint',
      'ilpEndpoint',
      'endpoint',
    ]);
    const amount = readAmount(entry, ['amount', 'price', 'maxAmountRequired']);

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

// ─── HTTP-in-ILP framing (minimal HTTP/1.1 serialize/parse) ─────────────────

const CRLF = '\r\n';

/** Bytes of a string concatenated with a Uint8Array body (no extra copies of body). */
function concatHeadAndBody(head: string, body: Uint8Array): Uint8Array {
  const headBytes = encodeUtf8(head);
  const out = new Uint8Array(headBytes.length + body.length);
  out.set(headBytes, 0);
  out.set(body, headBytes.length);
  return out;
}

/** Normalize an optional string|Uint8Array body to bytes. */
function bodyToBytes(body: string | Uint8Array | undefined): Uint8Array {
  if (body === undefined) return new Uint8Array(0);
  return typeof body === 'string' ? encodeUtf8(body) : body;
}

/**
 * Serialize a raw HTTP request to HTTP/1.1 wire bytes:
 * `METHOD path HTTP/1.1\r\n` + `Host:` + headers + `\r\n\r\n` + body.
 *
 * The request-line target is the URL's path+query (origin-form); we add a
 * `Host` header from the URL authority and a `Content-Length` when there's a
 * body, unless the caller already supplied them. Header names are matched
 * case-insensitively so we never duplicate `Host`/`Content-Length`.
 */
export function serializeHttpRequest(req: {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: string | Uint8Array;
}): Uint8Array {
  const u = new URL(req.url);
  const target = `${u.pathname}${u.search}` || '/';
  const bodyBytes = bodyToBytes(req.body);

  const headers = new Map<string, string>(); // lower-name → "Name: value"
  const put = (name: string, value: string) =>
    headers.set(name.toLowerCase(), `${name}: ${value}`);
  const has = (name: string) => headers.has(name.toLowerCase());

  for (const [name, value] of Object.entries(req.headers ?? {})) {
    put(name, value);
  }
  if (!has('host')) put('Host', u.host);
  if (bodyBytes.length > 0 && !has('content-length')) {
    put('Content-Length', String(bodyBytes.length));
  }

  const lines = [
    `${req.method.toUpperCase()} ${target} HTTP/1.1`,
    ...headers.values(),
  ];
  const head = lines.join(CRLF) + CRLF + CRLF;
  return concatHeadAndBody(head, bodyBytes);
}

/** Find the index just past the first `\r\n\r\n` (header/body boundary). */
function findHeaderEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (
      bytes[i] === 0x0d &&
      bytes[i + 1] === 0x0a &&
      bytes[i + 2] === 0x0d &&
      bytes[i + 3] === 0x0a
    ) {
      return i + 4;
    }
  }
  return -1;
}

/**
 * Parse HTTP/1.1 wire bytes (status-line + headers + CRLFCRLF + body) into a
 * standard Web `Response`. Used to reconstruct the origin response from the ILP
 * FULFILL `data`.
 *
 * @throws {ConnectorError} If the bytes are not a parseable HTTP/1.1 response.
 */
export function parseHttpResponse(bytes: Uint8Array): Response {
  const headerEnd = findHeaderEnd(bytes);
  // No header/body separator: treat the whole payload as a header block (some
  // bodiless responses may omit the trailing CRLFCRLF); fall back to end.
  const headBytes =
    headerEnd === -1 ? bytes : bytes.subarray(0, headerEnd - 2);
  const body = headerEnd === -1 ? new Uint8Array(0) : bytes.subarray(headerEnd);

  const headText = decodeUtf8(headBytes);
  const lines = headText.split(CRLF).filter((l) => l.length > 0);
  const statusLine = lines.shift();
  if (!statusLine) {
    throw new ConnectorError(
      'h402 response payload had no HTTP status line'
    );
  }

  // `HTTP/1.1 200 OK` — tolerate a missing reason phrase.
  const match = /^HTTP\/\d\.\d\s+(\d{3})(?:\s+(.*))?$/.exec(statusLine.trim());
  if (!match) {
    throw new ConnectorError(
      `h402 response payload had a malformed status line: "${statusLine}"`
    );
  }
  const status = parseInt(match[1] as string, 10);
  const statusText = match[2] ?? '';

  const headers = new Headers();
  for (const line of lines) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name.length === 0) continue;
    // 204/304 etc. must not carry these on a Web Response — Headers tolerates
    // them, but Response construction below sets the real body length anyway.
    headers.append(name, value);
  }

  // `Response` forbids a body for null-body statuses (101/204/205/304).
  const nullBodyStatus =
    status === 101 || status === 204 || status === 205 || status === 304;
  const init: ResponseInit = { status, headers };
  if (statusText) init.statusText = statusText;

  return new Response(
    nullBodyStatus || body.length === 0 ? null : body.slice(),
    init
  );
}

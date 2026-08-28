/**
 * A fake terminating connector for tests: it holds an identity key, answers
 * `GET /ilp/identity` with it, opens what a sender sealed to it, and seals its
 * answer back with the secret it recovered.
 *
 * It exists because a sealed exchange cannot be faked one half at a time. A
 * test that hand-writes FULFILL bytes has to hand-write the seal too, which
 * means encoding this repo's own idea of the wire into the fixture — and a
 * mistake in the implementation would be copied faithfully into the
 * expectation. Here the ONLY way to produce a response the client can open is
 * to genuinely open the request first, so the two directions check each other.
 *
 * The crypto is the shipped crypto (`giftwrap.ts`, itself replayed against the
 * connector's committed vectors); nothing here reimplements it.
 *
 * Test-only. Nothing in `src/index.ts` reaches it, so it is not published.
 *
 * ─── The client edge, not just the seal ─────────────────────────────────────
 * Since 1.0 this fake also serves the four client-edge routes a real send
 * traverses — `GET /ilp` (the self-description), `GET /ilp/identity`,
 * `GET /ilp/routes/price` and the claim-bearing `POST /ilp` — so
 * {@link ../client/send.js!send} can be driven end to end over an injected
 * `fetch` with no socket, no chain and no connector process. The knobs below
 * ({@link FakeTerminatingConnector.refusal},
 * {@link FakeTerminatingConnector.requiredTransport}) reproduce the refusals the
 * client has to get right, each shaped exactly as `client-edge-spec.md`
 * describes it: an underpayment reports the route's price as the accumulated
 * cost, an over-deposit reports zero, and an unknown channel reports neither.
 */

import {
  decodeEnvelopeRequest,
  encodeEnvelopeResponse,
  type EnvelopeRequest,
  type EnvelopeResponse,
} from './envelope.js';
import {
  deriveFulfillment,
  localGiftWrapEcdh,
  openRequest,
  sealResponse,
} from './giftwrap.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { toBase64, fromBase64, encodeUtf8, decodeUtf8 } from '../utils/binary.js';
import {
  deserializeIlpPrepare,
  serializeIlpFulfill,
  serializeIlpReject,
} from '../btp/protocol.js';
import type {
  ConnectorSettlementTerms,
  ConnectorSolanaSettlementTerms,
} from '../connector/ConnectorEdgeClient.js';

/**
 * How this connector refuses the next claim-bearing request, when it does.
 *
 * Each value is one row of `client-edge-spec.md` §1.3's refusal taxonomy, and
 * the differences between them are exactly what a client has to get right:
 *
 * - `underpay` — the claim's cumulative did not advance by the route's price.
 *   `F03`, and the accumulated cost IS the price, which makes an underpayment
 *   the cheapest way to learn one.
 * - `overDeposit` — the cumulative exceeds the channel's on-chain deposit.
 *   Also `F03`, but the cost is `0`: nothing was traversed and nothing
 *   terminated, and the remedy is to deposit more and resend the SAME claim.
 * - `unknownChannel` — the claim names a channel this connector holds no
 *   record of. `F01`, no cost at all, and the one refusal that means a client's
 *   binding is dead rather than its arithmetic wrong.
 * - `sealedReject` — the destination itself refused, sealed with the request's
 *   own secret so the refusal is provably its.
 * - `pathReject` — somebody short of the destination refused, in plaintext,
 *   which identifies nobody.
 * - `greeting` — the connector answers `402` with its terms even though a claim
 *   was presented, which is what a route refuses a wrong carriage or an
 *   unrecognised channel with before it routes anything.
 * - `routedButUnbanked` — a FULFILL whose `claim-ack` says the claim was
 *   REFUSED. The single most load-bearing case in the connector's vector set:
 *   the two verdicts are independent and neither may be inferred from the other.
 */
export type FakeRefusal =
  | 'greeting'
  | 'underpay'
  | 'overDeposit'
  | 'unknownChannel'
  | 'sealedReject'
  | 'pathReject'
  | 'routedButUnbanked';

/** What a request, once opened, turns out to have been. */
export interface OpenedPrepare {
  request: EnvelopeRequest;
  sharedSecret: Uint8Array;
  /** The fulfilment this connector would return: derived, never invented. */
  fulfillment: Uint8Array;
}

export interface FakeTerminatingConnectorOptions {
  /** 32-byte identity secret. Default: a fixed, obviously-test key. */
  identitySecret?: Uint8Array;
  /** The client-edge origin this connector answers on. */
  endpoint?: string;
}

/**
 * A connector that terminates every packet it is handed.
 *
 * `answer` is what the app behind it says; set it per test. `opened` records
 * every request it decoded, so a test can assert on what actually crossed the
 * wire rather than on what the caller intended to send.
 */
export class FakeTerminatingConnector {
  readonly identitySecret: Uint8Array;
  readonly identityPublic: Uint8Array;
  readonly endpoint: string;
  readonly opened: OpenedPrepare[] = [];

  /** The app's answer. Replace to drive a different status/body. */
  answer: EnvelopeResponse = {
    status: 200,
    headers: [['content-type', 'application/json']],
    body: new TextEncoder().encode('{"ok":true}'),
  };

  /**
   * What every destination costs here — the flat per-handler price ADR 0020
   * makes a route's whole fee. `null` means this connector terminates no
   * matching route, which it reports as the `404` a real one does.
   */
  routePrice: bigint | null = 1000n;

  /**
   * The per-kibibyte rate this connector meters by, on top of
   * {@link FakeConnector.routePrice}. `undefined` — the default — is a
   * flat-priced route, which is most of them; set it to exercise a metered one.
   */
  pricePerKib: bigint | undefined = undefined;

  /**
   * The channel-opening facts the 402 greeting carries (connector #617).
   * `null` — the default — is a settlement-less node: the greeting has no
   * `settlement` key at all, exactly as the real edge omits it.
   */
  settlementTerms: ConnectorSettlementTerms | null = null;

  /**
   * The additive per-chain `settlements` list the greeting carries beside
   * `settlementTerms` (connector #632) — untagged on the wire, one entry per
   * chain this fake "settles on". `null` — the default — omits the key
   * entirely, exactly as a pre-#632 (or settlement-less) node's greeting
   * does.
   */
  settlements:
    | (ConnectorSettlementTerms | ConnectorSolanaSettlementTerms)[]
    | null = null;

  /**
   * Additional members merged into the greeting's `accepts[0].extra` bag
   * beside `settlement`/`settlements` (issue #509, e.g.
   * `session_lease_ttl_ms`). `null` — the default — adds nothing beyond the
   * fixture's own `ilpAddress`/`endpoint`/`price` fields.
   */
  extraFields: Record<string, unknown> | null = null;

  // ─── The self-description this node answers `GET /ilp` with ───────────────

  /** The addresses this node answers to. */
  ilpAddresses: string[] = ['g.fake'];
  /** The routes it prices, as the self-description lists them (price as a STRING). */
  routes: { prefix: string; price: string }[] = [{ prefix: 'g.fake', price: '1000' }];
  /**
   * The settlement entries `GET /ilp` publishes — separate from
   * {@link settlements}, which is the greeting's list, because a test may want a
   * node that settles on a chain while its greeting says nothing.
   */
  describeSettlements: Record<string, unknown>[] = [
    {
      chain: 'evm:84532',
      settlementAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      tokenNetworkRegistry: '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1',
      tokenNetwork: '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478',
      tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
      decimals: 6,
    },
  ];
  /** Set to pin every route to one carriage, as the devnet relay pins BTP. */
  requiredTransport: 'http' | 'btp' | null = null;
  /** Set to omit the sealing key from the self-description, forcing the `/ilp/identity` fallback. */
  publishEdgeIdentity = true;

  // ─── How the next claim-bearing request is answered ───────────────────────

  /** `null` (the default) fulfils. Otherwise, one row of the refusal taxonomy. */
  refusal: FakeRefusal | null = null;
  /** Every claim this connector was presented with, in order. */
  readonly claims: Record<string, unknown>[] = [];
  /** Every claim-bearing request, whether or not it was fulfilled. */
  paidRequests = 0;
  /** Set to refuse every probe with `403`, as a node over its probe rate limit does. */
  probeForbidden = false;

  constructor(options: FakeTerminatingConnectorOptions = {}) {
    this.identitySecret = options.identitySecret ?? new Uint8Array(32).fill(9);
    this.identityPublic = secp256k1.getPublicKey(this.identitySecret, false);
    this.endpoint = options.endpoint ?? 'http://connector.test';
  }

  /** `0x`-prefixed uncompressed hex, exactly as `GET /ilp/identity` reports. */
  get publicKeyHex(): string {
    return `0x${Array.from(this.identityPublic, (b) =>
      b.toString(16).padStart(2, '0')
    ).join('')}`;
  }

  /** The self-description this node answers `GET /ilp` with. */
  selfDescription(): Record<string, unknown> {
    return {
      ilpAddresses: this.ilpAddresses,
      httpEndpoint: `${this.endpoint}/ilp`,
      btpEndpoint: `${this.endpoint.replace(/^http/, 'ws')}/ilp/btp`,
      peerCarriages: [],
      ...(this.publishEdgeIdentity
        ? { edgeIdentity: { keyId: 'fake', publicKey: this.publicKeyHex } }
        : {}),
      settlements: this.describeSettlements,
      routes: this.routes,
      ...(this.requiredTransport ? { requiredTransport: this.requiredTransport } : {}),
      supportedVersions: [1],
      defaultVersion: 1,
    };
  }

  /**
   * A `fetch` serving this connector's client edge: `GET /ilp`,
   * `GET /ilp/identity`, `GET /ilp/routes/price`, and `POST /ilp` both with and
   * without a claim. Anything else 404s, so a test that reaches an unexpected
   * route fails loudly.
   */
  fetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();

    if (method === 'GET' && (url.endsWith('/ilp') || url.endsWith('/ilp/'))) {
      return new Response(JSON.stringify(this.selfDescription()), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.endsWith('/ilp/identity')) {
      return new Response(
        JSON.stringify({ keyId: 'fake', publicKey: this.publicKeyHex }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.includes('/ilp/routes/price')) {
      if (this.routePrice === null) {
        return new Response('no route', { status: 404 });
      }
      const destination =
        new URL(url, 'http://x.invalid').searchParams.get('destination') ?? '';
      return new Response(
        // `price` is a JSON NUMBER on this endpoint, as the connector emits it,
        // and the per-KiB rate is `price_per_kib` — snake_case HERE and
        // camelCase in `GET /ilp`, matching the real edge's own inconsistency.
        JSON.stringify({
          destination,
          price: Number(this.routePrice),
          ...(this.pricePerKib !== undefined
            ? { price_per_kib: Number(this.pricePerKib) }
            : {}),
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    // `POST /ilp/probe` (client-edge-spec.md §1.6): the same framing as a paid
    // request, but nothing is charged and nothing is DELIVERED. A destination
    // this node terminates is answered `F03` carrying that route's price — the
    // same figure a real request would be charged, and the whole path cost,
    // since no hop was traversed to reach it. Free traversal is all a probe
    // buys; it does not also buy the work behind a priced route.
    if (method === 'POST' && url.endsWith('/ilp/probe')) {
      const probeClaim = readHeader(init?.headers, 'ilp-payment-channel-claim');
      if (probeClaim === undefined || this.probeForbidden) {
        // A probe is accepted only from a sender identified by a claim on a
        // channel this connector recognizes. `403`, distinct from `401`: the
        // sender may be perfectly well authenticated and simply not authorized.
        return new Response('probe forbidden', { status: 403 });
      }
      this.claims.push(
        JSON.parse(decodeUtf8(fromBase64(probeClaim))) as Record<string, unknown>
      );
      return this.rejectResponse(
        serializeIlpReject({
          code: 'F03',
          triggeredBy: 'g.fake',
          message: 'probe: destination terminates here and is priced',
          data: new Uint8Array(0),
        }),
        { cost: this.routePrice ?? 0n }
      );
    }

    // A claim-bearing POST /ilp: the paid path. The claim is RECORDED rather
    // than verified — this fake holds no chain to verify it against, and what a
    // client test needs to know is what it put on the wire, not whether a
    // counterfactual connector would have banked it.
    const claimHeader = readHeader(init?.headers, 'ilp-payment-channel-claim');
    if (method === 'POST' && url.endsWith('/ilp') && claimHeader !== undefined) {
      this.paidRequests += 1;
      this.claims.push(
        JSON.parse(decodeUtf8(fromBase64(claimHeader))) as Record<string, unknown>
      );
      return this.answerPaidRequest(init?.body);
    }

    // A claimless POST /ilp to a PRICED route: the x402 greeting
    // (client-edge-spec.md §1.4), including the channel-opening facts when
    // this fake "has a settlement backend" (connector #617). The real edge
    // answers 402 without routing the packet, so the fake does not decode
    // the PREPARE either — the greeting depends only on the route's price.
    //
    // `price = 0` is NOT greeted, and that asymmetry is the point of the rule
    // that a terminated route must state a price: zero is how an operator
    // writes down that a route is deliberately free, and a free route runs no
    // claim gate — an unpaid request to one is simply routed. Verified against
    // the devnet relay, whose `g.toon.relay.ephemeral` is priced at zero and
    // answers a claimless request with the app's own reply.
    if (url.endsWith('/ilp') && this.routePrice !== null && this.routePrice > 0n) {
      return this.greeting();
    }
    // A claimless request to a free route is delivered like any other.
    if (url.endsWith('/ilp') && this.routePrice === 0n) {
      return this.answerPaidRequest(init?.body);
    }
    return new Response('not found', { status: 404 });
  };

  /**
   * The x402 greeting (`client-edge-spec.md` §1.4): the terms an unpaid — or
   * otherwise unacceptable — request is answered with instead of being
   * performed. Includes the channel-opening facts when this fake "has a
   * settlement backend", and `extra.requiredTransport` when its routes are
   * pinned to one carriage.
   */
  private greeting(): Response {
    const destination = 'g.fake.route';
    const price = String(this.routePrice ?? 0n);
    const body = JSON.stringify({
      x402Version: 2,
      resource: { url: destination },
      accepts: [
        {
          scheme: 'toon-channel',
          network: destination,
          amount: price,
          payTo: destination,
          maxTimeoutSeconds: 60,
          httpEndpoint: '/ilp',
          extra: {
            ilpAddress: destination,
            endpoint: '/ilp',
            price,
            ...(this.requiredTransport
              ? { requiredTransport: this.requiredTransport }
              : {}),
            ...(this.settlementTerms ? { settlement: this.settlementTerms } : {}),
            ...(this.settlements ? { settlements: this.settlements } : {}),
            ...(this.extraFields ?? {}),
          },
        },
      ],
    });
    return new Response(body, {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Answer one claim-bearing PREPARE, shaped by {@link refusal}.
   *
   * The three facts that ride BESIDE the packet — the accumulated cost, the
   * claim ack, the x402 greeting — are set as HTTP headers here rather than
   * encoded into the OER body, because that is where they live on this carriage
   * (`client-edge-spec.md` §1.6). A fake that put them inside the packet would
   * let a client that read them from the wrong place pass.
   */
  private answerPaidRequest(body: RequestInit['body']): Response {
    if (this.refusal === 'greeting') return this.greeting();

    const prepare = deserializeIlpPrepare(toBytes(body));
    const dataBase64 = toBase64(prepare.data);

    switch (this.refusal) {
      case 'underpay':
        // The claim did not advance by the route's price. `F03`, and the cost
        // reported IS that price — the refusal's whole subject is the figure
        // the sender did not cover.
        return this.rejectResponse(
          serializeIlpReject({
            code: 'F03',
            triggeredBy: 'g.fake',
            message: 'claim rejected: amount not advancing by the route price',
            data: new Uint8Array(0),
          }),
          {
            cost: this.routePrice ?? 0n,
            claimAck: { result: 'rejected', reason: 'amount_not_advancing' },
          }
        );

      case 'overDeposit':
        // The cumulative exceeds the channel's on-chain deposit. Also `F03`, but
        // the cost is 0: nothing was traversed and nothing terminated. Deposit
        // more and resend the SAME claim, at the same nonce.
        return this.rejectResponse(
          serializeIlpReject({
            code: 'F03',
            triggeredBy: 'g.fake',
            message:
              'claim rejected: cumulative transferredAmount exceeds the channel deposit',
            data: new Uint8Array(0),
          }),
          { cost: 0n }
        );

      case 'unknownChannel':
        return this.rejectResponse(
          serializeIlpReject({
            code: 'F01',
            triggeredBy: 'g.fake',
            message: 'claim rejected: names a channel this connector has no record of',
            data: new Uint8Array(0),
          }),
          { claimAck: { result: 'rejected', reason: 'unknown_channel' } }
        );

      case 'sealedReject': {
        const sealed = this.rejectSealed(dataBase64, 'F99', 'the app refused');
        return this.rejectResponse(
          serializeIlpReject({
            code: sealed.code,
            triggeredBy: 'g.fake',
            message: sealed.message,
            data: fromBase64(sealed.data),
          }),
          {}
        );
      }

      case 'pathReject':
        return this.rejectResponse(
          serializeIlpReject({
            code: 'F02',
            triggeredBy: 'g.hop',
            message: 'no route to destination',
            data: new Uint8Array(0),
          }),
          {}
        );

      case 'routedButUnbanked': {
        // A FULFILL carrying a REJECTED claim ack. The ILP verdict and the
        // claim's verdict are independent, and neither may be inferred from the
        // other; this is the case that proves it.
        const fulfilled = this.fulfill(dataBase64);
        return this.fulfillResponse(fulfilled, {
          claimAck: { result: 'rejected', reason: 'nonce_not_advancing' },
        });
      }

      case null:
      default: {
        const fulfilled = this.fulfill(dataBase64);
        return this.fulfillResponse(fulfilled, { claimAck: { result: 'accepted' } });
      }
    }
  }

  private fulfillResponse(
    fulfilled: { data: string; fulfillment: string },
    meta: { claimAck?: { result: string; reason?: string } }
  ): Response {
    return new Response(
      serializeIlpFulfill({
        fulfillment: fromBase64(fulfilled.fulfillment),
        data: fromBase64(fulfilled.data),
      }).slice(),
      { status: 200, headers: metaHeaders(meta) }
    );
  }

  private rejectResponse(
    packet: Uint8Array,
    meta: { cost?: bigint; claimAck?: { result: string; reason?: string } }
  ): Response {
    return new Response(packet.slice(), {
      status: 200,
      headers: metaHeaders(meta),
    });
  }

  /**
   * Open a base64 PREPARE `data` as this connector would, recording it.
   *
   * Enforces ADR 0025 (connector #596) on the envelope's target exactly as
   * `resolve_target_under_handler` does: a target is resolved strictly
   * beneath the route's handler path, so `''` and `'/'` mean "the handler's
   * own path" and anything else starting with `/`, containing a `..`/`.`
   * segment, a backslash, or a scheme is refused. A fake that accepted
   * `'/write'` here while the real edge answers F00 is exactly the drift
   * ADR 0007 forbids — and is how the suite stayed green while the deployed
   * connector refused every default-target write.
   *
   * @throws whatever `openRequest`/`decodeEnvelopeRequest` throw — a test
   *   sending unsealed or misdirected bytes should fail here, loudly.
   * @throws {Error} on a target ADR 0025 refuses, mirroring the F00 reject.
   */
  open(dataBase64: string): OpenedPrepare {
    const { envelopeBytes, sharedSecret } = openRequest(
      fromBase64(dataBase64),
      localGiftWrapEcdh(this.identitySecret)
    );
    const request = decodeEnvelopeRequest(envelopeBytes);
    assertTargetStaysUnderHandler(request.target);
    const entry: OpenedPrepare = {
      request,
      sharedSecret,
      fulfillment: deriveFulfillment(sharedSecret),
    };
    this.opened.push(entry);
    return entry;
  }

  /**
   * Handle a PREPARE end to end: open it, then seal {@link answer} back — the
   * FULFILL an `IlpSendResult` would carry, including the derived fulfilment
   * the sender's condition check will be run against.
   */
  fulfill(dataBase64: string): {
    accepted: true;
    data: string;
    fulfillment: string;
  } {
    const { sharedSecret, fulfillment } = this.open(dataBase64);
    return {
      accepted: true,
      data: toBase64(
        sealResponse(sharedSecret, encodeEnvelopeResponse(this.answer))
      ),
      fulfillment: toBase64(fulfillment),
    };
  }

  /**
   * A REJECT raised AT the termination: sealed with the request's own secret,
   * which is what makes "the destination said no" provable.
   */
  rejectSealed(
    dataBase64: string,
    code = 'F99',
    message = 'the app refused',
    detail = new Uint8Array(0)
  ): { accepted: false; code: string; message: string; data: string } {
    const { sharedSecret } = this.open(dataBase64);
    return {
      accepted: false,
      code,
      message,
      data: toBase64(sealResponse(sharedSecret, detail)),
    };
  }
}

/**
 * ADR 0025's target rule, the fake's copy of the connector's
 * `resolve_target_under_handler` core: `''`/`'/'` name the handler's own
 * path; any other leading `/` is an absolute-path escape; `..`/`.` segments,
 * backslashes and schemes (plus their percent-encoded forms) are refusals.
 */
function assertTargetStaysUnderHandler(target: string): void {
  const path = target.split('?')[0] ?? '';
  if (path === '' || path === '/') return;
  if (path.startsWith('/')) {
    throw new Error(
      `F00: envelope target '${target}' is an absolute path -- it must be ` +
        "relative to the route's handler path, never in place of it"
    );
  }
  const decoded = decodeURIComponent(path);
  const escapes =
    decoded.startsWith('/') ||
    decoded.includes('\\') ||
    /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(decoded) ||
    decoded.split('/').some((segment) => segment === '..' || segment === '.');
  if (escapes) {
    throw new Error(
      `F00: envelope target '${target}' attempts to escape the route's handler path`
    );
  }
}

/**
 * A REJECT raised SHORT of the termination: plaintext, because an
 * intermediate hop shares no secret and cannot seal anything.
 */
export function plaintextReject(
  code = 'F02',
  message = 'no route to destination'
): { accepted: false; code: string; message: string } {
  return { accepted: false, code, message };
}

/** Read one header, case-insensitively, out of whatever shape `fetch` was given. */
function readHeader(headers: RequestInit['headers'], name: string): string | undefined {
  if (headers === undefined) return undefined;
  const wanted = name.toLowerCase();
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      if (key?.toLowerCase() === wanted) return value;
    }
    return undefined;
  }
  if (typeof (headers as Headers).get === 'function') {
    return (headers as Headers).get(name) ?? undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
}

/** The request body as bytes, however `fetch` was handed it. */
function toBytes(body: RequestInit['body']): Uint8Array {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  if (typeof body === 'string') return encodeUtf8(body);
  throw new Error(`FakeTerminatingConnector: unsupported request body ${String(body)}`);
}

/**
 * The response headers carrying what rides beside the packet.
 *
 * `toon-accumulated-cost` is plain decimal text; `toon-claim-ack` is
 * base64(JSON), because base64 is a header artefact and nothing else — its BTP
 * twin carries the same JSON as raw UTF-8.
 */
function metaHeaders(meta: {
  cost?: bigint;
  claimAck?: { result: string; reason?: string };
}): Record<string, string> {
  return {
    'content-type': 'application/octet-stream',
    ...(meta.cost !== undefined ? { 'toon-accumulated-cost': meta.cost.toString() } : {}),
    ...(meta.claimAck !== undefined
      ? { 'toon-claim-ack': toBase64(encodeUtf8(JSON.stringify(meta.claimAck))) }
      : {}),
  };
}

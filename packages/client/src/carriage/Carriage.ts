/**
 * The carriage: the one module that delivers a packet, and says what came back.
 *
 * Everything about *how* a packet travels lives here — which carriage the node
 * wants for this route, where that carriage is dialled (the endpoint resolution
 * of {@link ../btp/transport-select.js!resolveCarriageEndpoints}), whether it is
 * a stateless `POST /ilp` or a persistent BTP session, and the HTTP fallback
 * beneath a BTP outage. {@link ../client/send.js!send} sees none of it: it hands
 * over a packet, with or without a voucher, and gets one of four outcomes.
 *
 * - **answered** — a FULFILL. The app said something.
 * - **refused** — a REJECT. Somebody said no, and the result says what and why.
 * - **greeting** — the connector answered with its terms instead of routing: an
 *   unpaid request to a priced route, or one on a carriage the route does not
 *   accept (`402` on HTTP, `F06`/`F02` beside a `payment-required` entry on
 *   BTP). The same outcome on either carriage, because it is the same document.
 *   A node that offers no endpoint for the carriage asked for is a greeting too:
 *   nothing was sent, and what the caller needs is which carriage to ask for.
 * - **unknown** — the carriage failed before an answer arrived. The packet may
 *   have been banked, and the caller must not assume otherwise.
 *
 * Only the first two are verdicts about the packet. A greeting is returned, not
 * thrown, because from the caller's side it is an answer like the others: the
 * packet did not travel, nothing was paid, and what is wanted is the terms.
 */
import { HttpIlpClient } from '../http/HttpIlpClient.js';
import { BtpRuntimeClient, type BtpChannelDeclaration } from '../btp/BtpRuntimeClient.js';
import { BtpPaidWriteTransport } from '../btp/BtpPaidWriteTransport.js';
import {
  resolveCarriageEndpoints,
  selectTransport,
} from '../btp/transport-select.js';
import {
  requiredTransportFor,
  type NodeSelfDescription,
} from '../connector/self-description.js';
import { parsePaymentTerms } from '../connector/x402.js';
import { ConfigError, type EndpointSource } from '../client/errors.js';
import type {
  CarriageEndpoints,
  PaymentTerms,
  TransportPreference,
} from '../client/types.js';
import type { IlpSendParams } from '../ilp/ilp-send.js';
import type { IlpSendResult } from '../ilp/types.js';

/** Which carriage a packet rode, or would have. */
export type CarriageKind = 'http' | 'btp';

/** The carriage answered the packet with a FULFILL. */
export interface Answered {
  kind: 'answered';
  carriage: CarriageKind;
  result: IlpSendResult;
}

/** The carriage answered the packet with a REJECT. */
export interface Refused {
  kind: 'refused';
  carriage: CarriageKind;
  result: IlpSendResult;
}

/**
 * The connector answered with terms instead of routing, or the node offers no
 * way to reach it on the carriage this packet needs. Nothing was banked.
 */
export interface Greeting {
  kind: 'greeting';
  /** The carriage that was asked, or that would have been. */
  carriage: CarriageKind;
  /** `'TRANSPORT_REQUIRED'` when the refusal named a carriage; `'PAYMENT_REQUIRED'` otherwise. */
  code: 'PAYMENT_REQUIRED' | 'TRANSPORT_REQUIRED';
  message: string;
  /** The route's terms, when the greeting carried them. */
  terms?: PaymentTerms;
}

/** The carriage failed before an answer arrived; the packet may have been banked. */
export interface Unknown {
  kind: 'unknown';
  carriage: CarriageKind;
  error: unknown;
}

export type CarriageOutcome = Answered | Refused | Greeting | Unknown;

/** A carriage chosen and connected, ready to deliver packets to one destination. */
export interface OpenCarriage {
  readonly kind: CarriageKind;
  /**
   * Deliver one packet. With a `voucher` it is the claim attached to the packet;
   * without one, the packet goes unpaid, which only a free route accepts.
   * Never throws for a verdict or a greeting; a failure of the carriage itself
   * is the `unknown` outcome.
   */
  deliver(packet: IlpSendParams, voucher?: Record<string, unknown>): Promise<CarriageOutcome>;
}

export interface CarriageConfig {
  /** The payer's carriage preference. */
  transport: TransportPreference;
  /** The payer's absolute endpoint overrides. */
  carriageEndpoints: CarriageEndpoints;
  /** Per-packet timeout for HTTP, in milliseconds. */
  timeoutMs: number;
  fetch: typeof fetch;
  createWebSocket?: ((url: string) => unknown) | undefined;
  btp: { maxReconnectAttempts?: number; reconnectDelay?: number; declareChannel: boolean };
  /** The anonymous peer id presented on a BTP auth frame. */
  peerId: string;
  /** The channel to declare on a BTP auth frame, when there is one. */
  channelDeclaration(): Promise<BtpChannelDeclaration | undefined>;
  /** Refuse an endpoint this client has no way to dial. Throws {@link ConfigError}. */
  assertReachable(endpoint: string): void;
}

type Adapter = Pick<HttpIlpClient, 'sendIlpPacket' | 'sendIlpPacketWithClaim'>;

export class Carriage {
  /**
   * One live carriage per kind, not one per client.
   *
   * A node pins carriages **per route** (connector ADR 0072), so one client can
   * legitimately owe one destination a BTP session and another an HTTP one-shot.
   * Keying by kind keeps each carriage chosen once and reused — which is the
   * point of caching at all — without letting the first destination decide for
   * every later one.
   */
  private open_: Partial<Record<CarriageKind, OpenCarriage>> = {};
  private btpSession: BtpRuntimeClient | undefined;
  private closed = false;

  constructor(private readonly config: CarriageConfig) {}

  /**
   * The carriage for `destination`: chosen once per kind, then reused.
   *
   * Reuse matters for BTP specifically: the whole reason to prefer it is that one
   * ordered socket cannot race its own vouchers' amounts into a refusal
   * (`client-edge-spec.md` §1.9), and a session rebuilt per request would give
   * that up while paying for the handshake.
   *
   * `destination` is what lets the node's **per-route** pin decide, rather than
   * only its node-wide summary — which is silent on any node that pins one of
   * its own addresses and not another (TOON_Network#111). The choice is made
   * before the first packet, so a pinned route is dialled correctly on the first
   * attempt and never learns its carriage from a refusal.
   *
   * Returns a {@link Greeting} when the node offers no endpoint for the carriage
   * required. An endpoint this client cannot dial (a hidden service with no
   * proxy) still throws {@link ConfigError}: that is this client's own
   * configuration, found before anything is sent.
   */
  async open(
    description: NodeSelfDescription,
    destination?: string
  ): Promise<OpenCarriage | Greeting> {
    if (this.closed) {
      throw new ConfigError('This client has been closed; construct a new one to send again.');
    }

    const overrides = this.config.carriageEndpoints;
    const choice = selectTransport(
      description,
      this.config.transport,
      undefined,
      destination,
      overrides
    );
    if (choice.kind === 'unavailable') {
      const { required } = choice;
      return {
        kind: 'greeting',
        carriage: required ?? (this.config.transport === 'btp' ? 'btp' : 'http'),
        code: 'TRANSPORT_REQUIRED',
        message: choice.message,
      };
    }
    const cached = this.open_[choice.kind];
    if (cached) return cached;
    // The HTTP fallback beneath BTP is the published (or overridden) endpoint
    // or nothing: a paid packet never goes to a URL nobody published (ADR 0006).
    const httpEndpoint =
      choice.kind === 'http'
        ? choice.url
        : resolveCarriageEndpoints(description, undefined, overrides).http;
    this.config.assertReachable(choice.url);
    if (httpEndpoint !== undefined) this.config.assertReachable(httpEndpoint);
    const sourceOf = (kind: CarriageKind): EndpointSource | undefined => {
      const published = description[kind === 'http' ? 'httpEndpoint' : 'btpEndpoint'];
      if (overrides[kind] !== undefined) {
        return { override: published !== undefined ? { published } : {} };
      }
      return published !== undefined ? 'published' : undefined;
    };
    const httpSource = sourceOf('http');
    const btpSource = sourceOf('btp');
    const http =
      httpEndpoint === undefined
        ? undefined
        : new HttpIlpClient({
            httpEndpoint,
            ...(httpSource !== undefined ? { endpointSource: httpSource } : {}),
            timeout: this.config.timeoutMs,
            httpClient: this.config.fetch,
          });

    if (choice.kind === 'http') {
      if (http === undefined) throw new Error('unreachable: an http choice has an endpoint');
      return (this.open_.http = adapt('http', http, httpEndpoint));
    }

    const { btp } = this.config;
    const session = new BtpRuntimeClient({
      btpUrl: choice.url,
      // The client edge resolves a PRESENTED identity before it looks at the
      // route and answers `401` when it cannot authenticate one, so an anonymous
      // peer plus a valid claim is the supported permissionless path.
      peerId: this.config.peerId,
      authToken: '',
      ...(btp.maxReconnectAttempts !== undefined ? { maxRetries: btp.maxReconnectAttempts } : {}),
      ...(btp.reconnectDelay !== undefined ? { retryDelay: btp.reconnectDelay } : {}),
      ...(this.config.createWebSocket
        ? { createWebSocket: this.config.createWebSocket as (url: string) => WebSocket }
        : {}),
      ...(btp.declareChannel
        ? { getChannelDeclaration: () => this.config.channelDeclaration() }
        : {}),
    });
    this.btpSession = session;

    const transport = new BtpPaidWriteTransport({
      session,
      url: choice.url,
      ...(btpSource !== undefined ? { endpointSource: btpSource } : {}),
      // HTTP fallback only where the node did not REQUIRE btp *for this
      // destination*: falling back onto a carriage the route refuses would
      // turn a recoverable socket outage into a `402` per request. Read
      // through the same per-route resolution the choice above was made with,
      // so the fallback cannot be enabled against a route the node-wide field
      // happens not to describe (TOON_Network#111).
      ...(requiredTransportFor(description, destination) === 'btp' || http === undefined
        ? {}
        : { fallback: http }),
      ...(btp.maxReconnectAttempts !== undefined
        ? { maxReconnectAttempts: btp.maxReconnectAttempts }
        : {}),
      ...(btp.reconnectDelay !== undefined ? { reconnectDelay: btp.reconnectDelay } : {}),
    });
    return (this.open_.btp = adapt('btp', transport, undefined));
  }

  /** Release the BTP session and refuse further packets. */
  async close(): Promise<void> {
    this.closed = true;
    const session = this.btpSession;
    this.btpSession = undefined;
    this.open_ = {};
    if (session) await session.disconnect();
  }
}

function adapt(kind: CarriageKind, adapter: Adapter, baseUrl: string | undefined): OpenCarriage {
  return {
    kind,
    async deliver(packet, voucher) {
      let result: IlpSendResult;
      try {
        result =
          voucher === undefined
            ? await adapter.sendIlpPacket(packet)
            : await adapter.sendIlpPacketWithClaim(packet, voucher);
      } catch (error) {
        return { kind: 'unknown', carriage: kind, error };
      }
      if (result.accepted) return { kind: 'answered', carriage: kind, result };
      return readGreeting(kind, result, baseUrl) ?? { kind: 'refused', carriage: kind, result };
    },
  };
}

/**
 * The greeting a reject carried, when it carried one.
 *
 * Terms are the tell, not the code: `paymentRequired` is the raw x402 document
 * the connector attached — the `402` body on HTTP, the `payment-required`
 * protocolData entry beside an `F06`/`F02` on BTP — and one parser projects it
 * onto {@link PaymentTerms} for both, so the carriages cannot come to different
 * conclusions about one greeting. A document that is not TOON terms is no
 * greeting; it stays the reject it arrived as.
 */
function readGreeting(
  carriage: CarriageKind,
  result: IlpSendResult,
  baseUrl: string | undefined
): Greeting | undefined {
  if (result.paymentRequired === undefined) return undefined;
  const terms = parsePaymentTerms(result.paymentRequired, baseUrl);
  if (terms === undefined) return undefined;
  const required = terms.requiredTransport;
  // A greeting that NAMES a carriage is a different refusal from one that merely
  // asks to be paid, because the remedy is different: paying more will never
  // help, and re-sending over the named carriage always will.
  const message =
    result.message ??
    (required !== undefined
      ? `The connector refused this write over ${carriage}; the route requires the ${required} transport.`
      : `The connector answered with terms for ${terms.destination} at ${terms.price}.`);
  return {
    kind: 'greeting',
    carriage,
    code: required !== undefined ? 'TRANSPORT_REQUIRED' : 'PAYMENT_REQUIRED',
    message,
    terms,
  };
}

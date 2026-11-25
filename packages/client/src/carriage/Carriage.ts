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
 * - **unknown** — the carriage failed before an answer arrived. `written`
 *   says whether any of the packet left: when it did, it may have been banked,
 *   and the caller must not assume otherwise.
 *
 * ## The retry rule (ADR 0007)
 *
 * The carriage sends a packet again only when none of it was written: a dial or
 * connect failure, which the adapter reports as {@link NothingWritten} from the
 * step where it happened. Such failures are retried within one budget,
 * `btp.maxReconnectAttempts` more tries spaced by `btp.reconnectDelay`, and once
 * it runs out a BTP packet may fall back to HTTP where the route does not
 * require BTP and the node publishes an HTTP endpoint. A packet that was written
 * and whose answer was lost is never resent, on either carriage: the outcome is
 * `unknown`, and the caller marks its channel in doubt.
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
import { NothingWritten } from './nothing-written.js';
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

/** The carriage failed before an answer arrived. */
export interface Unknown {
  kind: 'unknown';
  carriage: CarriageKind;
  /**
   * Whether any of the packet may have left. `false` only when the adapter
   * knows it did not — every connect failed within the budget, with no
   * fallback. `true` otherwise: the packet may have been banked.
   */
  written: boolean;
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

type Send = () => Promise<IlpSendResult>;

/** How many more tries a connect failure gets, and the delay before the first. */
interface Budget {
  attempts: number;
  delayMs: number;
}

/** One reconnect beyond the first dial, after 250 ms. */
const DEFAULT_BUDGET: Budget = { attempts: 1, delayMs: 250 };

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
      return (this.open_.http = carriageOf('http', httpEndpoint, (packet, voucher) =>
        sendOver(http, packet, voucher)
      ));
    }

    const { btp } = this.config;
    const session = new BtpRuntimeClient({
      btpUrl: choice.url,
      // The client edge resolves a PRESENTED identity before it looks at the
      // route and answers `401` when it cannot authenticate one, so an anonymous
      // peer plus a valid claim is the supported permissionless path.
      peerId: this.config.peerId,
      authToken: '',
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
    });
    // HTTP fallback only where the node did not REQUIRE btp *for this
    // destination*: falling back onto a carriage the route refuses would turn a
    // recoverable socket outage into a greeting per request. Read through the
    // same per-route resolution the choice above was made with, so the fallback
    // cannot be enabled against a route the node-wide field happens not to
    // describe (TOON_Network#111).
    const fallback =
      requiredTransportFor(description, destination) === 'btp' ? undefined : http;
    const budget: Budget = {
      attempts: btp.maxReconnectAttempts ?? DEFAULT_BUDGET.attempts,
      delayMs: btp.reconnectDelay ?? DEFAULT_BUDGET.delayMs,
    };
    return (this.open_.btp = carriageOf('btp', undefined, (packet, voucher) =>
      // The whole rule runs in one slot of the session's queue, so a retry or a
      // fallback holds this packet's place and reorders nothing behind it.
      transport.ordered((attempt) =>
        underRetryRule(
          () => attempt(packet, voucher),
          budget,
          fallback && (() => sendOver(fallback, packet, voucher))
        )
      )
    ));
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

function sendOver(
  http: HttpIlpClient,
  packet: IlpSendParams,
  voucher: Record<string, unknown> | undefined
): Promise<IlpSendResult> {
  return voucher === undefined
    ? http.sendIlpPacket(packet)
    : http.sendIlpPacketWithClaim(packet, voucher);
}

/**
 * The retry rule, the only one in this package: `send` again only while it
 * failed with nothing written and the budget lasts; then `fallback`, if there
 * is one, sent once. Anything that may have been written is passed on at once.
 */
async function underRetryRule(
  send: Send,
  budget: Budget,
  fallback: Send | undefined
): Promise<IlpSendResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (!(error instanceof NothingWritten)) throw error;
      if (attempt >= budget.attempts) {
        if (fallback !== undefined) return fallback();
        throw error;
      }
      await sleep(budget.delayMs * (attempt + 1));
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function carriageOf(
  kind: CarriageKind,
  baseUrl: string | undefined,
  send: (packet: IlpSendParams, voucher?: Record<string, unknown>) => Promise<IlpSendResult>
): OpenCarriage {
  return {
    kind,
    async deliver(packet, voucher) {
      let result: IlpSendResult;
      try {
        result = await send(packet, voucher);
      } catch (error) {
        if (error instanceof NothingWritten) {
          return { kind: 'unknown', carriage: kind, written: false, error: error.error };
        }
        return { kind: 'unknown', carriage: kind, written: true, error };
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

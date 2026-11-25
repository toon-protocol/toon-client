/**
 * Persistent, strictly-ordered BTP transport for paid writes (issue #482).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 * `HttpIlpClient` (the default paid-write transport, `POST /ilp`) is
 * stateless: every write is an independent HTTP request, and the connector's
 * claim gate admits a voucher only if its amount strictly exceeds the
 * channel's watermark (client-edge-spec.md §1.3 step 2). A burst of concurrent
 * paid writes on one channel can therefore race each other's amounts: two
 * vouchers both built against the same watermark, one arrives first and
 * advances it, and the other no longer exceeds it and is refused.
 *
 * The connector's client-facing BTP websocket ingress (client-edge-spec.md
 * §1.9, connector#680/#674) processes frames on ONE session strictly in
 * arrival order — the next frame is not read until the previous frame's
 * voucher has been judged. A client that dispatches its OWN vouchers in the
 * same order it enqueued them therefore never races itself. This was measured
 * on the huddle-over-ILP prototype (`toon-meta/prototypes/huddle-over-ilp`,
 * branch `proto/huddle-over-ilp`): 0 refused vouchers across 4,156 events at a
 * paced 50fps (audio-frame-rate) sustained load, where the equivalent
 * unordered concurrent-HTTP baseline raced.
 *
 * This module productizes that pattern as a reusable transport rather than
 * a one-off harness: a caller that needs many ordered paid writes on one
 * channel (the motivating consumer is relay-native huddle audio, ~140fps of
 * measured headroom per session) constructs one `BtpPaidWriteTransport`
 * around a `BtpRuntimeClient` session and sends through it exactly like it
 * would through `HttpIlpClient.sendIlpPacketWithClaim`.
 *
 * ─── What it adds over a bare `BtpRuntimeClient` ────────────────────────
 *  - **Persistent session**: the underlying session is connected once,
 *    lazily, on the first write, and stays open across every subsequent
 *    write. The whole point is to reuse
 *    one ordered socket across a burst.
 *  - **Strictly ordered dispatch**: every `sendIlpPacketWithClaim` call is
 *    appended to a FIFO queue; the next call is not dispatched onto the wire
 *    until the previous one has fully settled (fulfilled, rejected, failed,
 *    or fallen back to HTTP). Callers may still fire writes concurrently
 *    (`Promise.all`) — ordering is enforced here, not pushed onto the
 *    caller.
 *  - **One attempt per slot, unless the carriage asks for more**: a plain
 *    `sendIlpPacketWithClaim` writes once. The carriage's retry rule
 *    (ADR 0007) runs inside one slot through {@link BtpPaidWriteTransport.ordered},
 *    so a connect retry or the HTTP fallback beneath it holds the write's
 *    place in the queue and reorders nothing behind it.
 *
 * This transport never retries on its own, and never decides whether a failure
 * came before the write: the session says so with {@link NothingWritten}. An
 * ILP-level REJECT (F02, T01, ...) is a normal `IlpSendResult`, returned to the
 * caller unchanged.
 */

import type { IlpSendResult } from '../ilp/types.js';
import type { BtpRuntimeClient } from './BtpRuntimeClient.js';
import type { IlpSendParams } from '../ilp/ilp-send.js';
import { BtpAuthError, BtpConnectionError } from './IsomorphicBtpClient.js';
import { NothingWritten } from '../carriage/nothing-written.js';
import {
  NetworkError,
  describeEndpoint,
  type EndpointSource,
} from '../client/errors.js';

/**
 * The subset of `BtpRuntimeClient` this transport drives. `BtpRuntimeClient`
 * satisfies this structurally — no adapter needed — but tests can supply a
 * lightweight fake instead of a real WebSocket-backed instance.
 */
export type BtpSession = Pick<
  BtpRuntimeClient,
  | 'isConnected'
  | 'disconnect'
  | 'sendIlpPacketWithClaim'
  | 'sendIlpPacket'
>;

/** One attempt on the session: a claim makes it a paid write. */
export type BtpAttempt = (
  params: IlpSendParams,
  claim?: Record<string, unknown>
) => Promise<IlpSendResult>;

export interface BtpPaidWriteTransportConfig {
  /**
   * The persistent BTP session this transport writes through. It connects
   * itself on a write that finds its socket closed, and is never disconnected
   * between writes.
   */
  session: BtpSession;
  /**
   * The `ws(s)://` URL the session dials, so a connection failure can name it.
   * Omit and a failure carries the session's own message alone.
   */
  url?: string;
  /** Where `url` came from, so a failure can say the node chose it. */
  endpointSource?: EndpointSource;
}

/**
 * Wraps a {@link BtpSession} (a `BtpRuntimeClient`) as a first-class,
 * persistent, strictly-ordered paid-write transport. See the module docs
 * above for the full rationale.
 */
export class BtpPaidWriteTransport {
  private readonly session: BtpSession;
  private readonly url: string | undefined;
  private readonly endpointSource: EndpointSource | undefined;
  /**
   * Tail of the ordering queue. ALWAYS settles (never rejects) so one
   * failed write can never strand every write queued behind it — only the
   * write itself carries its own outcome, via the promise `sendIlpPacketWithClaim`
   * returns to its caller.
   */
  private queueTail: Promise<void> = Promise.resolve();

  constructor(config: BtpPaidWriteTransportConfig) {
    this.session = config.session;
    this.url = config.url;
    this.endpointSource = config.endpointSource;
  }

  /** Whether the underlying session currently holds an open socket. */
  get isConnected(): boolean {
    return this.session.isConnected;
  }

  /** Explicitly closes the persistent session (e.g. `ToonClient.stop()`). */
  async disconnect(): Promise<void> {
    await this.session.disconnect();
  }

  /**
   * Run `task` in this session's order. `task` is handed {@link BtpAttempt}, one
   * write on the session, which it may call more than once — the carriage's
   * retry rule does, when nothing was written — while every write queued behind
   * it waits. The returned promise settles with THIS task's own outcome.
   */
  ordered<T>(task: (attempt: BtpAttempt) => Promise<T>): Promise<T> {
    const dispatched = this.queueTail.then(() =>
      task((params, claim) => this.attempt(params, claim))
    );
    this.queueTail = dispatched.then(
      () => undefined,
      () => undefined
    );
    return dispatched;
  }

  /** Enqueue a claim-bearing write, written once. */
  sendIlpPacketWithClaim(
    params: IlpSendParams,
    claim: Record<string, unknown>
  ): Promise<IlpSendResult> {
    return this.ordered((attempt) => attempt(params, claim));
  }

  /**
   * Send a packet with no claim, for a route priced at zero.
   *
   * Enqueued behind the same tail as a paid write. The ordering exists for
   * vouchers — amounts on one socket must not race — and an unpaid packet
   * carries none, so strictly it needs no slot. It takes one anyway: letting an
   * unpaid send dial concurrently with a paid one would race the session itself
   * rather than the vouchers' amounts.
   */
  sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult> {
    return this.ordered((attempt) => attempt(params));
  }

  /** One write on the session, connecting it first if it is not open. */
  private async attempt(
    params: IlpSendParams,
    claim?: Record<string, unknown>
  ): Promise<IlpSendResult> {
    try {
      return claim === undefined
        ? await this.session.sendIlpPacket(params)
        : await this.session.sendIlpPacketWithClaim(params, claim);
    } catch (error) {
      if (error instanceof NothingWritten) throw new NothingWritten(this.nameEndpoint(error.error));
      throw this.nameEndpoint(error);
    }
  }

  /**
   * A failure of the socket itself becomes a {@link NetworkError} naming the BTP
   * URL, with the original kept as `cause`. Anything else passes through.
   */
  private nameEndpoint(error: unknown): unknown {
    if (this.url === undefined || error instanceof NetworkError) return error;
    if (!(error instanceof BtpConnectionError || error instanceof BtpAuthError)) return error;
    return new NetworkError(
      `BTP connection failed reaching ${describeEndpoint(this.url, this.endpointSource)}: ${
        error.message
      }`,
      error,
      this.url
    );
  }
}

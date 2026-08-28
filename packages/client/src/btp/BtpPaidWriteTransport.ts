/**
 * Persistent, strictly-ordered BTP transport for paid writes (issue #482).
 *
 * ─── Why this exists ─────────────────────────────────────────────────────
 * `HttpIlpClient` (the default paid-write transport, `POST /ilp`) is
 * stateless: every write is an independent HTTP request, and the connector's
 * claim gate advances a channel's nonce watermark per request in WHATEVER
 * order those requests happen to arrive — client-edge-spec.md §1.3 step 2. A
 * burst of concurrent paid writes on one channel can therefore race each
 * other into `F01 NonceNotAdvancing`: two requests both built against the
 * same last-known nonce, one arrives first and advances the watermark, the
 * other is now stale.
 *
 * The connector's client-facing BTP websocket ingress (client-edge-spec.md
 * §1.9, connector#680/#674) processes frames on ONE session strictly in
 * arrival order — the next frame is not read until the previous frame's
 * claim has been judged. A client that dispatches its OWN claims in the same
 * order it enqueued them therefore never races itself. This was measured on
 * the huddle-over-ILP prototype (`toon-meta/prototypes/huddle-over-ilp`,
 * branch `proto/huddle-over-ilp`): 0 F01 rejects across 4,156 events at a
 * paced 50fps (audio-frame-rate) sustained load, where the equivalent
 * unordered concurrent-HTTP baseline raced.
 *
 * This module productizes that pattern as a reusable transport rather than
 * a one-off harness: a caller that needs many ordered paid writes on one
 * channel (the motivating consumer is relay-native huddle audio, ~140fps of
 * measured headroom per session) constructs one `BtpPaidWriteTransport`
 * around a `BtpRuntimeClient` session and sends through it exactly like any
 * other `sendIlpPacketWithClaim`-shaped transport.
 *
 * ─── What it adds over a bare `BtpRuntimeClient` ────────────────────────
 *  - **Persistent session**: the underlying session is connected once,
 *    lazily, on the first write, and stays open across every subsequent
 *    write. This is NOT the `Http402Client.upgradeToBtp()` pattern (open,
 *    send one packet, immediately disconnect) — the whole point is to reuse
 *    one ordered socket across a burst.
 *  - **Strictly ordered dispatch**: every `sendIlpPacketWithClaim` call is
 *    appended to a FIFO queue; the next call is not dispatched onto the wire
 *    until the previous one has fully settled (fulfilled, rejected, or
 *    fallen back to HTTP). Callers may still fire writes concurrently
 *    (`Promise.all`) — ordering is enforced here, not pushed onto the
 *    caller.
 *  - **Reconnect + resume**: a write that fails on a connection-level error
 *    (socket dropped mid-burst) reconnects the SAME session and retries
 *    that write in place, without losing its position in the queue and
 *    without reordering the writes queued behind it — they simply wait for
 *    it to resolve one way or another.
 *  - **Falls back to HTTP**: once the reconnect budget for one write is
 *    exhausted, the write is handed to `fallback` (typically the existing
 *    `HttpIlpClient`) when one is configured, so a BTP outage degrades a
 *    session to the pre-existing one-shot behavior instead of failing the
 *    write outright.
 *
 * Only CONNECTION-level failures (dropped socket, timeout — the errors
 * `BtpRuntimeClient`/`IsomorphicBtpClient` throw) are retried or routed to
 * the fallback. An ILP-level REJECT (F02, T01, ...) is a normal
 * `IlpSendResult`, exactly like every other transport here — it is returned
 * to the caller unchanged, never retried and never silently resent over
 * HTTP (a claim that was actually judged and refused must not be replayed).
 */

import type { IlpSendResult } from '../ilp/types.js';
import type { IlpSendParams } from '../ilp/ilp-send.js';
import { NetworkError } from '../client/errors.js';

/**
 * The narrow shape a paid-write transport candidate needs — the same method
 * `ToonClient.getClaimTransport()` already requires of `HttpIlpClient` and
 * `BtpRuntimeClient`. Declared independently so this module (and its tests)
 * do not need the concrete transport classes.
 */
export interface ClaimSendingTransport {
  sendIlpPacketWithClaim(
    params: IlpSendParams,
    claim: unknown
  ): Promise<IlpSendResult>;
  sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult>;
}

/**
 * The subset of `BtpRuntimeClient` this transport drives. `BtpRuntimeClient`
 * satisfies this structurally — no adapter needed — but tests can supply a
 * lightweight fake instead of a real WebSocket-backed instance.
 */
export interface OrderedBtpSession {
  readonly isConnected: boolean;
  connect(): Promise<void>;
  reconnect(): Promise<void>;
  disconnect(): Promise<void>;
  sendIlpPacketWithClaim(
    params: IlpSendParams,
    claim: Record<string, unknown>
  ): Promise<IlpSendResult>;
  sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult>;
}

export interface BtpPaidWriteTransportConfig {
  /**
   * The persistent BTP session this transport owns the connect/reconnect
   * lifecycle of. May already be connected (the common case — `modes/http.ts`
   * connects `btpClient` at startup) or not; either way it is connected
   * lazily on first use and never disconnected between writes.
   */
  session: OrderedBtpSession;
  /**
   * Stateless fallback used once a write's reconnect budget is exhausted.
   * Typically an `HttpIlpClient` pointed at the same connector's `POST /ilp`.
   * Omit to have an exhausted BTP session fail the write outright.
   */
  fallback?: ClaimSendingTransport;
  /**
   * Reconnect attempts for one write before giving up on BTP (and, if
   * configured, falling back to HTTP). Default 1 — one explicit reconnect
   * beyond whatever retrying the session already does internally.
   */
  maxReconnectAttempts?: number;
  /** Delay before each reconnect attempt, in ms. Default 250. */
  reconnectDelay?: number;
}

/** Message substrings that identify a connection-level (retryable) failure,
 * as opposed to an application-level one. Mirrors `BtpRuntimeClient`'s own
 * `isConnectionError` — duplicated rather than imported since that helper is
 * private to a different transport and this module must not reach into it. */
function isConnectionError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('not connected') ||
    msg.includes('connection') ||
    msg.includes('websocket') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wraps an {@link OrderedBtpSession} (a `BtpRuntimeClient`) as a first-class,
 * persistent, strictly-ordered paid-write transport with an optional HTTP
 * fallback. See the module docs above for the full rationale.
 */
export class BtpPaidWriteTransport implements ClaimSendingTransport {
  private readonly session: OrderedBtpSession;
  private readonly fallback: ClaimSendingTransport | undefined;
  private readonly maxReconnectAttempts: number;
  private readonly reconnectDelay: number;
  /**
   * Tail of the ordering queue. ALWAYS settles (never rejects) so one
   * failed write can never strand every write queued behind it — only the
   * write itself carries its own outcome, via the promise `sendIlpPacketWithClaim`
   * returns to its caller.
   */
  private queueTail: Promise<void> = Promise.resolve();

  constructor(config: BtpPaidWriteTransportConfig) {
    this.session = config.session;
    this.fallback = config.fallback;
    this.maxReconnectAttempts = config.maxReconnectAttempts ?? 1;
    this.reconnectDelay = config.reconnectDelay ?? 250;
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
   * Enqueue a claim-bearing write. The returned promise resolves/rejects
   * with THIS write's own outcome; its position in the queue only controls
   * WHEN it is dispatched onto the wire, never what it returns.
   */
  sendIlpPacketWithClaim(
    params: IlpSendParams,
    claim: unknown
  ): Promise<IlpSendResult> {
    const dispatched = this.queueTail.then(() =>
      this.dispatchWithRetry(params, claim)
    );
    this.queueTail = dispatched.then(
      () => undefined,
      () => undefined
    );
    return dispatched;
  }

  /**
   * Send a packet with no claim, for a route priced at zero.
   *
   * Enqueued behind the same tail as a paid write. The ordering exists for
   * claims — nonces on one socket must not race — and an unpaid packet carries
   * none, so strictly it needs no slot. It takes one anyway: the queue also
   * serialises this transport's connect/reconnect policy, and letting an unpaid
   * send dial concurrently with a paid one would race the session itself rather
   * than the nonces.
   */
  sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult> {
    const dispatched = this.queueTail.then(() => this.dispatchUnpaid(params));
    this.queueTail = dispatched.then(
      () => undefined,
      () => undefined
    );
    return dispatched;
  }

  /** Connect if need be, then send once. No claim, so nothing to re-spend. */
  private async dispatchUnpaid(params: IlpSendParams): Promise<IlpSendResult> {
    if (!this.session.isConnected) await this.session.connect();
    return this.session.sendIlpPacket(params);
  }

  /**
   * One write's worth of connect/send/reconnect/fallback policy. Runs
   * strictly after every write enqueued ahead of it has settled.
   */
  private async dispatchWithRetry(
    params: IlpSendParams,
    claim: unknown
  ): Promise<IlpSendResult> {
    let attempt = 0;
    let lastError: unknown;

    // attempt 0: use the session as-is (connecting it if this is the very
    // first write). attempt 1..maxReconnectAttempts: explicit reconnect,
    // i.e. "resume" — the queue already guarantees nothing behind this write
    // has been dispatched early, so a reconnect here reorders nothing.
    while (attempt <= this.maxReconnectAttempts) {
      try {
        if (!this.session.isConnected) {
          if (attempt === 0) {
            await this.session.connect();
          } else {
            await sleep(this.reconnectDelay * attempt);
            await this.session.reconnect();
          }
        }
        return await this.session.sendIlpPacketWithClaim(
          params,
          claim as Record<string, unknown>
        );
      } catch (error) {
        lastError = error;
        if (!isConnectionError(error)) {
          throw error;
        }
        attempt += 1;
      }
    }

    if (this.fallback) {
      return this.fallback.sendIlpPacketWithClaim(params, claim);
    }

    throw lastError instanceof Error
      ? lastError
      : new NetworkError(
          'BTP paid-write transport exhausted its reconnect budget and no HTTP fallback is configured'
        );
  }
}

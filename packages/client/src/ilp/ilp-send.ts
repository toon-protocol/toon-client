/**
 * Shared sender-side plumbing for both ILP carriages: how a PREPARE's
 * non-routing fields are resolved, and how the answer is read.
 *
 * Connector ADR 0069 (issue #1269) removed the execution condition from the
 * wire. Two things changed here and nothing else did:
 *
 *   - the PREPARE carries a one-byte `greeting` flag where a 32-byte
 *     condition used to sit — see {@link IlpSendParams.greeting};
 *   - the sender's delivery check compares a FULFILL's preimage directly
 *     against the fulfilment its own sealed secret derives
 *     ({@link IlpSendParams.expectedFulfillment}), rather than hashing it back
 *     to a condition that no longer exists.
 *
 * Both transports (HTTP `POST /ilp` and BTP) take the SAME params and map
 * FULFILL/REJECT through the SAME verifier, so the two paths cannot drift.
 * Omitting `expectedFulfillment` keeps a FULFILL unverified — the right shape
 * for a caller that never sealed anything and so has nothing to compare
 * against.
 */

import type { IlpSendResult } from './types.js';
import { ILPPacketType, type ILPResponsePacket } from '../btp/protocol.js';
import { fromBase64, toBase64 } from '../utils/binary.js';
import { fulfillmentMatches } from '../utils/fulfillment.js';

/**
 * Send parameters accepted by both ILP transports.
 */
export interface IlpSendParams {
  destination: string;
  amount: string;
  /** Base64 ILP `data` payload. */
  data: string;
  /** Transport timeout in ms; also the default expiry window. */
  timeout?: number;
  /**
   * Declare this PREPARE a bootstrap/greeting probe (connector ADR 0069).
   *
   * Defaults to `false`, which is what every real send wants: a greeting is
   * never routed, never priced and never fulfilled — the connector answers
   * the x402 terms instead. Set it only to ASK for those terms without a
   * route match, the shape `ConnectorEdgeClient` uses for bootstrap. A claim
   * riding with the packet suppresses the greeting either way, so this can
   * never turn a paid packet into a free one.
   */
  greeting?: boolean;
  /**
   * The 32 bytes an honest FULFILL must carry: `deriveFulfillment(sharedSecret)`
   * for the secret sealed inside this packet's gift wrap (ADR 0019), which
   * `sealExchange` returns as `SealedExchange.fulfillment`.
   *
   * Present = verify; absent = accept a FULFILL unchecked, which is the only
   * honest option for a caller that sealed nothing and therefore knows no
   * secret. This is the sender's own end-to-end check and the ONLY fulfilment
   * check left anywhere on the path (ADR 0069) — no hop performs one.
   *
   * Accepts the raw 32 bytes or their base64 encoding; normalize with
   * {@link resolveExpectedFulfillment} before touching the bytes.
   */
  expectedFulfillment?: Uint8Array | string;
  /**
   * Explicit PREPARE `expiresAt`. Defaults to `now + timeout` plus
   * {@link PACKET_EXPIRY_HEADROOM_MS}. Accepts a `Date` or an ISO 8601 string.
   */
  expiresAt?: Date | string;
}

/**
 * Normalize an `IlpSendParams.expectedFulfillment` to raw bytes.
 *
 * The two representations are the two callers: this package's own senders
 * pass the bytes `sealExchange` derived, while a caller typed against the
 * JSON-shaped port passes their base64 spelling. Both mean the same 32 bytes.
 *
 * Length is NOT validated here — that stays with `assertValidFulfillment` at
 * the transports, so a malformed value fails with the same message on both
 * paths regardless of which representation it arrived in.
 */
export function resolveExpectedFulfillment(
  fulfillment: Uint8Array | string | undefined
): Uint8Array | undefined {
  if (fulfillment === undefined) return undefined;
  return typeof fulfillment === 'string' ? fromBase64(fulfillment) : fulfillment;
}

/**
 * How much longer a packet lives on the wire than the sender is prepared to wait.
 *
 * The packet's expiry and the sender's own abort used to be the same number, and
 * on clearnet nothing showed: both are far longer than a round trip. They are not
 * the same thing, though, and over a slow carriage the difference is money. If a
 * PREPARE expires at the instant the client gives up, then a late answer arrives
 * to a client that has already stopped listening, having *already presented a
 * signed claim* — the packet is paid for and the verdict is lost. Worse, the
 * expiry is stamped when the packet is built, which over a hidden service is
 * before the circuit even exists, so seconds of it are spent before the connector
 * has seen a byte.
 *
 * Giving the wire the longer deadline means the client is always the first of the
 * two to give up: whatever the client stops waiting for is still, briefly, a live
 * packet the connector can answer and this client can reconcile — never one that
 * expired underneath a claim.
 */
export const PACKET_EXPIRY_HEADROOM_MS = 15_000;

/**
 * Normalize an `IlpSendParams.expiresAt` to a `Date`.
 *
 * Default: now + timeout + {@link PACKET_EXPIRY_HEADROOM_MS}. An explicit
 * `expiresAt` is honoured exactly as given — a caller who names a deadline has
 * one, and it is not this function's business to extend it.
 */
export function resolveExpiresAt(
  expiresAt: Date | string | undefined,
  timeoutMs: number
): Date {
  if (expiresAt === undefined) return new Date(Date.now() + timeoutMs + PACKET_EXPIRY_HEADROOM_MS);
  return expiresAt instanceof Date ? new Date(expiresAt.getTime()) : new Date(expiresAt);
}

/**
 * `IlpSendResult` plus the FULFILL preimage, populated only when the sender
 * knew what to expect and the bytes matched.
 */
export interface IlpSendResultWithFulfillment extends IlpSendResult {
  /** Base64 32-byte fulfillment preimage (verified against the expected one). */
  fulfillment?: string;
}

/** ILP code used for a client-side fulfillment-verification failure. */
export const FULFILLMENT_MISMATCH_CODE = 'F99';

/** Message for a client-side fulfillment-verification failure. */
export const FULFILLMENT_MISMATCH_MESSAGE =
  'FULFILL fulfillment is not the one this packet\'s sealed secret derives ' +
  '(ADR 0019) — packet counted failed';

/**
 * Map a parsed ILP response packet to an `IlpSendResult`, enforcing the
 * sender's end-to-end delivery check when it knows what to expect.
 *
 * Verification is fail-closed: when `expectedFulfillment` is given, a FULFILL
 * whose preimage is absent, not exactly 32 bytes, or simply different yields
 * `accepted: false` (code F99). The result shape — not a thrown error — is
 * deliberate: transports only retry thrown `NetworkError`s, so a forged or
 * wrong FULFILL is never retried, because re-sending would re-spend the
 * attached claim.
 *
 * Since ADR 0069 this is the only fulfilment check anywhere on the path. A
 * candidate FULFILL rides home through every hop unexamined, which is exactly
 * why the sender must still make it.
 */
export function mapIlpResponse(
  packet: ILPResponsePacket,
  expectedFulfillment?: Uint8Array
): IlpSendResultWithFulfillment {
  if (packet.type === ILPPacketType.FULFILL) {
    const dataField =
      packet.data.length > 0 ? { data: toBase64(packet.data) } : {};

    // Nothing to compare against: a caller that sealed no request holds no
    // secret and can derive no fulfilment, so there is no check to make.
    if (expectedFulfillment === undefined) {
      return { accepted: true, ...dataField };
    }

    if (!fulfillmentMatches(packet.fulfillment, expectedFulfillment)) {
      return {
        accepted: false,
        code: FULFILLMENT_MISMATCH_CODE,
        message: FULFILLMENT_MISMATCH_MESSAGE,
        ...dataField,
      };
    }

    return {
      accepted: true,
      fulfillment: toBase64(packet.fulfillment),
      ...dataField,
    };
  }

  // REJECT
  return {
    accepted: false,
    code: packet.code,
    message: packet.message,
    ...(packet.data.length > 0 ? { data: toBase64(packet.data) } : {}),
  };
}

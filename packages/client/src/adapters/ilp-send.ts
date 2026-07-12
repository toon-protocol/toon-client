/**
 * Shared sender-side plumbing for sender-chosen execution conditions
 * (toon-client#350; contract: connector `docs/local-delivery-fulfillment-contract.md`,
 * connector#309; spec: toon-meta `docs/rolling-swap.md` §3).
 *
 * Both ILP transports (HTTP `POST /ilp` and BTP) take the SAME extended send
 * params and map FULFILL/REJECT responses through the SAME verifier so the
 * two paths cannot drift:
 *
 *   - absent/all-zero `executionCondition` → legacy class: today's behavior,
 *     byte-for-byte (zero condition on the wire, no FULFILL verification);
 *   - non-zero `executionCondition` → sender-chosen: the condition goes on
 *     the PREPARE verbatim and the FULFILL's 32-byte fulfillment MUST hash
 *     back to it — a missing/malformed/mismatching preimage is surfaced as a
 *     FAILED result (never a silent accept, never retried).
 */

import type { IlpSendResult } from '@toon-protocol/core';
import { ILPPacketType, type ILPResponsePacket } from '../btp/protocol.js';
import { toBase64 } from '../utils/binary.js';
import {
  fulfillmentMatchesCondition,
  isZeroCondition,
} from '../utils/condition.js';

/**
 * Send parameters accepted by both ILP transports. Extends the
 * `@toon-protocol/core` `IlpClient` param shape with the sender-chosen
 * condition and an explicit expiry — plain `IlpClient` callers keep working
 * unchanged (both extras are optional; omitting them is the legacy path).
 */
export interface IlpSendParams {
  destination: string;
  amount: string;
  /** Base64 ILP `data` payload. */
  data: string;
  /** Transport timeout in ms; also the default expiry window. */
  timeout?: number;
  /**
   * Sender-chosen 32-byte execution condition `C = sha256(P)` (spec R2).
   * Absent or all-zero = legacy unverified packet (default — ordinary
   * publish/upload writes MUST keep this default).
   */
  executionCondition?: Uint8Array;
  /**
   * Explicit PREPARE `expiresAt` (spec R7). Defaults to `now + timeout`,
   * preserving pre-#350 behavior.
   */
  expiresAt?: Date;
}

/**
 * `IlpSendResult` plus the FULFILL preimage when a sender-chosen condition
 * was verified. Only populated on the sender-chosen path so legacy result
 * objects stay byte-identical.
 */
export interface IlpSendResultWithFulfillment extends IlpSendResult {
  /** Base64 32-byte fulfillment preimage (verified: sha256 == condition). */
  fulfillment?: string;
}

/** ILP code used for a client-side fulfillment-verification failure. */
export const FULFILLMENT_MISMATCH_CODE = 'F99';

/** Message for a client-side fulfillment-verification failure. */
export const FULFILLMENT_MISMATCH_MESSAGE =
  'FULFILL fulfillment does not match execution condition ' +
  '(sha256(fulfillment) != executionCondition) — packet counted failed';

/**
 * Map a parsed ILP response packet to an `IlpSendResult`, enforcing the
 * sender-chosen condition when one was sent.
 *
 * Verification is fail-closed: when `sentCondition` is non-zero, a FULFILL
 * whose fulfillment is absent, not exactly 32 bytes, or does not sha256-hash
 * to the condition yields `accepted: false` (code F99). The result shape —
 * not a thrown error — is deliberate: transports only retry thrown
 * `NetworkError`s, so a forged/wrong FULFILL is never retried (re-sending
 * would re-spend the attached claim), and packet counters (`streamSwap`
 * rejections) count it failed.
 */
export function mapIlpResponse(
  packet: ILPResponsePacket,
  sentCondition?: Uint8Array
): IlpSendResultWithFulfillment {
  if (packet.type === ILPPacketType.FULFILL) {
    const dataField =
      packet.data.length > 0 ? { data: toBase64(packet.data) } : {};

    // Legacy class: absent/all-zero condition → accept without verification
    // (pre-#350 behavior, byte-for-byte).
    if (sentCondition === undefined || isZeroCondition(sentCondition)) {
      return { accepted: true, ...dataField };
    }

    // Sender-chosen class: the FULFILL preimage MUST hash to the condition.
    if (!fulfillmentMatchesCondition(packet.fulfillment, sentCondition)) {
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

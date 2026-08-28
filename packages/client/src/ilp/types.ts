/**
 * The ILP transport port: what a carriage must be able to do, and what it
 * reports back.
 *
 * These types were `@toon-protocol/core`'s. They live here now because 1.0 has
 * exactly two implementations of them — {@link ../http/HttpIlpClient.js} and
 * {@link ../btp/BtpRuntimeClient.js} — and a shared package that carried
 * nothing else this client needs is a dependency with no subject.
 *
 * The one substantive change from core's version: a result carries what the
 * connector reported **beside** the packet. `accumulated_cost` is deliberately
 * not part of the OER REJECT encoding (`vectors/README.md` — it "rides beside
 * the packet"), so it arrives as the `toon-accumulated-cost` HTTP header on one
 * carriage and as the protocolData entry of the same name on the other. Both
 * are normalized into {@link IlpSendResult.accumulatedCost} here so a caller
 * never has to know which carriage answered.
 */

/** A claim the connector acknowledged, or refused, beside the packet's own verdict. */
export interface ClaimAck {
  result: 'accepted' | 'rejected';
  /**
   * Present only on `rejected`. The connector's own reason taxonomy —
   * `signature_invalid`, `nonce_not_advancing`, `amount_not_advancing`,
   * `unknown_channel` — carried verbatim rather than re-spelled.
   */
  reason?: string;
}

import type { IlpSendParams } from './ilp-send.js';

export type { IlpSendParams };

/**
 * The outcome of one PREPARE.
 *
 * `accepted` is the ILP verdict — fulfilled or rejected — and is independent of
 * the claim's own verdict: a FULFILL can carry a *rejected* `claimAck`, which is
 * the single most load-bearing case in the connector's vector set. Never infer
 * one from the other.
 */
export interface IlpSendResult {
  /** `true` = FULFILL, `false` = REJECT. Never an HTTP status. */
  accepted: boolean;
  /** Base64 of the answer packet's `data` — a sealed response wrap on a FULFILL. */
  data?: string;
  /** REJECT code: `F00`…`F06`, `T00`…`T05`, `R00`. Absent on a FULFILL. */
  code?: string;
  /** The REJECT's human-readable message. Diagnostic only; never branch on it. */
  message?: string;
  /** The ILP address of the hop that raised the REJECT, when it named itself. */
  triggeredBy?: string;
  /** Base64 of the 32-byte fulfilment, on a FULFILL. */
  fulfillment?: string;
  /**
   * The path's cost, as reported beside a REJECT (`toon-accumulated-cost`).
   * Present on every REJECT the connector answers and absent from a FULFILL.
   * `0n` when nothing was traversed and nothing terminated; on an underpayment
   * it is the route's price — which is the cheapest way to learn a price.
   */
  accumulatedCost?: bigint;
  /** The connector's verdict on the claim that rode with this packet, if it gave one. */
  claimAck?: ClaimAck;
  /**
   * The raw x402 terms document, when the connector answered with a greeting
   * instead of routing (HTTP `402`, or an `F06`/`F02` carrying a
   * `payment-required` protocolData entry). Parse with
   * {@link ../connector/x402.js}'s `parseX402Body`.
   */
  paymentRequired?: unknown;
}

/** A transport that can send an unpaid packet. */
export interface IlpClient {
  sendIlpPacket(params: IlpSendParams): Promise<IlpSendResult>;
}

/**
 * A transport that can send a packet with its covering claim attached.
 *
 * The claim is passed as a plain object and serialized by the carriage, because
 * the two carriages disagree about the envelope and only about that: HTTP sends
 * `base64(JSON.stringify(claim))` in the `ILP-Payment-Channel-Claim` header,
 * BTP sends the same JSON as raw UTF-8 in a `payment-channel-claim`
 * protocolData entry. Same object, two spellings.
 */
export interface ClaimSendingTransport extends IlpClient {
  sendIlpPacketWithClaim(
    params: IlpSendParams,
    claim: Record<string, unknown>
  ): Promise<IlpSendResult>;
}


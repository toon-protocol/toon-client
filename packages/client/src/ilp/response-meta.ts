/**
 * What rides **beside** the answer packet, decoded once for both carriages.
 *
 * Three facts about a paid write are deliberately not part of the OER
 * FULFILL/REJECT encoding — the accumulated cost, the connector's verdict on
 * the claim, and an x402 greeting — so each travels alongside the packet
 * instead of inside it. The two carriages spell them differently and mean
 * exactly the same thing:
 *
 * | Concept          | HTTP response header      | BTP protocolData entry    |
 * | ---------------- | ------------------------- | ------------------------- |
 * | accumulated cost | `toon-accumulated-cost`   | `toon-accumulated-cost`   |
 * | claim ack        | `toon-claim-ack`          | `claim-ack`               |
 * | x402 greeting    | `payment-required`        | `payment-required`        |
 *
 * That table is the connector's own `connector_btp::CARRIAGE_NAMES`, which
 * declares each concept's two names *as a pair* so a header cannot be added
 * without its protocolData twin (`peer-carriage-spec.md` invariant I2).
 * The only encoding difference is that HTTP base64s the two JSON-valued
 * fields, because base64 is a header artefact and nothing else
 * (`client-edge-spec.md` §1.3 vs §1.9 step 2 makes the same point about the
 * claim itself: HTTP sends `base64(JSON)`, BTP sends the raw UTF-8 JSON).
 *
 * Everything below therefore takes an already-de-base64'd string or the raw
 * bytes, so the HTTP reader in `../http/HttpIlpClient.ts` and the BTP reader
 * in `../btp/BtpRuntimeClient.ts` are two thin adapters over ONE decoder each.
 * That is the same discipline the connector holds itself to (invariant I1:
 * "a decoder written twice is a rule enforced once, and a rule enforced once
 * is a rule the two carriages cannot disagree about"), and the connector's
 * `vectors/wire-vectors.json` pins the two spellings of each value as a pair,
 * so a client that decoded them differently would fail the vector replay.
 */

import type { ClaimAck, IlpSendResult } from './types.js';
import { decodeUtf8, fromBase64 } from '../utils/binary.js';

/** The HTTP response header carrying the running cost of a REJECT. */
export const ACCUMULATED_COST_HEADER = 'toon-accumulated-cost';
/** The BTP protocolData entry carrying the running cost of a REJECT. */
export const ACCUMULATED_COST_PROTOCOL = 'toon-accumulated-cost';
/** The HTTP response header carrying the connector's verdict on the claim. */
export const CLAIM_ACK_HEADER = 'toon-claim-ack';
/**
 * The BTP protocolData entry carrying the connector's verdict on the claim.
 * Note the name is NOT the header's: `claim-ack`, not `toon-claim-ack`
 * (`connector_btp::CLAIM_ACK_PROTOCOL` vs `CLAIM_ACK_HEADER`). It is the one
 * pair in the table whose two halves are spelled differently, which is
 * exactly why they are declared here together rather than at each use site.
 */
export const CLAIM_ACK_PROTOCOL = 'claim-ack';
/** The HTTP response header carrying the x402 terms, base64 of the 402 body. */
export const PAYMENT_REQUIRED_HEADER = 'payment-required';
/** The BTP protocolData entry carrying the same x402 terms, raw UTF-8 JSON. */
export const PAYMENT_REQUIRED_PROTOCOL = 'payment-required';

/**
 * The three fields of an {@link IlpSendResult} that arrive beside the packet
 * rather than inside it. A key is present only when the carriage actually
 * carried a readable value — never defaulted, since a substituted default is
 * indistinguishable from a fact the connector stated.
 */
export type IlpResponseMeta = Pick<
  IlpSendResult,
  'accumulatedCost' | 'claimAck' | 'paymentRequired'
>;

/**
 * The four refusal reasons a `claim-ack` may name
 * (`connector_peer_btp::ack::reason_name`, `peer-carriage-spec.md` §6.1).
 * Closed on purpose: the connector's own decoder refuses a spelling its build
 * does not know, and §6.3 makes that "not acknowledged" rather than a fifth
 * verdict.
 */
export const CLAIM_REJECT_REASONS = [
  'signature_invalid',
  'nonce_not_advancing',
  'amount_not_advancing',
  'unknown_channel',
] as const;

/**
 * Decode the accumulated-cost value — a decimal `uint64` as UTF-8 text on
 * either carriage (`client-edge-spec.md` §1.6).
 *
 * `undefined` for anything that is not a bare run of digits. A cost is a
 * number the sender may reason about (an underpayment reports the route's
 * price, which is the cheapest way to learn one), so a value this client
 * cannot read is reported as absent rather than guessed at or coerced to `0` —
 * `0` is itself a meaningful answer, meaning "nothing was traversed and
 * nothing terminated".
 */
export function decodeAccumulatedCost(value: string): bigint | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  return BigInt(trimmed);
}

/**
 * Decode a `claim-ack` document: `{"result":"accepted"}` or
 * `{"result":"rejected","reason":"<one of CLAIM_REJECT_REASONS>"}`.
 *
 * **Absence and malformation both mean NOT ACKNOWLEDGED**
 * (`peer-carriage-spec.md` §6.3), so every shape that is not exactly one of
 * those two — undecodable JSON, an unknown `result`, a `rejected` carrying no
 * reason or an unknown one — yields `undefined`, and a caller must never read
 * `undefined` as either verdict. This mirrors `connector_peer_btp::ack::decode`
 * arm for arm; the connector's `ack_malformed` vector (`{"result":"maybe"}`)
 * is exactly this case, pinned on both carriages.
 */
export function decodeClaimAck(json: string): ClaimAck | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const result = (parsed as Record<string, unknown>)['result'];
  if (result === 'accepted') return { result: 'accepted' };
  if (result !== 'rejected') return undefined;
  const reason = (parsed as Record<string, unknown>)['reason'];
  if (typeof reason !== 'string') return undefined;
  if (!(CLAIM_REJECT_REASONS as readonly string[]).includes(reason)) {
    return undefined;
  }
  return { result: 'rejected', reason };
}

/**
 * Decode an x402 terms document that rode beside a packet, returning it raw.
 *
 * Raw, not parsed into {@link ../connector/x402.js}'s shape, because
 * `IlpSendResult.paymentRequired` is the document as the connector stated it:
 * the transports' job is to stop losing it, and deciding what it means is the
 * caller's. `undefined` when the bytes are not JSON at all.
 */
export function decodePaymentRequired(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    return undefined;
  }
}

/** Assemble a meta object, omitting every field the carriage did not carry. */
export function buildResponseMeta(parts: {
  accumulatedCost?: bigint | undefined;
  claimAck?: ClaimAck | undefined;
  paymentRequired?: unknown;
}): IlpResponseMeta {
  return {
    ...(parts.accumulatedCost !== undefined
      ? { accumulatedCost: parts.accumulatedCost }
      : {}),
    ...(parts.claimAck !== undefined ? { claimAck: parts.claimAck } : {}),
    ...(parts.paymentRequired !== undefined
      ? { paymentRequired: parts.paymentRequired }
      : {}),
  };
}

/**
 * Decode a base64 header value to its UTF-8 text, or `undefined` when it is
 * not decodable base64. Used for the two JSON-valued HTTP headers, whose BTP
 * twins carry the same text with no base64 layer at all.
 */
export function decodeBase64Text(value: string): string | undefined {
  try {
    return decodeUtf8(fromBase64(value.trim()));
  } catch {
    return undefined;
  }
}

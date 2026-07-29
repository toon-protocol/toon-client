/**
 * One sealed request/answer exchange with a terminating connector (ADR 0018,
 * ADR 0019, ADR 0020) — the whole shape of a packet's payload, from the
 * envelope going out to the answer coming back, behind two functions.
 *
 * A sender's obligations on this wire are not independent of one another, and
 * getting any of them separately wrong is silent:
 *
 * - The `data` is a gift wrap addressed to the connector that TERMINATES the
 *   route, around an OER envelope — never HTTP text, never a bare payload.
 * - The execution condition is `sha256` of the fulfilment DERIVED from the
 *   very secret that wrap carries. A random condition would never be
 *   fulfilled; an all-zero one is refused outright by the connector
 *   (`connector-domain`'s `condition_is_present`), which is why the publish
 *   path could not work against it at all before this module existed.
 * - The answer is sealed with that same secret, so opening it requires having
 *   kept it from the seal.
 *
 * {@link sealExchange} produces all three from one call so they cannot drift
 * apart, and {@link readExchangeOutcome} is the only thing that reads the
 * answer. The secret is the token joining them.
 *
 * ─── Why the outcome is a tagged union ─────────────────────────────────────
 * ADR 0018 gives a sender something it never had: a REJECT sealed with the
 * request's own secret can ONLY have come from the termination, because only
 * the termination could recover that secret. A reject raised short of it is
 * necessarily plaintext — an intermediate hop shares no secret and cannot
 * seal. So "the destination said no" and "somebody on the path said no" are
 * now genuinely different facts, and flattening both into one error string
 * would throw away the distinction the seal was introduced to create.
 *
 * ADR 0020 draws the other line this union encodes: an HTTP status inside a
 * response envelope is envelope CONTENT, not a packet outcome. A 404 arrives
 * on a FULFILL and value moved. {@link ExchangeOutcome.Answered} therefore
 * carries any status at all, and it is the caller's business — not this
 * module's — whether a given status means its own operation succeeded.
 *
 * Pure: no I/O, no clock, no network. Randomness only through
 * {@link sealRequest}.
 */

import {
  decodeEnvelopeResponse,
  encodeEnvelopeRequest,
  EnvelopeError,
  type EnvelopeRequest,
  type EnvelopeResponse,
} from './envelope.js';
import {
  deriveCondition,
  deriveFulfillment,
  GiftWrapError,
  looksLikeSealedResponse,
  openResponse,
  sealRequest,
} from './giftwrap.js';

/**
 * A sealed request, ready to become a PREPARE: what goes in `data`, what goes
 * on `executionCondition`, and the secret needed to read the answer.
 *
 * The three are produced together and belong together. Sending `data` under a
 * condition minted any other way produces a packet no honest connector can
 * fulfil; opening the answer with any other secret fails.
 */
export interface SealedExchange {
  /** The gift wrap to carry as the PREPARE's `data`. */
  readonly data: Uint8Array;
  /**
   * The PREPARE's `executionCondition`: `sha256(deriveFulfillment(secret))`.
   * Derived, never random and never caller-supplied — the terminating
   * connector recovers the same secret and derives the same fulfilment
   * without the app participating (ADR 0019).
   */
  readonly condition: Uint8Array;
  /**
   * The 32-byte secret sealed inside the wrap. Keep it until the answer is
   * read; it is the only thing that opens the response. Never send it
   * anywhere else, and never reuse it for a second packet.
   */
  readonly sharedSecret: Uint8Array;
  /**
   * The fulfilment the terminating connector will return. Held so a caller
   * can check the FULFILL preimage it actually got, rather than only that it
   * hashes to the condition.
   */
  readonly fulfillment: Uint8Array;
}

/**
 * How an exchange ended. Three outcomes, deliberately not two: a refusal's
 * ORIGIN is the fact ADR 0018 makes knowable for the first time.
 */
export type ExchangeOutcome =
  /**
   * The termination answered. `response` is whatever it said, at whatever
   * status — a non-2xx here is a real answer that was paid for (ADR 0020),
   * not a failure of the packet.
   */
  | { readonly kind: 'answered'; readonly response: EnvelopeResponse }
  /**
   * The DESTINATION refused, provably: the reject's `data` was sealed with
   * this exchange's own secret, which only the terminating connector could
   * hold. `detail` is whatever it sealed alongside (often empty).
   */
  | {
      readonly kind: 'destination-refused';
      readonly code: string;
      readonly message: string;
      readonly detail: Uint8Array;
    }
  /**
   * Somebody ON THE PATH refused — no route, expiry, a ceiling, a rejected
   * claim — short of the termination, so nothing was sealed. Unauthenticated
   * by construction: any hop can produce this, and it should be read as a
   * hint, not a verdict from the destination.
   */
  | {
      readonly kind: 'path-refused';
      readonly code: string;
      readonly message: string;
    };

/**
 * Why an answer that arrived could not be read. Distinct from an
 * {@link ExchangeOutcome}: these are not the destination's answer at all, but
 * bytes that failed to be one.
 */
export type SealedResponseErrorKind =
  /** A FULFILL whose `data` is absent, or does not begin with the sealed-response type byte. */
  | 'not-sealed'
  /** The wrap is shaped right but does not open under this exchange's secret. */
  | 'unopenable'
  /** It opened, and what came out is not a response envelope. */
  | 'malformed-envelope';

/** A refusal to read an answer. Never carries recovered plaintext. */
export class SealedResponseError extends Error {
  constructor(
    readonly kind: SealedResponseErrorKind,
    message: string,
    override readonly cause?: Error
  ) {
    super(message);
    this.name = 'SealedResponseError';
  }
}

/**
 * Seal `request` to `connectorPublicKey` — the identity of the connector that
 * TERMINATES the destination, as read from its own client edge
 * (`ConnectorEdgeClient`). Sealing to any other key is a confidentiality
 * failure that presents as an undeliverable packet.
 *
 * @param request the envelope to seal.
 * @param connectorPublicKey the terminating connector's 65-byte uncompressed
 *   secp256k1 identity key.
 */
export function sealExchange(
  request: EnvelopeRequest,
  connectorPublicKey: Uint8Array
): SealedExchange {
  const { wrapped, sharedSecret } = sealRequest(
    encodeEnvelopeRequest(request),
    connectorPublicKey
  );
  const fulfillment = deriveFulfillment(sharedSecret);
  return {
    data: wrapped,
    condition: deriveCondition(fulfillment),
    sharedSecret,
    fulfillment,
  };
}

/**
 * Read what came back.
 *
 * `accepted` distinguishes a FULFILL from a REJECT; `data` is the packet's
 * payload bytes, absent when it carried none. Both come straight off the
 * transport's result, so this stays testable without a socket.
 *
 * A FULFILL must be sealed and must decode: value moved, so bytes that are
 * neither are a broken counterparty, and this throws rather than inventing an
 * outcome. A REJECT is classified instead of thrown on — an unopenable one is
 * simply a path reject that happened to carry bytes.
 *
 * @throws {SealedResponseError} for a FULFILL that is not a readable sealed
 *   response envelope.
 */
export function readExchangeOutcome(
  result: { accepted: boolean; code?: string; message?: string },
  data: Uint8Array | undefined,
  sharedSecret: Uint8Array
): ExchangeOutcome {
  if (result.accepted) {
    return { kind: 'answered', response: openAnswer(data, sharedSecret) };
  }

  const code = result.code ?? 'F00';
  const message = result.message ?? '';

  // Only the termination could have sealed this, so only a wrap that actually
  // OPENS proves the destination refused. A leading type byte alone is a
  // claim, not evidence — an intermediary can write one byte.
  if (data !== undefined && looksLikeSealedResponse(data)) {
    try {
      return {
        kind: 'destination-refused',
        code,
        message,
        detail: openResponse(sharedSecret, data),
      };
    } catch (error) {
      if (!(error instanceof GiftWrapError)) throw error;
      // Fall through: bytes that pose as sealed but do not open are not the
      // destination's word, and must not be reported as if they were.
    }
  }

  return { kind: 'path-refused', code, message };
}

function openAnswer(
  data: Uint8Array | undefined,
  sharedSecret: Uint8Array
): EnvelopeResponse {
  if (data === undefined || data.length === 0) {
    throw new SealedResponseError(
      'not-sealed',
      'FULFILL carried no data; a terminated route always seals a response envelope'
    );
  }
  if (!looksLikeSealedResponse(data)) {
    throw new SealedResponseError(
      'not-sealed',
      `FULFILL data is not a sealed response (leading byte 0x${(data[0] ?? 0)
        .toString(16)
        .padStart(2, '0')}, expected 0x02)`
    );
  }

  let opened: Uint8Array;
  try {
    opened = openResponse(sharedSecret, data);
  } catch (error) {
    if (!(error instanceof GiftWrapError)) throw error;
    throw new SealedResponseError(
      'unopenable',
      'FULFILL data did not open under this packet\'s shared secret',
      error
    );
  }

  try {
    return decodeEnvelopeResponse(opened);
  } catch (error) {
    if (!(error instanceof EnvelopeError)) throw error;
    throw new SealedResponseError(
      'malformed-envelope',
      `sealed answer opened but did not decode as a response envelope: ${error.message}`,
      error
    );
  }
}

/** Read a response header, case-insensitively; the first match wins. */
export function envelopeHeader(
  response: EnvelopeResponse,
  name: string
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [header, value] of response.headers) {
    if (header.toLowerCase() === wanted) return value;
  }
  return undefined;
}

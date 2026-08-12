/**
 * The structured wire (ADR 0018) as this client speaks it.
 *
 * The OER envelope codec, the gift wrap that seals it to the terminating
 * connector's identity, and the fulfilment a sealed request's shared secret
 * derives (ADR 0019) — each checked against the connector's committed
 * cross-repo vectors in `wire-vectors.test.ts`.
 *
 * `sealed-exchange.ts` binds them into the one thing a sender actually forms:
 * a sealed request, the condition that matches it, and the reader for the
 * answer that comes back. It is what `ToonClient.publishEvent` sends
 * (toon-client#450).
 */

export {
  OerError,
  OerErrorKind,
  encodeVarUint,
  decodeVarUint,
  encodeVarOctetString,
  decodeVarOctetString,
  type Decoded,
} from './oer.js';

export {
  EnvelopeError,
  EnvelopeErrorKind,
  encodeEnvelope,
  decodeEnvelope,
  encodeEnvelopeRequest,
  decodeEnvelopeRequest,
  encodeEnvelopeResponse,
  decodeEnvelopeResponse,
  type Envelope,
  type EnvelopeHeader,
  type EnvelopeRequest,
  type EnvelopeResponse,
} from './envelope.js';

export {
  GiftWrapError,
  GiftWrapErrorKind,
  GIFTWRAP_NONCE_LENGTH,
  GIFTWRAP_PUBLIC_KEY_LENGTH,
  GIFTWRAP_SECRET_LENGTH,
  GIFTWRAP_TYPE_REQUEST,
  GIFTWRAP_TYPE_RESPONSE,
  deriveCondition,
  deriveFulfillment,
  giftWrapPublicKey,
  localGiftWrapEcdh,
  looksLikeSealedResponse,
  openRequest,
  openResponse,
  sealRequest,
  sealRequestWithRandomness,
  sealResponse,
  sealResponseWithRandomness,
  type GiftWrapEcdh,
  type OpenedRequest,
  type SealedRequest,
} from './giftwrap.js';

export {
  sealExchange,
  readExchangeOutcome,
  envelopeHeader,
  SealedResponseError,
  type SealedExchange,
  type ExchangeOutcome,
  type SealedResponseErrorKind,
} from './sealed-exchange.js';

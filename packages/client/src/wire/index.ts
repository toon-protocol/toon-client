/**
 * The structured wire (ADR 0018) as this client speaks it.
 *
 * Today: the OER envelope codec, checked against the connector's committed
 * cross-repo vectors. The seal around it (toon-client#449) and the fulfilment
 * derivation land beside these.
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

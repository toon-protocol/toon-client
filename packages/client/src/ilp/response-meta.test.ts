/**
 * The one invariant this module exists for: **the two carriages must agree**.
 *
 * The connector pins each of these values in two spellings at once — a
 * `http_headers` array and a `btp_response_hex` frame in the same
 * `vectors/wire-vectors.json` fixture — and declares the header/entry names as
 * pairs (`connector_btp::CARRIAGE_NAMES`, peer-carriage-spec invariant I2). A
 * client that decoded one side differently from the other would report a
 * different cost, or a different claim verdict, depending on which socket the
 * answer happened to come back over.
 *
 * The literal base64 strings below are copied from that vector set, so these
 * cases fail if the encoding drifts even where a hand-written fixture would
 * not. W-B's full replay walks the file itself; this suite pins the decoders.
 */
import { describe, it, expect } from 'vitest';
import { readResponseMeta as readHttpMeta } from '../http/HttpIlpClient.js';
import { readResponseMeta as readBtpMeta } from '../btp/BtpRuntimeClient.js';
import { decodeAccumulatedCost, decodeClaimAck } from './response-meta.js';
import type { BTPProtocolData } from '../btp/protocol.js';
import { encodeUtf8 } from '../utils/binary.js';

function pd(protocolName: string, text: string): BTPProtocolData {
  return { protocolName, contentType: 1, data: encodeUtf8(text) };
}

/** `{"result":"accepted"}`, base64 — `peer_fulfill_ack_accepted`. */
const ACK_ACCEPTED_B64 = 'eyJyZXN1bHQiOiJhY2NlcHRlZCJ9';
/** `{"result":"rejected","reason":"signature_invalid"}`, base64 — `peer_fulfill_ack_rejected`. */
const ACK_REJECTED_B64 =
  'eyJyZXN1bHQiOiJyZWplY3RlZCIsInJlYXNvbiI6InNpZ25hdHVyZV9pbnZhbGlkIn0=';
/** `{"result":"maybe"}`, base64 — `peer_ack_malformed`. */
const ACK_MALFORMED_B64 = 'eyJyZXN1bHQiOiJtYXliZSJ9';

describe('HTTP and BTP decode the same fact to the same value', () => {
  it('peer_reject_with_cost: 4200 and an accepted ack, on both carriages', () => {
    const http = readHttpMeta([
      ['toon-accumulated-cost', '4200'],
      ['toon-claim-ack', ACK_ACCEPTED_B64],
    ]);
    const btp = readBtpMeta([
      pd('toon-accumulated-cost', '4200'),
      pd('claim-ack', '{"result":"accepted"}'),
    ]);

    expect(http).toEqual(btp);
    expect(http).toEqual({
      accumulatedCost: 4200n,
      claimAck: { result: 'accepted' },
    });
  });

  it('peer_fulfill_ack_rejected: a rejected ack with no cost, on both carriages', () => {
    const http = readHttpMeta([['toon-claim-ack', ACK_REJECTED_B64]]);
    const btp = readBtpMeta([
      pd('claim-ack', '{"result":"rejected","reason":"signature_invalid"}'),
    ]);

    expect(http).toEqual(btp);
    expect(http).toEqual({
      claimAck: { result: 'rejected', reason: 'signature_invalid' },
    });
  });

  it('peer_ack_absent: nothing on either carriage means nothing, not a verdict', () => {
    expect(readHttpMeta([])).toEqual(readBtpMeta([]));
    expect(readHttpMeta([])).toEqual({});
  });

  it('peer_ack_malformed: not acknowledged on either carriage', () => {
    const http = readHttpMeta([['toon-claim-ack', ACK_MALFORMED_B64]]);
    const btp = readBtpMeta([pd('claim-ack', '{"result":"maybe"}')]);
    expect(http).toEqual(btp);
    expect(http.claimAck).toBeUndefined();
  });

  it('the x402 terms decode to the same document either way', () => {
    const terms = {
      x402Version: 2,
      resource: { url: 'g.toon.relay' },
      accepts: [{ scheme: 'toon-channel', amount: '1' }],
    };
    const json = JSON.stringify(terms);
    const http = readHttpMeta([
      ['payment-required', Buffer.from(json, 'utf8').toString('base64')],
    ]);
    const btp = readBtpMeta([pd('payment-required', json)]);

    expect(http).toEqual(btp);
    expect(http.paymentRequired).toEqual(terms);
  });
});

describe('decodeAccumulatedCost', () => {
  it('reads a decimal uint64, including one past 2^53', () => {
    expect(decodeAccumulatedCost('0')).toBe(0n);
    expect(decodeAccumulatedCost(' 4200 ')).toBe(4200n);
    expect(decodeAccumulatedCost('18446744073709551615')).toBe(
      18446744073709551615n
    );
  });

  it('refuses anything that is not a bare run of digits', () => {
    // Reported as absent, never coerced: `0n` is itself an answer — "nothing
    // was traversed and nothing terminated" (client-edge-spec §1.6).
    for (const bad of ['', '-1', '1.5', '0x10', '1e3', 'lots']) {
      expect(decodeAccumulatedCost(bad)).toBeUndefined();
    }
  });
});

describe('decodeClaimAck', () => {
  it('reads the four reasons the connector can name', () => {
    for (const reason of [
      'signature_invalid',
      'nonce_not_advancing',
      'amount_not_advancing',
      'unknown_channel',
    ]) {
      expect(
        decodeClaimAck(`{"result":"rejected","reason":"${reason}"}`)
      ).toEqual({ result: 'rejected', reason });
    }
  });

  it('reads a rejected ack whatever key order the JSON arrived in', () => {
    expect(
      decodeClaimAck('{"reason":"unknown_channel","result":"rejected"}')
    ).toEqual({ result: 'rejected', reason: 'unknown_channel' });
  });

  it('returns undefined for every shape that is not one of the two documented ones', () => {
    // `peer-carriage-spec.md` §6.3: absence and malformation both mean NOT
    // ACKNOWLEDGED, and a caller must never read that as either verdict.
    expect(decodeClaimAck('nonsense')).toBeUndefined();
    expect(decodeClaimAck('null')).toBeUndefined();
    expect(decodeClaimAck('[]')).toBeUndefined();
    expect(decodeClaimAck('{"result":"maybe"}')).toBeUndefined();
    expect(decodeClaimAck('{"result":"rejected"}')).toBeUndefined();
    expect(
      decodeClaimAck('{"result":"rejected","reason":"vibes"}')
    ).toBeUndefined();
  });
});

import { describe, it, expect } from 'vitest';
import {
  ILPPacketType,
  BTPMessageType,
  serializeIlpPrepare,
  deserializeIlpPacket,
  parseBtpMessage,
  serializeBtpMessage,
  type BTPErrorData,
  type BTPTransferData,
} from './protocol.js';

describe('serializeIlpPrepare — executionCondition on the wire', () => {
  // OER layout: type(1) | varUInt amount | GeneralizedTime(19) | condition(32) | ...
  function conditionBytesOf(prepare: Uint8Array): Uint8Array {
    let offset = 1;
    const first = prepare[offset]!;
    offset += first <= 127 ? 1 : 1 + (first & 0x7f);
    offset += 19; // 'YYYYMMDDHHMMSS.mmmZ'
    return prepare.slice(offset, offset + 32);
  }

  it('places a caller-supplied 32-byte condition verbatim', () => {
    const condition = new Uint8Array(32).map((_, i) => i + 1);
    const prepare = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: 1000n,
      destination: 'g.toon.alice',
      executionCondition: condition,
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
      data: new Uint8Array([9]),
    });
    expect(conditionBytesOf(prepare)).toEqual(condition);
  });

  it('zero condition serializes as 32 zero bytes (legacy class)', () => {
    const prepare = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: 1n,
      destination: 'g.toon.alice',
      executionCondition: new Uint8Array(32),
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
      data: new Uint8Array(0),
    });
    expect(conditionBytesOf(prepare)).toEqual(new Uint8Array(32));
  });
});

describe('deserializeIlpPacket — FULFILL fulfillment capture (#350)', () => {
  it('captures the 32-byte fulfillment preimage from the wire', () => {
    const fulfillment = new Uint8Array(32).map((_, i) => 255 - i);
    const data = new Uint8Array([7, 8]);
    const wire = new Uint8Array([
      ILPPacketType.FULFILL,
      ...fulfillment,
      data.length,
      ...data,
    ]);
    const packet = deserializeIlpPacket(wire);
    expect(packet.type).toBe(ILPPacketType.FULFILL);
    if (packet.type !== ILPPacketType.FULFILL) return;
    expect(packet.fulfillment).toEqual(fulfillment);
    expect(packet.data).toEqual(data);
  });

  it('throws on a truncated FULFILL (fulfillment shorter than 32 bytes)', () => {
    const wire = new Uint8Array([ILPPacketType.FULFILL, 1, 2, 3]);
    expect(() => deserializeIlpPacket(wire)).toThrow(/underflow/i);
  });
});

describe('parseBtpMessage — ERROR data shape', () => {
  it('decodes code/name/triggeredAt and the trailing data as a UTF-8 message', () => {
    const enc = new TextEncoder();
    const code = enc.encode('F00');
    const name = enc.encode('NotAcceptedError');
    const triggeredAt = enc.encode('2026-07-12T00:00:00.000Z');
    const msg = enc.encode('bad auth token');
    const wire = new Uint8Array([
      BTPMessageType.ERROR,
      0,
      0,
      0,
      42, // requestId
      code.length,
      ...code,
      name.length,
      ...name,
      triggeredAt.length,
      ...triggeredAt,
      0,
      0,
      0,
      msg.length, // uint32 BE data length
      ...msg,
    ]);

    const message = parseBtpMessage(wire);
    expect(message.type).toBe(BTPMessageType.ERROR);
    expect(message.requestId).toBe(42);
    const errData = message.data as BTPErrorData;
    expect(errData.code).toBe('F00');
    expect(errData.name).toBe('NotAcceptedError');
    expect(errData.triggeredAt).toBe('2026-07-12T00:00:00.000Z');
    expect(errData.message).toBe('bad auth token');
    expect(errData.data).toEqual(msg);
  });
});

// ─── TRANSFER (type 7) — toon-client#493, connector issue #697's symmetric
// grammar. Vectors mirror crates/connector-client-edge/src/btp.rs's own unit
// tests byte-for-byte, so the two implementations agree on the wire.

describe('serializeBtpMessage — TRANSFER is amount then protocolData, no ILP trailer', () => {
  it('matches the connector encode_transfer vector', () => {
    const encoded = serializeBtpMessage({
      type: BTPMessageType.TRANSFER,
      requestId: 11,
      data: {
        amount: 1_000_000n,
        protocolData: [
          {
            protocolName: 'payout-claim',
            contentType: 1,
            data: new TextEncoder().encode('{}'),
          },
        ],
      },
    });

    const nameBytes = new TextEncoder().encode('payout-claim');
    const expected = new Uint8Array([
      7, // TRANSFER
      0, 0, 0, 11, // requestId
      0, 0, 0, 0, 0, 0x0f, 0x42, 0x40, // amount 1_000_000 as u64 BE
      1, // one protocolData entry
      nameBytes.length,
      ...nameBytes,
      0, 1, // contentType
      0, 0, 0, 2, // dataLen
      0x7b, 0x7d, // "{}"
    ]);
    expect(encoded).toEqual(expected);
  });

  it('matches the connector vector for zero amount and no protocolData', () => {
    const encoded = serializeBtpMessage({
      type: BTPMessageType.TRANSFER,
      requestId: 6,
      data: { amount: 0n, protocolData: [] },
    });
    expect(encoded).toEqual(
      new Uint8Array([7, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0])
    );
  });
});

describe('parseBtpMessage — TRANSFER decode', () => {
  it('round-trips amount + protocolData with no ILP packet', () => {
    const claimBytes = new TextEncoder().encode('claim-bytes');
    const encoded = serializeBtpMessage({
      type: BTPMessageType.TRANSFER,
      requestId: 5,
      data: {
        amount: 42n,
        protocolData: [
          { protocolName: 'payout-claim', contentType: 1, data: claimBytes },
        ],
      },
    });

    const decoded = parseBtpMessage(encoded);
    expect(decoded.type).toBe(BTPMessageType.TRANSFER);
    expect(decoded.requestId).toBe(5);
    const data = decoded.data as BTPTransferData;
    expect(data.amount).toBe(42n);
    expect(data.protocolData).toEqual([
      { protocolName: 'payout-claim', contentType: 1, data: claimBytes },
    ]);
    expect('ilpPacket' in data).toBe(false);
  });

  it('decodes a TRANSFER with no protocolData to an empty list', () => {
    const wire = new Uint8Array([7, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    const decoded = parseBtpMessage(wire);
    const data = decoded.data as BTPTransferData;
    expect(data.amount).toBe(0n);
    expect(data.protocolData).toEqual([]);
  });

  it('throws on a truncated TRANSFER amount', () => {
    // Type TRANSFER, requestId 8, five of the eight amount bytes.
    const wire = new Uint8Array([7, 0, 0, 0, 8, 0, 0, 0, 0, 0]);
    expect(() => parseBtpMessage(wire)).toThrow(/underflow/i);
  });

  it('a MESSAGE still decodes with no amount field, unchanged by TRANSFER (#697 non-regression)', () => {
    const encoded = serializeBtpMessage({
      type: BTPMessageType.MESSAGE,
      requestId: 1,
      data: { protocolData: [], ilpPacket: new Uint8Array(0) },
    });
    const decoded = parseBtpMessage(encoded);
    expect('amount' in decoded.data).toBe(false);
  });
});

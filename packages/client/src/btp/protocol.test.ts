import { describe, it, expect } from 'vitest';
import {
  ILPPacketType,
  BTPMessageType,
  serializeIlpPrepare,
  deserializeIlpPacket,
  parseBtpMessage,
  type BTPErrorData,
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

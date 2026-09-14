import { describe, it, expect } from 'vitest';
import {
  ILPPacketType,
  BTPMessageType,
  serializeIlpPrepare,
  deserializeIlpPacket,
  deserializeIlpPrepare,
  serializeIlpFulfill,
  serializeIlpReject,
  parseBtpMessage,
  serializeBtpMessage,
  type BTPErrorData,
  type BTPTransferData,
} from './protocol.js';

describe('serializeIlpPrepare — the greeting flag on the wire (ADR 0069)', () => {
  // OER layout: type(1) | varUInt amount | GeneralizedTime(19) | greeting(1) | ...
  // The flag sits exactly where a 32-byte execution condition sat until
  // connector issue #1269 removed it; a decoder reading one byte where the
  // encoder wrote thirty-two is the bug that produced the `invalid packet
  // type byte` refusal this replaces.
  /**
   * Read one byte, failing loudly rather than asserting non-null. A short
   * buffer here means the encoder changed shape, and that must not quietly
   * read as `undefined` and compare unequal to both 0 and 1 — the whole point
   * of this suite is that the byte is where we say it is.
   */
  function byteAt(buf: Uint8Array, index: number): number {
    const byte = buf[index];
    if (byte === undefined) {
      throw new Error(`PREPARE is too short to hold a byte at offset ${index}`);
    }
    return byte;
  }

  function greetingByteOf(prepare: Uint8Array): number {
    let offset = 1;
    const first = byteAt(prepare, offset);
    offset += first <= 127 ? 1 : 1 + (first & 0x7f);
    offset += 19; // 'YYYYMMDDHHMMSS.mmmZ'
    return byteAt(prepare, offset);
  }

  it('writes 0x00 for an ordinary payment attempt', () => {
    const prepare = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: 1000n,
      destination: 'g.toon.alice',
      greeting: false,
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
      data: new Uint8Array([9]),
    });
    expect(greetingByteOf(prepare)).toBe(0x00);
  });

  it('writes 0x01 for a bootstrap probe', () => {
    const prepare = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: 1n,
      destination: 'g.toon.alice',
      greeting: true,
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
      data: new Uint8Array(0),
    });
    expect(greetingByteOf(prepare)).toBe(0x01);
  });

  it('spends one byte on the flag, not thirty-two', () => {
    // -31 bytes per packet per hop is ADR 0069's own arithmetic, and the
    // clearest single assertion that this codec is on the new wire.
    const fields = {
      type: ILPPacketType.PREPARE,
      amount: 1000n,
      destination: 'g.toon.alice',
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
      data: new Uint8Array([9]),
    } as const;
    const prepare = serializeIlpPrepare({ ...fields, greeting: false });
    // type(1) + amount varUInt(3 for 1000) + time(19) + greeting(1)
    // + destination(1+12) + data(1+1)
    expect(prepare.length).toBe(1 + 3 + 19 + 1 + 1 + 12 + 1 + 1);
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

describe('deserializeIlpPrepare — server-role decode (toon-client#494)', () => {
  it.each([false, true])(
    'round-trips every field through serializeIlpPrepare (greeting: %s)',
    (greeting) => {
      const expiresAt = new Date('2026-07-12T00:00:00.000Z');
      const wire = serializeIlpPrepare({
        type: ILPPacketType.PREPARE,
        amount: 12345n,
        destination: 'g.toon.provider',
        greeting,
        expiresAt,
        data: new Uint8Array([1, 2, 3]),
      });
      const decoded = deserializeIlpPrepare(wire);
      expect(decoded.amount).toBe(12345n);
      expect(decoded.destination).toBe('g.toon.provider');
      expect(decoded.greeting).toBe(greeting);
      expect(decoded.expiresAt.toISOString()).toBe(expiresAt.toISOString());
      expect(decoded.data).toEqual(new Uint8Array([1, 2, 3]));
    }
  );

  it('refuses a greeting byte that is neither 0x00 nor 0x01', () => {
    // `Prepare::decode` answers anything else with `PacketError::InvalidType`
    // rather than coercing it to truthy, so this decoder must refuse the same
    // bytes rather than quietly accepting a packet the connector would not.
    const wire = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: 100n,
      destination: 'g.toon.provider',
      greeting: false,
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
      data: new Uint8Array(0),
    });
    // type(1) + amount varUInt(1 for 100) + GeneralizedTime(19) = offset 21.
    expect(wire[21]).toBe(0x00);
    const corrupted = wire.slice();
    corrupted[21] = 0x02;
    expect(() => deserializeIlpPrepare(corrupted)).toThrow(/greeting/i);
  });

  it('throws on a non-PREPARE type byte', () => {
    const wire = serializeIlpFulfill({
      fulfillment: new Uint8Array(32),
      data: new Uint8Array(0),
    });
    expect(() => deserializeIlpPrepare(wire)).toThrow(/PREPARE/);
  });

  it('throws on a truncated PREPARE', () => {
    const wire = serializeIlpPrepare({
      type: ILPPacketType.PREPARE,
      amount: 1n,
      destination: 'g.toon.provider',
      greeting: false,
      expiresAt: new Date('2026-07-12T00:00:00.000Z'),
      data: new Uint8Array(0),
    });
    expect(() => deserializeIlpPrepare(wire.slice(0, wire.length - 5))).toThrow(
      /underflow/i
    );
  });
});

describe('serializeIlpFulfill — server-role encode (toon-client#494)', () => {
  it('round-trips through deserializeIlpPacket', () => {
    const fulfillment = new Uint8Array(32).map((_, i) => i);
    const data = new Uint8Array([9, 8, 7]);
    const wire = serializeIlpFulfill({ fulfillment, data });
    const decoded = deserializeIlpPacket(wire);
    expect(decoded.type).toBe(ILPPacketType.FULFILL);
    if (decoded.type !== ILPPacketType.FULFILL) return;
    expect(decoded.fulfillment).toEqual(fulfillment);
    expect(decoded.data).toEqual(data);
  });

  it('throws when the fulfillment is not exactly 32 bytes', () => {
    expect(() =>
      serializeIlpFulfill({ fulfillment: new Uint8Array(31), data: new Uint8Array(0) })
    ).toThrow(/32 bytes/);
  });
});

describe('serializeIlpReject — server-role encode (toon-client#494)', () => {
  it('round-trips code/triggeredBy/message/data through deserializeIlpPacket', () => {
    const wire = serializeIlpReject({
      code: 'F99',
      triggeredBy: 'g.toon.provider',
      message: 'handler declined',
      data: new Uint8Array([1]),
    });
    const decoded = deserializeIlpPacket(wire);
    expect(decoded.type).toBe(ILPPacketType.REJECT);
    if (decoded.type !== ILPPacketType.REJECT) return;
    expect(decoded.code).toBe('F99');
    expect(decoded.triggeredBy).toBe('g.toon.provider');
    expect(decoded.message).toBe('handler declined');
    expect(decoded.data).toEqual(new Uint8Array([1]));
  });

  it('defaults triggeredBy to an empty string when omitted', () => {
    const wire = serializeIlpReject({
      code: 'F00',
      message: 'malformed',
      data: new Uint8Array(0),
    });
    const decoded = deserializeIlpPacket(wire);
    if (decoded.type !== ILPPacketType.REJECT) throw new Error('expected REJECT');
    expect(decoded.triggeredBy).toBe('');
  });

  it('throws when code is not exactly 3 ASCII characters', () => {
    expect(() =>
      serializeIlpReject({ code: 'F9', message: 'x', data: new Uint8Array(0) })
    ).toThrow(/3 ASCII characters/);
  });
});

/**
 * Integration test: BtpRuntimeClient against a real local `ws` WebSocket
 * server speaking BTP binary frames. Exercises the full BTP path — auth
 * frame, MESSAGE framing, OER PREPARE serialization on the wire, and OER
 * FULFILL parsing — without mocking the socket.
 *
 * Covers sender-chosen execution conditions (#350): the condition and
 * explicit expiry land on the OER wire inside the BTP MESSAGE, and the
 * FULFILL preimage is verified client-side (contract: connector
 * docs/local-delivery-fulfillment-contract.md).
 *
 * And what rides BESIDE the packet (`client-edge-spec.md` §1.6, §1.9 step 2):
 * `toon-accumulated-cost`, `claim-ack` and `payment-required` protocolData
 * entries on the RESPONSE frame survive a real websocket round trip and land
 * on the `IlpSendResult` — the BTP half of the pair the connector's vector set
 * pins alongside the HTTP headers.
 *
 * Runs under the integration config (`vitest.integration.config.ts`); needs
 * no external services (binds an ephemeral loopback port).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { BtpRuntimeClient } from '../btp/BtpRuntimeClient.js';
import {
  FULFILLMENT_MISMATCH_CODE,
  type IlpSendResultWithFulfillment,
} from '../ilp/ilp-send.js';
import { mintExecutionCondition } from '../utils/condition.js';
import {
  BTPMessageType,
  parseBtpMessage,
  serializeBtpMessage,
  type BTPMessageData,
  type BTPProtocolData,
} from '../btp/protocol.js';

const ILP_FULFILL = 13;
const ILP_REJECT = 14;

function serializeFulfill(
  data: Uint8Array,
  fulfillment: Uint8Array = new Uint8Array(32)
): Uint8Array {
  return new Uint8Array([ILP_FULFILL, ...fulfillment, data.length, ...data]);
}

/** An OER REJECT: type(1) code(3) triggeredBy message data. */
function serializeReject(code: string, message: string): Uint8Array {
  const enc = new TextEncoder();
  const msg = enc.encode(message);
  const trigger = enc.encode('g.connector');
  return new Uint8Array([
    ILP_REJECT,
    ...enc.encode(code),
    trigger.length,
    ...trigger,
    msg.length,
    ...msg,
    0,
  ]);
}

/** One protocolData entry carrying UTF-8 text, the way the connector writes them. */
function pd(protocolName: string, text: string): BTPProtocolData {
  return {
    protocolName,
    contentType: 1,
    data: new TextEncoder().encode(text),
  };
}

/**
 * Parse the executionCondition + expiresAt out of an OER PREPARE.
 * Layout: type(1) | varUInt amount | GeneralizedTime(19) | condition(32) | ...
 */
function parsePrepareWire(body: Uint8Array): {
  expiresAt: string;
  condition: Uint8Array;
} {
  let offset = 1;
  const first = body[offset]!;
  offset += first <= 127 ? 1 : 1 + (first & 0x7f);
  const expiresAt = new TextDecoder().decode(body.slice(offset, offset + 19));
  offset += 19;
  return { expiresAt, condition: body.slice(offset, offset + 32) };
}

describe('BtpRuntimeClient over a real ws server (integration)', () => {
  let wss: WebSocketServer;
  let btpUrl: string;
  let lastPrepareWire:
    | { expiresAt: string; condition: Uint8Array }
    | undefined;
  /** When set, the server FULFILLs with this preimage instead of zeros. */
  let respondFulfillment: Uint8Array | undefined;
  /**
   * When set, the server answers a PREPARE with exactly this RESPONSE body
   * instead of the default FULFILL — the way a real connector answers a
   * refusal or a greeting, with entries riding beside the packet.
   */
  let respondWith:
    | { protocolData: BTPProtocolData[]; ilpPacket: Uint8Array }
    | undefined;

  beforeAll(async () => {
    wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    wss.on('connection', (socket) => {
      socket.on('message', (raw: Buffer) => {
        const message = parseBtpMessage(new Uint8Array(raw));
        if (message.type !== BTPMessageType.MESSAGE) return;
        const data = message.data as BTPMessageData;

        // Auth frame → empty RESPONSE.
        if (data.protocolData.some((pd) => pd.protocolName === 'auth')) {
          socket.send(
            serializeBtpMessage({
              type: BTPMessageType.RESPONSE,
              requestId: message.requestId,
              data: { protocolData: [] },
            })
          );
          return;
        }

        // ILP PREPARE → RESPONSE carrying an OER FULFILL or REJECT.
        if (data.ilpPacket && data.ilpPacket.length > 0) {
          lastPrepareWire = parsePrepareWire(data.ilpPacket);
          socket.send(
            serializeBtpMessage({
              type: BTPMessageType.RESPONSE,
              requestId: message.requestId,
              data: respondWith ?? {
                protocolData: [],
                ilpPacket: serializeFulfill(
                  new TextEncoder().encode('ok'),
                  respondFulfillment ?? new Uint8Array(32)
                ),
              },
            })
          );
        }
      });
    });
    await new Promise<void>((resolve) => wss.on('listening', resolve));
    const { port } = wss.address() as AddressInfo;
    btpUrl = `ws://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  function makeClient(): BtpRuntimeClient {
    return new BtpRuntimeClient({
      btpUrl,
      peerId: 'itest-peer',
      authToken: 'itest-secret',
      maxRetries: 0,
    });
  }

  it('legacy default: all-zero condition on the wire, FULFILL accepted unverified', async () => {
    respondWith = undefined;
    respondFulfillment = undefined;
    const client = makeClient();
    await client.connect();
    try {
      const result = await client.sendIlpPacketWithClaim(
        { destination: 'g.toon.alice', amount: '1000', data: 'aGVsbG8=' },
        { messageId: 'm1', nonce: 1, transferredAmount: '1000' }
      );
      expect(result.accepted).toBe(true);
      expect(lastPrepareWire!.condition).toEqual(new Uint8Array(32));
    } finally {
      await client.disconnect();
    }
  });

  it('puts a sender-chosen condition + explicit expiry on the wire and verifies the FULFILL preimage (#350)', async () => {
    respondWith = undefined;
    const { preimage, condition } = mintExecutionCondition();
    respondFulfillment = preimage;
    // Near-future expiry (a far-future one overflows setTimeout's 32-bit ms).
    const expiresAt = new Date(Date.now() + 60_000);
    // GeneralizedTime 'YYYYMMDDHHMMSS.mmmZ' == ISO string minus separators.
    const expectedWireExpiry = expiresAt.toISOString().replace(/[-:T]/g, '');
    const client = makeClient();
    await client.connect();
    try {
      const result = (await client.sendIlpPacketWithClaim(
        {
          destination: 'g.toon.alice',
          amount: '1000',
          data: 'aGVsbG8=',
          executionCondition: condition,
          expiresAt,
        },
        { messageId: 'm2', nonce: 2, transferredAmount: '2000' }
      )) as IlpSendResultWithFulfillment;

      expect(lastPrepareWire!.condition).toEqual(condition);
      expect(lastPrepareWire!.condition.some((b) => b !== 0)).toBe(true);
      expect(lastPrepareWire!.expiresAt).toBe(expectedWireExpiry);
      expect(result.accepted).toBe(true);
      expect(Buffer.from(result.fulfillment!, 'base64')).toEqual(
        Buffer.from(preimage)
      );
    } finally {
      await client.disconnect();
    }
  });

  it('fails closed when the server FULFILLs with the wrong preimage (#350)', async () => {
    respondWith = undefined;
    const { condition } = mintExecutionCondition();
    respondFulfillment = mintExecutionCondition().preimage; // wrong preimage
    const client = makeClient();
    await client.connect();
    try {
      const result = await client.sendIlpPacketWithClaim(
        {
          destination: 'g.toon.alice',
          amount: '1000',
          data: 'aGVsbG8=',
          executionCondition: condition,
        },
        { messageId: 'm3', nonce: 3, transferredAmount: '3000' }
      );
      expect(result.accepted).toBe(false);
      expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
    } finally {
      await client.disconnect();
    }
  });

  it('carries the accumulated cost and claim-ack that rode beside a REJECT', async () => {
    respondWith = {
      protocolData: [
        pd('toon-accumulated-cost', '1000'),
        pd('claim-ack', '{"result":"rejected","reason":"amount_not_advancing"}'),
      ],
      ilpPacket: serializeReject('F03', 'underpaid'),
    };
    const client = makeClient();
    await client.connect();
    try {
      const result = await client.sendIlpPacketWithClaim(
        { destination: 'g.toon.alice', amount: '1', data: 'aGVsbG8=' },
        { messageId: 'm4', nonce: 4, transferredAmount: '1000' }
      );

      expect(result.accepted).toBe(false);
      expect(result.code).toBe('F03');
      // An underpayment reports the route's price (client-edge-spec §1.6) —
      // the same figure the HTTP carriage puts in `toon-accumulated-cost`.
      expect(result.accumulatedCost).toBe(1000n);
      expect(result.claimAck).toEqual({
        result: 'rejected',
        reason: 'amount_not_advancing',
      });
    } finally {
      respondWith = undefined;
      await client.disconnect();
    }
  });

  it('reports no accumulated cost on a FULFILL, and reads a rejected ack sitting on one', async () => {
    // The packet's verdict and the claim's verdict are separate answers. A
    // FULFILL is never priced (it was paid for), and it may still carry a
    // refusal of the claim that came with it.
    respondWith = {
      protocolData: [
        pd('claim-ack', '{"result":"rejected","reason":"signature_invalid"}'),
      ],
      ilpPacket: serializeFulfill(new TextEncoder().encode('ok')),
    };
    const client = makeClient();
    await client.connect();
    try {
      const result = await client.sendIlpPacketWithClaim(
        { destination: 'g.toon.alice', amount: '1000', data: 'aGVsbG8=' },
        { messageId: 'm5', nonce: 5, transferredAmount: '2000' }
      );

      expect(result.accepted).toBe(true);
      expect(result.accumulatedCost).toBeUndefined();
      expect(result.claimAck).toEqual({
        result: 'rejected',
        reason: 'signature_invalid',
      });
    } finally {
      respondWith = undefined;
      await client.disconnect();
    }
  });

  it('carries the x402 terms of an F06 greeting as RAW JSON protocolData (§1.9 step 4)', async () => {
    const terms = {
      x402Version: 2,
      resource: { url: 'g.toon.relay' },
      accepts: [
        {
          scheme: 'toon-channel',
          amount: '1',
          httpEndpoint: '/ilp',
          extra: { ilpAddress: 'g.toon.relay', endpoint: '/ilp', price: '1' },
        },
      ],
    };
    respondWith = {
      protocolData: [
        pd('toon-accumulated-cost', '0'),
        // No base64 layer here: that is an HTTP-header artifact.
        pd('payment-required', JSON.stringify(terms)),
      ],
      ilpPacket: serializeReject('F06', 'No payment channel claim attached'),
    };
    const client = makeClient();
    await client.connect();
    try {
      const result = await client.sendIlpPacket({
        destination: 'g.toon.relay',
        amount: '0',
        data: '',
      });

      expect(result.code).toBe('F06');
      expect(result.accumulatedCost).toBe(0n);
      expect(result.paymentRequired).toEqual(terms);
    } finally {
      respondWith = undefined;
      await client.disconnect();
    }
  });
});

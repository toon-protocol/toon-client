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
 * Runs under the integration config (`vitest.integration.config.ts`); needs
 * no external services (binds an ephemeral loopback port).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { WebSocketServer } from 'ws';
import type { AddressInfo } from 'node:net';
import { BtpRuntimeClient } from '../adapters/BtpRuntimeClient.js';
import {
  FULFILLMENT_MISMATCH_CODE,
  type IlpSendResultWithFulfillment,
} from '../adapters/ilp-send.js';
import { mintExecutionCondition } from '../utils/condition.js';
import {
  BTPMessageType,
  parseBtpMessage,
  serializeBtpMessage,
  type BTPMessageData,
} from '../btp/protocol.js';

const ILP_FULFILL = 13;

function serializeFulfill(
  data: Uint8Array,
  fulfillment: Uint8Array = new Uint8Array(32)
): Uint8Array {
  return new Uint8Array([ILP_FULFILL, ...fulfillment, data.length, ...data]);
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

        // ILP PREPARE → RESPONSE carrying an OER FULFILL.
        if (data.ilpPacket && data.ilpPacket.length > 0) {
          lastPrepareWire = parsePrepareWire(data.ilpPacket);
          socket.send(
            serializeBtpMessage({
              type: BTPMessageType.RESPONSE,
              requestId: message.requestId,
              data: {
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
});

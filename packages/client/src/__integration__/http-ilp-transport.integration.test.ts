/**
 * Integration test: HttpIlpClient against a real local http.Server stub that
 * echoes an OER FULFILL. Exercises the full one-shot `POST /ilp` path over the
 * loopback network — request construction, body transmission, and OER response
 * parsing — without mocking fetch.
 *
 * Also covers sender-chosen execution conditions (#350): the condition and
 * explicit expiry land on the OER wire, and the FULFILL preimage is verified
 * client-side (contract: connector docs/local-delivery-fulfillment-contract.md).
 *
 * Runs under the integration config (`vitest.integration.config.ts`); needs no
 * external services (binds an ephemeral loopback port).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpIlpClient, ILP_CLAIM_HEADER } from '../adapters/HttpIlpClient.js';
import {
  FULFILLMENT_MISMATCH_CODE,
  type IlpSendResultWithFulfillment,
} from '../adapters/ilp-send.js';
import { mintExecutionCondition } from '../utils/condition.js';

const ILP_FULFILL = 13;

/** Serialize an OER FULFILL the client's deserializeIlpPacket understands. */
function serializeFulfill(
  data: Uint8Array,
  fulfillment: Uint8Array = new Uint8Array(32) // legacy: all-zero preimage
): Uint8Array {
  return new Uint8Array([
    ILP_FULFILL,
    ...fulfillment,
    data.length, // var-octet length (< 128)
    ...data,
  ]);
}

/**
 * Parse the executionCondition + expiresAt out of an OER PREPARE body.
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

describe('HttpIlpClient over a real http.Server (integration)', () => {
  let server: Server;
  let url: string;
  let lastClaimHeader: string | undefined;
  let lastPrepareFirstByte: number | undefined;
  let lastPrepareWire: { expiresAt: string; condition: Uint8Array } | undefined;
  /** When set, the server FULFILLs with this preimage instead of zeros. */
  let respondFulfillment: Uint8Array | undefined;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      lastClaimHeader = req.headers[ILP_CLAIM_HEADER.toLowerCase()] as
        | string
        | undefined;
      const body = await readBody(req);
      lastPrepareFirstByte = body[0];
      lastPrepareWire = parsePrepareWire(new Uint8Array(body));

      // Echo a FULFILL whose data is the received PREPARE length (proof the
      // server saw the full body).
      const fulfill = serializeFulfill(
        new TextEncoder().encode(`ok:${body.length}`),
        respondFulfillment ?? new Uint8Array(32)
      );
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
      res.end(Buffer.from(fulfill));
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve)
    );
    const { port } = server.address() as AddressInfo;
    url = `http://127.0.0.1:${port}/ilp`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('round-trips a PREPARE+claim and parses the echoed FULFILL', async () => {
    respondFulfillment = undefined;
    const client = new HttpIlpClient({ httpEndpoint: url });
    const claim = { messageId: 'm1', nonce: 1, transferredAmount: '1000' };

    const result = await client.sendIlpPacketWithClaim(
      { destination: 'g.toon.alice', amount: '1000', data: 'aGVsbG8=' },
      claim
    );

    expect(result.accepted).toBe(true);
    // Server saw the claim header as base64(JSON.stringify(claim)).
    expect(lastClaimHeader).toBe(
      Buffer.from(JSON.stringify(claim)).toString('base64')
    );
    // Server saw an OER PREPARE (type byte 12).
    expect(lastPrepareFirstByte).toBe(12);
    // Legacy default: the condition on the wire is all-zero.
    expect(lastPrepareWire!.condition).toEqual(new Uint8Array(32));
    // FULFILL data decodes back.
    expect(new TextDecoder().decode(Buffer.from(result.data!, 'base64'))).toMatch(
      /^ok:\d+$/
    );
  });

  it('puts a sender-chosen condition + explicit expiry on the wire and verifies the FULFILL preimage (#350)', async () => {
    const { preimage, condition } = mintExecutionCondition();
    respondFulfillment = preimage;
    const expiresAt = new Date('2027-01-02T03:04:05.678Z');
    const client = new HttpIlpClient({ httpEndpoint: url });

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

    // The server saw the real condition and the explicit expiry on the wire.
    expect(lastPrepareWire!.condition).toEqual(condition);
    expect(lastPrepareWire!.condition.some((b) => b !== 0)).toBe(true);
    expect(lastPrepareWire!.expiresAt).toBe('20270102030405.678Z');

    // The FULFILL preimage round-tripped and verified.
    expect(result.accepted).toBe(true);
    expect(Buffer.from(result.fulfillment!, 'base64')).toEqual(
      Buffer.from(preimage)
    );
  });

  it('fails closed when the server FULFILLs with the wrong preimage (#350)', async () => {
    const { condition } = mintExecutionCondition();
    respondFulfillment = mintExecutionCondition().preimage; // wrong preimage
    const client = new HttpIlpClient({ httpEndpoint: url });

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
  });
});

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

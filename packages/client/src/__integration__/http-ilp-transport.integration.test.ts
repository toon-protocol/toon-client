/**
 * Integration test: HttpIlpClient against a real local http.Server stub that
 * echoes an OER FULFILL. Exercises the full one-shot `POST /ilp` path over the
 * loopback network — request construction, body transmission, and OER response
 * parsing — without mocking fetch.
 *
 * Runs under the integration config (`vitest.integration.config.ts`); needs no
 * external services (binds an ephemeral loopback port).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HttpIlpClient, ILP_CLAIM_HEADER } from '../adapters/HttpIlpClient.js';

const ILP_FULFILL = 13;

/** Serialize an OER FULFILL the client's deserializeIlpPacket understands. */
function serializeFulfill(data: Uint8Array): Uint8Array {
  return new Uint8Array([
    ILP_FULFILL,
    ...new Array(32).fill(0), // fulfillment (unused in TOON)
    data.length, // var-octet length (< 128)
    ...data,
  ]);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

describe('HttpIlpClient over a real http.Server (integration)', () => {
  let server: Server;
  let url: string;
  let lastClaimHeader: string | undefined;
  let lastPrepareFirstByte: number | undefined;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      lastClaimHeader = req.headers[ILP_CLAIM_HEADER.toLowerCase()] as
        | string
        | undefined;
      const body = await readBody(req);
      lastPrepareFirstByte = body[0];

      // Echo a FULFILL whose data is the received PREPARE length (proof the
      // server saw the full body).
      const fulfill = serializeFulfill(
        new TextEncoder().encode(`ok:${body.length}`)
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
    // FULFILL data decodes back.
    expect(new TextDecoder().decode(Buffer.from(result.data!, 'base64'))).toMatch(
      /^ok:\d+$/
    );
  });
});

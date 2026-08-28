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
 * And what rides BESIDE the packet (`client-edge-spec.md` §1.6): the
 * `toon-accumulated-cost` / `toon-claim-ack` / `payment-required` response
 * headers survive a real HTTP round trip and land on the `IlpSendResult`. A
 * unit test can stub `fetch`; only this one proves the headers make it through
 * an actual server, an actual socket, and an actual `Response`.
 *
 * Runs under the integration config (`vitest.integration.config.ts`); needs no
 * external services (binds an ephemeral loopback port).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server, IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  HttpIlpClient,
  ILP_CLAIM_HEADER,
} from '../http/HttpIlpClient.js';
import { PaymentRequiredError, TransportRequiredError } from '../client/errors.js';
import {
  FULFILLMENT_MISMATCH_CODE,
  type IlpSendResultWithFulfillment,
} from '../ilp/ilp-send.js';
import { mintExecutionCondition } from '../utils/condition.js';

const ILP_FULFILL = 13;
const ILP_REJECT = 14;

/** Serialize an OER REJECT the client's deserializeIlpPacket understands. */
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
  /**
   * When set, the server answers this instead of the echo FULFILL — the way a
   * real connector answers a refusal or a greeting.
   */
  let respondWith:
    | { status: number; headers: Record<string, string>; body: Buffer }
    | undefined;

  beforeAll(async () => {
    server = createServer(async (req, res) => {
      lastClaimHeader = req.headers[ILP_CLAIM_HEADER.toLowerCase()] as
        | string
        | undefined;
      const body = await readBody(req);
      lastPrepareFirstByte = body[0];
      lastPrepareWire = parsePrepareWire(new Uint8Array(body));

      if (respondWith) {
        res.writeHead(respondWith.status, respondWith.headers);
        res.end(respondWith.body);
        return;
      }

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
    respondWith = undefined;
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
    respondWith = undefined;
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
    respondWith = undefined;
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

  it('carries toon-accumulated-cost off a real REJECT response, and nothing off a FULFILL', async () => {
    respondWith = {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        // The connector sets this on every REJECT it answers with, and never
        // on a FULFILL (client-edge-spec §1.6).
        'toon-accumulated-cost': '1000',
        'toon-claim-ack': Buffer.from(
          '{"result":"accepted"}',
          'utf8'
        ).toString('base64'),
      },
      body: Buffer.from(serializeReject('F03', 'underpaid')),
    };
    const client = new HttpIlpClient({ httpEndpoint: url });

    const rejected = await client.sendIlpPacketWithClaim(
      { destination: 'g.toon.alice', amount: '1', data: 'aGVsbG8=' },
      { messageId: 'm4', nonce: 4, transferredAmount: '1' }
    );
    expect(rejected.accepted).toBe(false);
    expect(rejected.code).toBe('F03');
    expect(rejected.accumulatedCost).toBe(1000n);
    expect(rejected.claimAck).toEqual({ result: 'accepted' });

    respondWith = undefined;
    respondFulfillment = undefined;
    const fulfilled = await client.sendIlpPacketWithClaim(
      { destination: 'g.toon.alice', amount: '1000', data: 'aGVsbG8=' },
      { messageId: 'm5', nonce: 5, transferredAmount: '2000' }
    );
    expect(fulfilled.accepted).toBe(true);
    expect(fulfilled.accumulatedCost).toBeUndefined();
  });

  it('a FULFILL can carry a rejected claim-ack across a real socket', async () => {
    // The work was delivered and the claim that came with it was refused. The
    // two verdicts are separate answers to separate questions and neither may
    // be inferred from the other.
    respondWith = {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'toon-claim-ack': Buffer.from(
          '{"result":"rejected","reason":"nonce_not_advancing"}',
          'utf8'
        ).toString('base64'),
      },
      body: Buffer.from(serializeFulfill(new TextEncoder().encode('ok'))),
    };
    const client = new HttpIlpClient({ httpEndpoint: url });

    const result = await client.sendIlpPacketWithClaim(
      { destination: 'g.toon.alice', amount: '1000', data: 'aGVsbG8=' },
      { messageId: 'm6', nonce: 6, transferredAmount: '3000' }
    );

    expect(result.accepted).toBe(true);
    expect(result.claimAck).toEqual({
      result: 'rejected',
      reason: 'nonce_not_advancing',
    });
  });

  it('throws TransportRequiredError on a real 402 naming another carriage', async () => {
    const terms = {
      x402Version: 2,
      resource: { url: 'g.toon.relay' },
      accepts: [
        {
          scheme: 'toon-channel',
          amount: '1',
          payTo: 'g.toon.relay',
          httpEndpoint: '/ilp',
          extra: {
            ilpAddress: 'g.toon.relay',
            endpoint: '/ilp',
            price: '1',
            requiredTransport: 'btp',
            btpEndpoint: 'wss://relay.example/ilp/btp',
          },
        },
      ],
    };
    const body = Buffer.from(JSON.stringify(terms), 'utf8');
    respondWith = {
      status: 402,
      headers: {
        'Content-Type': 'application/json',
        'payment-required': body.toString('base64'),
      },
      body,
    };
    const client = new HttpIlpClient({ httpEndpoint: url, maxRetries: 0 });

    const error = (await client
      .sendIlpPacketWithClaim(
        { destination: 'g.toon.relay', amount: '1', data: '' },
        { messageId: 'm7', nonce: 7, transferredAmount: '4000' }
      )
      .catch((e: unknown) => e)) as TransportRequiredError;

    expect(error).toBeInstanceOf(TransportRequiredError);
    expect(error).not.toBeInstanceOf(PaymentRequiredError);
    expect(error.required).toBe('btp');
    expect(error.terms?.price).toBe(1n);
    expect(error.terms?.btpEndpoint).toBe('wss://relay.example/ilp/btp');
    respondWith = undefined;
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

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  HttpIlpClient,
  ILP_CLAIM_HEADER,
  readResponseMeta,
} from './HttpIlpClient.js';
import {
  NetworkError,
  ConnectorError,
  PaymentRequiredError,
  TransportRequiredError,
} from '../client/errors.js';
import { fromBase64 } from '../utils/binary.js';
import { mintExecutionCondition } from '../utils/condition.js';
import {
  FULFILLMENT_MISMATCH_CODE,
  type IlpSendResultWithFulfillment,
} from '../ilp/ilp-send.js';

// ─── OER response builders (mirror connector wire format) ────────────────────
// The client's deserializeIlpPacket skips a 32-byte fulfillment then reads a
// var-octet-string of data for FULFILL; REJECT is code(3) + triggeredBy + msg +
// data, each a var-octet-string. These helpers produce bytes the client parses.

const ILP_FULFILL = 13;
const ILP_REJECT = 14;

function varOctet(data: Uint8Array): number[] {
  // Lengths in these tests stay < 128, so single-byte length prefix is fine.
  return [data.length, ...data];
}

function serializeFulfill(
  data: Uint8Array,
  fulfillment: Uint8Array = new Uint8Array(32) // legacy: all-zero preimage
): Uint8Array {
  return new Uint8Array([ILP_FULFILL, ...fulfillment, ...varOctet(data)]);
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

function serializeReject(
  code: string,
  message: string,
  data = new Uint8Array(0)
): Uint8Array {
  const enc = new TextEncoder();
  const codeBytes = enc.encode(code); // exactly 3 bytes
  return new Uint8Array([
    ILP_REJECT,
    ...codeBytes,
    ...varOctet(enc.encode('g.connector')), // triggeredBy
    ...varOctet(enc.encode(message)),
    ...varOctet(data),
  ]);
}

/** Minimal valid claim — same JSON shape the BTP path attaches. */
function makeTestClaim(): Record<string, unknown> {
  return {
    version: '1.0',
    blockchain: 'evm',
    messageId: 'test-msg-id',
    timestamp: '2026-06-20T00:00:00.000Z',
    senderId: 'test',
    channelId: '0x' + '12'.repeat(32),
    nonce: 1,
    transferredAmount: '1000',
    lockedAmount: '0',
    locksRoot: '0x' + '00'.repeat(32),
    signature: '0x' + 'ab'.repeat(65),
    signerAddress: '0x' + '11'.repeat(20),
    chainId: 421614,
    tokenNetworkAddress: '0x' + '99'.repeat(20),
  };
}

const SEND_PARAMS = {
  destination: 'g.toon.alice',
  amount: '1000',
  // base64 of "hello"
  data: 'aGVsbG8=',
};

function fetchReturning(body: Uint8Array, init?: ResponseInit): typeof fetch {
  return vi.fn(
    async () =>
      new Response(body.slice().buffer, {
        status: 200,
        ...init,
      })
  ) as unknown as typeof fetch;
}

describe('HttpIlpClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST request construction', () => {
    it('posts an OER PREPARE body with octet-stream content type', async () => {
      const httpClient = fetchReturning(serializeFulfill(new Uint8Array(0)));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      await client.sendIlpPacketWithClaim(SEND_PARAMS, makeTestClaim());

      expect(httpClient).toHaveBeenCalledTimes(1);
      const [url, init] = (httpClient as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      expect(url).toBe('http://connector.test/ilp');
      expect(init.method).toBe('POST');
      const headers = init.headers as Record<string, string>;
      expect(headers['Content-Type']).toBe('application/octet-stream');

      // Body is an OER PREPARE (type byte 12).
      const body = new Uint8Array(init.body as ArrayBuffer);
      expect(body[0]).toBe(12);
    });

    it('attaches the claim as base64(JSON) — identical to the BTP path', async () => {
      const httpClient = fetchReturning(serializeFulfill(new Uint8Array(0)));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });
      const claim = makeTestClaim();

      await client.sendIlpPacketWithClaim(SEND_PARAMS, claim);

      const [, init] = (httpClient as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      const headerVal = headers[ILP_CLAIM_HEADER];
      expect(headerVal).toBeDefined();

      // The BTP path does encodeUtf8(JSON.stringify(claim)); the HTTP path must
      // base64 the SAME bytes. Decode and compare structurally.
      const decoded = new TextDecoder().decode(fromBase64(headerVal!));
      expect(JSON.parse(decoded)).toEqual(claim);
      expect(decoded).toBe(JSON.stringify(claim));
    });

    it('forwards peer identity + Authorization headers when configured', async () => {
      const httpClient = fetchReturning(serializeFulfill(new Uint8Array(0)));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        peerId: 'peer-1',
        authToken: 'secret',
        httpClient,
      });

      await client.sendIlpPacketWithClaim(SEND_PARAMS, makeTestClaim());

      const [, init] = (httpClient as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['ILP-Peer-Id']).toBe('peer-1');
      expect(headers['Authorization']).toBe('Bearer secret');
    });

    /**
     * Issue #565: the connector's client edge resolves a PRESENTED peer id
     * BEFORE the route, and 401s when it can't authenticate it — while a
     * request with no id at all is anonymous and gets its identity from the
     * claim. So an id we hold no secret for must never reach the wire. The MCP
     * daemon shipped exactly this pair (`g.toon.client` + `btpAuthToken: ''`),
     * which 401'd every default paid write.
     */
    it.each([
      ['no authToken at all', undefined],
      ['an EMPTY authToken (the daemon default)', ''],
    ])('omits ILP-Peer-Id with %s', async (_label, authToken) => {
      const httpClient = fetchReturning(serializeFulfill(new Uint8Array(0)));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        peerId: 'g.toon.client',
        ...(authToken !== undefined ? { authToken } : {}),
        httpClient,
      });

      await client.sendIlpPacketWithClaim(SEND_PARAMS, makeTestClaim());

      const [, init] = (httpClient as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers['ILP-Peer-Id']).toBeUndefined();
      expect(headers['Authorization']).toBeUndefined();
      // The claim still rides — anonymous + a valid claim is the supported
      // permissionless path, and it is the whole point of dropping the id.
      expect(headers[ILP_CLAIM_HEADER]).toBeDefined();
    });

    it('omits the claim header on a plain sendIlpPacket', async () => {
      const httpClient = fetchReturning(serializeFulfill(new Uint8Array(0)));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      await client.sendIlpPacket(SEND_PARAMS);

      const [, init] = (httpClient as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const headers = init.headers as Record<string, string>;
      expect(headers[ILP_CLAIM_HEADER]).toBeUndefined();
    });
  });

  describe('response parsing', () => {
    it('parses a FULFILL from a 200 body (accepted, with data)', async () => {
      const fulfillData = new TextEncoder().encode('arweave-tx-id');
      const httpClient = fetchReturning(serializeFulfill(fulfillData));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      const result = await client.sendIlpPacketWithClaim(
        SEND_PARAMS,
        makeTestClaim()
      );

      expect(result.accepted).toBe(true);
      expect(result.data).toBeDefined();
      expect(new TextDecoder().decode(fromBase64(result.data!))).toBe(
        'arweave-tx-id'
      );
    });

    it('parses a REJECT from a 200 body (not accepted, with code/message)', async () => {
      const httpClient = fetchReturning(serializeReject('F02', 'Unreachable'));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      const result = await client.sendIlpPacketWithClaim(
        SEND_PARAMS,
        makeTestClaim()
      );

      expect(result.accepted).toBe(false);
      expect(result.code).toBe('F02');
      expect(result.message).toBe('Unreachable');
    });
  });

  describe('transport-error mapping', () => {
    it('maps a 4xx to a non-retryable ConnectorError', async () => {
      const httpClient = vi.fn(
        async () =>
          new Response('bad claim', { status: 400, statusText: 'Bad Request' })
      ) as unknown as typeof fetch;
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      await expect(
        client.sendIlpPacketWithClaim(SEND_PARAMS, makeTestClaim())
      ).rejects.toBeInstanceOf(ConnectorError);
      // 4xx is not retried.
      expect(httpClient).toHaveBeenCalledTimes(1);
    });

    it('maps a 401 to an ordinary, non-retryable ConnectorError', async () => {
      // Pre-1.0 a bare 401 was re-thrown as "retry this over BTP". It is an
      // ordinary transport error again: `authHeaders()` never presents a peer
      // id it cannot back with a secret (issue #565), and anonymous + a valid
      // claim is the supported permissionless path (client-edge-spec §1.2), so
      // a 401 now means a genuinely misconfigured credential.
      const httpClient = vi.fn(
        async () =>
          new Response("identity 'g.toon.client' failed to authenticate", {
            status: 401,
            statusText: 'Unauthorized',
          })
      ) as unknown as typeof fetch;
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      const error = await client
        .sendIlpPacket(SEND_PARAMS)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectorError);
      expect((error as Error).message).toContain('401');
      expect(httpClient).toHaveBeenCalledTimes(1);
    });

    it('wraps a fetch network failure as a retryable NetworkError', async () => {
      const httpClient = vi.fn(async () => {
        throw new TypeError('fetch failed');
      }) as unknown as typeof fetch;
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
        maxRetries: 2,
        retryDelay: 0,
      });

      await expect(client.sendIlpPacket(SEND_PARAMS)).rejects.toBeInstanceOf(
        NetworkError
      );
      // 1 initial + 2 retries.
      expect(httpClient).toHaveBeenCalledTimes(3);
    });

    it('throws ConnectorError on an empty 200 body', async () => {
      const httpClient = fetchReturning(new Uint8Array(0));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      await expect(client.sendIlpPacket(SEND_PARAMS)).rejects.toBeInstanceOf(
        ConnectorError
      );
    });
  });

  // ─── issue #561: a 402 declaring requiredTransport in its BODY, never in ────
  // the peer's kind:10032 announce — the live devnet relay's actual shape ────
  describe('402 — the connector answered with terms, not a failure', () => {
    /** The x402 402 body shape the live connector answers with (§1.4). */
    function x402Body(extra: Record<string, unknown>): string {
      return JSON.stringify({
        x402Version: 2,
        resource: { url: 'g.toon.relay' },
        accepts: [
          {
            scheme: 'toon-channel',
            network: 'g.toon.relay',
            amount: '1000',
            payTo: 'g.toon.relay',
            maxTimeoutSeconds: 60,
            httpEndpoint: '/ilp',
            extra: {
              ilpAddress: 'g.toon.relay',
              endpoint: '/ilp',
              price: '1000',
              sessionLeaseTtlMs: 120000,
              ...extra,
            },
          },
        ],
      });
    }

    function answering402(body: string): typeof fetch {
      return vi.fn(
        async () =>
          new Response(body, { status: 402, statusText: 'Payment Required' })
      ) as unknown as typeof fetch;
    }

    it('throws PaymentRequiredError carrying the parsed terms on an ordinary greeting', async () => {
      const httpClient = answering402(
        x402Body({
          settlements: [
            {
              chain: 'evm:84532',
              settlementAddress: '0x' + '11'.repeat(20),
              tokenNetworkRegistry: '0x' + '22'.repeat(20),
              tokenNetwork: '0x' + '33'.repeat(20),
              tokenAddress: '0x' + '44'.repeat(20),
              decimals: 6,
            },
          ],
        })
      );
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      const error = (await client
        .sendIlpPacketWithClaim(SEND_PARAMS, makeTestClaim())
        .catch((e: unknown) => e)) as PaymentRequiredError;

      expect(error).toBeInstanceOf(PaymentRequiredError);
      expect(error.terms.destination).toBe('g.toon.relay');
      expect(error.terms.price).toBe(1000n);
      // A relative endpoint is resolved against the URL that answered.
      expect(error.terms.httpEndpoint).toBe('http://connector.test/ilp');
      expect(error.terms.sessionLeaseTtlMs).toBe(120000);
      expect(error.terms.settlements).toHaveLength(1);
      expect(error.terms.settlements[0]).toMatchObject({
        kind: 'evm',
        chain: 'evm:84532',
      });
      expect(error.terms.requiredTransport).toBeUndefined();
      // Not retried — a repeat POST would only repeat the same 402.
      expect(httpClient).toHaveBeenCalledTimes(1);
    });

    it('throws TransportRequiredError when the greeting names a carriage (issue #701)', async () => {
      const httpClient = answering402(x402Body({ requiredTransport: 'btp' }));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      const error = (await client
        .sendIlpPacketWithClaim(SEND_PARAMS, makeTestClaim())
        .catch((e: unknown) => e)) as TransportRequiredError;

      // A different refusal from "pay me": paying more never helps, and
      // re-sending over BTP always does.
      expect(error).toBeInstanceOf(TransportRequiredError);
      expect(error).not.toBeInstanceOf(PaymentRequiredError);
      expect(error.required).toBe('btp');
      expect(error.terms?.requiredTransport).toBe('btp');
      expect(error.terms?.price).toBe(1000n);
      expect(httpClient).toHaveBeenCalledTimes(1);
    });

    it('reads requiredTransport from the entry top level too, not only from extra', async () => {
      const body = JSON.stringify({
        x402Version: 2,
        resource: { url: 'g.toon.relay' },
        accepts: [
          {
            scheme: 'toon-channel',
            amount: '1000',
            httpEndpoint: '/ilp',
            requiredTransport: 'btp',
            extra: { ilpAddress: 'g.toon.relay', price: '1000' },
          },
        ],
      });
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient: answering402(body),
      });

      const error = (await client
        .sendIlpPacketWithClaim(SEND_PARAMS, makeTestClaim())
        .catch((e: unknown) => e)) as TransportRequiredError;
      expect(error).toBeInstanceOf(TransportRequiredError);
      expect(error.required).toBe('btp');
    });

    it('falls back to a plain ConnectorError on a 402 with no usable toon-channel terms', async () => {
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient: answering402('not json'),
      });

      const error = await client
        .sendIlpPacketWithClaim(SEND_PARAMS, makeTestClaim())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConnectorError);
      expect(error).not.toBeInstanceOf(PaymentRequiredError);
    });
  });

  describe('what rides beside the packet (client-edge-spec §1.6)', () => {
    const b64 = (text: string): string =>
      Buffer.from(text, 'utf8').toString('base64');

    function fetchAnswering(
      body: Uint8Array,
      headers: Record<string, string>
    ): typeof fetch {
      return vi.fn(
        async () =>
          new Response(body.slice().buffer, { status: 200, headers })
      ) as unknown as typeof fetch;
    }

    it('surfaces the accumulated cost on a REJECT', async () => {
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient: fetchAnswering(serializeReject('F03', 'underpaid'), {
          'toon-accumulated-cost': '1000',
        }),
      });

      const result = await client.sendIlpPacketWithClaim(
        SEND_PARAMS,
        makeTestClaim()
      );

      expect(result.accepted).toBe(false);
      expect(result.code).toBe('F03');
      // An underpayment reports the route's price — the cheapest way to learn
      // one, and the reason the header exists at all.
      expect(result.accumulatedCost).toBe(1000n);
    });

    it('reports no accumulated cost on a FULFILL — the header is absent there', async () => {
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient: fetchAnswering(serializeFulfill(new Uint8Array(0)), {}),
      });

      const result = await client.sendIlpPacketWithClaim(
        SEND_PARAMS,
        makeTestClaim()
      );

      expect(result.accepted).toBe(true);
      expect(result.accumulatedCost).toBeUndefined();
    });

    it('a FULFILL can carry a REJECTED claim-ack — the two verdicts never couple', async () => {
      // The connector's `peer_fulfill_ack_rejected` vector, header and all:
      // the work was delivered AND the claim that came with it was refused.
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient: fetchAnswering(serializeFulfill(new Uint8Array(0)), {
          'toon-claim-ack': 'eyJyZXN1bHQiOiJyZWplY3RlZCIsInJlYXNvbiI6InNpZ25hdHVyZV9pbnZhbGlkIn0=',
        }),
      });

      const result = await client.sendIlpPacketWithClaim(
        SEND_PARAMS,
        makeTestClaim()
      );

      expect(result.accepted).toBe(true);
      expect(result.claimAck).toEqual({
        result: 'rejected',
        reason: 'signature_invalid',
      });
    });

    it('reads the x402 terms off the payment-required header', async () => {
      const terms = { x402Version: 2, accepts: [] };
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient: fetchAnswering(serializeReject('F06', 'no claim'), {
          'payment-required': b64(JSON.stringify(terms)),
          'toon-accumulated-cost': '0',
        }),
      });

      const result = await client.sendIlpPacketWithClaim(
        SEND_PARAMS,
        makeTestClaim()
      );

      expect(result.code).toBe('F06');
      expect(result.accumulatedCost).toBe(0n);
      expect(result.paymentRequired).toEqual(terms);
    });
  });

  describe('readResponseMeta', () => {
    it('reads the connector vector set\'s reject_with_cost header pair', () => {
      // peer_carriage.reject_with_cost — pinned as a pair with the BTP form,
      // which `BtpRuntimeClient.readResponseMeta` must decode identically.
      expect(
        readResponseMeta([
          ['toon-accumulated-cost', '4200'],
          ['toon-claim-ack', 'eyJyZXN1bHQiOiJhY2NlcHRlZCJ9'],
        ])
      ).toEqual({
        accumulatedCost: 4200n,
        claimAck: { result: 'accepted' },
      });
    });

    it('accepts a Headers object, a pair array and a plain record alike', () => {
      const expected = { accumulatedCost: 7n };
      expect(
        readResponseMeta(new Headers({ 'toon-accumulated-cost': '7' }))
      ).toEqual(expected);
      expect(readResponseMeta([['TOON-Accumulated-Cost', '7']])).toEqual(
        expected
      );
      expect(readResponseMeta({ 'Toon-Accumulated-Cost': '7' })).toEqual(
        expected
      );
    });

    it('reads nothing from an empty header set (peer_ack_absent)', () => {
      expect(readResponseMeta([])).toEqual({});
    });

    it('treats a malformed ack as NOT ACKNOWLEDGED (peer_ack_malformed)', () => {
      // `{"result":"maybe"}`, base64 — the connector's own malformed fixture.
      expect(
        readResponseMeta([['toon-claim-ack', 'eyJyZXN1bHQiOiJtYXliZSJ9']])
      ).toEqual({});
    });

    it('drops a claim-ack header that is not decodable base64 JSON', () => {
      expect(readResponseMeta([['toon-claim-ack', '!!!not base64!!!']])).toEqual(
        {}
      );
    });
  });

  describe('sender-chosen execution conditions (#350)', () => {
    it('legacy default: PREPARE carries an all-zero condition and the FULFILL is accepted unverified', async () => {
      const httpClient = fetchReturning(serializeFulfill(new Uint8Array(0)));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      const result = await client.sendIlpPacketWithClaim(
        SEND_PARAMS,
        makeTestClaim()
      );

      expect(result.accepted).toBe(true);
      const [, init] = (httpClient as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const { condition } = parsePrepareWire(
        new Uint8Array(init.body as ArrayBuffer)
      );
      expect(condition).toEqual(new Uint8Array(32));
    });

    it('sets the condition and an explicit expiry on the wire (spec R2/R7)', async () => {
      const { preimage, condition } = mintExecutionCondition();
      const expiresAt = new Date('2026-07-12T12:34:56.789Z');
      const httpClient = fetchReturning(
        serializeFulfill(new Uint8Array(0), preimage)
      );
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      await client.sendIlpPacketWithClaim(
        { ...SEND_PARAMS, executionCondition: condition, expiresAt },
        makeTestClaim()
      );

      const [, init] = (httpClient as ReturnType<typeof vi.fn>).mock
        .calls[0] as [string, RequestInit];
      const wire = parsePrepareWire(new Uint8Array(init.body as ArrayBuffer));
      expect(wire.condition).toEqual(condition);
      expect(wire.condition.some((b) => b !== 0)).toBe(true);
      expect(wire.expiresAt).toBe('20260712123456.789Z');
    });

    it('accepts a FULFILL whose preimage hashes to the condition and surfaces it', async () => {
      const { preimage, condition } = mintExecutionCondition();
      const httpClient = fetchReturning(
        serializeFulfill(new TextEncoder().encode('ok'), preimage)
      );
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      const result = (await client.sendIlpPacketWithClaim(
        { ...SEND_PARAMS, executionCondition: condition },
        makeTestClaim()
      )) as IlpSendResultWithFulfillment;

      expect(result.accepted).toBe(true);
      expect(result.fulfillment).toBeDefined();
      expect(fromBase64(result.fulfillment!)).toEqual(preimage);
    });

    it('rejects a FULFILL with the wrong preimage — failed packet, no retry, no silent accept', async () => {
      const { condition } = mintExecutionCondition();
      const wrongPreimage = mintExecutionCondition().preimage;
      const httpClient = fetchReturning(
        serializeFulfill(new Uint8Array(0), wrongPreimage)
      );
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
        maxRetries: 2,
        retryDelay: 0,
      });

      const result = await client.sendIlpPacketWithClaim(
        { ...SEND_PARAMS, executionCondition: condition },
        makeTestClaim()
      );

      expect(result.accepted).toBe(false);
      expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
      expect(result.message).toMatch(/does not match execution condition/);
      // A verification failure must NOT be retried (re-sending re-spends the claim).
      expect(httpClient).toHaveBeenCalledTimes(1);
    });

    it('an all-zero fulfillment (legacy auto-fulfill) fails a conditioned packet closed', async () => {
      const { condition } = mintExecutionCondition();
      const httpClient = fetchReturning(serializeFulfill(new Uint8Array(0)));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      const result = await client.sendIlpPacket({
        ...SEND_PARAMS,
        executionCondition: condition,
      });

      expect(result.accepted).toBe(false);
      expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
    });

    it('throws on a malformed (non-32-byte) condition instead of zero-filling it', async () => {
      const httpClient = fetchReturning(serializeFulfill(new Uint8Array(0)));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      await expect(
        client.sendIlpPacket({
          ...SEND_PARAMS,
          executionCondition: new Uint8Array(31).fill(7),
        })
      ).rejects.toThrow(/32 bytes/);
      expect(httpClient).not.toHaveBeenCalled();
    });
  });
});

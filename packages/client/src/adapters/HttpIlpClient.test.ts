import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HttpIlpClient, ILP_CLAIM_HEADER } from './HttpIlpClient.js';
import { NetworkError, ConnectorError } from '../errors.js';
import { fromBase64 } from '../utils/binary.js';

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

function serializeFulfill(data: Uint8Array): Uint8Array {
  return new Uint8Array([
    ILP_FULFILL,
    ...new Array(32).fill(0), // fulfillment (unused in TOON)
    ...varOctet(data),
  ]);
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
  return vi.fn(async () =>
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
      const httpClient = fetchReturning(
        serializeReject('F02', 'Unreachable')
      );
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
      const httpClient = vi.fn(async () =>
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

    it('maps a 401 to a ConnectorError (auth, transport-level)', async () => {
      const httpClient = vi.fn(async () =>
        new Response('', { status: 401, statusText: 'Unauthorized' })
      ) as unknown as typeof fetch;
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      await expect(
        client.sendIlpPacket(SEND_PARAMS)
      ).rejects.toBeInstanceOf(ConnectorError);
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

      await expect(
        client.sendIlpPacket(SEND_PARAMS)
      ).rejects.toBeInstanceOf(NetworkError);
      // 1 initial + 2 retries.
      expect(httpClient).toHaveBeenCalledTimes(3);
    });

    it('throws ConnectorError on an empty 200 body', async () => {
      const httpClient = fetchReturning(new Uint8Array(0));
      const client = new HttpIlpClient({
        httpEndpoint: 'http://connector.test/ilp',
        httpClient,
      });

      await expect(
        client.sendIlpPacket(SEND_PARAMS)
      ).rejects.toBeInstanceOf(ConnectorError);
    });
  });
});

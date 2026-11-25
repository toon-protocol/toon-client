/**
 * The carriage's four outcomes, against the fake connector.
 *
 * HTTP rides the fake's `fetch`. BTP rides a mocked session, because the fake
 * has no socket: what is under test there is how a reject carrying terms beside
 * it becomes a greeting, and that is the carriage's, not the socket's.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockSendPacket = vi.fn();

vi.mock('../btp/IsomorphicBtpClient.js', () => ({
  IsomorphicBtpClient: vi.fn().mockImplementation(() => {
    const socket = {
      isConnected: false,
      connect: async () => {
        await mockConnect();
        socket.isConnected = true;
      },
      disconnect: async () => {
        socket.isConnected = false;
        await mockDisconnect();
      },
      sendPacket: mockSendPacket,
      reauthenticate: vi.fn(),
    };
    return socket;
  }),
  BtpConnectionError: class BtpConnectionError extends Error {},
}));

import { Carriage, type CarriageOutcome } from './Carriage.js';
import { FakeTerminatingConnector } from '../wire/fake-connector.test-support.js';
import { lossyLine } from './lost-answer.test-support.js';
import { parseSelfDescription } from '../connector/self-description.js';
import { sealExchange } from '../wire/sealed-exchange.js';
import { toEnvelopeRequest } from '../client/send.js';
import { ConfigError, NetworkError } from '../client/errors.js';
import { BtpConnectionError } from '../btp/IsomorphicBtpClient.js';
import { toBase64, encodeUtf8 } from '../utils/binary.js';
import type { IlpSendParams } from '../ilp/ilp-send.js';
import type { TransportPreference } from '../client/types.js';

const DESTINATION = 'g.fake.route';
const VOUCHER = {
  blockchain: 'evm',
  channelId: `0x${'ab'.repeat(32)}`,
  maxClaimableAmount: '1000',
  scheme: 'batch-settlement',
};

let fake: FakeTerminatingConnector;

beforeEach(() => {
  fake = new FakeTerminatingConnector({ endpoint: 'http://connector.test' });
  mockConnect.mockReset().mockResolvedValue(undefined);
  mockSendPacket.mockReset();
});

function carriage(
  transport: TransportPreference = 'http',
  fetchImpl = fake.fetch,
  budget: { maxReconnectAttempts?: number; reconnectDelay?: number } = {}
): Carriage {
  return new Carriage({
    transport,
    carriageEndpoints: {},
    timeoutMs: 5_000,
    fetch: fetchImpl,
    btp: { declareChannel: false, ...budget },
    peerId: 'test-peer',
    channelDeclaration: async () => undefined,
    assertReachable: () => undefined,
  });
}

const description = () => parseSelfDescription(fake.selfDescription(), fake.endpoint);

function packet(timeout = 5_000): IlpSendParams {
  const exchange = sealExchange(toEnvelopeRequest({}), fake.identityPublic);
  return {
    destination: DESTINATION,
    amount: '1000',
    data: toBase64(exchange.data),
    expectedFulfillment: exchange.fulfillment,
    timeout,
  };
}

async function deliver(
  c: Carriage,
  voucher: Record<string, unknown> | null = VOUCHER,
  timeout = 5_000
): Promise<CarriageOutcome> {
  const open = await c.open(description(), DESTINATION);
  if (open.kind === 'greeting') return open;
  return open.deliver(packet(timeout), voucher ?? undefined);
}

describe('Carriage over HTTP', () => {
  it('answers a FULFILL', async () => {
    const outcome = await deliver(carriage());
    expect(outcome).toMatchObject({ kind: 'answered', carriage: 'http' });
    if (outcome.kind !== 'answered') return;
    expect(outcome.result.accepted).toBe(true);
  });

  it('delivers an unpaid packet to a free route', async () => {
    fake.routePrice = 0n;
    const outcome = await deliver(carriage(), null);
    expect(outcome.kind).toBe('answered');
    expect(fake.claims).toHaveLength(0);
  });

  it('returns a refused voucher as a refusal, with the connector’s verdict on the claim', async () => {
    fake.refusal = 'underpay';
    const outcome = await deliver(carriage());
    expect(outcome.kind).toBe('refused');
    if (outcome.kind !== 'refused') return;
    expect(outcome.result.code).toBe('F03');
    expect(outcome.result.claimAck).toMatchObject({ result: 'rejected' });
  });

  it('returns a greeting with its terms, and does not throw', async () => {
    fake.refusal = 'greeting';
    const outcome = await deliver(carriage());
    expect(outcome).toMatchObject({ kind: 'greeting', carriage: 'http', code: 'PAYMENT_REQUIRED' });
    if (outcome.kind !== 'greeting') return;
    expect(outcome.terms?.price).toBe(1000n);
    expect(outcome.terms?.destination).toBe(DESTINATION);
    expect(outcome.message).toContain(`The connector at ${fake.endpoint}`);
  });

  it('returns a greeting that names a carriage as TRANSPORT_REQUIRED', async () => {
    fake.refusal = 'greeting';
    fake.requiredTransport = 'btp';
    const outcome = await deliver(carriage());
    expect(outcome).toMatchObject({ kind: 'greeting', code: 'TRANSPORT_REQUIRED' });
    if (outcome.kind !== 'greeting') return;
    expect(outcome.terms?.requiredTransport).toBe('btp');
  });

  it('is unknown when the carriage fails before an answer', async () => {
    const failing = vi.fn(async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const outcome = await deliver(carriage('http', failing));
    expect(outcome.kind).toBe('unknown');
    if (outcome.kind !== 'unknown') return;
    expect((outcome.error as Error).message).toContain('socket hang up');
  });
});

describe('Carriage over BTP', () => {
  /** The terms the fake's HTTP greeting carries, as a BTP reject would carry them. */
  async function termsDocument(requiredTransport?: 'http' | 'btp'): Promise<string> {
    fake.refusal = 'greeting';
    if (requiredTransport) fake.requiredTransport = requiredTransport;
    const response = await fake.fetch('http://connector.test/ilp', {
      method: 'POST',
      body: new Uint8Array(0),
    });
    fake.refusal = null;
    fake.requiredTransport = null;
    return response.text();
  }

  const entry = (protocolName: string, text: string) => ({
    protocolName,
    contentType: 1,
    data: encodeUtf8(text),
  });

  function rejectWith(code: string, protocolData: ReturnType<typeof entry>[]) {
    mockSendPacket.mockResolvedValue({
      packet: { type: 14, code, message: 'no claim', data: new Uint8Array(0) },
      protocolData,
    });
  }

  it('returns a greeting from an F06 carrying terms beside the REJECT', async () => {
    rejectWith('F06', [
      entry('toon-accumulated-cost', '0'),
      entry('payment-required', await termsDocument()),
    ]);
    const outcome = await deliver(carriage('btp'));
    expect(outcome).toMatchObject({ kind: 'greeting', carriage: 'btp', code: 'PAYMENT_REQUIRED' });
    if (outcome.kind !== 'greeting') return;
    expect(outcome.terms?.price).toBe(1000n);
  });

  it('returns an F02 greeting that names a carriage as TRANSPORT_REQUIRED', async () => {
    rejectWith('F02', [entry('payment-required', await termsDocument('http'))]);
    const outcome = await deliver(carriage('btp'));
    expect(outcome).toMatchObject({ kind: 'greeting', carriage: 'btp', code: 'TRANSPORT_REQUIRED' });
  });

  it('returns a plain REJECT as a refusal', async () => {
    rejectWith('F02', [entry('toon-accumulated-cost', '0')]);
    const outcome = await deliver(carriage('btp'));
    expect(outcome).toMatchObject({ kind: 'refused', carriage: 'btp' });
  });

  it('is unknown when the session fails with a non-connection error', async () => {
    mockSendPacket.mockRejectedValue(new Error('boom'));
    const outcome = await deliver(carriage('btp'));
    expect(outcome.kind).toBe('unknown');
  });
});

describe('Carriage choice', () => {
  it('greets, naming the carriage, when the node publishes no endpoint for the one asked for', async () => {
    const bare = parseSelfDescription(
      { ...fake.selfDescription(), btpEndpoint: undefined },
      fake.endpoint
    );
    const open = await carriage('btp').open(bare, DESTINATION);
    expect(open).toMatchObject({ kind: 'greeting', code: 'TRANSPORT_REQUIRED', carriage: 'btp' });
  });

  it('reuses one carriage per kind', async () => {
    const c = carriage();
    expect(await c.open(description(), DESTINATION)).toBe(await c.open(description(), DESTINATION));
  });

  it('refuses to open once closed', async () => {
    const c = carriage();
    await c.close();
    await expect(c.open(description(), DESTINATION)).rejects.toBeInstanceOf(ConfigError);
  });
});

/**
 * The one retry rule: a packet is sent again only when none of it was written.
 * A voucher that left and whose answer was lost is never resent.
 */
describe('Carriage retry rule', () => {
  const connectRefused = () => new BtpConnectionError('WebSocket connection error: ECONNREFUSED');

  it('sends a written, unanswered packet exactly once over HTTP, and returns unknown', async () => {
    const line = lossyLine(fake);
    line.silent = true;
    const outcome = await deliver(carriage('http', line.fetch), VOUCHER, 50);
    expect(fake.paidRequests).toBe(1);
    expect(outcome).toMatchObject({ kind: 'unknown', carriage: 'http', written: true });
    if (outcome.kind !== 'unknown') return;
    expect(outcome.error).toBeInstanceOf(NetworkError);
  });

  it('sends a written, unanswered packet exactly once over BTP, and never falls back to HTTP', async () => {
    mockSendPacket.mockRejectedValue(new BtpConnectionError('Packet send timeout (1000ms)'));
    const outcome = await deliver(carriage('btp', fake.fetch, { reconnectDelay: 1 }));
    expect(mockSendPacket).toHaveBeenCalledTimes(1);
    expect(fake.paidRequests).toBe(0);
    expect(outcome).toMatchObject({ kind: 'unknown', carriage: 'btp', written: true });
    if (outcome.kind !== 'unknown') return;
    expect(outcome.error).toBeInstanceOf(NetworkError);
  });

  it('sends a packet whose socket closed after it was written exactly once', async () => {
    mockSendPacket.mockRejectedValue(new BtpConnectionError('Connection closed'));
    const outcome = await deliver(carriage('btp', fake.fetch, { reconnectDelay: 1 }));
    expect(mockSendPacket).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: 'unknown', written: true });
  });

  it('retries a connect failure within the budget, then sends once', async () => {
    mockConnect
      .mockRejectedValueOnce(connectRefused())
      .mockRejectedValueOnce(connectRefused())
      .mockResolvedValue(undefined);
    rejectPlainly();
    const outcome = await deliver(
      carriage('btp', fake.fetch, { maxReconnectAttempts: 2, reconnectDelay: 1 })
    );
    expect(mockConnect).toHaveBeenCalledTimes(3);
    expect(mockSendPacket).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({ kind: 'refused', carriage: 'btp' });
  });

  it('falls back to HTTP once the connect budget runs out, where the route does not require BTP', async () => {
    mockConnect.mockRejectedValue(connectRefused());
    const outcome = await deliver(
      carriage('btp', fake.fetch, { maxReconnectAttempts: 1, reconnectDelay: 1 })
    );
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockSendPacket).not.toHaveBeenCalled();
    expect(fake.paidRequests).toBe(1);
    expect(outcome.kind).toBe('answered');
  });

  it('does not fall back to HTTP where the route requires BTP: nothing was written', async () => {
    fake.routes = [{ prefix: 'g.fake', price: '1000', requiredTransport: 'btp' }];
    mockConnect.mockRejectedValue(connectRefused());
    const outcome = await deliver(
      carriage('btp', fake.fetch, { maxReconnectAttempts: 1, reconnectDelay: 1 })
    );
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(fake.paidRequests).toBe(0);
    expect(outcome).toMatchObject({ kind: 'unknown', carriage: 'btp', written: false });
    if (outcome.kind !== 'unknown') return;
    expect(outcome.error).toBeInstanceOf(NetworkError);
    expect((outcome.error as NetworkError).message).toContain('ws://connector.test/ilp/btp');
  });

  it('does not fall back when the node publishes no HTTP endpoint', async () => {
    mockConnect.mockRejectedValue(connectRefused());
    const bare = parseSelfDescription(
      { ...fake.selfDescription(), httpEndpoint: undefined },
      fake.endpoint
    );
    const open = await carriage('btp', fake.fetch, { maxReconnectAttempts: 0 }).open(
      bare,
      DESTINATION
    );
    if (open.kind === 'greeting') throw new Error('expected a carriage');
    const outcome = await open.deliver(packet(), VOUCHER);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(fake.paidRequests).toBe(0);
    expect(outcome).toMatchObject({ kind: 'unknown', written: false });
  });
});

function rejectPlainly(): void {
  mockSendPacket.mockResolvedValue({
    packet: { type: 14, code: 'F02', message: 'no route', data: new Uint8Array(0) },
    protocolData: [],
  });
}

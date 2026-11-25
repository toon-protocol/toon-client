import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NetworkError } from '../client/errors.js';
import type { IlpSendResult } from '../ilp/types.js';
import { BtpPaidWriteTransport, type BtpSession } from './BtpPaidWriteTransport.js';
import { BtpConnectionError } from './IsomorphicBtpClient.js';
import { NothingWritten } from '../carriage/nothing-written.js';
import type { IlpSendParams } from '../ilp/ilp-send.js';

function params(destination: string): IlpSendParams {
  return { destination, amount: '100', data: 'ZGF0YQ==' };
}

function fulfilled(data = 'ok'): IlpSendResult {
  return { accepted: true, data };
}

/** A controllable fake session: `isConnected` is a real mutable field. */
function makeFakeSession(): BtpSession & {
  sendIlpPacketWithClaim: ReturnType<typeof vi.fn>;
  sendIlpPacket: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const session = {
    isConnected: false,
    disconnect: vi.fn(async () => {
      session.isConnected = false;
    }),
    sendIlpPacketWithClaim: vi.fn(),
    sendIlpPacket: vi.fn(),
  };
  return session;
}

const URL = 'ws://connector.test/ilp/btp';

describe('BtpPaidWriteTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('the session', () => {
    it('exposes isConnected and disconnect as passthroughs to the session', async () => {
      const session = makeFakeSession();
      session.isConnected = true;
      const transport = new BtpPaidWriteTransport({ session });

      expect(transport.isConnected).toBe(true);
      await transport.disconnect();
      expect(session.disconnect).toHaveBeenCalledTimes(1);
      expect(transport.isConnected).toBe(false);
    });
  });

  describe('strictly ordered dispatch', () => {
    it('dispatches writes to the session in the order they were enqueued, never overlapping', async () => {
      const session = makeFakeSession();
      session.isConnected = true;
      const order: string[] = [];
      const gates = new Map<string, { resolve: () => void }>();
      const openGate = (label: string): void => {
        const gate = gates.get(label);
        if (!gate) throw new Error(`no gate registered for ${label}`);
        gate.resolve();
      };

      session.sendIlpPacketWithClaim.mockImplementation(
        async (p: IlpSendParams) => {
          const label = p.destination;
          order.push(`start:${label}`);
          await new Promise<void>((resolve) => {
            gates.set(label, { resolve });
          });
          order.push(`end:${label}`);
          return fulfilled(label);
        }
      );

      const transport = new BtpPaidWriteTransport({ session });

      // Enqueue three writes back-to-back without awaiting between them —
      // this is the burst scenario (audio frames) the transport exists for.
      const p1 = transport.sendIlpPacketWithClaim(params('one'), {});
      const p2 = transport.sendIlpPacketWithClaim(params('two'), {});
      const p3 = transport.sendIlpPacketWithClaim(params('three'), {});

      // Let microtasks flush: only the FIRST write should have reached the
      // session — the ordering queue must not let #2/#3 race ahead of #1.
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(['start:one']);
      expect(session.sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);

      openGate('one');
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual(['start:one', 'end:one', 'start:two']);

      openGate('two');
      await vi.advanceTimersByTimeAsync(0);
      expect(order).toEqual([
        'start:one',
        'end:one',
        'start:two',
        'end:two',
        'start:three',
      ]);

      openGate('three');
      const results = await Promise.all([p1, p2, p3]);
      expect(results.map((r) => r.data)).toEqual(['one', 'two', 'three']);
    });

    it('keeps dispatching later writes even when an earlier one rejects', async () => {
      const session = makeFakeSession();
      session.isConnected = true;
      session.sendIlpPacketWithClaim
        .mockRejectedValueOnce(new Error('boom-application-error'))
        .mockResolvedValueOnce(fulfilled('second'));
      const transport = new BtpPaidWriteTransport({ session });

      const p1 = transport.sendIlpPacketWithClaim(params('one'), {});
      const p2 = transport.sendIlpPacketWithClaim(params('two'), {});

      await expect(p1).rejects.toThrow('boom-application-error');
      await expect(p2).resolves.toEqual(fulfilled('second'));
      expect(session.sendIlpPacketWithClaim).toHaveBeenCalledTimes(2);
    });
  });

  describe('one write per call', () => {
    it('writes a claim once and passes a failure on, never resending it', async () => {
      const session = makeFakeSession();
      session.sendIlpPacketWithClaim.mockRejectedValue(new BtpConnectionError('Packet send timeout'));
      const transport = new BtpPaidWriteTransport({ session });

      await expect(transport.sendIlpPacketWithClaim(params('g.a'), {})).rejects.toBeInstanceOf(
        Error
      );
      await vi.advanceTimersByTimeAsync(10_000);
      expect(session.sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    });

    it('holds one slot for every attempt a task makes, so nothing queued behind it overtakes', async () => {
      const session = makeFakeSession();
      const order: string[] = [];
      session.sendIlpPacketWithClaim.mockImplementation(async (p: IlpSendParams) => {
        order.push(p.destination);
        if (p.destination === 'retried' && order.length === 1) {
          throw new NothingWritten(new BtpConnectionError('ECONNREFUSED'));
        }
        return fulfilled(p.destination);
      });
      const transport = new BtpPaidWriteTransport({ session });

      const first = transport.ordered(async (attempt) => {
        try {
          return await attempt(params('retried'), {});
        } catch {
          return attempt(params('retried'), {});
        }
      });
      const second = transport.sendIlpPacketWithClaim(params('behind'), {});

      await expect(first).resolves.toEqual(fulfilled('retried'));
      await expect(second).resolves.toEqual(fulfilled('behind'));
      expect(order).toEqual(['retried', 'retried', 'behind']);
    });
  });

  describe('naming the endpoint', () => {
    it('names the BTP URL when the socket fails after the write', async () => {
      const session = makeFakeSession();
      session.sendIlpPacketWithClaim.mockRejectedValue(new BtpConnectionError('Connection closed'));
      const transport = new BtpPaidWriteTransport({ session, url: URL, endpointSource: 'published' });

      const error = await transport.sendIlpPacketWithClaim(params('g.a'), {}).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NetworkError);
      expect((error as NetworkError).message).toContain(URL);
      expect((error as NetworkError).message).toContain('Connection closed');
    });

    it('names the BTP URL on a connect failure, and still says nothing was written', async () => {
      const session = makeFakeSession();
      session.sendIlpPacket.mockRejectedValue(
        new NothingWritten(new BtpConnectionError('WebSocket connection error: ECONNREFUSED'))
      );
      const transport = new BtpPaidWriteTransport({ session, url: URL });

      const error = await transport.sendIlpPacket(params('g.a')).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NothingWritten);
      const inner = (error as NothingWritten).error;
      expect(inner).toBeInstanceOf(NetworkError);
      expect((inner as NetworkError).message).toContain(URL);
    });

    it('passes any other failure on unchanged', async () => {
      const session = makeFakeSession();
      const boom = new Error('boom');
      session.sendIlpPacketWithClaim.mockRejectedValue(boom);
      const transport = new BtpPaidWriteTransport({ session, url: URL });

      await expect(transport.sendIlpPacketWithClaim(params('g.a'), {})).rejects.toBe(boom);
    });
  });
});

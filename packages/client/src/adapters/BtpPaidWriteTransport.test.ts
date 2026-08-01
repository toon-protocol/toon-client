import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { IlpSendResult } from '@toon-protocol/core';
import {
  BtpPaidWriteTransport,
  type OrderedBtpSession,
  type ClaimSendingTransport,
} from './BtpPaidWriteTransport.js';
import type { IlpSendParams } from './ilp-send.js';

function params(destination: string): IlpSendParams {
  return { destination, amount: '100', data: 'ZGF0YQ==' };
}

function fulfilled(data = 'ok'): IlpSendResult {
  return { accepted: true, data };
}

/** A controllable fake session: `isConnected` is a real mutable field (not a
 * getter) so tests can flip it directly to simulate a dropped socket. */
function makeFakeSession(): OrderedBtpSession & {
  sendIlpPacketWithClaim: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  reconnect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
} {
  const session = {
    isConnected: false,
    connect: vi.fn(async () => {
      session.isConnected = true;
    }),
    reconnect: vi.fn(async () => {
      session.isConnected = true;
    }),
    disconnect: vi.fn(async () => {
      session.isConnected = false;
    }),
    sendIlpPacketWithClaim: vi.fn(),
  };
  return session;
}

describe('BtpPaidWriteTransport', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('persistent connection', () => {
    it('connects lazily on the first write and reuses the session thereafter', async () => {
      const session = makeFakeSession();
      session.sendIlpPacketWithClaim.mockResolvedValue(fulfilled());
      const transport = new BtpPaidWriteTransport({ session });

      expect(session.connect).not.toHaveBeenCalled();

      await transport.sendIlpPacketWithClaim(params('g.a'), { n: 1 });
      await transport.sendIlpPacketWithClaim(params('g.a'), { n: 2 });

      expect(session.connect).toHaveBeenCalledTimes(1);
      expect(session.sendIlpPacketWithClaim).toHaveBeenCalledTimes(2);
    });

    it('does not reconnect an already-connected session', async () => {
      const session = makeFakeSession();
      session.isConnected = true; // e.g. modes/http.ts already connected it
      session.sendIlpPacketWithClaim.mockResolvedValue(fulfilled());
      const transport = new BtpPaidWriteTransport({ session });

      await transport.sendIlpPacketWithClaim(params('g.a'), {});

      expect(session.connect).not.toHaveBeenCalled();
    });

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

  describe('reconnect + resume', () => {
    it('reconnects the same session and resumes the write after one connection error', async () => {
      const session = makeFakeSession();
      session.isConnected = true;
      session.sendIlpPacketWithClaim
        .mockImplementationOnce(async () => {
          // Mirrors real BtpRuntimeClient: a connection-level failure marks
          // the session disconnected before the error surfaces here.
          session.isConnected = false;
          throw new Error('WebSocket connection error');
        })
        .mockResolvedValueOnce(fulfilled('resumed'));
      const transport = new BtpPaidWriteTransport({
        session,
        reconnectDelay: 50,
      });

      const send = transport.sendIlpPacketWithClaim(params('g.a'), {
        claim: 1,
      });

      await vi.advanceTimersByTimeAsync(50);
      const result = await send;

      expect(result.data).toBe('resumed');
      expect(session.reconnect).toHaveBeenCalledTimes(1);
      expect(session.sendIlpPacketWithClaim).toHaveBeenCalledTimes(2);
    });

    it('does not let a mid-burst reconnect reorder writes queued behind it', async () => {
      const session = makeFakeSession();
      session.isConnected = true;
      const calls: string[] = [];
      session.sendIlpPacketWithClaim.mockImplementation(
        async (p: IlpSendParams) => {
          calls.push(p.destination);
          if (
            p.destination === 'one' &&
            calls.filter((c) => c === 'one').length === 1
          ) {
            session.isConnected = false;
            throw new Error('connection reset');
          }
          return fulfilled(p.destination);
        }
      );
      const transport = new BtpPaidWriteTransport({
        session,
        reconnectDelay: 10,
      });

      const p1 = transport.sendIlpPacketWithClaim(params('one'), {});
      const p2 = transport.sendIlpPacketWithClaim(params('two'), {});

      await vi.advanceTimersByTimeAsync(10);
      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1.data).toBe('one');
      expect(r2.data).toBe('two');
      // 'one' failed once then succeeded on retry, BEFORE 'two' ever ran.
      expect(calls).toEqual(['one', 'one', 'two']);
    });
  });

  describe('fallback to HTTP', () => {
    function makeFallback(): ClaimSendingTransport & {
      sendIlpPacketWithClaim: ReturnType<typeof vi.fn>;
    } {
      return { sendIlpPacketWithClaim: vi.fn() };
    }

    it('falls back to HTTP once the reconnect budget is exhausted', async () => {
      const session = makeFakeSession();
      session.isConnected = true;
      session.sendIlpPacketWithClaim.mockImplementation(async () => {
        session.isConnected = false;
        throw new Error('ECONNRESET');
      });
      const fallback = makeFallback();
      fallback.sendIlpPacketWithClaim.mockResolvedValue(fulfilled('via-http'));

      const transport = new BtpPaidWriteTransport({
        session,
        fallback,
        maxReconnectAttempts: 1,
        reconnectDelay: 10,
      });

      const send = transport.sendIlpPacketWithClaim(params('g.a'), {
        claim: true,
      });
      await vi.advanceTimersByTimeAsync(10);
      const result = await send;

      expect(result.data).toBe('via-http');
      expect(fallback.sendIlpPacketWithClaim).toHaveBeenCalledWith(
        params('g.a'),
        { claim: true }
      );
      // session was tried initially plus every reconnect attempt.
      expect(session.sendIlpPacketWithClaim).toHaveBeenCalledTimes(2);
    });

    it('throws the last connection error when no fallback is configured', async () => {
      const session = makeFakeSession();
      session.isConnected = true;
      session.sendIlpPacketWithClaim.mockImplementation(async () => {
        session.isConnected = false;
        throw new Error('socket hang up');
      });
      const transport = new BtpPaidWriteTransport({
        session,
        maxReconnectAttempts: 1,
        reconnectDelay: 10,
      });

      const send = transport.sendIlpPacketWithClaim(params('g.a'), {});
      const caught = send.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(10);

      const error = (await caught) as Error;
      expect(error.message).toBe('socket hang up');
    });

    it('never falls back on an application-level (non-connection) error', async () => {
      const session = makeFakeSession();
      session.isConnected = true;
      session.sendIlpPacketWithClaim.mockRejectedValue(
        new Error('F02_UNREACHABLE something odd')
      );
      const fallback = makeFallback();
      const transport = new BtpPaidWriteTransport({ session, fallback });

      await expect(
        transport.sendIlpPacketWithClaim(params('g.a'), {})
      ).rejects.toThrow('F02_UNREACHABLE something odd');
      expect(fallback.sendIlpPacketWithClaim).not.toHaveBeenCalled();
      expect(session.reconnect).not.toHaveBeenCalled();
    });
  });
});

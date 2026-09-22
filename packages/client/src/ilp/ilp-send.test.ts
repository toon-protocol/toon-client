import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mapIlpResponse,
  resolveExpectedFulfillment,
  resolveExpiresAt,
  FULFILLMENT_MISMATCH_CODE,
  FULFILLMENT_MISMATCH_MESSAGE,
  PACKET_EXPIRY_HEADROOM_MS,
} from './ilp-send.js';
import { ILPPacketType } from '../btp/protocol.js';
import { deriveFulfillment } from '../wire/giftwrap.js';
import { toBase64 } from '../utils/binary.js';

const EMPTY = new Uint8Array(0);

/** The fulfilment a sealed request's shared secret derives (ADR 0019). */
function fulfilmentOf(seed: number): Uint8Array {
  return deriveFulfillment(new Uint8Array(32).fill(seed));
}

describe('mapIlpResponse — the sender\u2019s end-to-end check (ADR 0069)', () => {
  it('no expectation: accepts a FULFILL without verification', () => {
    // A caller that sealed nothing holds no secret and can derive no
    // fulfilment, so there is genuinely nothing to compare against.
    const result = mapIlpResponse({
      type: ILPPacketType.FULFILL,
      fulfillment: new Uint8Array(32),
      data: EMPTY,
    });
    expect(result).toEqual({ accepted: true });
    expect('fulfillment' in result).toBe(false);
  });

  it('accepts the fulfilment the packet\u2019s own secret derives, and echoes it', () => {
    const expected = fulfilmentOf(0x11);
    const data = new Uint8Array([1, 2, 3]);
    const result = mapIlpResponse(
      { type: ILPPacketType.FULFILL, fulfillment: expected, data },
      expected
    );
    expect(result.accepted).toBe(true);
    expect(result.fulfillment).toBe(toBase64(expected));
    expect(result.data).toBe(toBase64(data));
  });

  it('a different preimage is a FAILED packet, not a silent accept', () => {
    // Since ADR 0069 no hop checks this: a forged FULFILL rides home through
    // every one of them, and the sender is the only thing standing between it
    // and a delivery counted as good.
    const result = mapIlpResponse(
      {
        type: ILPPacketType.FULFILL,
        fulfillment: fulfilmentOf(0x22),
        data: EMPTY,
      },
      fulfilmentOf(0x11)
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
    expect(result.message).toBe(FULFILLMENT_MISMATCH_MESSAGE);
    expect(result.fulfillment).toBeUndefined();
  });

  it('an all-zero fulfilment fails closed', () => {
    const result = mapIlpResponse(
      {
        type: ILPPacketType.FULFILL,
        fulfillment: new Uint8Array(32),
        data: EMPTY,
      },
      fulfilmentOf(0x11)
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
  });

  it('a missing fulfilment (malformed transport response) fails closed', () => {
    const result = mapIlpResponse(
      {
        type: ILPPacketType.FULFILL,
        data: EMPTY,
      } as unknown as Parameters<typeof mapIlpResponse>[0],
      fulfilmentOf(0x11)
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
  });

  it('REJECT maps unchanged whether or not a fulfilment was expected', () => {
    const reject = {
      type: ILPPacketType.REJECT,
      code: 'F06',
      message: 'nope',
      data: EMPTY,
    } as const;
    expect(mapIlpResponse(reject)).toEqual({
      accepted: false,
      code: 'F06',
      message: 'nope',
    });
    expect(mapIlpResponse(reject, fulfilmentOf(0x11))).toEqual({
      accepted: false,
      code: 'F06',
      message: 'nope',
    });
  });
});

describe('resolveExpectedFulfillment — bytes or their base64 spelling', () => {
  it('passes raw bytes through by identity (this package\u2019s own senders)', () => {
    const expected = fulfilmentOf(0x11);
    expect(resolveExpectedFulfillment(expected)).toBe(expected);
  });

  it('decodes the base64 form a JSON-shaped port declares', () => {
    const expected = fulfilmentOf(0x11);
    expect(resolveExpectedFulfillment(toBase64(expected))).toEqual(expected);
  });

  it('both representations of one fulfilment agree byte-for-byte', () => {
    const expected = fulfilmentOf(0x11);
    expect(resolveExpectedFulfillment(toBase64(expected))).toEqual(
      resolveExpectedFulfillment(expected)
    );
  });

  it('keeps absent absent — the unverified class', () => {
    expect(resolveExpectedFulfillment(undefined)).toBeUndefined();
  });
});

describe('resolveExpiresAt — the wire outlives the sender’s own patience (#646)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-12T12:34:56.789Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is 15 s of headroom, exported so both carriages state the same invariant', () => {
    expect(PACKET_EXPIRY_HEADROOM_MS).toBe(15_000);
  });

  it('defaults to now + timeout + headroom', () => {
    expect(resolveExpiresAt(undefined, 30_000).getTime()).toBe(
      Date.now() + 30_000 + PACKET_EXPIRY_HEADROOM_MS
    );
  });

  it('leaves the packet live at the instant the sender aborts — never expired under a signed claim', () => {
    const timeoutMs = 5_000;
    expect(resolveExpiresAt(undefined, timeoutMs).getTime()).toBeGreaterThan(
      Date.now() + timeoutMs
    );
  });

  it('honours an explicit Date exactly: neither extended nor clamped', () => {
    const named = new Date('2026-07-12T12:35:00.000Z');
    const resolved = resolveExpiresAt(named, 30_000);
    expect(resolved.getTime()).toBe(named.getTime());
    expect(resolved).not.toBe(named);
  });

  it('honours an explicit ISO string exactly, headroom left out of it', () => {
    expect(resolveExpiresAt('2026-07-12T12:35:00.000Z', 30_000).toISOString()).toBe(
      '2026-07-12T12:35:00.000Z'
    );
  });

  it('honours a named deadline shorter than the timeout — a caller who names one has one', () => {
    const soon = new Date(Date.now() + 100);
    expect(resolveExpiresAt(soon, 30_000).getTime()).toBe(soon.getTime());
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mapIlpResponse,
  resolveExecutionCondition,
  resolveExpiresAt,
  FULFILLMENT_MISMATCH_CODE,
  FULFILLMENT_MISMATCH_MESSAGE,
  PACKET_EXPIRY_HEADROOM_MS,
} from './ilp-send.js';
import { ILPPacketType } from '../btp/protocol.js';
import { mintExecutionCondition } from '../utils/condition.js';
import { toBase64 } from '../utils/binary.js';

const EMPTY = new Uint8Array(0);

describe('mapIlpResponse — shared transport response mapping (#350)', () => {
  it('legacy (no condition): accepts a FULFILL without verification', () => {
    const result = mapIlpResponse({
      type: ILPPacketType.FULFILL,
      fulfillment: new Uint8Array(32),
      data: EMPTY,
    });
    expect(result).toEqual({ accepted: true });
    // No fulfillment leaks onto legacy results (shape unchanged pre-#350).
    expect('fulfillment' in result).toBe(false);
  });

  it('legacy (all-zero condition): identical to no condition', () => {
    const result = mapIlpResponse(
      {
        type: ILPPacketType.FULFILL,
        fulfillment: new Uint8Array(32),
        data: EMPTY,
      },
      new Uint8Array(32)
    );
    expect(result).toEqual({ accepted: true });
  });

  it('sender-chosen: accepts when sha256(fulfillment) == condition and echoes the preimage', () => {
    const { preimage, condition } = mintExecutionCondition();
    const data = new Uint8Array([1, 2, 3]);
    const result = mapIlpResponse(
      { type: ILPPacketType.FULFILL, fulfillment: preimage, data },
      condition
    );
    expect(result.accepted).toBe(true);
    expect(result.fulfillment).toBe(toBase64(preimage));
    expect(result.data).toBe(toBase64(data));
  });

  it('sender-chosen: a wrong preimage is a FAILED packet, not a silent accept', () => {
    const { condition } = mintExecutionCondition();
    const wrong = mintExecutionCondition().preimage;
    const result = mapIlpResponse(
      { type: ILPPacketType.FULFILL, fulfillment: wrong, data: EMPTY },
      condition
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
    expect(result.message).toBe(FULFILLMENT_MISMATCH_MESSAGE);
    expect(result.fulfillment).toBeUndefined();
  });

  it('sender-chosen: an all-zero fulfillment (legacy auto-fulfill stub) fails closed', () => {
    const { condition } = mintExecutionCondition();
    const result = mapIlpResponse(
      {
        type: ILPPacketType.FULFILL,
        fulfillment: new Uint8Array(32),
        data: EMPTY,
      },
      condition
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
  });

  it('sender-chosen: a missing fulfillment (malformed transport response) fails closed', () => {
    const { condition } = mintExecutionCondition();
    const result = mapIlpResponse(
      // Simulates a pre-#350 peer/mock that never surfaced the fulfillment.
      {
        type: ILPPacketType.FULFILL,
        data: EMPTY,
      } as unknown as Parameters<typeof mapIlpResponse>[0],
      condition
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
  });

  it('REJECT maps unchanged regardless of condition class', () => {
    const { condition } = mintExecutionCondition();
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
    expect(mapIlpResponse(reject, condition)).toEqual({
      accepted: false,
      code: 'F06',
      message: 'nope',
    });
  });
});

describe('resolveExecutionCondition — core ≥3.4.0 IlpClient base64 form', () => {
  it('passes raw bytes through by identity (this package’s own senders)', () => {
    const { condition } = mintExecutionCondition();
    expect(resolveExecutionCondition(condition)).toBe(condition);
  });

  it('decodes the base64 form core’s IlpClient port declares', () => {
    const { condition } = mintExecutionCondition();
    const decoded = resolveExecutionCondition(toBase64(condition));
    expect(decoded).toEqual(condition);
  });

  it('both representations of one condition agree byte-for-byte', () => {
    const { condition } = mintExecutionCondition();
    expect(resolveExecutionCondition(toBase64(condition))).toEqual(
      resolveExecutionCondition(condition)
    );
  });

  it('keeps absent absent — the legacy unverified class', () => {
    expect(resolveExecutionCondition(undefined)).toBeUndefined();
  });

  it('preserves an all-zero condition as zero in either form', () => {
    const zero = new Uint8Array(32);
    expect(resolveExecutionCondition(zero)).toEqual(zero);
    expect(resolveExecutionCondition(toBase64(zero))).toEqual(zero);
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

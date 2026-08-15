/**
 * Rolling-swap wire protocol tests (toon-client#573).
 */
import { describe, it, expect } from 'vitest';
import { encodeUtf8 } from '../utils/binary.js';
import {
  ROLLING_PROTOCOL,
  isValidStreamNonce,
  generateStreamNonce,
  encodeRollingFillPayload,
  parseRollingAdvancePayload,
} from './rolling-protocol.js';

const STREAM_NONCE = '6e'.repeat(16);

function advanceJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    proto: ROLLING_PROTOCOL,
    type: 'advance',
    streamNonce: STREAM_NONCE,
    seq: 1,
    claim: 'AQIDBA==',
    rate: '0.5',
    rateTimestamp: 1_700_000_000_000,
    sourceAmount: '2000000',
    targetAmount: '1000000',
    ...overrides,
  });
}

describe('isValidStreamNonce / generateStreamNonce', () => {
  it('accepts a 16-byte lowercase hex string', () => {
    expect(isValidStreamNonce(STREAM_NONCE)).toBe(true);
  });

  it('rejects uppercase, short, and non-hex strings', () => {
    expect(isValidStreamNonce(STREAM_NONCE.toUpperCase())).toBe(false);
    expect(isValidStreamNonce('ab')).toBe(false);
    expect(isValidStreamNonce('z'.repeat(32))).toBe(false);
  });

  it('generates a fresh valid nonce each call', () => {
    const a = generateStreamNonce();
    const b = generateStreamNonce();
    expect(isValidStreamNonce(a)).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('encodeRollingFillPayload', () => {
  it('round-trips through JSON as the wire shape the maker parses', () => {
    const bytes = encodeRollingFillPayload({ streamNonce: STREAM_NONCE, seq: 3 });
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    expect(parsed).toEqual({
      proto: ROLLING_PROTOCOL,
      type: 'fill',
      streamNonce: STREAM_NONCE,
      seq: 3,
    });
  });

  it('throws on an invalid streamNonce', () => {
    expect(() =>
      encodeRollingFillPayload({ streamNonce: 'nope', seq: 1 })
    ).toThrow(/streamNonce/);
  });

  it('throws on a non-positive or non-integer seq', () => {
    expect(() =>
      encodeRollingFillPayload({ streamNonce: STREAM_NONCE, seq: 0 })
    ).toThrow(/seq/);
    expect(() =>
      encodeRollingFillPayload({ streamNonce: STREAM_NONCE, seq: 1.5 })
    ).toThrow(/seq/);
  });
});

describe('parseRollingAdvancePayload', () => {
  it('parses a well-formed advance with every optional field present', () => {
    const parsed = parseRollingAdvancePayload(
      encodeUtf8(
        advanceJson({
          claimId: 'c-1',
          channelId: '0x' + '11'.repeat(32),
          nonce: '1',
          cumulativeAmount: '1000000',
          recipient: '0x' + 'aa'.repeat(20),
          swapSignerAddress: '0x' + 'bb'.repeat(20),
        })
      )
    );
    expect(parsed).toEqual({
      proto: ROLLING_PROTOCOL,
      type: 'advance',
      streamNonce: STREAM_NONCE,
      seq: 1,
      claim: 'AQIDBA==',
      claimId: 'c-1',
      channelId: '0x' + '11'.repeat(32),
      nonce: '1',
      cumulativeAmount: '1000000',
      recipient: '0x' + 'aa'.repeat(20),
      swapSignerAddress: '0x' + 'bb'.repeat(20),
      rate: '0.5',
      rateTimestamp: 1_700_000_000_000,
      sourceAmount: '2000000',
      targetAmount: '1000000',
    });
  });

  it('parses a well-formed advance with every optional field absent', () => {
    const parsed = parseRollingAdvancePayload(encodeUtf8(advanceJson()));
    expect(parsed).toMatchObject({ streamNonce: STREAM_NONCE, seq: 1 });
    expect(parsed).not.toHaveProperty('channelId');
    expect(parsed).not.toHaveProperty('nonce');
  });

  it('returns null for non-JSON bytes', () => {
    expect(parseRollingAdvancePayload(encodeUtf8('not json'))).toBeNull();
  });

  it('returns null for JSON that is not rolling/1 traffic at all', () => {
    expect(
      parseRollingAdvancePayload(encodeUtf8(JSON.stringify({ hello: 'world' })))
    ).toBeNull();
  });

  it('returns null for a fill payload (wrong type)', () => {
    expect(
      parseRollingAdvancePayload(
        encodeUtf8(
          JSON.stringify({ proto: ROLLING_PROTOCOL, type: 'fill', streamNonce: STREAM_NONCE, seq: 1 })
        )
      )
    ).toBeNull();
  });

  it('returns null when streamNonce is malformed', () => {
    expect(
      parseRollingAdvancePayload(encodeUtf8(advanceJson({ streamNonce: 'zz' })))
    ).toBeNull();
  });

  it('returns null when seq is not a positive integer', () => {
    expect(parseRollingAdvancePayload(encodeUtf8(advanceJson({ seq: 0 })))).toBeNull();
    expect(parseRollingAdvancePayload(encodeUtf8(advanceJson({ seq: 1.5 })))).toBeNull();
    expect(parseRollingAdvancePayload(encodeUtf8(advanceJson({ seq: 'one' })))).toBeNull();
  });

  it('returns null when a required field is missing', () => {
    const withoutClaim = advanceJson();
    const rec = JSON.parse(withoutClaim) as Record<string, unknown>;
    delete rec['claim'];
    expect(
      parseRollingAdvancePayload(encodeUtf8(JSON.stringify(rec)))
    ).toBeNull();
  });
});

import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  CONDITION_LENGTH,
  mintExecutionCondition,
  isZeroCondition,
  assertValidCondition,
  fulfillmentMatchesCondition,
} from './condition.js';

describe('mintExecutionCondition (spec R1)', () => {
  it('mints a 32-byte preimage and its sha256 condition', () => {
    const { preimage, condition } = mintExecutionCondition();
    expect(preimage).toHaveLength(CONDITION_LENGTH);
    expect(condition).toHaveLength(CONDITION_LENGTH);
    expect(condition).toEqual(sha256(preimage));
  });

  it('mints a NON-ZERO condition (never collides with the legacy class)', () => {
    const { condition } = mintExecutionCondition();
    expect(isZeroCondition(condition)).toBe(false);
  });

  it('mints a FRESH pair per call — reveal is the commit act, no reuse', () => {
    const a = mintExecutionCondition();
    const b = mintExecutionCondition();
    expect(a.preimage).not.toEqual(b.preimage);
    expect(a.condition).not.toEqual(b.condition);
  });
});

describe('isZeroCondition (legacy-class detection)', () => {
  it('treats absent and all-zero as the same legacy class', () => {
    expect(isZeroCondition(undefined)).toBe(true);
    expect(isZeroCondition(new Uint8Array(32))).toBe(true);
  });

  it('any non-zero byte selects the sender-chosen class', () => {
    const condition = new Uint8Array(32);
    condition[31] = 1;
    expect(isZeroCondition(condition)).toBe(false);
  });
});

describe('assertValidCondition', () => {
  it('accepts exactly 32 bytes', () => {
    expect(() =>
      assertValidCondition(new Uint8Array(32).fill(7))
    ).not.toThrow();
  });

  it.each([[0], [31], [33]])('rejects %d bytes', (len) => {
    expect(() => assertValidCondition(new Uint8Array(len).fill(7))).toThrow(
      /32 bytes/
    );
  });
});

describe('fulfillmentMatchesCondition (sender-side FULFILL check)', () => {
  it('accepts the matching preimage', () => {
    const { preimage, condition } = mintExecutionCondition();
    expect(fulfillmentMatchesCondition(preimage, condition)).toBe(true);
  });

  it('rejects a wrong preimage', () => {
    const { condition } = mintExecutionCondition();
    const wrong = mintExecutionCondition().preimage;
    expect(fulfillmentMatchesCondition(wrong, condition)).toBe(false);
  });

  it('fails closed on absent or malformed (non-32-byte) fulfillments', () => {
    const { preimage, condition } = mintExecutionCondition();
    expect(fulfillmentMatchesCondition(undefined, condition)).toBe(false);
    expect(fulfillmentMatchesCondition(preimage.slice(0, 31), condition)).toBe(
      false
    );
    const long = new Uint8Array(33);
    long.set(preimage);
    expect(fulfillmentMatchesCondition(long, condition)).toBe(false);
  });

  it('an all-zero fulfillment does not satisfy a real condition', () => {
    const { condition } = mintExecutionCondition();
    expect(fulfillmentMatchesCondition(new Uint8Array(32), condition)).toBe(
      false
    );
  });
});

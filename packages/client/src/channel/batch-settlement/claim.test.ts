import { describe, it, expect } from 'vitest';
import {
  evmVoucherClaim,
  nextVoucherAmount,
  solanaVoucherClaim,
} from './claim.js';

describe('nextVoucherAmount', () => {
  it('sends no voucher on a free route', () => {
    expect(nextVoucherAmount(0n, 0n)).toBeUndefined();
    expect(nextVoucherAmount(5_000n, 0n)).toBeUndefined();
  });

  it('advances by exactly the charge', () => {
    expect(nextVoucherAmount(0n, 1_000n)).toBe(1_000n);
    expect(nextVoucherAmount(1_000n, 500n)).toBe(1_500n);
  });

  it('refuses a negative charge', () => {
    expect(() => nextVoucherAmount(0n, -1n)).toThrow(RangeError);
  });
});

describe('voucher claims', () => {
  it('draw a fresh message id and a millisecond-zeroed timestamp when none is given', () => {
    const evm = evmVoucherClaim(
      { channelId: '0xAB', maxClaimableAmount: '1', signature: '0xCD' },
      {
        payer: '0xAa',
        payerAuthorizer: '0xBb',
        receiver: '0xCc',
        receiverAuthorizer: '0xCc',
        token: '0xDd',
        withdrawDelay: 86_400,
        salt: '0xEe',
      }
    );
    const solana = solanaVoucherClaim(
      { channelId: 'C', maxClaimableAmount: '1', expiresAt: 0, signature: 'S' },
      'K'
    );
    for (const claim of [evm, solana]) {
      expect(claim['scheme']).toBe('batch-settlement');
      expect(claim['messageId']).toMatch(/^[0-9a-f-]{36}$/);
      expect(claim['timestamp']).toMatch(/\.000Z$/);
    }
    expect(evm['messageId']).not.toBe(solana['messageId']);
    expect(evm['senderId']).toBe('0xbb');
    expect(evm['channelId']).toBe('0xab');
  });
});

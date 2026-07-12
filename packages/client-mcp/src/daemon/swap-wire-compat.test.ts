import { describe, it, expect } from 'vitest';
// Deliberately NOT mocked (unlike client-runner.test.ts / routes.test.ts):
// these tests pin the REAL sdk's FULFILL settlement-metadata wire behavior.
import { __streamSwapTesting } from '@toon-protocol/sdk';

const { decodeFulfillMetadata } = __streamSwapTesting;

/**
 * Wire-compat pin for the sdk ≥2.0.0 `millSignerAddress`→`swapSignerAddress`
 * rename (toon commit `af4cd24`, no back-compat alias) — issue #349.
 *
 * `decodeFulfillMetadata` drops unknown settlement fields *silently*, so a
 * version-skewed swap peer never produces a decode error: the signer address
 * just vanishes and the failure surfaces much later as
 * `MISSING_SETTLEMENT_METADATA` in `buildSettlementTx`. These tests assert,
 * against the real sdk (no mocks):
 *
 *  1. `swapSignerAddress` survives an encode→decode round trip (the happy
 *     path after both sides are on sdk ≥2), and
 *  2. a pre-rename peer's `millSignerAddress` is indeed dropped — documenting
 *     the trap this repo's deploy-ordering note (and the swap-time `warning`
 *     in `ClientRunner.swap`) exists for. If the sdk ever grows a tolerant
 *     back-compat alias, test 2 fails and the warning path can be retired.
 */

const CHAIN = 'evm:base:84532';
const SIGNER = '0x' + 'bb'.repeat(20);

/** Base64-encode FULFILL metadata the way a swap peer puts it on the wire. */
function encodeFulfillData(extra: Record<string, string>): string {
  return Buffer.from(
    JSON.stringify({
      claim: Buffer.from([1, 2, 3, 4]).toString('base64'),
      ephemeralPubkey: 'ab'.repeat(32),
      channelId: '0x' + '11'.repeat(32),
      nonce: '1',
      cumulativeAmount: '999',
      recipient: '0x' + 'aa'.repeat(20),
      ...extra,
    })
  ).toString('base64');
}

describe('FULFILL settlement metadata wire compat (sdk ≥2 rename, #349)', () => {
  it('round-trips swapSignerAddress through decodeFulfillMetadata', () => {
    const decoded = decodeFulfillMetadata(
      encodeFulfillData({ swapSignerAddress: SIGNER }),
      CHAIN
    );
    expect(decoded.swapSignerAddress).toBe(SIGNER);
    // The rest of the settlement context survives alongside it.
    expect(decoded.channelId).toBe('0x' + '11'.repeat(32));
    expect(decoded.nonce).toBe('1');
    expect(decoded.cumulativeAmount).toBe('999');
    expect(decoded.recipient).toBe('0x' + 'aa'.repeat(20));
  });

  it('silently drops a pre-rename millSignerAddress — the documented skew trap', () => {
    const decoded = decodeFulfillMetadata(
      encodeFulfillData({ millSignerAddress: SIGNER }),
      CHAIN
    );
    // No error, no alias: the field is simply gone. This is why a one-sided
    // upgrade fails silently at swap time and loudly only at settlement.
    expect(decoded).not.toHaveProperty('swapSignerAddress');
    expect(decoded).not.toHaveProperty('millSignerAddress');
    // The decode itself still succeeds (claim + ephemeralPubkey intact).
    expect(decoded.claim).toBe(Buffer.from([1, 2, 3, 4]).toString('base64'));
    expect(decoded.ephemeralPubkey).toBe('ab'.repeat(32));
  });
});

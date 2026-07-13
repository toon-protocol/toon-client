/**
 * Conformance test for the v2 EIP-712 rolling-swap balance-proof digest.
 *
 * The literals below are the GOLDEN VECTORS from the canonical cross-repo spec
 * `docs/rolling-swap-v2-digest-spec.md` §4 (connector#324 finding #1 /
 * connector#325). The connector contract, toon core/sdk, the swap signer, and
 * this client MUST all produce these byte-for-byte. Any drift here is a
 * cross-repo wire break — do NOT "fix" the expected values to match code.
 */
import { describe, it, expect } from 'vitest';
import {
  evmClaimDigest,
  evmCooperativeCloseDigest,
  recoverEvmClaimSigner,
  verifyEvmClaimSignature,
  CLAIM_TYPEHASH,
  COOP_CLOSE_TYPEHASH,
  ROLLING_SWAP_DOMAIN_NAME,
  ROLLING_SWAP_DOMAIN_VERSION,
} from './evm-claim-digest.js';

// ── Golden vectors (spec §4) ──────────────────────────────────────────────────

const CTX = {
  chainId: 8453,
  verifyingContract: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
} as const;

const MSG = {
  channelId:
    '0x000000000000000000000000000000000000000000000000000000000000005b',
  cumulativeAmount: 24_000_000n,
  nonce: 24n,
  recipient: '0x00000000000000000000000000000000DEADBEEF',
} as const;

const CLAIM_DIGEST =
  '0x8e0b1e0baf4cb5490d8d8ebcad0c51feec55adff992680c21cbf137a4434fede';
const COOP_DIGEST =
  '0x8b748bdfc330a591164551d4b536d64b963aff1059b594acc1dc5a24297e25c0';

// Claim signer = anvil key #0.
const CLAIM_SIG =
  '0xfa66a50c60bdd47c11b4b6a76f44255095d77cead2910b619d3b8e838237982b196b22bc46254ff3e85923d0604bf7de9136d0ba79cfe85a3f38d636b262c9bb1b';
const CLAIM_SIGNER = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';

// Coop-close (recipient) signer = anvil key #1.
const COOP_SIG =
  '0xd8c7479c1d048fc8ee8bbb912db60d2c7b0056245a7c3611b88eceabe243932d7878586332642641c62fb909e4f23655a428f13125af2e41fe1f90ea85a100621b';
const COOP_SIGNER = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

describe('v2 EIP-712 balance-proof digest (golden vectors, spec §4)', () => {
  it('pins the domain name/version and both type hashes', () => {
    expect(ROLLING_SWAP_DOMAIN_NAME).toBe('RollingSwapChannel');
    expect(ROLLING_SWAP_DOMAIN_VERSION).toBe('2');
    expect(CLAIM_TYPEHASH).toBe(
      '0xa0c8262c1a8615f7674d3af796b14d19672d3634f89c6093502ab35c0afe2d91'
    );
    expect(COOP_CLOSE_TYPEHASH).toBe(
      '0xa5753389755fea51cd5016d7b02b508ac03f2e822d9a7ee345ec45b36574ff9f'
    );
  });

  it('computes the exact claim digest', () => {
    expect(evmClaimDigest(CTX, MSG)).toBe(CLAIM_DIGEST);
  });

  it('computes the exact cooperative-close digest', () => {
    expect(
      evmCooperativeCloseDigest(CTX, {
        channelId: MSG.channelId,
        cumulativeAmount: MSG.cumulativeAmount,
        nonce: MSG.nonce,
      })
    ).toBe(COOP_DIGEST);
  });

  it('recovers the golden claim signer from the golden signature', () => {
    expect(recoverEvmClaimSigner(CTX, MSG, CLAIM_SIG).toLowerCase()).toBe(
      CLAIM_SIGNER.toLowerCase()
    );
  });

  it('verifyEvmClaimSignature accepts the golden claim + expected signer', () => {
    const res = verifyEvmClaimSignature({
      ctx: CTX,
      message: MSG,
      signature: CLAIM_SIG,
      expectedSigner: CLAIM_SIGNER,
    });
    expect(res.valid).toBe(true);
  });

  it('the coop-close signature recovers to the recipient over the coop digest', () => {
    // Cross-check: recovering the coop signature against the CLAIM digest must
    // NOT yield the recipient (distinct type hash → distinct digest), proving
    // a close-ack can never be replayed as a balance-proof claim.
    const wrong = recoverEvmClaimSigner(CTX, MSG, COOP_SIG);
    expect(wrong.toLowerCase()).not.toBe(COOP_SIGNER.toLowerCase());
  });

  // ── Domain separation is load-bearing (finding #1) ──────────────────────────

  it('a claim signature is NOT valid on a different chainId (cross-chain replay closed)', () => {
    const res = verifyEvmClaimSignature({
      ctx: { ...CTX, chainId: 1 },
      message: MSG,
      signature: CLAIM_SIG,
      expectedSigner: CLAIM_SIGNER,
    });
    expect(res.valid).toBe(false);
  });

  it('a claim signature is NOT valid on a different verifyingContract (cross-deployment replay closed)', () => {
    const res = verifyEvmClaimSignature({
      ctx: {
        ...CTX,
        verifyingContract: '0x0000000000000000000000000000000000000001',
      },
      message: MSG,
      signature: CLAIM_SIG,
      expectedSigner: CLAIM_SIGNER,
    });
    expect(res.valid).toBe(false);
  });

  it('rejects a malformed signature (wrong length) fail-closed', () => {
    const res = verifyEvmClaimSignature({
      ctx: CTX,
      message: MSG,
      signature: '0x1234',
      expectedSigner: CLAIM_SIGNER,
    });
    expect(res.valid).toBe(false);
  });
});

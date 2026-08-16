/**
 * Receipt-time verification pipeline tests (#352). Fixtures are REAL signed
 * balance proofs — EVM secp256k1 (r||s||v over the **v2 EIP-712** claim digest,
 * connector#324 finding #1) and Solana Ed25519 (over `balanceProofHashSolana`).
 * The EVM fixtures are byte-compatible with what a v2 `@toon-protocol/swap`
 * claim signer emits; the digest is asserted against the spec golden vectors in
 * `evm-claim-digest.test.ts`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { ed25519 } from '@noble/curves/ed25519.js';
import {
  balanceProofHashSolana,
  base58Encode,
  hexToBytes,
} from '@toon-protocol/core';
import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';
import { ingestReceivedClaims } from './received-claims.js';
import { evmClaimDigest } from './evm-claim-digest.js';
import { InMemoryReceivedClaimStore } from '../channel/ReceivedClaimStore.js';

// ── EVM fixtures ──────────────────────────────────────────────────────────────

const SIGNER_A = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const SIGNER_B = privateKeyToAccount(
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a'
);
const ADDR_A = SIGNER_A.address.toLowerCase();
const ADDR_B = SIGNER_B.address.toLowerCase();
const RECIPIENT = '0x' + 'aa'.repeat(20);
const CHANNEL = '0x' + '11'.repeat(32);
const EVM_CHAIN = 'evm:anvil:31337';
/** chain id embedded in EVM_CHAIN — the v2 EIP-712 domain `chainId`. */
const EVM_CHAIN_ID = 31337;
/** The deployed RollingSwapChannel / EIP-712 `verifyingContract`. */
const EVM_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
/** Leg-B swapVerifyingContracts map the receive path needs for the v2 domain. */
const EVM_VERIFYING_CONTRACTS = { [EVM_CHAIN]: EVM_CONTRACT };
const EVM_PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
  rate: '1.0',
};

async function evmClaim(opts: {
  nonce: string;
  cumulativeAmount: string;
  targetAmount: bigint;
  packetIndex?: number;
  channelId?: string;
  recipient?: string;
  signer?: typeof SIGNER_A;
  /** Advertise different values than were signed (tampering). */
  signedCumulative?: string;
}): Promise<AccumulatedClaim> {
  const channelId = opts.channelId ?? CHANNEL;
  const recipient = opts.recipient ?? RECIPIENT;
  const signer = opts.signer ?? SIGNER_A;
  const digest = evmClaimDigest(
    { chainId: EVM_CHAIN_ID, verifyingContract: EVM_CONTRACT },
    {
      channelId,
      cumulativeAmount: BigInt(opts.signedCumulative ?? opts.cumulativeAmount),
      nonce: BigInt(opts.nonce),
      recipient,
    }
  );
  const sig = await signer.sign({ hash: digest });
  return {
    packetIndex: opts.packetIndex ?? 0,
    sourceAmount: opts.targetAmount,
    targetAmount: opts.targetAmount,
    claimBytes: hexToBytes(sig),
    swapEphemeralPubkey: 'ab'.repeat(32),
    pair: EVM_PAIR,
    receivedAt: 42,
    channelId,
    nonce: opts.nonce,
    cumulativeAmount: opts.cumulativeAmount,
    recipient,
    swapSignerAddress: signer.address.toLowerCase(),
  };
}

// ── Solana fixtures ───────────────────────────────────────────────────────────

const SOL_PRIV = new Uint8Array(32).fill(7);
const SOL_PUB = ed25519.getPublicKey(SOL_PRIV);
const SOL_SIGNER = base58Encode(SOL_PUB);
const SOL_RECIPIENT = base58Encode(new Uint8Array(32).fill(9));
const SOL_CHANNEL = base58Encode(new Uint8Array(32).fill(3));
const SOL_CHAIN = 'solana:devnet';
const SOL_PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: SOL_CHAIN },
  rate: '1.0',
};

function solanaClaim(opts: {
  nonce: string;
  cumulativeAmount: string;
  targetAmount: bigint;
}): AccumulatedClaim {
  const msgHash = balanceProofHashSolana(
    SOL_CHANNEL,
    BigInt(opts.cumulativeAmount),
    BigInt(opts.nonce),
    SOL_RECIPIENT
  );
  return {
    packetIndex: 0,
    sourceAmount: opts.targetAmount,
    targetAmount: opts.targetAmount,
    claimBytes: ed25519.sign(msgHash, SOL_PRIV),
    swapEphemeralPubkey: 'ab'.repeat(32),
    pair: SOL_PAIR,
    receivedAt: 42,
    channelId: SOL_CHANNEL,
    nonce: opts.nonce,
    cumulativeAmount: opts.cumulativeAmount,
    recipient: SOL_RECIPIENT,
    swapSignerAddress: SOL_SIGNER,
  };
}

describe('ingestReceivedClaims (#352)', () => {
  let store: InMemoryReceivedClaimStore;
  const base = {
    expectedChain: EVM_CHAIN,
    chainRecipient: RECIPIENT,
    swapVerifyingContracts: EVM_VERIFYING_CONTRACTS,
  };

  beforeEach(() => {
    store = new InMemoryReceivedClaimStore();
  });

  it('verifies + persists a valid EVM claim as the channel watermark', async () => {
    const claim = await evmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
    });
    const res = ingestReceivedClaims({ claims: [claim], ...base, store });

    expect(res.rejected).toHaveLength(0);
    expect(res.legacy).toHaveLength(0);
    expect(res.verified).toHaveLength(1);
    expect(res.verified[0]!.watermarkAdvance).toBe(999n);
    expect(res.valueReceived).toBe(999n);

    const entry = store.load(EVM_CHAIN, CHANNEL)!;
    expect(entry.nonce).toBe(1n);
    expect(entry.cumulativeAmount).toBe(999n);
    expect(entry.swapSignerAddress).toBe(ADDR_A);
    expect(entry.claimBytes).toEqual(claim.claimBytes);
    expect(entry.pair).toEqual(EVM_PAIR);
    // #572: the verifyingContract the v2 domain was reconstructed against is
    // pinned onto the entry, so settlement re-verification doesn't depend on
    // whatever `swapVerifyingContracts` config happens to hold later.
    expect(entry.verifyingContract).toBe(EVM_CONTRACT);
  });

  it('does not pin verifyingContract on a non-EVM (Solana) watermark', () => {
    const res = ingestReceivedClaims({
      claims: [
        solanaClaim({
          nonce: '1',
          cumulativeAmount: '500',
          targetAmount: 500n,
        }),
      ],
      expectedChain: SOL_CHAIN,
      chainRecipient: SOL_RECIPIENT,
      store,
    });
    expect(res.verified).toHaveLength(1);
    expect(
      store.load(SOL_CHAIN, SOL_CHANNEL)!.verifyingContract
    ).toBeUndefined();
  });

  it('verifies a valid Solana Ed25519 claim', () => {
    const res = ingestReceivedClaims({
      claims: [
        solanaClaim({
          nonce: '1',
          cumulativeAmount: '500',
          targetAmount: 500n,
        }),
      ],
      expectedChain: SOL_CHAIN,
      chainRecipient: SOL_RECIPIENT,
      store,
    });
    expect(res.verified).toHaveLength(1);
    expect(store.load(SOL_CHAIN, SOL_CHANNEL)!.cumulativeAmount).toBe(500n);
  });

  it('folds a multi-packet stream into one advancing watermark (delta-checked per packet)', async () => {
    const claims = [
      await evmClaim({
        nonce: '1',
        cumulativeAmount: '300',
        targetAmount: 300n,
        packetIndex: 0,
      }),
      await evmClaim({
        nonce: '2',
        cumulativeAmount: '600',
        targetAmount: 300n,
        packetIndex: 1,
      }),
      await evmClaim({
        nonce: '3',
        cumulativeAmount: '900',
        targetAmount: 300n,
        packetIndex: 2,
      }),
    ];
    const res = ingestReceivedClaims({ claims, ...base, store });
    expect(res.verified).toHaveLength(3);
    expect(res.valueReceived).toBe(900n);
    expect(store.list()).toHaveLength(1);
    expect(store.load(EVM_CHAIN, CHANNEL)!.nonce).toBe(3n);
  });

  it('advances an EXISTING persisted watermark across sessions', async () => {
    ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '5',
          cumulativeAmount: '1000',
          targetAmount: 1000n,
        }),
      ],
      ...base,
      store,
    });
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '6',
          cumulativeAmount: '1400',
          targetAmount: 400n,
        }),
      ],
      ...base,
      store,
    });
    expect(res.verified).toHaveLength(1);
    expect(res.valueReceived).toBe(400n); // the advance, not the cumulative
    expect(store.load(EVM_CHAIN, CHANNEL)!.cumulativeAmount).toBe(1400n);
  });

  it('buckets a claim missing settlement metadata as legacy (#349 path), unpersisted', async () => {
    const claim = await evmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
    });
    delete (claim as { swapSignerAddress?: string }).swapSignerAddress;
    const res = ingestReceivedClaims({ claims: [claim], ...base, store });
    expect(res.legacy).toHaveLength(1);
    expect(res.verified).toHaveLength(0);
    expect(res.rejected).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
    expect(res.valueReceived).toBe(0n);
  });

  it('rejects a claim for the wrong chain (CHAIN_MISMATCH)', async () => {
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ],
      expectedChain: 'evm:base:8453',
      chainRecipient: RECIPIENT,
      store,
    });
    expect(res.rejected[0]!.code).toBe('CHAIN_MISMATCH');
    expect(store.list()).toHaveLength(0);
  });

  it('rejects a claim paying someone else (RECIPIENT_MISMATCH, the anti-substitution check)', async () => {
    const other = '0x' + 'ee'.repeat(20);
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
          recipient: other,
        }),
      ],
      ...base,
      store,
    });
    expect(res.rejected[0]!.code).toBe('RECIPIENT_MISMATCH');
  });

  it('EVM recipient comparison is case-insensitive (checksummed vs lowercase)', async () => {
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ],
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT.toUpperCase().replace('0X', '0x'),
      swapVerifyingContracts: EVM_VERIFYING_CONTRACTS,
      store,
    });
    expect(res.verified).toHaveLength(1);
  });

  it("rejects a signer that differs from the maker's ADVERTISED address (SWAP_SIGNER_MISMATCH)", async () => {
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ],
      ...base,
      expectedSignerAddress: ADDR_B,
      store,
    });
    expect(res.rejected[0]!.code).toBe('SWAP_SIGNER_MISMATCH');
    expect(store.list()).toHaveLength(0);
  });

  it('verifies against the ADVERTISED signer, never the claim self-report: a self-consistent claim by the wrong key is caught', async () => {
    // Signed by B AND self-reporting B — internally consistent, but the maker
    // advertised A. Trusting the self-report would accept it.
    const claim = await evmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
      signer: SIGNER_B,
    });
    const res = ingestReceivedClaims({
      claims: [claim],
      ...base,
      expectedSignerAddress: ADDR_A,
      store,
    });
    expect(res.rejected[0]!.code).toBe('SWAP_SIGNER_MISMATCH');
  });

  it('rejects a tampered cumulative (signature covers different values → SIGNER_MISMATCH)', async () => {
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          signedCumulative: '1',
          targetAmount: 999n,
        }),
      ],
      ...base,
      store,
    });
    expect(res.rejected[0]!.code).toBe('SIGNER_MISMATCH');
    expect(res.valueReceived).toBe(0n);
    expect(store.list()).toHaveLength(0);
  });

  it('[#583] rejects an EVM claim with NO known leg-B verifying contract as MISSING_SWAP_VERIFYING_CONTRACT — never SIGNER_MISMATCH', async () => {
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ],
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT,
      // no swapVerifyingContracts → cannot reconstruct the EIP-712 domain
      store,
    });
    // The distinct code is the point: the pre-#583 code fell back to the
    // leg-A `tokenNetworks` map and reported `SIGNER_MISMATCH`, which reads
    // as "wrong key" and sent the last reader hunting for an hour.
    expect(res.rejected[0]!.code).toBe('MISSING_SWAP_VERIFYING_CONTRACT');
    expect(res.rejected[0]!.code).not.toBe('SIGNER_MISMATCH');
    // The message must name what is missing AND warn off the leg-A map.
    expect(res.rejected[0]!.message).toContain('swapVerifyingContracts');
    expect(res.rejected[0]!.message).toContain('RollingSwapChannel');
    expect(res.rejected[0]!.message).toContain('tokenNetworks');
    expect(res.verified).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
  });

  it('[#583] a chain key with no numeric chain id is MISSING_CHAIN_CONFIG (distinct from the missing contract)', async () => {
    const badChain = 'evm:nochainid';
    const claim = await evmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
    });
    claim.pair = { ...EVM_PAIR, to: { ...EVM_PAIR.to, chain: badChain } };
    const res = ingestReceivedClaims({
      claims: [claim],
      expectedChain: badChain,
      chainRecipient: RECIPIENT,
      swapVerifyingContracts: { [badChain]: EVM_CONTRACT },
      store,
    });
    expect(res.rejected[0]!.code).toBe('MISSING_CHAIN_CONFIG');
  });

  it('[#583] the leg-A tokenNetworks map is NOT a fallback: passing it changes nothing', async () => {
    // The live-devnet shape that broke: the daemon config holds ONLY the
    // leg-A TokenNetwork, and the maker's leg-B RollingSwapChannel is a
    // different contract. `ingestReceivedClaims` has no `tokenNetworks`
    // parameter at all any more, so the leg-A address is unreachable from
    // here by construction — this pins that the type has no such door.
    const params = {
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ],
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT,
      store,
    };
    expect('tokenNetworks' in params).toBe(false);
    const res = ingestReceivedClaims(params);
    expect(res.rejected[0]!.code).toBe('MISSING_SWAP_VERIFYING_CONTRACT');
  });

  it('rejects an EVM claim signed for a DIFFERENT contract (cross-deployment replay, finding #1)', async () => {
    // The fixture is signed against EVM_CONTRACT; verifying under a different
    // RollingSwapChannel address must fail (the v2 digest binds it).
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ],
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT,
      swapVerifyingContracts: {
        [EVM_CHAIN]: '0x0000000000000000000000000000000000000009',
      },
      store,
    });
    expect(res.rejected[0]!.code).toBe('SIGNER_MISMATCH');
    expect(store.list()).toHaveLength(0);
  });

  it('rejects garbage claim bytes (SIGNATURE_INVALID)', async () => {
    const claim = await evmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
    });
    claim.claimBytes = new Uint8Array([1, 2, 3, 4]);
    const res = ingestReceivedClaims({ claims: [claim], ...base, store });
    expect(res.rejected[0]!.code).toBe('SIGNATURE_INVALID');
  });

  it('rejects a non-monotonic nonce vs the persisted watermark (replay defense)', async () => {
    const claim = await evmClaim({
      nonce: '3',
      cumulativeAmount: '900',
      targetAmount: 900n,
    });
    ingestReceivedClaims({ claims: [claim], ...base, store });
    // The SAME valid claim again — a replay must not double-count.
    const res = ingestReceivedClaims({ claims: [claim], ...base, store });
    expect(res.rejected[0]!.code).toBe('NON_MONOTONIC_NONCE');
    expect(res.valueReceived).toBe(0n);
    expect(store.load(EVM_CHAIN, CHANNEL)!.nonce).toBe(3n);
  });

  it('rejects a higher nonce with a NON-advancing cumulative (NON_MONOTONIC_CUMULATIVE)', async () => {
    ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '900',
          targetAmount: 900n,
        }),
      ],
      ...base,
      store,
    });
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '2',
          cumulativeAmount: '900',
          targetAmount: 100n,
        }),
      ],
      ...base,
      store,
    });
    expect(res.rejected[0]!.code).toBe('NON_MONOTONIC_CUMULATIVE');
  });

  it('rejects an advance smaller than the packet targetAmount (CUMULATIVE_SHORTFALL: maker short-paid)', async () => {
    ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '900',
          targetAmount: 900n,
        }),
      ],
      ...base,
      store,
    });
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '2',
          cumulativeAmount: '950',
          targetAmount: 100n,
        }),
      ],
      ...base,
      store,
    });
    expect(res.rejected[0]!.code).toBe('CUMULATIVE_SHORTFALL');
    // The watermark did NOT advance on the short-paid claim.
    expect(store.load(EVM_CHAIN, CHANNEL)!.cumulativeAmount).toBe(900n);
  });

  it('pins the channel signer: a validly-signed claim by a NEW key may not rotate the watermark', async () => {
    ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '500',
          targetAmount: 500n,
        }),
      ],
      ...base,
      store,
    });
    const res = ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '2',
          cumulativeAmount: '1000',
          targetAmount: 500n,
          signer: SIGNER_B,
        }),
      ],
      ...base,
      store,
    });
    expect(res.rejected[0]!.code).toBe('SWAP_SIGNER_MISMATCH');
    expect(store.load(EVM_CHAIN, CHANNEL)!.swapSignerAddress).toBe(ADDR_A);
  });

  it('fails CLOSED on mina claims when no mina-signer client is provided', () => {
    const minaPair = {
      ...EVM_PAIR,
      to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
    };
    const claim: AccumulatedClaim = {
      packetIndex: 0,
      sourceAmount: 100n,
      targetAmount: 400n,
      claimBytes: new TextEncoder().encode('some-base58-signature'),
      swapEphemeralPubkey: 'ab'.repeat(32),
      pair: minaPair,
      receivedAt: 42,
      channelId: 'B62channel',
      nonce: '1',
      cumulativeAmount: '400',
      recipient: 'B62recipient',
      swapSignerAddress: 'B62signer',
    };
    const res = ingestReceivedClaims({
      claims: [claim],
      expectedChain: 'mina:devnet',
      chainRecipient: 'B62recipient',
      store,
    });
    expect(res.rejected[0]!.code).toBe('MINA_VERIFICATION_UNSUPPORTED');
    expect(store.list()).toHaveLength(0);
  });

  it('a rejected claim never blocks later valid claims (per-claim isolation)', async () => {
    const bad = await evmClaim({
      nonce: '1',
      cumulativeAmount: '300',
      signedCumulative: '1',
      targetAmount: 300n,
      packetIndex: 0,
    });
    const good = await evmClaim({
      nonce: '2',
      cumulativeAmount: '300',
      targetAmount: 300n,
      packetIndex: 1,
    });
    const res = ingestReceivedClaims({ claims: [bad, good], ...base, store });
    expect(res.rejected).toHaveLength(1);
    expect(res.verified).toHaveLength(1);
    // Value received counts ONLY the verified advance.
    expect(res.valueReceived).toBe(300n);
    expect(store.load(EVM_CHAIN, CHANNEL)!.nonce).toBe(2n);
  });

  it('preserves settlement bookkeeping when a watermark advances', async () => {
    ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '1',
          cumulativeAmount: '500',
          targetAmount: 500n,
        }),
      ],
      ...base,
      store,
    });
    const settled = store.load(EVM_CHAIN, CHANNEL)!;
    store.save({
      ...settled,
      settledAt: 777,
      settledNonce: 1n,
      settleTxHash: '0xtx',
    });

    ingestReceivedClaims({
      claims: [
        await evmClaim({
          nonce: '2',
          cumulativeAmount: '900',
          targetAmount: 400n,
        }),
      ],
      ...base,
      store,
    });
    const after = store.load(EVM_CHAIN, CHANNEL)!;
    expect(after.nonce).toBe(2n);
    expect(after.settledNonce).toBe(1n);
    expect(after.settleTxHash).toBe('0xtx');
  });
});

// ── The live devnet claim that motivated #583 ────────────────────────────────
//
// A REAL leg-B balance proof, signed by the devnet maker `g.toon.swap.maker`
// and captured off a swap that succeeded on the wire on 2026-08-16 (1 packet
// accepted, state "completed", 1000 → 1000 at rate 1) but delivered ZERO
// verified value because the client verified it under the wrong contract.
//
// The two addresses below are the whole bug, and both were confirmed by
// recovering this exact signature twice:
//   verifyingContract = LEG_A (TokenNetwork)      → 0x977485ff59e2f556…e05
//   verifyingContract = LEG_B (RollingSwapChannel) → 0x5f68f3a1ab1eb594…005  ✓
// The first is the garbage address the shipped client reported as
// `SIGNER_MISMATCH: recovered 0x977485ff…, expected 0x5f68f3a1…`.
const LIVE = {
  chain: 'evm:84532',
  /** LEG B — the maker's RollingSwapChannel; the EIP-712 verifyingContract. */
  rollingSwapChannel: '0xd329aBf86ceae23F904641F992ca90e3721FeF83',
  /** LEG A — the TokenNetwork the client pays the maker THROUGH. Never leg B. */
  tokenNetwork: '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478',
  channelId:
    '0x0124a370557b0c2d64b2acd05769e5300abc19aefb286bfba9aede2f263100b1',
  nonce: '6',
  cumulativeAmount: '5001000',
  recipient: '0xd7d0d2f8269452c95a70a597d596899d3f01eeb0',
  swapSignerAddress: '0x5f68f3a1ab1eb59417dbe11b8d8c9db339a04005',
  claimBase64:
    'UPLkiUXZKqCZFxsg2NzGJIVAj+QFoI+c6FadFzhnAUVW1aNdOgXxm1cqzvC+mMiLVuN1ID/uCxYTVo51TMTJDxw=',
  targetAmount: 1000n,
  /** The address the pre-#583 client recovered under the leg-A domain. */
  wrongRecoveredUnderLegA: '0x977485ff59e2f55609f9c6e1275764731e045e05',
} as const;

const LIVE_PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: LIVE.chain },
  to: { assetCode: 'USDC', assetScale: 6, chain: LIVE.chain },
  rate: '1.0',
};

function liveClaim(): AccumulatedClaim {
  return {
    packetIndex: 0,
    sourceAmount: 1000n,
    targetAmount: LIVE.targetAmount,
    claimBytes: new Uint8Array(Buffer.from(LIVE.claimBase64, 'base64')),
    swapEphemeralPubkey: '0'.repeat(64),
    pair: LIVE_PAIR,
    receivedAt: 1,
    channelId: LIVE.channelId,
    nonce: LIVE.nonce,
    cumulativeAmount: LIVE.cumulativeAmount,
    recipient: LIVE.recipient,
    swapSignerAddress: LIVE.swapSignerAddress,
  };
}

describe('#583 — the live devnet maker claim (real signed fixture)', () => {
  let store: InMemoryReceivedClaimStore;
  const base = {
    expectedChain: LIVE.chain,
    chainRecipient: LIVE.recipient,
    expectedSignerAddress: LIVE.swapSignerAddress,
  };

  beforeEach(() => {
    store = new InMemoryReceivedClaimStore();
  });

  it('[P0] VERIFIES under the maker-announced swapVerifyingContracts entry, and pins that contract onto the watermark', () => {
    const res = ingestReceivedClaims({
      claims: [liveClaim()],
      ...base,
      swapVerifyingContracts: { [LIVE.chain]: LIVE.rollingSwapChannel },
      store,
    });

    expect(res.rejected).toEqual([]);
    expect(res.verified).toHaveLength(1);
    expect(res.valueReceived).toBe(5001000n);

    const entry = store.load(LIVE.chain, LIVE.channelId)!;
    expect(entry.nonce).toBe(6n);
    expect(entry.cumulativeAmount).toBe(5001000n);
    expect(entry.swapSignerAddress).toBe(LIVE.swapSignerAddress);
    expect(entry.verifyingContract).toBe(LIVE.rollingSwapChannel);
  });

  it('[P0] the SAME claim under the leg-A TokenNetwork recovers the exact garbage address the live swap reported', () => {
    // Not a hypothetical: this reproduces the shipped failure byte for byte,
    // and is why the leg-A map may never be the leg-B fallback.
    const digestSigner = evmClaimDigest(
      { chainId: 84532, verifyingContract: LIVE.tokenNetwork },
      {
        channelId: LIVE.channelId,
        cumulativeAmount: BigInt(LIVE.cumulativeAmount),
        nonce: BigInt(LIVE.nonce),
        recipient: LIVE.recipient,
      }
    );
    const digestReal = evmClaimDigest(
      { chainId: 84532, verifyingContract: LIVE.rollingSwapChannel },
      {
        channelId: LIVE.channelId,
        cumulativeAmount: BigInt(LIVE.cumulativeAmount),
        nonce: BigInt(LIVE.nonce),
        recipient: LIVE.recipient,
      }
    );
    // Different domain ⇒ different digest ⇒ different recovered signer.
    expect(digestSigner).not.toBe(digestReal);

    const res = ingestReceivedClaims({
      claims: [liveClaim()],
      ...base,
      swapVerifyingContracts: { [LIVE.chain]: LIVE.tokenNetwork },
      store,
    });
    expect(res.verified).toHaveLength(0);
    expect(res.rejected[0]!.code).toBe('SIGNER_MISMATCH');
    expect(res.rejected[0]!.message).toContain(LIVE.wrongRecoveredUnderLegA);
    expect(store.list()).toHaveLength(0);
  });

  it('[P1] pin-on-first-use: once the channel verified under one contract, a later claim may not rotate it', () => {
    ingestReceivedClaims({
      claims: [liveClaim()],
      ...base,
      swapVerifyingContracts: { [LIVE.chain]: LIVE.rollingSwapChannel },
      store,
    });
    expect(store.load(LIVE.chain, LIVE.channelId)!.verifyingContract).toBe(
      LIVE.rollingSwapChannel
    );

    // The maker re-announces a DIFFERENT RollingSwapChannel mid-stream.
    const next = liveClaim();
    next.nonce = '7';
    next.cumulativeAmount = '5002000';
    const res = ingestReceivedClaims({
      claims: [next],
      ...base,
      swapVerifyingContracts: { [LIVE.chain]: '0x' + '77'.repeat(20) },
      store,
    });
    expect(res.verified).toHaveLength(0);
    expect(res.rejected[0]!.code).toBe('MISSING_SWAP_VERIFYING_CONTRACT');
    expect(res.rejected[0]!.message).toContain('may not rotate it mid-stream');
    // Watermark untouched.
    expect(store.load(LIVE.chain, LIVE.channelId)!.nonce).toBe(6n);
  });
});

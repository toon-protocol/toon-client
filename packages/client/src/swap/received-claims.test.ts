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
/** tokenNetworks map the receive path needs to reconstruct the v2 domain. */
const EVM_TOKEN_NETWORKS = { [EVM_CHAIN]: EVM_CONTRACT };
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
    tokenNetworks: EVM_TOKEN_NETWORKS,
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
      tokenNetworks: EVM_TOKEN_NETWORKS,
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

  it('rejects an EVM claim when the v2 domain config is missing (MISSING_CHAIN_CONFIG, fail-closed)', async () => {
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
      // no tokenNetworks → cannot reconstruct the EIP-712 domain
      store,
    });
    expect(res.rejected[0]!.code).toBe('MISSING_CHAIN_CONFIG');
    expect(res.verified).toHaveLength(0);
    expect(store.list()).toHaveLength(0);
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
      tokenNetworks: {
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

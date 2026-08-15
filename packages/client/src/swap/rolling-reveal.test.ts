/**
 * Rolling-swap leg-B verify-before-reveal tests (toon-client#573).
 *
 * Fixtures are REAL signed EVM balance proofs (same shape as
 * `atomic-reveal.test.ts`), so `handleRollingAdvance` exercises the genuine
 * `ingestReceivedClaims` verification ladder — not a stubbed verifier. This
 * is the live wiring `atomic-reveal.ts`'s own module doc calls out as never
 * having been exercised end-to-end before this issue.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes } from '@toon-protocol/core';
import { evmClaimDigest } from './evm-claim-digest.js';
import { InMemoryReceivedClaimStore } from '../channel/ReceivedClaimStore.js';
import { mintExecutionCondition } from '../utils/condition.js';
import { InMemoryPreimageRetentionStore } from './preimage-retention.js';
import { toBase64, encodeUtf8 } from '../utils/binary.js';
import { ROLLING_PROTOCOL } from './rolling-protocol.js';
import {
  handleRollingAdvance,
  RollingAdvanceRejectedError,
  type RollingAdvanceContext,
} from './rolling-reveal.js';

const SIGNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const OTHER_SIGNER = privateKeyToAccount(
  '0x8975a7907e8f3b5db9d6ae3d44d16adaa3db1401b7a9fdfd433278077178bdc8'
);
const RECIPIENT = '0x' + 'aa'.repeat(20);
const CHANNEL = '0x' + '11'.repeat(32);
const EVM_CHAIN = 'evm:anvil:31337';
const EVM_CHAIN_ID = 31337;
const EVM_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
const STREAM_NONCE = '6e'.repeat(16);
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: EVM_CHAIN },
  rate: '0.5',
};

async function signedAdvanceBytes(opts: {
  seq: number;
  nonce: string;
  cumulativeAmount: string;
  targetAmount: string;
  signer?: typeof SIGNER;
}): Promise<Uint8Array> {
  const digest = evmClaimDigest(
    { chainId: EVM_CHAIN_ID, verifyingContract: EVM_CONTRACT },
    {
      channelId: CHANNEL,
      cumulativeAmount: BigInt(opts.cumulativeAmount),
      nonce: BigInt(opts.nonce),
      recipient: RECIPIENT,
    }
  );
  const sig = await (opts.signer ?? SIGNER).sign({ hash: digest });
  return encodeUtf8(
    JSON.stringify({
      proto: ROLLING_PROTOCOL,
      type: 'advance',
      streamNonce: STREAM_NONCE,
      seq: opts.seq,
      claim: toBase64(hexToBytes(sig)),
      channelId: CHANNEL,
      nonce: opts.nonce,
      cumulativeAmount: opts.cumulativeAmount,
      recipient: RECIPIENT,
      swapSignerAddress: SIGNER.address.toLowerCase(),
      rate: '0.5',
      rateTimestamp: 1_700_000_000_000,
      sourceAmount: '2000000',
      targetAmount: opts.targetAmount,
    })
  );
}

describe('handleRollingAdvance (#573)', () => {
  let store: InMemoryReceivedClaimStore;
  let preimages: InMemoryPreimageRetentionStore;
  let ctx: RollingAdvanceContext;

  beforeEach(() => {
    store = new InMemoryReceivedClaimStore();
    preimages = new InMemoryPreimageRetentionStore();
    ctx = {
      pair: PAIR,
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT,
      tokenNetworks: { [EVM_CHAIN]: EVM_CONTRACT },
      store,
      preimages,
    };
  });

  it('verified + preimage retained: reveals the retained preimage and advances the watermark', async () => {
    const { preimage, condition } = mintExecutionCondition();
    preimages.retain({ packetIndex: 0, preimage, condition, retainedAt: 1 });

    const bytes = await signedAdvanceBytes({
      seq: 1,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
    });
    const outcome = await handleRollingAdvance(bytes, ctx);

    expect(outcome.fulfillment).toEqual(preimage);
    expect(outcome.watermarkAdvance).toBe(1000000n);
    expect(outcome.claim.channelId).toBe(CHANNEL);
    expect(store.load(EVM_CHAIN, CHANNEL)?.nonce).toBe(1n);
    // Single-use: the preimage is consumed, not reusable for the next seq.
    expect(preimages.get(0)).toBeUndefined();
  });

  it("the CRUX (R5/R8): a claim that FAILS verification is never revealed, and never persisted", async () => {
    const { preimage, condition } = mintExecutionCondition();
    preimages.retain({ packetIndex: 0, preimage, condition, retainedAt: 1 });

    // Signed by the wrong key — SIGNER_MISMATCH.
    const bytes = await signedAdvanceBytes({
      seq: 1,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
      signer: OTHER_SIGNER,
    });

    await expect(handleRollingAdvance(bytes, ctx)).rejects.toThrow(
      RollingAdvanceRejectedError
    );
    expect(store.load(EVM_CHAIN, CHANNEL)).toBeUndefined();
    // The preimage was never consumed — nothing reveals leg A for this packet.
    expect(preimages.get(0)?.preimage).toEqual(preimage);
  });

  it('verified but NO preimage retained for this seq: withheld, and the watermark advance is rolled back', async () => {
    // No `preimages.retain` call for packetIndex 0 — simulates a packet the
    // sender never actually sent a fill for (or already consumed).
    const bytes = await signedAdvanceBytes({
      seq: 1,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
    });

    await expect(handleRollingAdvance(bytes, ctx)).rejects.toThrow(
      /reveal was withheld/
    );
    // R8: verification persisted the watermark, but withholding must roll it
    // back so the maker's reused nonce for the next legitimate fill is
    // accepted, not falsely rejected as non-monotonic.
    expect(store.load(EVM_CHAIN, CHANNEL)).toBeUndefined();
  });

  it('a mid-stream withheld packet does not block the NEXT packet reusing the maker-rolled-back nonce', async () => {
    const first = mintExecutionCondition();
    preimages.retain({
      packetIndex: 0,
      preimage: first.preimage,
      condition: first.condition,
      retainedAt: 1,
    });
    const badBytes = await signedAdvanceBytes({
      seq: 1,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
      signer: OTHER_SIGNER,
    });
    await expect(handleRollingAdvance(badBytes, ctx)).rejects.toThrow(
      RollingAdvanceRejectedError
    );

    // The maker reuses nonce=1 for the next fill after rolling its own side
    // back — the watermark must accept it, not reject NON_MONOTONIC_NONCE.
    const second = mintExecutionCondition();
    preimages.retain({
      packetIndex: 1,
      preimage: second.preimage,
      condition: second.condition,
      retainedAt: 2,
    });
    const goodBytes = await signedAdvanceBytes({
      seq: 2,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
    });
    const outcome = await handleRollingAdvance(goodBytes, ctx);
    expect(outcome.fulfillment).toEqual(second.preimage);
    expect(store.load(EVM_CHAIN, CHANNEL)?.nonce).toBe(1n);
  });

  it('malformed / non-rolling data rejects before any verification', async () => {
    await expect(
      handleRollingAdvance(encodeUtf8('not json'), ctx)
    ).rejects.toThrow(/malformed or non-rolling/);
  });
});

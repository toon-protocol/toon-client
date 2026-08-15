/**
 * RollingSwapSessionRegistry tests (toon-client#573) — the daemon's
 * `jobHandler` router for inbound rolling-swap leg-B advances.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import {
  evmClaimDigest,
  InMemoryReceivedClaimStore,
  InMemoryPreimageRetentionStore,
  mintExecutionCondition,
} from '@toon-protocol/client';
import { hexToBytes } from '@toon-protocol/core';
import { RollingSwapSessionRegistry } from './rolling-swap-sessions.js';

const SIGNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
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

async function advanceBytes(opts: {
  seq: number;
  nonce: string;
  cumulativeAmount: string;
  targetAmount: string;
  streamNonce?: string;
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
  const sig = await SIGNER.sign({ hash: digest });
  return new TextEncoder().encode(
    JSON.stringify({
      proto: 'rolling/1',
      type: 'advance',
      streamNonce: opts.streamNonce ?? STREAM_NONCE,
      seq: opts.seq,
      claim: Buffer.from(hexToBytes(sig)).toString('base64'),
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

describe('RollingSwapSessionRegistry (#573)', () => {
  let registry: RollingSwapSessionRegistry;
  let store: InMemoryReceivedClaimStore;
  let preimages: InMemoryPreimageRetentionStore;

  beforeEach(() => {
    registry = new RollingSwapSessionRegistry();
    store = new InMemoryReceivedClaimStore();
    preimages = new InMemoryPreimageRetentionStore();
  });

  it('rejects a job that is not a rolling advance payload at all', async () => {
    await expect(
      registry.jobHandler({
        amount: 1n,
        destination: 'g.toon.client',
        executionCondition: new Uint8Array(32),
        expiresAt: new Date(Date.now() + 30_000),
        data: new TextEncoder().encode('not rolling traffic'),
      })
    ).rejects.toThrow(/not a rolling-swap leg-B advance/);
  });

  it('rejects a well-formed advance for a streamNonce with no registered session', async () => {
    const bytes = await advanceBytes({
      seq: 1,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
    });
    await expect(
      registry.jobHandler({
        amount: 1n,
        destination: 'g.toon.client',
        executionCondition: new Uint8Array(32),
        expiresAt: new Date(Date.now() + 30_000),
        data: bytes,
      })
    ).rejects.toThrow(/unknown or inactive rolling-swap session/);
  });

  it('routes a matching advance to its registered session, recording the outcome', async () => {
    const { preimage, condition } = mintExecutionCondition();
    preimages.retain({ packetIndex: 0, preimage, condition, retainedAt: 1 });
    const session = registry.register(STREAM_NONCE, {
      pair: PAIR,
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT,
      tokenNetworks: { [EVM_CHAIN]: EVM_CONTRACT },
      store,
      preimages,
    });

    const bytes = await advanceBytes({
      seq: 1,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
    });
    const answer = await registry.jobHandler({
      amount: 1n,
      destination: 'g.toon.client',
      executionCondition: condition,
      expiresAt: new Date(Date.now() + 30_000),
      data: bytes,
    });

    expect(answer.fulfillment).toEqual(preimage);
    expect(session.outcomes.get(1)?.watermarkAdvance).toBe(1000000n);
    expect(session.rejections.size).toBe(0);
  });

  it('records a REJECTION on the session (and rethrows) when leg-B verification fails', async () => {
    const session = registry.register(STREAM_NONCE, {
      pair: PAIR,
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT,
      tokenNetworks: { [EVM_CHAIN]: EVM_CONTRACT },
      store,
      preimages, // no preimage retained for seq 1 -> withheld
    });

    const bytes = await advanceBytes({
      seq: 1,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
    });
    await expect(
      registry.jobHandler({
        amount: 1n,
        destination: 'g.toon.client',
        executionCondition: new Uint8Array(32),
        expiresAt: new Date(Date.now() + 30_000),
        data: bytes,
      })
    ).rejects.toThrow();

    expect(session.outcomes.size).toBe(0);
    expect(session.rejections.get(1)).toBeDefined();
  });

  it('unregister() stops routing to a session — a late advance is now unknown-session', async () => {
    registry.register(STREAM_NONCE, {
      pair: PAIR,
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT,
      tokenNetworks: { [EVM_CHAIN]: EVM_CONTRACT },
      store,
      preimages,
    });
    registry.unregister(STREAM_NONCE);

    const bytes = await advanceBytes({
      seq: 1,
      nonce: '1',
      cumulativeAmount: '1000000',
      targetAmount: '1000000',
    });
    await expect(
      registry.jobHandler({
        amount: 1n,
        destination: 'g.toon.client',
        executionCondition: new Uint8Array(32),
        expiresAt: new Date(Date.now() + 30_000),
        data: bytes,
      })
    ).rejects.toThrow(/unknown or inactive rolling-swap session/);
  });

  it('register() throws when a streamNonce is already active', () => {
    registry.register(STREAM_NONCE, {
      pair: PAIR,
      expectedChain: EVM_CHAIN,
      chainRecipient: RECIPIENT,
      store,
      preimages,
    });
    expect(() =>
      registry.register(STREAM_NONCE, {
        pair: PAIR,
        expectedChain: EVM_CHAIN,
        chainRecipient: RECIPIENT,
        store,
        preimages,
      })
    ).toThrow(/already active/);
  });
});

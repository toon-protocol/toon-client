/**
 * Atomic verify -> persist -> reveal composition tests (toon-client#360).
 *
 * Fixtures are REAL signed EVM balance proofs (same shape as
 * `received-claims.test.ts`) so the underlying `ingestReceivedClaims`
 * verification ladder runs for real — these tests exercise the reveal/rollback
 * layer on top of genuine verification, not a stubbed verifier.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateKeyToAccount } from 'viem/accounts';
import { hexToBytes } from '@toon-protocol/core';
import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';
import { evmClaimDigest } from './evm-claim-digest.js';
import {
  InMemoryReceivedClaimStore,
  JsonFileReceivedClaimStore,
  type ReceivedClaimEntry,
  type ReceivedClaimStore,
} from '../channel/ReceivedClaimStore.js';
import { mintExecutionCondition } from '../utils/condition.js';
import {
  InMemoryPreimageRetentionStore,
  type RetainedPreimage,
} from './preimage-retention.js';
import { ingestAndReveal, type RevealFn } from './atomic-reveal.js';

const SIGNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const RECIPIENT = '0x' + 'aa'.repeat(20);
const CHANNEL = '0x' + '11'.repeat(32);
const EVM_CHAIN = 'evm:anvil:31337';
const EVM_CHAIN_ID = 31337;
const EVM_CONTRACT = '0x5FbDB2315678afecb367f032d93F642f64180aa3';
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
  recipient?: string;
}): Promise<AccumulatedClaim> {
  const recipient = opts.recipient ?? RECIPIENT;
  const digest = evmClaimDigest(
    { chainId: EVM_CHAIN_ID, verifyingContract: EVM_CONTRACT },
    {
      channelId: CHANNEL,
      cumulativeAmount: BigInt(opts.cumulativeAmount),
      nonce: BigInt(opts.nonce),
      recipient,
    }
  );
  const sig = await SIGNER.sign({ hash: digest });
  return {
    packetIndex: opts.packetIndex ?? 0,
    sourceAmount: opts.targetAmount,
    targetAmount: opts.targetAmount,
    claimBytes: hexToBytes(sig),
    swapEphemeralPubkey: 'ab'.repeat(32),
    pair: EVM_PAIR,
    receivedAt: 42,
    channelId: CHANNEL,
    nonce: opts.nonce,
    cumulativeAmount: opts.cumulativeAmount,
    recipient,
    swapSignerAddress: SIGNER.address.toLowerCase(),
  };
}

/** A legacy claim missing settlement metadata (pre-rename peer path, #349). */
function legacyClaim(): AccumulatedClaim {
  return {
    packetIndex: 0,
    sourceAmount: 100n,
    targetAmount: 100n,
    claimBytes: new Uint8Array([1, 2, 3]),
    swapEphemeralPubkey: 'ab'.repeat(32),
    pair: EVM_PAIR,
    receivedAt: 42,
    // no channelId / nonce / cumulativeAmount / recipient / swapSignerAddress
  };
}

/** Store wrapper counting durable mutations — asserts "persists exactly once". */
class CountingStore implements ReceivedClaimStore {
  saves = 0;
  deletes = 0;
  constructor(private readonly inner: ReceivedClaimStore) {}
  save(e: ReceivedClaimEntry): void {
    this.saves += 1;
    this.inner.save(e);
  }
  load(chain: string, channelId: string): ReceivedClaimEntry | undefined {
    return this.inner.load(chain, channelId);
  }
  list(): ReceivedClaimEntry[] {
    return this.inner.list();
  }
  delete(chain: string, channelId: string): void {
    this.deletes += 1;
    this.inner.delete(chain, channelId);
  }
}

function retained(packetIndex: number): RetainedPreimage {
  const { preimage, condition } = mintExecutionCondition();
  return { packetIndex, preimage, condition, retainedAt: 1000 };
}

const base = {
  expectedChain: EVM_CHAIN,
  chainRecipient: RECIPIENT,
  tokenNetworks: EVM_TOKEN_NETWORKS,
};
const reveal: RevealFn = () => ({ decision: 'revealed' });
const withhold: RevealFn = () => ({
  decision: 'withheld',
  reason: 'test-withhold',
});

describe('ingestAndReveal (#360)', () => {
  let store: InMemoryReceivedClaimStore;

  beforeEach(() => {
    store = new InMemoryReceivedClaimStore();
  });

  it('verify -> reveal success: persists the watermark exactly once, counts value', async () => {
    const counting = new CountingStore(store);
    const claim = await evmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
    });

    const res = await ingestAndReveal({
      ...base,
      claims: [claim],
      store: counting,
      reveal,
    });

    expect(res.revealed).toHaveLength(1);
    expect(res.rolledBack).toHaveLength(0);
    expect(res.valueRevealed).toBe(999n);
    expect(counting.saves).toBe(1); // persisted exactly once
    expect(counting.deletes).toBe(0);
    expect(store.load(EVM_CHAIN, CHANNEL)?.nonce).toBe(1n);
  });

  it('the CRUX (R8): verify -> WITHHOLD rolls the watermark back so a reused-nonce re-fill is ACCEPTED', async () => {
    // Packet 0 verifies and persists nonce=1, then the sender withholds the
    // reveal (leg B never commits). The maker rolls its side back and REUSES
    // nonce=1 for the next legitimate fill.
    const first = await evmClaim({
      nonce: '1',
      cumulativeAmount: '500',
      targetAmount: 500n,
      packetIndex: 0,
    });
    const withheld = await ingestAndReveal({
      ...base,
      claims: [first],
      store,
      reveal: withhold,
    });
    expect(withheld.revealed).toHaveLength(0);
    expect(withheld.rolledBack).toHaveLength(1);
    expect(withheld.rolledBack[0].reason).toBe('test-withhold');
    // Watermark was rolled back to nothing — the withheld packet left no trace.
    expect(store.load(EVM_CHAIN, CHANNEL)).toBeUndefined();

    // The maker's re-fill reuses nonce=1. Without rollback this would be
    // NON_MONOTONIC_NONCE (1 <= 1); with it, the fill is accepted.
    const refill = await evmClaim({
      nonce: '1',
      cumulativeAmount: '500',
      targetAmount: 500n,
      packetIndex: 1,
    });
    const accepted = await ingestAndReveal({
      ...base,
      claims: [refill],
      store,
      reveal,
    });
    expect(accepted.rejected).toHaveLength(0);
    expect(accepted.rolledBack).toHaveLength(0);
    expect(accepted.revealed).toHaveLength(1);
    expect(accepted.valueRevealed).toBe(500n);
    expect(store.load(EVM_CHAIN, CHANNEL)?.nonce).toBe(1n);
  });

  it('rollback restores a PRIOR watermark (not just delete) when one existed', async () => {
    // Commit nonce=1, then verify nonce=2 but withhold: the watermark must
    // roll back to nonce=1, not vanish.
    const c1 = await evmClaim({
      nonce: '1',
      cumulativeAmount: '100',
      targetAmount: 100n,
    });
    await ingestAndReveal({ ...base, claims: [c1], store, reveal });
    expect(store.load(EVM_CHAIN, CHANNEL)?.nonce).toBe(1n);

    const c2 = await evmClaim({
      nonce: '2',
      cumulativeAmount: '250',
      targetAmount: 150n,
      packetIndex: 1,
    });
    const res = await ingestAndReveal({
      ...base,
      claims: [c2],
      store,
      reveal: withhold,
    });
    expect(res.rolledBack).toHaveLength(1);
    // Restored to the prior committed watermark, not deleted.
    const wm = store.load(EVM_CHAIN, CHANNEL);
    expect(wm?.nonce).toBe(1n);
    expect(wm?.cumulativeAmount).toBe(100n);
  });

  it('a THROWN reveal is treated as withheld and rolls back', async () => {
    const claim = await evmClaim({
      nonce: '1',
      cumulativeAmount: '500',
      targetAmount: 500n,
    });
    const res = await ingestAndReveal({
      ...base,
      claims: [claim],
      store,
      reveal: () => {
        throw new Error('signer offline');
      },
    });
    expect(res.revealed).toHaveLength(0);
    expect(res.rolledBack).toHaveLength(1);
    expect(res.rolledBack[0].reason).toBe('signer offline');
    expect(store.load(EVM_CHAIN, CHANNEL)).toBeUndefined();
  });

  it('crash/restart between verify and reveal: the rolled-back watermark round-trips durably', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'atomic-reveal-'));
    try {
      const path = join(dir, 'received-claims.json');
      const fileStore = new JsonFileReceivedClaimStore(path);

      // Commit nonce=1 durably.
      const c1 = await evmClaim({
        nonce: '1',
        cumulativeAmount: '100',
        targetAmount: 100n,
      });
      await ingestAndReveal({
        ...base,
        claims: [c1],
        store: fileStore,
        reveal,
      });

      // Verify nonce=2 then withhold — rollback must be DURABLE.
      const c2 = await evmClaim({
        nonce: '2',
        cumulativeAmount: '250',
        targetAmount: 150n,
        packetIndex: 1,
      });
      await ingestAndReveal({
        ...base,
        claims: [c2],
        store: fileStore,
        reveal: withhold,
      });

      // Simulate a restart: a fresh store instance reads the same file.
      const restarted = new JsonFileReceivedClaimStore(path);
      const wm = restarted.load(EVM_CHAIN, CHANNEL);
      expect(wm?.nonce).toBe(1n); // the withheld nonce=2 never survives
      expect(wm?.cumulativeAmount).toBe(100n);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reveal receives the retained preimage for the packetIndex and CONSUMES it', async () => {
    const preimages = new InMemoryPreimageRetentionStore();
    const p0 = retained(0);
    preimages.retain(p0);
    let seen: RetainedPreimage | undefined;

    const claim = await evmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
      packetIndex: 0,
    });
    await ingestAndReveal({
      ...base,
      claims: [claim],
      store,
      preimages,
      reveal: (_c, pre) => {
        seen = pre;
        return { decision: 'revealed' };
      },
    });

    expect(seen?.preimage).toEqual(p0.preimage);
    // Consumed: revealed exactly once, never available to reveal again.
    expect(preimages.get(0)).toBeUndefined();
    expect(preimages.size()).toBe(0);
  });

  it('legacy no-metadata swaps are unchanged: no reveal, no persist', async () => {
    const counting = new CountingStore(store);
    let revealCalled = false;
    const res = await ingestAndReveal({
      ...base,
      claims: [legacyClaim()],
      store: counting,
      reveal: () => {
        revealCalled = true;
        return { decision: 'revealed' };
      },
    });

    expect(res.legacy).toHaveLength(1);
    expect(res.revealed).toHaveLength(0);
    expect(res.rolledBack).toHaveLength(0);
    expect(revealCalled).toBe(false);
    expect(counting.saves).toBe(0);
    expect(counting.deletes).toBe(0);
  });

  it('a hard verification reject never reveals and never touches the watermark', async () => {
    const counting = new CountingStore(store);
    let revealCalled = false;
    // Wrong recipient -> RECIPIENT_MISMATCH before any persist.
    const bad = await evmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
      recipient: '0x' + 'cc'.repeat(20),
    });
    const res = await ingestAndReveal({
      ...base,
      claims: [bad],
      store: counting,
      reveal: () => {
        revealCalled = true;
        return { decision: 'revealed' };
      },
    });

    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].code).toBe('RECIPIENT_MISMATCH');
    expect(revealCalled).toBe(false);
    expect(counting.saves).toBe(0);
    expect(store.load(EVM_CHAIN, CHANNEL)).toBeUndefined();
  });

  it('a mixed batch: reveal packet 0, withhold packet 1 — only the revealed one advances', async () => {
    const c0 = await evmClaim({
      nonce: '1',
      cumulativeAmount: '100',
      targetAmount: 100n,
      packetIndex: 0,
    });
    const c1 = await evmClaim({
      nonce: '2',
      cumulativeAmount: '250',
      targetAmount: 150n,
      packetIndex: 1,
    });
    // Reveal the first, withhold the second.
    const decisions = ['revealed', 'withheld'] as const;
    let i = 0;
    const res = await ingestAndReveal({
      ...base,
      claims: [c0, c1],
      store,
      reveal: () => ({ decision: decisions[i++] }),
    });

    expect(res.revealed.map((r) => r.claim.packetIndex)).toEqual([0]);
    expect(res.rolledBack.map((r) => r.claim.packetIndex)).toEqual([1]);
    expect(res.valueRevealed).toBe(100n);
    // Watermark sits at the committed packet 0, not the withheld packet 1.
    expect(store.load(EVM_CHAIN, CHANNEL)?.nonce).toBe(1n);
  });
});

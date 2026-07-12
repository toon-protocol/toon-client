/**
 * Settlement builder tests (#352): persisted watermark entries → sdk
 * `buildSettlementTx` bundles, with the stored claim RE-VERIFIED at settle
 * time, plus the EVM unsigned-tx decode used by the submission path.
 */
import { describe, it, expect } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { keccak256, stringToBytes } from 'viem';
import { balanceProofHashEvm, hexToBytes } from '@toon-protocol/core';
import {
  buildSwapSettlements,
  decodeEvmSettlementTx,
  entryToAccumulatedClaim,
  parseEvmChainId,
} from './settle-received-claims.js';
import type { ReceivedClaimEntry } from '../channel/ReceivedClaimStore.js';

const SIGNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const RECIPIENT = '0x' + 'aa'.repeat(20);
const CHANNEL = '0x' + '11'.repeat(32);
const CONTRACT = '0x' + '22'.repeat(20);
const CHAIN = 'evm:anvil:31337';
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
  rate: '1.0',
};

async function evmEntry(over: Partial<ReceivedClaimEntry> = {}): Promise<ReceivedClaimEntry> {
  const nonce = over.nonce ?? 3n;
  const cumulativeAmount = over.cumulativeAmount ?? 900n;
  const hash = balanceProofHashEvm(
    hexToBytes(CHANNEL),
    cumulativeAmount,
    nonce,
    hexToBytes(RECIPIENT)
  );
  const sig = await SIGNER.sign({ hash: `0x${Buffer.from(hash).toString('hex')}` });
  return {
    chain: CHAIN,
    channelId: CHANNEL,
    nonce,
    cumulativeAmount,
    recipient: RECIPIENT,
    swapSignerAddress: SIGNER.address.toLowerCase(),
    claimBytes: hexToBytes(sig),
    pair: PAIR,
    receivedAt: 1,
    updatedAt: 2,
    ...over,
  };
}

describe('buildSwapSettlements (#352)', () => {
  it('builds ONE bundle carrying the final watermark, re-verified from the stored claim', async () => {
    const entry = await evmEntry();
    const [build] = buildSwapSettlements({
      entries: [entry],
      tokenNetworks: { [CHAIN]: CONTRACT },
    });
    expect(build!.error).toBeUndefined();
    const bundle = build!.bundle!;
    expect(bundle.chainKind).toBe('evm');
    expect(bundle.channelId).toBe(CHANNEL);
    expect(bundle.nonce).toBe('3');
    expect(bundle.cumulativeAmount).toBe('900');
    expect(bundle.recipient).toBe(RECIPIENT);
    expect(bundle.swapSignerAddress).toBe(SIGNER.address.toLowerCase());

    // The unsigned tx targets the TokenNetwork with updateBalance calldata
    // over the watermark values.
    const { to, data, chainId } = decodeEvmSettlementTx(bundle);
    expect(to).toBe(CONTRACT);
    expect(chainId).toBe(31337);
    const selector = keccak256(
      stringToBytes('updateBalance(bytes32,uint256,uint256,address,bytes)')
    ).slice(0, 10);
    expect(data.startsWith(selector)).toBe(true);
    expect(data).toContain(CHANNEL.slice(2)); // channelId in calldata
  });

  it('REJECTS a tampered stored claim at settle time (defense in depth over the store file)', async () => {
    const entry = await evmEntry();
    // Someone edits received-claims.json to inflate the payout.
    entry.cumulativeAmount = 999999n;
    const [build] = buildSwapSettlements({
      entries: [entry],
      tokenNetworks: { [CHAIN]: CONTRACT },
    });
    expect(build!.bundle).toBeUndefined();
    expect(build!.error?.code).toBe('SIGNER_MISMATCH');
  });

  it('reports missing EVM chain config result-shaped (MISSING_CHAIN_CONFIG)', async () => {
    const [noContract] = buildSwapSettlements({ entries: [await evmEntry()] });
    expect(noContract!.error?.code).toBe('MISSING_CHAIN_CONFIG');

    const badKey = await evmEntry({ chain: 'evm:nochainid' });
    badKey.pair = { ...PAIR, to: { ...PAIR.to, chain: 'evm:nochainid' } };
    const [noId] = buildSwapSettlements({
      entries: [badKey],
      tokenNetworks: { 'evm:nochainid': CONTRACT },
    });
    expect(noId!.error?.code).toBe('MISSING_CHAIN_CONFIG');
  });

  it('one bad channel never blocks another (per-entry isolation)', async () => {
    const good = await evmEntry();
    const bad = await evmEntry({ channelId: '0x' + '33'.repeat(32) });
    bad.claimBytes = new Uint8Array([1, 2, 3]);
    const builds = buildSwapSettlements({
      entries: [bad, good],
      tokenNetworks: { [CHAIN]: CONTRACT },
    });
    expect(builds[0]!.error).toBeDefined();
    expect(builds[1]!.bundle).toBeDefined();
  });

  it('fails CLOSED on mina entries without a mina-signer client', async () => {
    const entry = await evmEntry({ chain: 'mina:devnet', channelId: 'B62channel' });
    entry.pair = { ...PAIR, to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' } };
    entry.recipient = 'B62recipient';
    entry.swapSignerAddress = 'B62signer';
    entry.claimBytes = new TextEncoder().encode('sig');
    const [build] = buildSwapSettlements({ entries: [entry] });
    expect(build!.bundle).toBeUndefined();
    expect(build!.error?.code).toBe('MINA_VERIFICATION_UNSUPPORTED');
  });

  it('entryToAccumulatedClaim carries every settlement-context field', async () => {
    const entry = await evmEntry({ claimId: 'c-3' });
    const claim = entryToAccumulatedClaim(entry);
    expect(claim).toMatchObject({
      channelId: CHANNEL,
      nonce: '3',
      cumulativeAmount: '900',
      recipient: RECIPIENT,
      swapSignerAddress: SIGNER.address.toLowerCase(),
      claimId: 'c-3',
      pair: PAIR,
    });
    expect(claim.claimBytes).toEqual(entry.claimBytes);
  });
});

describe('parseEvmChainId', () => {
  it('parses 3-part and 2-part chain keys', () => {
    expect(parseEvmChainId('evm:anvil:31337')).toBe(31337);
    expect(parseEvmChainId('evm:8453')).toBe(8453);
  });
  it('returns undefined on malformed keys', () => {
    expect(parseEvmChainId('evm')).toBeUndefined();
    expect(parseEvmChainId('evm:base:notanumber')).toBeUndefined();
    expect(parseEvmChainId('evm:base:-5')).toBeUndefined();
  });
});

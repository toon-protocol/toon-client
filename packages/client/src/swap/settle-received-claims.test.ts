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
const CHAIN_ID = 31337n;
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
  rate: '1.0',
};

async function evmEntry(
  over: Partial<ReceivedClaimEntry> = {}
): Promise<ReceivedClaimEntry> {
  const nonce = over.nonce ?? 3n;
  const cumulativeAmount = over.cumulativeAmount ?? 900n;
  // v2 EIP-712 digest (sdk@^3): binds chainId + verifyingContract, so the
  // signature the sdk `buildSettlementTx` re-verifies must be over the same
  // (chainId, TokenNetwork) the settlement targets.
  const hash = balanceProofHashEvm(
    hexToBytes(CHANNEL),
    cumulativeAmount,
    nonce,
    hexToBytes(RECIPIENT),
    CHAIN_ID,
    hexToBytes(CONTRACT)
  );
  const sig = await SIGNER.sign({
    hash: `0x${Buffer.from(hash).toString('hex')}`,
  });
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
      swapVerifyingContracts: { [CHAIN]: CONTRACT },
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
      swapVerifyingContracts: { [CHAIN]: CONTRACT },
    });
    expect(build!.bundle).toBeUndefined();
    expect(build!.error?.code).toBe('SIGNER_MISMATCH');
  });

  it('reports missing EVM chain config result-shaped (MISSING_CHAIN_CONFIG)', async () => {
    const badKey = await evmEntry({ chain: 'evm:nochainid' });
    badKey.pair = { ...PAIR, to: { ...PAIR.to, chain: 'evm:nochainid' } };
    const [noId] = buildSwapSettlements({
      entries: [badKey],
      swapVerifyingContracts: { 'evm:nochainid': CONTRACT },
    });
    expect(noId!.error?.code).toBe('MISSING_CHAIN_CONFIG');
  });

  it('[#583] an EVM entry with no leg-B contract at all fails MISSING_SWAP_VERIFYING_CONTRACT, and the leg-A tokenNetworks map is NEVER substituted', async () => {
    const [noContract] = buildSwapSettlements({ entries: [await evmEntry()] });
    expect(noContract!.error?.code).toBe('MISSING_SWAP_VERIFYING_CONTRACT');
    expect(noContract!.error?.message).toContain('RollingSwapChannel');

    // The leg-A map is present and names a real contract — and is still not
    // used: substituting it is exactly the bug (#583), so this must NOT build.
    const [legAOnly] = buildSwapSettlements({
      entries: [await evmEntry()],
      tokenNetworks: { [CHAIN]: CONTRACT },
    });
    expect(legAOnly!.bundle).toBeUndefined();
    expect(legAOnly!.error?.code).toBe('MISSING_SWAP_VERIFYING_CONTRACT');
  });

  it('one bad channel never blocks another (per-entry isolation)', async () => {
    const good = await evmEntry();
    const bad = await evmEntry({ channelId: '0x' + '33'.repeat(32) });
    bad.claimBytes = new Uint8Array([1, 2, 3]);
    const builds = buildSwapSettlements({
      entries: [bad, good],
      swapVerifyingContracts: { [CHAIN]: CONTRACT },
    });
    expect(builds[0]!.error).toBeDefined();
    expect(builds[1]!.bundle).toBeDefined();
  });

  it('fails CLOSED on mina entries without a mina-signer client', async () => {
    const entry = await evmEntry({
      chain: 'mina:devnet',
      channelId: 'B62channel',
    });
    entry.pair = {
      ...PAIR,
      to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
    };
    entry.recipient = 'B62recipient';
    entry.swapSignerAddress = 'B62signer';
    entry.claimBytes = new TextEncoder().encode('sig');
    const [build] = buildSwapSettlements({ entries: [entry] });
    expect(build!.bundle).toBeUndefined();
    expect(build!.error?.code).toBe('MINA_VERIFICATION_UNSUPPORTED');
  });

  it('prefers the entry-pinned verifyingContract over the config tokenNetworks entry (#572)', async () => {
    // A different maker's deployment than the daemon's default config —
    // pinned at receive-verify time onto the entry itself.
    const otherContract = '0x' + '33'.repeat(20);
    const hash = balanceProofHashEvm(
      hexToBytes(CHANNEL),
      900n,
      3n,
      hexToBytes(RECIPIENT),
      CHAIN_ID,
      hexToBytes(otherContract)
    );
    const sig = await SIGNER.sign({
      hash: `0x${Buffer.from(hash).toString('hex')}`,
    });
    const entry = await evmEntry({
      claimBytes: hexToBytes(sig),
      verifyingContract: otherContract,
    });
    // Config still names the OTHER (default) contract — must not be used.
    const [build] = buildSwapSettlements({
      entries: [entry],
      swapVerifyingContracts: { [CHAIN]: CONTRACT },
    });
    expect(build!.error).toBeUndefined();
    const { to } = decodeEvmSettlementTx(build!.bundle!);
    expect(to).toBe(otherContract);
  });

  it('normalizes a mixed-case pinned/config contract address to lowercase (#572)', async () => {
    const mixedCase = '0x' + 'aB'.repeat(20);
    const hash = balanceProofHashEvm(
      hexToBytes(CHANNEL),
      900n,
      3n,
      hexToBytes(RECIPIENT),
      CHAIN_ID,
      hexToBytes(mixedCase)
    );
    const sig = await SIGNER.sign({
      hash: `0x${Buffer.from(hash).toString('hex')}`,
    });
    const entry = await evmEntry({ claimBytes: hexToBytes(sig) });
    const [build] = buildSwapSettlements({
      entries: [entry],
      swapVerifyingContracts: { [CHAIN]: mixedCase },
    });
    expect(build!.error).toBeUndefined();
    const { to } = decodeEvmSettlementTx(build!.bundle!);
    expect(to).toBe(mixedCase.toLowerCase());
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

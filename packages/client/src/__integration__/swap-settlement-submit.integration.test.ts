/**
 * Integration test (#352): the EVM swap-settlement submission seam against a
 * real loopback JSON-RPC http.Server — no mocked fetch, the full viem
 * transport path. Proves the AC end-to-end shape client-side: N verified
 * received advances redeem as ONE on-chain `updateBalance` close carrying the
 * FINAL watermark, signed by the recipient's account and broadcast as a raw
 * transaction.
 *
 * Runs under the integration config (`vitest.integration.config.ts`); needs
 * no external services (binds an ephemeral loopback port). Real-chain
 * submission stays env-gated in the daemon on `chainRpcUrls[chain]` — this
 * exercises the exact code that runs when that gate is open.
 *
 * ## The v2 EIP-712 domain (#607)
 *
 * This file was written against the v1 raw-keccak balance proof, which bound
 * no chain context: `balanceProofHashEvm(channelId, cumulativeAmount, nonce,
 * recipient)`. `@toon-protocol/core@3.5.0` (`@toon-protocol/settlement-digest`
 * 1.1.0) takes two more arguments — the EIP-712 `chainId` and
 * `verifyingContract` (connector#324 finding #1) — and the 4-argument call
 * threw inside `eip712DomainSeparatorEvm`. The two values are NOT free
 * parameters; each is fixed by what the receive-side verifier and the
 * settlement builder compute for this scenario, and both are asserted below so
 * neither can drift back to "whatever makes it green":
 *
 *  * `chainId` = 31337, which is what `parseEvmChainId` — the same function
 *    `received-claims.ts` and `settle-received-claims.ts` call — reads off the
 *    scenario's own `evm:anvil:31337` chain key. The loopback RPC already
 *    answers `eth_chainId` with `0x7a69` and the broadcast tx is already
 *    asserted to carry `chainId: 31337`, so the digest, the node and the
 *    signed transaction now all agree on one number.
 *  * `verifyingContract` = the maker's **leg-B `RollingSwapChannel`**, this
 *    file's `ROLLING_SWAP_CHANNEL` (the old `CONTRACT` constant, renamed to say
 *    which of the two contracts it is). Post-#583 that is the only contract a
 *    received claim can verify against, and post-#604 it is also the contract
 *    the settlement transaction is addressed `to` — so the one constant plays
 *    both roles here exactly as one address plays both roles in production.
 *    It is emphatically NOT the leg-A `TokenNetwork` this client pays the maker
 *    through; the last test below signs under a leg-A address and asserts the
 *    claim is REJECTED, which is #583's live defect reproduced end to end.
 *
 * The pipeline also moved under this file while it was unrun: EVM ingestion now
 * REQUIRES `swapVerifyingContracts[chain]` (`MISSING_SWAP_VERIFYING_CONTRACT`
 * otherwise) and PINS the contract it verified under onto the persisted
 * watermark, and `buildSwapSettlements`' `tokenNetworks` parameter is accepted
 * and never read. So the settlement contract is threaded here the way
 * production threads it — announce → ingest → pinned watermark → builder — and
 * `tokenNetworks` is not passed at all.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { privateKeyToAccount } from 'viem/accounts';
import { parseTransaction, keccak256, stringToBytes, type Hex } from 'viem';
import { balanceProofHashEvm, hexToBytes } from '@toon-protocol/core';
import { InMemoryReceivedClaimStore } from '../channel/ReceivedClaimStore.js';
import { ingestReceivedClaims } from '../swap/received-claims.js';
import {
  buildSwapSettlements,
  submitEvmSettlement,
} from '../swap/settle-received-claims.js';
import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';

const SWAP_SIGNER = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const RECIPIENT_ACCOUNT = privateKeyToAccount(
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
);
const RECIPIENT = RECIPIENT_ACCOUNT.address.toLowerCase();
const CHANNEL = '0x' + '11'.repeat(32);
/**
 * The maker's leg-B `RollingSwapChannel` — the EIP-712 `verifyingContract` a
 * received claim is signed under (#583) and the contract the settlement
 * `updateBalance` is addressed to (#604).
 */
const ROLLING_SWAP_CHANNEL = '0x' + '22'.repeat(20);
/**
 * The leg-A `TokenNetwork` this client pays the maker THROUGH. Present only to
 * be proved wrong: signing a claim under this domain must be rejected, never
 * silently accepted or fallen back to (#583).
 */
const LEG_A_TOKEN_NETWORK = '0x' + '44'.repeat(20);
const CHAIN = 'evm:anvil:31337';
/** What `parseEvmChainId(CHAIN)` returns — the digest's EIP-712 `chainId`. */
const CHAIN_ID = 31337n;
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
  rate: '1.0',
};

async function signedClaim(
  nonce: string,
  cumulativeAmount: string,
  targetAmount: bigint,
  packetIndex: number,
  /**
   * The EIP-712 `verifyingContract` the maker signs under. Defaults to the
   * leg-B `RollingSwapChannel`, which is the only value the receive-side
   * verifier will accept; overridden only by the #583 negative case.
   */
  verifyingContract: string = ROLLING_SWAP_CHANNEL
): Promise<AccumulatedClaim> {
  // v2, domain-separated: the signature is valid for exactly this
  // (chainId, verifyingContract) pair. Signed with `@toon-protocol/core`'s
  // digest and verified below by the client's OWN `evmClaimDigest`, so this
  // also pins the two implementations byte-identical.
  const hash = balanceProofHashEvm(
    hexToBytes(CHANNEL),
    BigInt(cumulativeAmount),
    BigInt(nonce),
    hexToBytes(RECIPIENT),
    CHAIN_ID,
    hexToBytes(verifyingContract)
  );
  const sig = await SWAP_SIGNER.sign({
    hash: `0x${Buffer.from(hash).toString('hex')}`,
  });
  return {
    packetIndex,
    sourceAmount: targetAmount,
    targetAmount,
    claimBytes: hexToBytes(sig),
    swapEphemeralPubkey: 'ab'.repeat(32),
    pair: PAIR,
    receivedAt: Date.now(),
    channelId: CHANNEL,
    nonce,
    cumulativeAmount,
    recipient: RECIPIENT,
    swapSignerAddress: SWAP_SIGNER.address.toLowerCase(),
  };
}

describe('EVM swap settlement submission over a real JSON-RPC server (integration)', () => {
  let server: Server;
  let rpcUrl: string;
  let sentRawTx: Hex | undefined;
  let txHash: Hex | undefined;
  const rpcCalls: string[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString()) as
          | { id: number; method: string; params?: unknown[] }
          | { id: number; method: string; params?: unknown[] }[];
        const requests = Array.isArray(body) ? body : [body];
        const results = requests.map((r) => {
          rpcCalls.push(r.method);
          return { jsonrpc: '2.0', id: r.id, result: handle(r.method, r.params ?? []) };
        });
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Array.isArray(body) ? results : results[0]));
      });
    });

    function handle(method: string, params: unknown[]): unknown {
      switch (method) {
        case 'eth_chainId':
          return '0x7a69'; // 31337
        case 'eth_blockNumber':
          return '0x10';
        case 'eth_getTransactionCount':
          return '0x5';
        case 'eth_gasPrice':
          return '0x3b9aca00'; // 1 gwei
        case 'eth_estimateGas':
          return '0x186a0'; // 100k
        case 'eth_sendRawTransaction': {
          sentRawTx = params[0] as Hex;
          txHash = keccak256(sentRawTx);
          return txHash;
        }
        case 'eth_getTransactionReceipt':
          return txHash
            ? {
                transactionHash: txHash,
                transactionIndex: '0x0',
                blockHash: '0x' + 'ab'.repeat(32),
                blockNumber: '0x11',
                from: RECIPIENT,
                to: ROLLING_SWAP_CHANNEL,
                cumulativeGasUsed: '0x186a0',
                gasUsed: '0x186a0',
                contractAddress: null,
                logs: [],
                logsBloom: '0x' + '00'.repeat(256),
                status: '0x1',
                effectiveGasPrice: '0x3b9aca00',
                type: '0x0',
              }
            : null;
        default:
          return null;
      }
    }

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    rpcUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
  });

  it('ingest N advances → build one bundle → sign as the recipient → broadcast → receipt', async () => {
    // 1) Three verified received advances fold into one persisted watermark.
    const store = new InMemoryReceivedClaimStore();
    const ingest = ingestReceivedClaims({
      claims: [
        await signedClaim('1', '300', 300n, 0),
        await signedClaim('2', '600', 300n, 1),
        await signedClaim('3', '900', 300n, 2),
      ],
      expectedChain: CHAIN,
      chainRecipient: RECIPIENT,
      expectedSignerAddress: SWAP_SIGNER.address.toLowerCase(),
      // Leg B, sourced in production from the maker's kind:10032
      // `swapVerifyingContracts` announce (swap#134) with daemon config
      // layered on top. REQUIRED for EVM under the v2 digest.
      swapVerifyingContracts: { [CHAIN]: ROLLING_SWAP_CHANNEL },
      store,
    });
    expect(ingest.rejected).toEqual([]);
    expect(ingest.verified).toHaveLength(3);
    expect(ingest.valueReceived).toBe(900n);
    expect(store.list()).toHaveLength(1);
    // The contract the claims verified under is PINNED onto the watermark
    // (#572), which is how the settlement below learns where to send.
    expect(store.list()[0]!.verifyingContract?.toLowerCase()).toBe(
      ROLLING_SWAP_CHANNEL
    );

    // 2) One settlement bundle with the FINAL watermark. No `tokenNetworks`
    //    and no `swapVerifyingContracts`: the builder reads the entry's own
    //    pinned contract, exactly as it does in the daemon.
    const [build] = buildSwapSettlements({ entries: store.list() });
    expect(build!.error).toBeUndefined();
    const bundle = build!.bundle!;
    expect(bundle.nonce).toBe('3');
    expect(bundle.cumulativeAmount).toBe('900');

    // 3) Submit over the real loopback RPC.
    const result = await submitEvmSettlement(bundle, {
      rpcUrl,
      account: RECIPIENT_ACCOUNT,
      timeoutMs: 10_000,
    });
    expect(result.txHash).toBe(txHash);
    expect(result.status).toBe('success');
    expect(rpcCalls).toContain('eth_sendRawTransaction');

    // 4) The broadcast raw tx is EXACTLY the settlement: recipient-signed, to
    //    the leg-B RollingSwapChannel, updateBalance calldata with the final
    //    watermark.
    const parsed = parseTransaction(sentRawTx!);
    // Addressed to the leg-B RollingSwapChannel — the same contract whose
    // address the claim signature is domain-separated over.
    expect(parsed.to?.toLowerCase()).toBe(ROLLING_SWAP_CHANNEL);
    expect(parsed.chainId).toBe(Number(CHAIN_ID));
    expect(parsed.nonce).toBe(5); // from eth_getTransactionCount
    expect(parsed.gas).toBe(100_000n);
    expect(parsed.gasPrice).toBe(1_000_000_000n);
    const selector = keccak256(
      stringToBytes('updateBalance(bytes32,uint256,uint256,address,bytes)')
    ).slice(0, 10);
    expect(parsed.data!.startsWith(selector)).toBe(true);
    expect(parsed.data).toContain(CHANNEL.slice(2));
    // cumulativeAmount 900 = 0x384, ABI-encoded as a 32-byte word.
    expect(parsed.data).toContain('384');
  });

  // The domain arguments above are load-bearing, not decoration. This is
  // toon-client#583's live devnet defect end to end: a maker's claim signed
  // against its leg-B RollingSwapChannel, verified against the leg-A
  // TokenNetwork, recovers an unrelated address. Nothing may fall back between
  // the two, in either direction, and nothing reaches a broadcast.
  it('refuses a claim whose domain is the leg-A TokenNetwork, and settles nothing (#583)', async () => {
    const store = new InMemoryReceivedClaimStore();
    const ingest = ingestReceivedClaims({
      claims: [await signedClaim('1', '300', 300n, 0, LEG_A_TOKEN_NETWORK)],
      expectedChain: CHAIN,
      chainRecipient: RECIPIENT,
      expectedSignerAddress: SWAP_SIGNER.address.toLowerCase(),
      swapVerifyingContracts: { [CHAIN]: ROLLING_SWAP_CHANNEL },
      store,
    });
    expect(ingest.verified).toEqual([]);
    expect(ingest.valueReceived).toBe(0n);
    expect(ingest.rejected).toHaveLength(1);
    expect(ingest.rejected[0]!.code).toBe('SIGNER_MISMATCH');
    // Nothing verified, so nothing is persisted and nothing can be settled —
    // the failure is fail-closed at receipt, not at broadcast.
    expect(store.list()).toEqual([]);
    expect(buildSwapSettlements({ entries: store.list() })).toEqual([]);
  });

  // A chain with no known leg-B contract is rejected rather than settled
  // against a guess — the whole reason the two arguments are REQUIRED.
  it('refuses an EVM claim when no leg-B verifying contract is known', async () => {
    const store = new InMemoryReceivedClaimStore();
    const ingest = ingestReceivedClaims({
      claims: [await signedClaim('1', '300', 300n, 0)],
      expectedChain: CHAIN,
      chainRecipient: RECIPIENT,
      expectedSignerAddress: SWAP_SIGNER.address.toLowerCase(),
      store,
    });
    expect(ingest.verified).toEqual([]);
    expect(ingest.rejected[0]!.code).toBe('MISSING_SWAP_VERIFYING_CONTRACT');
    expect(store.list()).toEqual([]);
  });
});

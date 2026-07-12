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
const CONTRACT = '0x' + '22'.repeat(20);
const CHAIN = 'evm:anvil:31337';
const PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: CHAIN },
  rate: '1.0',
};

async function signedClaim(
  nonce: string,
  cumulativeAmount: string,
  targetAmount: bigint,
  packetIndex: number
): Promise<AccumulatedClaim> {
  const hash = balanceProofHashEvm(
    hexToBytes(CHANNEL),
    BigInt(cumulativeAmount),
    BigInt(nonce),
    hexToBytes(RECIPIENT)
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
                to: CONTRACT,
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
      store,
    });
    expect(ingest.verified).toHaveLength(3);
    expect(ingest.valueReceived).toBe(900n);
    expect(store.list()).toHaveLength(1);

    // 2) One settlement bundle with the FINAL watermark.
    const [build] = buildSwapSettlements({
      entries: store.list(),
      tokenNetworks: { [CHAIN]: CONTRACT },
    });
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

    // 4) The broadcast raw tx is EXACTLY the settlement: recipient-signed,
    //    to the TokenNetwork, updateBalance calldata with the final watermark.
    const parsed = parseTransaction(sentRawTx!);
    expect(parsed.to?.toLowerCase()).toBe(CONTRACT);
    expect(parsed.chainId).toBe(31337);
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
});

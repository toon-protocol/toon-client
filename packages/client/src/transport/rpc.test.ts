/**
 * ADR 0002, tested the only way it can honestly be tested: from the outside.
 *
 * The claim under test is not "some function received a dispatcher" — it is that
 * a chain RPC call **arrives at the proxy**, and that one which is supposed to
 * stay off the proxy **does not**. So every test here points the chain at a
 * `.anyone` name that public DNS cannot resolve and a fake SOCKS5 proxy that is
 * the only route to the node behind it. A call that succeeds went through the
 * proxy; there is no other way it could have. A call that was meant to bypass the
 * proxy leaves the proxy's request log untouched, and fails in the resolver — the
 * same log an observer would be reading.
 *
 * Everything is loopback: no network, no daemon, no chain.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { encodeAbiParameters, http as viemHttp, toFunctionSelector } from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import { rpcFetch, rpcTransport } from './rpc.js';
import { startFakeSocks5, type FakeSocks5Server } from './fake-socks5.js';
import { createHiddenServiceTransport, type HiddenServiceTransport } from './socks.js';
import { TokenNetworkClient } from '../channel/evm/TokenNetworkClient.js';
import { EvmSigner } from '../signing/evm-signer.js';
import {
  readEvmNativeBalance,
  readEvmTokenBalance,
  readWalletBalances,
} from '../wallet/balances.js';
import { sendTransfer } from '../wallet/transfer.js';
import { getLamports } from '../channel/solana/payment-channel.js';
import { base58Encode } from '../utils/base58.js';
import { ToonClient } from '../client/ToonClient.js';

/**
 * A hidden-service name with no clearnet existence. Nothing in this file can
 * succeed by accident through the operating system's resolver.
 */
const HS_HOST = 'qrstuvwxyz234567abcdefghijklmnop.anyone';
const RPC_URL = `http://${HS_HOST}/rpc`;
const MNEMONIC = 'test test test test test test test test test test test junk';

const CHAIN_KEY = 'evm:hidden:84532';
const SIGNER_KEY = `0x${'11'.repeat(32)}` as const;
const DEST = '0x2222222222222222222222222222222222222222';
const TOKEN = '0x3333333333333333333333333333333333333333';
const REGISTRY = '0x4444444444444444444444444444444444444444';
const TOKEN_NETWORK = '0x5555555555555555555555555555555555555555';
const TX_HASH = `0x${'ab'.repeat(32)}`;
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const WEI = 1_000_000_000_000_000n;

/** A Solana keypair with no funds anywhere — only this fake node answers for it. */
const SOL_SEED = new Uint8Array(32).fill(7);
const SOL_PUBKEY = base58Encode(new Uint8Array(ed25519.getPublicKey(SOL_SEED)));
const SOL_DEST = base58Encode(new Uint8Array(32).fill(9));
const LAMPORTS = 1_000_000n;
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(3));
const SOL_SIGNATURE = base58Encode(new Uint8Array(64).fill(5));

const SEL_BALANCE_OF = toFunctionSelector('function balanceOf(address) view returns (uint256)');
const SEL_DECIMALS = toFunctionSelector('function decimals() view returns (uint8)');
const SEL_SYMBOL = toFunctionSelector('function symbol() view returns (string)');
const SEL_GET_TOKEN_NETWORK = toFunctionSelector(
  'function getTokenNetwork(address) view returns (address)'
);

/** Every JSON-RPC method this node was asked for, in order. */
let rpcCalls: string[] = [];
/** Every path the origin served, in order — `/ilp` included. */
let originPaths: string[] = [];
/** Flipped by `eth_sendRawTransaction`, so the destination's balance can rise. */
let evmSent = false;
/** Flipped by Solana `sendTransaction`, for the same reason. */
let solanaSent = false;

function word(value: bigint | string): string {
  const hex = typeof value === 'bigint' ? value.toString(16) : value.replace(/^0x/, '');
  return hex.toLowerCase().padStart(64, '0');
}

function evmResult(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_chainId':
      return '0x14a34';
    case 'eth_blockNumber':
      return '0x10';
    case 'eth_gasPrice':
    case 'eth_maxPriorityFeePerGas':
      return '0x1';
    case 'eth_estimateGas':
      return '0x5208';
    case 'eth_getTransactionCount':
      return '0x0';
    case 'eth_getBlockByNumber':
      return {
        number: '0x10',
        hash: BLOCK_HASH,
        parentHash: BLOCK_HASH,
        timestamp: '0x1',
        baseFeePerGas: '0x1',
        gasLimit: '0x1c9c380',
        gasUsed: '0x0',
        miner: `0x${'00'.repeat(20)}`,
        difficulty: '0x0',
        totalDifficulty: '0x0',
        extraData: '0x',
        logsBloom: `0x${'00'.repeat(256)}`,
        nonce: '0x0000000000000000',
        transactions: [],
        transactionsRoot: BLOCK_HASH,
        stateRoot: BLOCK_HASH,
        receiptsRoot: BLOCK_HASH,
        sha3Uncles: BLOCK_HASH,
        uncles: [],
        size: '0x0',
        mixHash: BLOCK_HASH,
      };
    case 'eth_getBalance': {
      const who = String(params[0] ?? '').toLowerCase();
      if (who === DEST.toLowerCase()) return `0x${(evmSent ? WEI : 0n).toString(16)}`;
      return `0x${(WEI * 1_000n).toString(16)}`;
    }
    case 'eth_sendRawTransaction':
      evmSent = true;
      return TX_HASH;
    case 'eth_getTransactionReceipt':
      return {
        transactionHash: TX_HASH,
        transactionIndex: '0x0',
        blockHash: BLOCK_HASH,
        blockNumber: '0x10',
        from: `0x${'00'.repeat(20)}`,
        to: DEST,
        cumulativeGasUsed: '0x5208',
        gasUsed: '0x5208',
        effectiveGasPrice: '0x1',
        contractAddress: null,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x1',
        type: '0x2',
      };
    case 'eth_call': {
      const data = String((params[0] as { data?: string })?.data ?? '');
      const selector = data.slice(0, 10);
      if (selector === SEL_GET_TOKEN_NETWORK) return `0x${word(TOKEN_NETWORK)}`;
      if (selector === SEL_DECIMALS) return `0x${word(6n)}`;
      if (selector === SEL_SYMBOL) return encodeAbiParameters([{ type: 'string' }], ['TST']);
      if (selector === SEL_BALANCE_OF) return `0x${word(42n)}`;
      return '0x';
    }
    default:
      return null;
  }
}

function solanaResult(method: string, params: unknown[]): unknown {
  const context = { slot: 1 };
  switch (method) {
    case 'getBalance': {
      const who = String(params[0] ?? '');
      if (who === SOL_DEST) return { context, value: Number(solanaSent ? LAMPORTS : 0n) };
      return { context, value: Number(LAMPORTS * 10n) };
    }
    case 'getLatestBlockhash':
      return { context, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 } };
    case 'sendTransaction':
      solanaSent = true;
      return SOL_SIGNATURE;
    case 'getSignatureStatuses':
      return {
        context,
        value: [{ slot: 1, confirmations: 0, err: null, confirmationStatus: 'confirmed' }],
      };
    case 'getTokenAccountsByOwner':
      return { context, value: [] };
    case 'getAccountInfo':
      return { context, value: null };
    default:
      return null;
  }
}

/** The node behind the hidden service: a connector edge and a chain, at one host. */
function startOrigin(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const path = (req.url ?? '/').split('?')[0] ?? '/';
      originPaths.push(path);

      if (path === '/ilp' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(SELF_DESCRIPTION));
        return;
      }

      let payload: unknown;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        payload = {};
      }
      const batch = Array.isArray(payload) ? payload : [payload];
      const answers = batch.map((one) => {
        const call = one as { id?: unknown; method?: string; params?: unknown[] };
        const method = String(call.method ?? '');
        rpcCalls.push(method);
        const result = method.startsWith('eth_')
          ? evmResult(method, call.params ?? [])
          : solanaResult(method, call.params ?? []);
        return { jsonrpc: '2.0', id: call.id ?? 1, result };
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(Array.isArray(payload) ? answers : answers[0]));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({ server, port: (server.address() as AddressInfo).port })
    );
  });
}

/** The minimum a stranger needs to transact, per the self-description spec. */
const SELF_DESCRIPTION = {
  ilpAddresses: ['g.toon.hs'],
  httpEndpoint: `http://${HS_HOST}/ilp`,
  edgeIdentity: { keyId: 'k1', publicKey: `0x04${'11'.repeat(64)}` },
  settlements: [
    {
      kind: 'evm',
      chain: CHAIN_KEY,
      settlementAddress: '0x1111111111111111111111111111111111111111',
      tokenNetworkRegistry: REGISTRY,
      tokenNetwork: TOKEN_NETWORK,
      tokenAddress: TOKEN,
      decimals: 6,
    },
  ],
  routes: [{ prefix: 'g.toon.hs', price: '0' }],
  peerCarriages: [],
};

let origin: http.Server;
let proxy: FakeSocks5Server;
let transport: HiddenServiceTransport;

beforeAll(async () => {
  const started = await startOrigin();
  origin = started.server;
  proxy = await startFakeSocks5(new Map([[HS_HOST, started.port]]));
  transport = createHiddenServiceTransport(proxy.url, { connectTimeoutMs: 5_000 });
});

afterAll(async () => {
  await transport.close();
  await proxy.close();
  await new Promise<void>((resolve) => origin.close(() => resolve()));
});

afterEach(() => {
  rpcCalls = [];
  originPaths = [];
  evmSent = false;
  solanaSent = false;
});

/**
 * Every destination this proxy was ever asked for arrived as a NAME.
 *
 * The log is never reset: undici pools its connections, so a later request may
 * ride a socket an earlier test opened and add no CONNECT of its own. What must
 * hold for every entry is that the client handed the proxy a hostname — a single
 * `ipv4` here would mean it resolved a hidden service locally, which in the real
 * world puts the address in a plaintext DNS query before anything else happens.
 */
function expectOnlyNamesReachedTheProxy(): void {
  expect(proxy.requests.length).toBeGreaterThan(0);
  for (const request of proxy.requests) {
    expect(request).toMatchObject({ host: HS_HOST, kind: 'domain' });
  }
}

describe('EVM chain RPC through the connector’s proxy', () => {
  const signer = new EvmSigner(SIGNER_KEY);

  it('carries a contract read to a node that public DNS cannot find', async () => {
    const client = new TokenNetworkClient({
      chain: CHAIN_KEY,
      rpcUrl: RPC_URL,
      signer,
      rpcDispatcher: transport.dispatcher,
    });

    await expect(client.resolveTokenNetwork(REGISTRY, TOKEN)).resolves.toBe(TOKEN_NETWORK);
    expect(rpcCalls).toContain('eth_call');
    expectOnlyNamesReachedTheProxy();
  });

  it('cannot reach that node at all without the dispatcher', async () => {
    // The negative control. Same client, same URL, no dispatcher: viem falls
    // back to the global `fetch`, which asks the operating system where a
    // `.anyone` host lives and is told nowhere. The proxy sees nothing, and in
    // the real world the address has by then gone out in a plaintext DNS query.
    const client = new TokenNetworkClient({ chain: CHAIN_KEY, rpcUrl: RPC_URL, signer });
    const seen = proxy.requests.length;

    await expect(client.resolveTokenNetwork(REGISTRY, TOKEN)).rejects.toThrow();
    expect(proxy.requests.length).toBe(seen);
    expect(rpcCalls).toEqual([]);
  });

  it('carries the wallet balance reads', async () => {
    const native = await readEvmNativeBalance({
      rpcUrl: RPC_URL,
      chainKey: CHAIN_KEY,
      owner: signer.address,
      rpcDispatcher: transport.dispatcher,
    });
    const token = await readEvmTokenBalance({
      rpcUrl: RPC_URL,
      chainKey: CHAIN_KEY,
      tokenAddress: TOKEN,
      owner: signer.address,
      rpcDispatcher: transport.dispatcher,
    });

    expect(native.amount).toBe((WEI * 1_000n).toString());
    expect(token.amount).toBe('42');
    expect(rpcCalls).toContain('eth_getBalance');
    expectOnlyNamesReachedTheProxy();
  });

  it('carries a write — the signed transaction itself goes to the proxy', async () => {
    const result = await sendTransfer(
      {
        evm: {
          chainKey: CHAIN_KEY,
          rpcUrl: RPC_URL,
          signer,
          rpcDispatcher: transport.dispatcher,
        },
      },
      { chain: 'evm', asset: 'native', to: DEST, amount: WEI, confirmTimeoutMs: 5_000 }
    );

    expect(result.txHash).toBe(TX_HASH);
    // Not merely the reads that precede a send: the send itself.
    expect(rpcCalls).toContain('eth_sendRawTransaction');
    expectOnlyNamesReachedTheProxy();
  });
});

describe('Solana chain RPC through the connector’s proxy', () => {
  it('carries JSON-RPC through the injected fetch', async () => {
    // The Solana shape: no dispatcher, a `fetch`. Passing the target as an
    // object rather than a bare URL is what lets every intermediate function
    // stay ignorant of the proxy.
    await expect(
      getLamports({ url: RPC_URL, fetchImpl: transport.fetch }, SOL_PUBKEY)
    ).resolves.toBe(LAMPORTS * 10n);

    expect(rpcCalls).toEqual(['getBalance']);
    expectOnlyNamesReachedTheProxy();
  });

  it('cannot reach that node on a bare URL', async () => {
    const seen = proxy.requests.length;
    await expect(getLamports(RPC_URL, SOL_PUBKEY)).rejects.toThrow();
    expect(proxy.requests.length).toBe(seen);
    expect(rpcCalls).toEqual([]);
  });

  it('carries the wallet balance reads', async () => {
    const [chain] = await readWalletBalances({
      solana: { rpcUrl: RPC_URL, owner: SOL_PUBKEY, tokenMint: TOKEN },
      fetchImpl: transport.fetch,
    });

    expect(chain?.chain).toBe('solana');
    expect(chain?.unreadable).toBeUndefined();
    expect(rpcCalls).toContain('getBalance');
    expectOnlyNamesReachedTheProxy();
  });

  it('carries a transfer’s reads as well as its send', async () => {
    const result = await sendTransfer(
      {
        solana: { rpcUrl: RPC_URL, rpcFetch: transport.fetch, keypair: SOL_SEED },
      },
      {
        chain: 'solana',
        asset: 'native',
        to: SOL_DEST,
        amount: LAMPORTS,
        confirmTimeoutMs: 5_000,
        confirmPollIntervalMs: 10,
      }
    );

    expect(result.txHash).toBe(SOL_SIGNATURE);
    // Both halves. A transfer whose `sendTransaction` rode the proxy while its
    // balance reads went out on clearnet would still correlate this wallet with
    // this IP, beside the very packet the overlay was carrying.
    expect(rpcCalls).toContain('getBalance');
    expect(rpcCalls).toContain('sendTransaction');
    expectOnlyNamesReachedTheProxy();
  });
});

/** A transport's configuration, minus the closure viem rebuilds every time. */
function settings(transport: { config: Record<string, unknown> }): Record<string, unknown> {
  const { request: _request, ...rest } = transport.config;
  return rest;
}

describe('a clearnet client, unchanged', () => {
  it('builds exactly the viem transport this package built before hidden services', () => {
    const plain = viemHttp(RPC_URL)({});
    const built = rpcTransport(RPC_URL, undefined)({});

    // Everything but the `request` closure, whose identity differs between any
    // two transports viem builds and says nothing about configuration.
    expect(settings(built)).toEqual(settings(plain));
    expect(built.value).toEqual(plain.value);
    // No fetch options at all — not an empty object, not an undefined dispatcher.
    expect(built.value?.fetchOptions).toBeUndefined();
  });

  it('keeps the caller’s options and adds fetchOptions only for a dispatcher', () => {
    const withOpts = viemHttp(RPC_URL, { timeout: 1_234, retryCount: 1 })({});
    const built = rpcTransport(RPC_URL, undefined, { timeout: 1_234, retryCount: 1 })({});
    expect(settings(built)).toEqual(settings(withOpts));

    const proxied = rpcTransport(RPC_URL, transport.dispatcher, { timeout: 1_234 })({});
    expect(
      (proxied.value?.fetchOptions as { dispatcher?: unknown } | undefined)?.dispatcher
    ).toBe(transport.dispatcher);
  });

  it('hands back the very same fetch when there is no dispatcher', () => {
    // Identity, not equivalence: a clearnet client must not acquire a wrapper.
    const injected: typeof fetch = () => Promise.resolve(new Response());
    expect(rpcFetch(undefined, injected)).toBe(injected);
    expect(rpcFetch(undefined)).toBe(globalThis.fetch);
  });
});

describe('one proxy for the client edge and the chain', () => {
  it('sends the self-description and the chain reads down the same proxy', async () => {
    const client = await ToonClient.create({
      connector: `http://${HS_HOST}`,
      mnemonic: MNEMONIC,
      socksProxy: proxy.url,
      rpcUrl: RPC_URL,
      channelStore: ':memory:',
    });

    try {
      const balances = await client.wallet.balances();
      expect(balances.length).toBeGreaterThan(0);
      for (const chain of balances) expect(chain.unreadable).toBeUndefined();

      // One socket log holds both: the connector edge and the chain.
      expect(originPaths).toContain('/ilp');
      expect(originPaths).toContain('/rpc');
      expect(rpcCalls).toContain('eth_getBalance');
      expect(rpcCalls).toContain('getBalance');
      expectOnlyNamesReachedTheProxy();
    } finally {
      await client.close();
    }
  });

  it('leaves the chain off the proxy — and only the chain — when proxyRpc is false', async () => {
    const client = await ToonClient.create({
      connector: `http://${HS_HOST}`,
      mnemonic: MNEMONIC,
      socksProxy: proxy.url,
      proxyRpc: false,
      rpcUrl: RPC_URL,
      channelStore: ':memory:',
    });

    try {
      // The edge still rides it: opting chain RPC out is not opting out of the
      // hidden service.
      await client.describe();
      expect(originPaths).toContain('/ilp');

      const balances = await client.wallet.balances();
      expect(balances.length).toBeGreaterThan(0);
      // Every chain is unreadable, on BOTH chains, because the RPC left the
      // overlay and the operating system cannot resolve a `.anyone` name. The
      // node itself is the witness: it was never asked.
      for (const chain of balances) expect(chain.unreadable).toBeDefined();
      expect(originPaths).not.toContain('/rpc');
      expect(rpcCalls).toEqual([]);
    } finally {
      await client.close();
    }
  });
});

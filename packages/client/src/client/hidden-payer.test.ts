/**
 * A hidden payer: a client that hides ITS OWN address from a clearnet connector
 * and from the public chain RPCs it settles on (TOON_Network#167).
 *
 * This is what a Hidden Provider's directory publisher is. The connector it pays
 * is the public devnet relay and the RPCs are public too. What must not leak is
 * the publisher's host, so every byte the client sends has to leave through the
 * `anon` daemon: the self-description, the paid packet, the BTP socket, and the
 * RPC for every chain it reads from or transacts on.
 *
 * The rig is built so that a leak cannot hide behind a failed DNS lookup. Every
 * URL the client is given names `localhost` at the port of a TRAP: a server
 * that answers nothing and counts every connection it gets. A direct dial would
 * succeed at the TCP level and show up in that count. The fake SOCKS5 proxy
 * maps the name `localhost` to the real node instead, so a request that
 * reached the node went through the proxy, and the proxy's log says which
 * circuit (SOCKS username) it rode.
 *
 * Everything is loopback: no network, no daemon, no chain.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { WebSocketServer } from 'ws';
import { ed25519 } from '@noble/curves/ed25519.js';
import { ToonClient } from './ToonClient.js';
import { InMemoryChannelStore } from '../channel/ChannelStore.js';
import { FakeTerminatingConnector } from '../wire/fake-connector.test-support.js';
import {
  startFakeSocks5,
  type FakeSocks5Server,
} from '../transport/fake-socks5.js';
import { RPC_SOCKS_USERNAMES } from '../transport/socks.js';
import {
  BTPMessageType,
  deserializeIlpPrepare,
  parseBtpMessage,
  serializeBtpMessage,
  serializeIlpFulfill,
  type BTPMessageData,
} from '../btp/protocol.js';
import { fromBase64, toBase64 } from '../utils/binary.js';
import { base58Encode } from '../utils/base58.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
/** The one name every URL uses. Direct, it reaches the trap; proxied, the node. */
const HOST = 'localhost';

const EVM_CHAIN = 'evm:84532';
const SOLANA_CHAIN = 'solana:devnet';
const TOKEN_NETWORK = '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478';
const EVM_TOKEN = '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce';
const SOL_PROGRAM = base58Encode(new Uint8Array(32).fill(11));
const SOL_MINT = base58Encode(new Uint8Array(32).fill(12));
const SOL_COUNTERPARTY = base58Encode(
  new Uint8Array(ed25519.getPublicKey(new Uint8Array(32).fill(13)))
);
const BLOCKHASH = base58Encode(new Uint8Array(32).fill(3));
const SOL_SIGNATURE = base58Encode(new Uint8Array(64).fill(5));
const BLOCK_HASH = `0x${'cd'.repeat(32)}`;

/** Every JSON-RPC method the node was asked for, in order. */
let rpcCalls: string[] = [];
/** WebSocket connections the node accepted on its BTP path. */
let btpConnections = 0;
/** Connections that reached the trap: every one of them is a leak. */
let directDials = 0;

function evmResult(method: string): unknown {
  switch (method) {
    case 'eth_chainId':
      return '0x14a34';
    case 'eth_blockNumber':
      return '0x10';
    case 'eth_getBalance':
      return '0xde0b6b3a7640000';
    case 'eth_call':
      // `balanceOf` / `decimals` / `symbol` all decode from one word well enough
      // for a balance read; the reads are what is under test, not their values.
      return `0x${'0'.repeat(63)}6`;
    case 'eth_getBlockByNumber':
      return {
        number: '0x10',
        hash: BLOCK_HASH,
        timestamp: '0x1',
        baseFeePerGas: '0x1',
      };
    default:
      return null;
  }
}

function solanaResult(method: string): unknown {
  const context = { slot: 1 };
  switch (method) {
    case 'getBalance':
      return { context, value: 5_000_000_000 };
    case 'getTokenAccountBalance':
      return { context, value: { amount: '1000000000', decimals: 6 } };
    case 'getTokenAccountsByOwner':
      return { context, value: [] };
    case 'getAccountInfo':
      return { context, value: null };
    case 'getLatestBlockhash':
      return {
        context,
        value: { blockhash: BLOCKHASH, lastValidBlockHeight: 100 },
      };
    case 'getBlockHeight':
      return 50;
    case 'getMinimumBalanceForRentExemption':
      return 2_039_280;
    case 'sendTransaction':
      return SOL_SIGNATURE;
    case 'getSignatureStatuses':
      return {
        context,
        value: [
          {
            slot: 1,
            confirmations: 0,
            err: null,
            confirmationStatus: 'confirmed',
          },
        ],
      };
    default:
      return null;
  }
}

/** Answers a JSON-RPC body, single or batched, for either chain. */
function answerRpc(body: Buffer): string {
  let payload: unknown;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    payload = {};
  }
  const batch = Array.isArray(payload) ? payload : [payload];
  const answers = batch.map((one) => {
    const call = one as { id?: unknown; method?: string };
    const method = String(call.method ?? '');
    rpcCalls.push(method);
    const result = method.startsWith('eth_')
      ? evmResult(method)
      : solanaResult(method);
    return { jsonrpc: '2.0', id: call.id ?? 1, result };
  });
  return JSON.stringify(Array.isArray(payload) ? answers : answers[0]);
}

let fake: FakeTerminatingConnector;
let node: http.Server;
let wss: WebSocketServer;
let trap: net.Server;
let trapPort: number;
let nodePort: number;
let proxy: FakeSocks5Server;
let connector: string;
let rpcUrl: string;

beforeAll(async () => {
  // The trap first: every URL below is named at ITS port.
  trap = net.createServer((socket) => {
    directDials += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', resolve));
  trapPort = (trap.address() as AddressInfo).port;
  connector = `http://${HOST}:${trapPort}`;
  rpcUrl = `http://${HOST}:${trapPort}/rpc`;

  fake = new FakeTerminatingConnector({ endpoint: connector });
  fake.routePrice = 0n;
  fake.routes = [
    { prefix: 'g.fake.http', price: '0' },
    // The devnet relay's shape: its write route is pinned to BTP.
    { prefix: 'g.fake.btp', price: '0', requiredTransport: 'btp' },
  ];
  fake.ilpAddresses = ['g.fake'];
  fake.describeSettlements = [
    {
      chain: EVM_CHAIN,
      settlementAddress: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      tokenNetworkRegistry: '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1',
      tokenNetwork: TOKEN_NETWORK,
      tokenAddress: EVM_TOKEN,
      decimals: 6,
    },
    {
      chain: SOLANA_CHAIN,
      settlementAddress: SOL_COUNTERPARTY,
      programId: SOL_PROGRAM,
      tokenAddress: SOL_MINT,
      decimals: 6,
    },
  ];

  node = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      if ((req.url ?? '').startsWith('/rpc')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(answerRpc(body));
        return;
      }
      void fake
        .fetch(`${fake.endpoint}${req.url ?? '/'}`, {
          method: req.method ?? 'GET',
          ...(body.length > 0 ? { body: new Uint8Array(body) } : {}),
        })
        .then(async (answer) => {
          res.writeHead(answer.status, Object.fromEntries(answer.headers));
          res.end(Buffer.from(await answer.arrayBuffer()));
        });
    });
  });

  // The BTP carriage, at the path the fake advertises (`ws://<host>/ilp/btp`).
  wss = new WebSocketServer({ server: node, path: '/ilp/btp' });
  wss.on('connection', (socket) => {
    btpConnections += 1;
    socket.on('message', (raw: Buffer) => {
      const message = parseBtpMessage(new Uint8Array(raw));
      if (message.type !== BTPMessageType.MESSAGE) return;
      const data = message.data as BTPMessageData;
      const respond = (payload: BTPMessageData): void =>
        socket.send(
          serializeBtpMessage({
            type: BTPMessageType.RESPONSE,
            requestId: message.requestId,
            data: payload,
          })
        );
      if (data.protocolData.some((entry) => entry.protocolName === 'auth')) {
        respond({ protocolData: [] });
        return;
      }
      if (data.ilpPacket && data.ilpPacket.length > 0) {
        const prepare = deserializeIlpPrepare(data.ilpPacket);
        const fulfilled = fake.fulfill(toBase64(prepare.data));
        respond({
          protocolData: [],
          ilpPacket: serializeIlpFulfill({
            fulfillment: fromBase64(fulfilled.fulfillment),
            data: fromBase64(fulfilled.data),
          }),
        });
      }
    });
  });

  await new Promise<void>((resolve) => node.listen(0, '127.0.0.1', resolve));
  nodePort = (node.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => wss.close(() => resolve()));
  await new Promise<void>((resolve) => node.close(() => resolve()));
  await new Promise<void>((resolve) => trap.close(() => resolve()));
});

beforeEach(async () => {
  rpcCalls = [];
  btpConnections = 0;
  directDials = 0;
  proxy = await startFakeSocks5(new Map([[HOST, nodePort]]));
});

afterEach(async () => {
  await proxy.close();
});

/** A client that hides behind the proxy, paying the clearnet node. */
function hiddenPayer(
  options: { transport?: 'http' | 'btp'; chain?: 'evm' | 'solana' } = {}
) {
  return ToonClient.create({
    connector,
    socksProxy: proxy.url,
    rpcUrl,
    mnemonic: MNEMONIC,
    channelStore: new InMemoryChannelStore(),
    transport: options.transport ?? 'http',
    ...(options.chain ? { chain: options.chain } : {}),
  });
}

/** The circuit (SOCKS username) each CONNECT rode, one entry per CONNECT. */
function circuits(): (string | undefined)[] {
  return proxy.requests.map((request) => request.username);
}

/**
 * Every CONNECT arrived as a NAME, never an address: this process resolved
 * nothing itself. And nothing dialled around the proxy.
 */
function expectEverythingRodeTheProxy(): void {
  expect(proxy.requests.length).toBeGreaterThan(0);
  for (const request of proxy.requests) {
    expect(request).toMatchObject({ host: HOST, kind: 'domain' });
  }
  expect(directDials).toBe(0);
}

describe('a hidden payer paying a clearnet connector', () => {
  it('sends the self-description and a paid packet over HTTP through the proxy', async () => {
    const client = await hiddenPayer();
    try {
      const reply = await client.send('g.fake.http', { body: 'hello' });
      expect(reply.fulfilled).toBe(true);
      expect(fake.destinations).toContain('g.fake.http');
      expectEverythingRodeTheProxy();
      // The client edge rides the daemon's default circuit, not a chain's.
      expect(circuits().every((username) => username === undefined)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it('opens its BTP socket through the proxy too', async () => {
    const client = await hiddenPayer({ transport: 'btp' });
    try {
      const reply = await client.send('g.fake.btp', { body: 'hello' });
      expect(reply.fulfilled).toBe(true);
      expect(btpConnections).toBe(1);
      expectEverythingRodeTheProxy();
    } finally {
      await client.close();
    }
  });

  it('reads both chains through the proxy, each on its own pinned circuit', async () => {
    const client = await hiddenPayer();
    try {
      const balances = await client.wallet.balances();
      expect(balances.map((chain) => chain.chain).sort()).toEqual([
        'evm',
        'solana',
      ]);
      for (const chain of balances) expect(chain.unreadable).toBeUndefined();
      expect(rpcCalls).toContain('eth_getBalance');
      expect(rpcCalls).toContain('getBalance');

      expectEverythingRodeTheProxy();
      const used = new Set(circuits());
      expect(used).toContain(RPC_SOCKS_USERNAMES.evm);
      expect(used).toContain(RPC_SOCKS_USERNAMES.solana);
      // Two chains, two circuits, and neither is the client edge's.
      expect(RPC_SOCKS_USERNAMES.evm).not.toBe(RPC_SOCKS_USERNAMES.solana);
    } finally {
      await client.close();
    }
  });

  it('opens a payment channel through the proxy: the reads, the send and the confirmation', async () => {
    const client = await hiddenPayer({ chain: 'solana' });
    try {
      const state = await client.channel.open();
      expect(state.channelId).toBeTruthy();

      for (const method of [
        'getAccountInfo',
        'getLatestBlockhash',
        'sendTransaction',
        'getSignatureStatuses',
      ]) {
        expect(rpcCalls).toContain(method);
      }
      expectEverythingRodeTheProxy();
      // Every chain call rode Solana's circuit; nothing else rode it.
      const chainConnects = proxy.requests.filter(
        (r) => r.username !== undefined
      );
      expect(chainConnects.length).toBeGreaterThan(0);
      for (const request of chainConnects)
        expect(request.username).toBe(RPC_SOCKS_USERNAMES.solana);
    } finally {
      await client.close();
    }
  });

  it('sends an EVM transaction through the proxy on the EVM circuit', async () => {
    const client = await hiddenPayer({ chain: 'evm' });
    try {
      // The native-coin transfer is the EVM write that needs no contract in the
      // fake chain. It goes through the same dispatcher a channel open does.
      await client.wallet
        .transfer({
          chain: 'evm',
          asset: 'native',
          to: '0x2222222222222222222222222222222222222222',
          amount: 1n,
          confirmTimeoutMs: 1,
        })
        .catch(() => undefined);
      expect(rpcCalls.some((method) => method.startsWith('eth_'))).toBe(true);
      expectEverythingRodeTheProxy();
      const chainConnects = proxy.requests.filter(
        (r) => r.username !== undefined
      );
      expect(chainConnects.length).toBeGreaterThan(0);
      for (const request of chainConnects)
        expect(request.username).toBe(RPC_SOCKS_USERNAMES.evm);
    } finally {
      await client.close();
    }
  });
});

describe('a hidden payer fails closed', () => {
  it('refuses to be built when the proxy is not there, having dialled nothing', async () => {
    await proxy.close();
    await expect(hiddenPayer()).rejects.toThrow(/No SOCKS5 proxy/);
    expect(directDials).toBe(0);
    expect(rpcCalls).toEqual([]);
  });

  it('never falls back to a direct dial when the proxy dies under it', async () => {
    const client = await hiddenPayer({ chain: 'solana' });
    try {
      // Warm every pool first, so the failure below is the proxy's death and
      // not a cold start.
      await client.wallet.balances();
      await proxy.close();
      rpcCalls = [];

      const balances = await client.wallet.balances();
      for (const chain of balances) expect(chain.unreadable).toBeDefined();
      await expect(client.channel.open()).rejects.toThrow();
      // Thrown or returned, the packet did not get anywhere.
      const sent = await client
        .send('g.fake.http', { body: 'hello' })
        .catch((error: unknown) => error);
      expect(
        sent instanceof Error ||
          (sent as { fulfilled?: boolean }).fulfilled === false
      ).toBe(true);

      // The node was never asked, and nothing reached the trap.
      expect(rpcCalls).toEqual([]);
      expect(directDials).toBe(0);
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe('proxyRpc: false beside a clearnet connector', () => {
  it('dials chain RPC directly, and only chain RPC', async () => {
    // The opt-out for a payer whose RPC is its own node on a private address,
    // which no exit could reach. Here the direct dial lands in the trap, which
    // is how the test sees it happen.
    const client = await ToonClient.create({
      connector,
      socksProxy: proxy.url,
      proxyRpc: false,
      rpcUrl,
      mnemonic: MNEMONIC,
      channelStore: new InMemoryChannelStore(),
      transport: 'http',
    });
    try {
      await client.describe();
      expect(directDials).toBe(0);
      await client.wallet.balances();
      expect(directDials).toBeGreaterThan(0);
      expect(circuits().every((username) => username === undefined)).toBe(true);
    } finally {
      await client.close();
    }
  });
});

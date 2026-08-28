/**
 * A hand-written {@link ToonClientLike} for testing the CLI.
 *
 * Every command is written against the interface rather than the class, and this
 * is why: the whole command surface — argument parsing, output shaping, exit
 * codes, the hints a refusal prints — can be exercised with no connector, no
 * chain, no keys and no network, in milliseconds. What the real client does with
 * a packet is the concern of the client's own tests; what the CLI does with a
 * *result* is this file's.
 *
 * Not `*.test.ts`, so the runner does not collect it as a suite.
 */
import type { ConnectorChainSettlementTerms } from '../connector/self-description.js';
import type { NodeSelfDescription } from '../connector/self-description.js';
import type { ChainKind, ChannelTerms } from '../channel/types.js';
import type { WalletChainBalances } from '../wallet/balances.js';
import type { SendTransferParams, SendTransferResult } from '../wallet/transfer.js';
import type { FundWalletResult } from '../wallet/faucet.js';
import type {
  ChannelFacade,
  ChannelState,
  ClaimStateResult,
  OpenChannelOptions,
  SendOptions,
  SendRequest,
  SendResult,
  ToonClientLike,
  ToonIdentity,
  TxRef,
  WalletFacade,
} from '../client/types.js';

/** A Base Sepolia settlement entry, shaped exactly as `GET /ilp` publishes one. */
export const FAKE_SETTLEMENT: ConnectorChainSettlementTerms = {
  kind: 'evm',
  chain: 'evm:84532',
  settlementAddress: '0x1111111111111111111111111111111111111111',
  tokenNetworkRegistry: '0x8263BdD4eB4862395Cb4ef5dA5d637F4b047Eea1',
  tokenNetwork: '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478',
  tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
  decimals: 6,
};

export const FAKE_DESCRIPTION: NodeSelfDescription = {
  ilpAddresses: ['g.toon.ario'],
  httpEndpoint: 'https://node.example/ilp',
  btpEndpoint: 'wss://node.example/ilp/btp',
  peerCarriages: ['http', 'btp'],
  edgeIdentity: { keyId: 'edge-1', publicKey: '0x04abcd' },
  settlements: [FAKE_SETTLEMENT],
  routes: [{ prefix: 'g.toon.ario', price: 1000n }],
  supportedVersions: [1],
  defaultVersion: 1,
  raw: {},
};

export const FAKE_TERMS: ChannelTerms = {
  kind: 'evm',
  chain: 'evm:84532',
  chainId: 84532,
  counterparty: FAKE_SETTLEMENT.settlementAddress,
  token: FAKE_SETTLEMENT.tokenAddress,
  decimals: 6,
  tokenNetwork: FAKE_SETTLEMENT.tokenNetwork,
};

export function fakeChannelState(overrides: Partial<ChannelState> = {}): ChannelState {
  return {
    chain: 'evm',
    channelId: '0xchannel',
    counterparty: FAKE_TERMS.counterparty,
    status: 'open',
    depositTotal: 100_000n,
    spent: 3_000n,
    nonce: 3,
    available: 97_000n,
    domain: FAKE_TERMS,
    ...overrides,
  };
}

/** A FULFILL carrying `hello` from an app that answered 200. */
export function fakeFulfilled(overrides: Partial<SendResult> = {}): SendResult {
  const body = new TextEncoder().encode('hello');
  return {
    fulfilled: true,
    transport: 'http',
    status: 200,
    headers: [['content-type', 'text/plain']],
    body,
    text: () => new TextDecoder().decode(body),
    json: <T>() => JSON.parse(new TextDecoder().decode(body)) as T,
    fulfillment: new Uint8Array(32),
    claim: { channelId: '0xchannel', chain: 'evm', nonce: 4, cumulative: 4_000n, amount: 1_000n },
    ...overrides,
  } as SendResult;
}

/** An underpayment refusal, the commonest one a newcomer meets. */
export function fakeRefused(overrides: Record<string, unknown> = {}): SendResult {
  return {
    fulfilled: false,
    transport: 'http',
    refusedBy: 'path',
    code: 'F03',
    message: 'insufficient payment',
    accumulatedCost: 1_000n,
    ...overrides,
  } as SendResult;
}

/** What a command asked the client to do, in order. */
export interface RecordedCall {
  method: string;
  args: unknown[];
}

export interface FakeClientOptions {
  connector?: string;
  chain?: ChainKind;
  identity?: ToonIdentity;
  description?: NodeSelfDescription;
  price?: bigint | null;
  probe?: { accumulatedCost: bigint; code: string; message: string };
  send?: SendResult | ((destination: string) => SendResult);
  claimState?: ClaimStateResult[];
  channelState?: ChannelState;
  balances?: WalletChainBalances[];
  transfer?: SendTransferResult;
  faucet?: FundWalletResult;
  /** Make any method throw, to exercise the exit-code mapping. */
  throws?: { method: string; error: unknown };
}

export class FakeToonClient implements ToonClientLike {
  readonly calls: RecordedCall[] = [];
  readonly connector: string;
  readonly chain: ChainKind;
  readonly identity: ToonIdentity;
  readonly channel: ChannelFacade;
  readonly wallet: WalletFacade;
  closed = false;

  private readonly options: FakeClientOptions;

  constructor(options: FakeClientOptions = {}) {
    this.options = options;
    this.connector = options.connector ?? 'https://node.example';
    this.chain = options.chain ?? 'evm';
    this.identity = options.identity ?? {
      evmAddress: '0x2222222222222222222222222222222222222222',
      solanaPublicKey: 'So11111111111111111111111111111111111111112',
      senderId: '0x2222222222222222222222222222222222222222',
    };

    const state = options.channelState ?? fakeChannelState();
    this.channel = {
      id: state.channelId,
      open: async (o?: OpenChannelOptions) => this.record('channel.open', [o], state),
      deposit: async (amount: bigint | string) =>
        this.record('channel.deposit', [amount], state),
      close: async () =>
        this.record('channel.close', [], {
          txHash: '0xclose',
          closedAt: 1_700_000_000n,
          settleableAt: 1_700_003_600n,
        } as TxRef & { closedAt?: bigint; settleableAt?: bigint }),
      settle: async () => this.record('channel.settle', [], { txHash: '0xsettle' }),
      state: async (o?: { onChain?: boolean }) => this.record('channel.state', [o], state),
      ensure: async () => this.record('channel.ensure', [], state.channelId),
    };

    this.wallet = {
      balances: async (chain?: ChainKind) =>
        this.record('wallet.balances', [chain], options.balances ?? []),
      transfer: async (params: SendTransferParams) =>
        this.record(
          'wallet.transfer',
          [params],
          options.transfer ?? {
            chain: params.chain,
            asset: params.asset,
            to: params.to,
            amount: String(params.amount),
            txHash: '0xtransfer',
            balanceBefore: '0',
            balanceAfter: String(params.amount),
          }
        ),
      faucet: async (chain?: ChainKind) =>
        this.record(
          'wallet.faucet',
          [chain],
          options.faucet ?? {
            chain: 'evm',
            address: this.identity.evmAddress ?? '',
            response: { ok: true },
          }
        ),
    };
  }

  /** Record a call, honour a configured throw, and return the canned answer. */
  private record<T>(method: string, args: unknown[], result: T): T {
    this.calls.push({ method, args });
    if (this.options.throws?.method === method) throw this.options.throws.error;
    return result;
  }

  /** Every call to `method`, for assertions. */
  callsTo(method: string): RecordedCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async describe(options?: { fresh?: boolean }): Promise<NodeSelfDescription> {
    return this.record('describe', [options], this.options.description ?? FAKE_DESCRIPTION);
  }

  async price(destination: string): Promise<bigint | null> {
    return this.record(
      'price',
      [destination],
      this.options.price === undefined ? 1_000n : this.options.price
    );
  }

  async probe(
    destination: string
  ): Promise<{ accumulatedCost: bigint; code: string; message: string }> {
    return this.record(
      'probe',
      [destination],
      this.options.probe ?? { accumulatedCost: 1_000n, code: 'F03', message: 'probe' }
    );
  }

  async send(
    destination: string,
    request?: SendRequest,
    options?: SendOptions
  ): Promise<SendResult> {
    const canned = this.options.send;
    const result =
      typeof canned === 'function' ? canned(destination) : (canned ?? fakeFulfilled());
    return this.record('send', [destination, request, options], result);
  }

  async claimState(channelIds?: string[]): Promise<ClaimStateResult[]> {
    return this.record(
      'claimState',
      [channelIds],
      this.options.claimState ?? [
        {
          blockchain: 'evm',
          channelId: '0xchannel',
          ok: true,
          depositTotal: '100000',
          cumulativeClaimed: '4000',
          available: '96000',
          nonce: 4,
          lastClaimTime: null,
        },
      ]
    );
  }

  async close(): Promise<void> {
    this.closed = true;
    this.calls.push({ method: 'close', args: [] });
  }
}

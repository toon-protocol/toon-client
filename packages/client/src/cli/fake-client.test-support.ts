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
import type { ConnectorRoutePrice } from '../connector/ConnectorEdgeClient.js';
import type { NodeSelfDescription } from '../connector/self-description.js';
import type { BatchSettlementTerms } from '../channel/batch-settlement/offers.js';
import type { ChainKind } from '../channel/types.js';
import type { WalletChainBalances } from '../wallet/balances.js';
import type { SendTransferParams, SendTransferResult } from '../wallet/transfer.js';
import type { FundWalletResult } from '../wallet/faucet.js';
import type {
  ChannelFacade,
  ChannelState,
  ClaimStateResult,
  SendOptions,
  SendRequest,
  SendResult,
  ToonClientLike,
  ToonIdentity,
  WalletFacade,
} from '../client/types.js';

/** The node's Base Sepolia x402 terms, shaped exactly as `GET /ilp` publishes them. */
export const FAKE_SETTLEMENT: BatchSettlementTerms = {
  chain: 'evm',
  network: 'eip155:84532',
  asset: '0x0C996d7c934c79a6255254875607Fe69df25C0E1',
  payTo: '0x1111111111111111111111111111111111111111',
  extra: {
    receiverAuthorizer: '0x1111111111111111111111111111111111111111',
    withdrawDelay: 86_400,
    name: 'USDC',
    version: '2',
  },
};

export const FAKE_DESCRIPTION: NodeSelfDescription = {
  ilpAddresses: ['g.toon.store'],
  httpEndpoint: 'https://node.example/ilp',
  btpEndpoint: 'wss://node.example/ilp/btp',
  peerCarriages: ['http', 'btp'],
  edgeIdentity: { keyId: 'edge-1', publicKey: '0x04abcd' },
  batchSettlements: [FAKE_SETTLEMENT],
  voucherSigners: [{ network: 'eip155:84532', signer: FAKE_SETTLEMENT.payTo }],
  routes: [{ prefix: 'g.toon.store', price: 1000n }],
  supportedVersions: [1],
  defaultVersion: 1,
  raw: {},
};

export function fakeChannelState(overrides: Partial<ChannelState> = {}): ChannelState {
  return {
    channel: {
      chain: 'evm',
      channelId: '0xchannel',
      network: 'eip155:84532',
      config: {
        payer: '0x2222222222222222222222222222222222222222',
        payerAuthorizer: '0x2222222222222222222222222222222222222222',
        receiver: FAKE_SETTLEMENT.payTo,
        receiverAuthorizer: FAKE_SETTLEMENT.payTo,
        token: FAKE_SETTLEMENT.asset,
        withdrawDelay: 86_400,
        salt: `0x${'00'.repeat(32)}`,
      },
    },
    depositTotal: 100_000n,
    signed: 3_000n,
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
    claim: { channelId: '0xchannel', chain: 'evm', cumulative: 4_000n, amount: 1_000n },
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
  /** The per-KiB rate `routePrice` reports; omitted means a flat-priced route. */
  pricePerKib?: bigint;
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
    const channelId = state.channel.channelId;
    this.channel = {
      channels: () => this.record('channel.channels', [], [state]),
      current: async () => this.record('channel.current', [], state),
      open: async () => this.record('channel.open', [], state),
      deposit: async (amount: bigint) => this.record('channel.deposit', [amount], state),
      close: async () =>
        this.record('channel.close', [], [
          { channelId, transaction: '0xclose', settleableAt: 1_700_003_600n },
        ]),
      settle: async () => this.record('channel.settle', [], [{ channelId, transaction: '0xsettle' }]),
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

  async routePrice(destination: string): Promise<ConnectorRoutePrice | null> {
    const price = this.options.price === undefined ? 1_000n : this.options.price;
    const perKib = this.options.pricePerKib;
    return this.record(
      'routePrice',
      [destination],
      price === null
        ? null
        : {
            destination,
            price,
            ...(perKib !== undefined ? { pricePerKib: perKib } : {}),
          }
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

  get defaultDestination(): string | undefined {
    return (this.options.description ?? FAKE_DESCRIPTION).ilpAddresses[0];
  }

  async send(request?: SendRequest, options?: SendOptions): Promise<SendResult>;
  async send(
    destination: string,
    request?: SendRequest,
    options?: SendOptions
  ): Promise<SendResult>;
  async send(
    destinationOrRequest?: string | SendRequest,
    requestOrOptions?: SendRequest | SendOptions,
    maybeOptions?: SendOptions
  ): Promise<SendResult> {
    const named = typeof destinationOrRequest === 'string';
    const destination = named ? destinationOrRequest : this.defaultDestination;
    const request = (named ? requestOrOptions : destinationOrRequest) as SendRequest | undefined;
    const options = (named ? maybeOptions : requestOrOptions) as SendOptions | undefined;
    const canned = this.options.send;
    const result =
      typeof canned === 'function' ? canned(destination ?? '') : (canned ?? fakeFulfilled());
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
          scheme: 'batch-settlement',
          cumulativeClaimed: '4000',
          maxCumulative: '100000',
          available: '96000',
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

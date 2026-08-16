import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Mock the SDK swap boundary so swap() can be unit-tested without a real swap peer
// (a faithful fake would have to unwrap the gift wrap + encrypt a FULFILL to the
// ephemeral key generated inside swap()).
vi.mock('@toon-protocol/sdk/swap', () => ({ streamSwap: vi.fn() }));
import { streamSwap } from '@toon-protocol/sdk/swap';
// The controller surface (#351) is NOT mocked: the state-persistence tests
// below exercise the real AdaptiveDeltaController + JsonFileSwapControllerStateStore.
import { swapControllerStateKey } from '@toon-protocol/sdk';
import type {
  AdaptiveDeltaController,
  PacketProgress,
} from '@toon-protocol/sdk';
// Mock only the faucet boundary so async fundWallet jobs run without a real
// faucet; every other `@toon-protocol/client` export is preserved.
vi.mock('@toon-protocol/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@toon-protocol/client')>();
  return { ...actual, fundWallet: vi.fn() };
});
import {
  fundWallet as faucetFund,
  evmClaimDigest,
} from '@toon-protocol/client';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  NostrEvent,
  EventTemplate,
  UnsignedEvent,
} from 'nostr-tools/pure';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { unwrapSwapPacketFromToon, wrapSwapPacket } from '@toon-protocol/sdk';
import { privateKeyToAccount } from 'viem/accounts';
import {
  BalancesUnavailableError,
  ClientRunner,
  InvalidPayloadError,
  NotReadyError,
  PublishRejectedError,
  RollingUnavailableError,
  TargetError,
  deriveFloorRate,
  type ToonClientLike,
} from './client-runner.js';
import type { ResolvedDaemonConfig } from './config.js';
import { RelaySubscription } from '../relay-subscription.js';
import {
  ILP_PEER_INFO_KIND,
  hexToBytes,
  type IlpPeerInfo,
} from '@toon-protocol/core';
import { loadTargets, saveApexTarget } from './targets-store.js';

// ── Received-claim fixtures (#352 / v2 #365): REAL secp256k1-signed EVM balance
//    proofs over the **v2 EIP-712 domain-separated** claim digest (connector#324
//    finding #1). The swap peer's signer signs `evmClaimDigest({chainId,
//    verifyingContract}, {channelId, cumulativeAmount, nonce, recipient})` — the
//    same digest the client's receive-side verify (`verifyEvmClaimSignature`)
//    recovers against — and ships the 65-byte r||s||v signature as claimBytes.
//    The digest binds `(chainId, verifyingContract)`, so the receive path needs
//    a matching LEG-B `swapVerifyingContracts` entry — never the leg-A
//    `tokenNetworks` map (#583) — see `EVM_VERIFYING_CONTRACTS`. ─────────────

/** The swap peer's chain-B signer (well-known dev key, never a live secret). */
const SWAP_SIGNER_ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
);
const SWAP_SIGNER = SWAP_SIGNER_ACCOUNT.address.toLowerCase();
/** The sender's payout address on the target chain. */
const EVM_RECIPIENT = '0x' + 'aa'.repeat(20);
const EVM_CHANNEL = '0x' + '11'.repeat(32);
const EVM_PAIR = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
  to: { assetCode: 'USDC', assetScale: 6, chain: 'evm:anvil:31337' },
  rate: '1.0',
};
/** Numeric chain id embedded in `EVM_PAIR.to.chain` — the v2 domain `chainId`. */
const EVM_CHAIN_ID = 31337;
/** The deployed RollingSwapChannel / EIP-712 `verifyingContract` for the target
 *  chain. MUST match the `swapVerifyingContracts` entry the runner is configured
 *  with so a fixture's v2 signature recovers under the receive-path domain. */
const EVM_VERIFYING_CONTRACT = '0x' + '22'.repeat(20);
/** LEG-B `swapVerifyingContracts` map (chain key → RollingSwapChannel) the v2
 *  receive path needs to reconstruct the EIP-712 domain; wired into the daemon
 *  `toonClientConfig`. Deliberately NOT `tokenNetworks` (leg A, #583). */
const EVM_VERIFYING_CONTRACTS = { [EVM_PAIR.to.chain]: EVM_VERIFYING_CONTRACT };
/** The leg-A TokenNetwork the daemon pays the maker THROUGH — a different
 *  contract, and never a valid leg-B verification domain (#583). */
const EVM_TOKEN_NETWORKS = { [EVM_PAIR.to.chain]: '0x' + '44'.repeat(20) };

/** Build a genuinely-signed accumulated EVM claim (v2 EIP-712, sdk wire shape). */
async function signedEvmClaim(opts: {
  nonce: string;
  cumulativeAmount: string;
  targetAmount: bigint;
  sourceAmount?: bigint;
  packetIndex?: number;
  channelId?: string;
  recipient?: string;
  /** Sign over DIFFERENT values than advertised (a tampered claim). */
  signedCumulative?: string;
}) {
  const channelId = opts.channelId ?? EVM_CHANNEL;
  const recipient = opts.recipient ?? EVM_RECIPIENT;
  const digest = evmClaimDigest(
    { chainId: EVM_CHAIN_ID, verifyingContract: EVM_VERIFYING_CONTRACT },
    {
      channelId,
      cumulativeAmount: BigInt(opts.signedCumulative ?? opts.cumulativeAmount),
      nonce: BigInt(opts.nonce),
      recipient,
    }
  );
  const sigHex = await SWAP_SIGNER_ACCOUNT.sign({ hash: digest });
  return {
    packetIndex: opts.packetIndex ?? 0,
    sourceAmount: opts.sourceAmount ?? opts.targetAmount,
    targetAmount: opts.targetAmount,
    claimBytes: hexToBytes(sigHex),
    swapEphemeralPubkey: 'ab'.repeat(32),
    claimId: `claim-${opts.nonce}`,
    channelId,
    recipient,
    swapSignerAddress: SWAP_SIGNER,
    nonce: opts.nonce,
    cumulativeAmount: opts.cumulativeAmount,
    pair: EVM_PAIR,
    receivedAt: 0,
  };
}

/** Wrap accumulated claims into a completed streamSwap result. */
function swapResult(
  claims: unknown[],
  totals?: { source?: bigint; target?: bigint }
) {
  return {
    state: 'completed',
    claims,
    rejections: [],
    errors: [],
    abortReason: 'complete',
    cumulativeSource: totals?.source ?? 1000n,
    cumulativeTarget: totals?.target ?? 999n,
    packetsSent: claims.length,
    packetsScheduled: claims.length,
  } as unknown as Awaited<ReturnType<typeof streamSwap>>;
}

let tmpDir: string;

function makeConfig(
  overrides: Partial<ResolvedDaemonConfig> = {}
): ResolvedDaemonConfig {
  const base = {
    httpPort: 8787,
    relayUrl: 'ws://relay.test',
    hasUplink: true,
    destination: 'g.proxy',
    feePerEvent: 1n,
    chain: 'evm' as const,
    apexChannelStorePath: join(tmpDir, 'apex-channels.json'),
    // The v2 EIP-712 receive path verifies EVM claims against the
    // `(chainId, verifyingContract)` domain, so the daemon must carry a
    // LEG-B `swapVerifyingContracts` entry for the target chain or every EVM
    // claim is rejected MISSING_SWAP_VERIFYING_CONTRACT at ingest. Mirror a
    // configured deployment by default — and carry the leg-A `tokenNetworks`
    // map too, pointing somewhere else, so any accidental fallback to it (the
    // #583 bug) fails these tests loudly instead of passing by coincidence.
    toonClientConfig: {
      btpUrl: 'ws://apex.test/btp',
      tokenNetworks: EVM_TOKEN_NETWORKS,
      swapVerifyingContracts: EVM_VERIFYING_CONTRACTS,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    ...overrides,
  };
  // Mirror resolveConfig: publish/store destinations fall back to `destination`.
  return {
    ...base,
    publishDestination: overrides.publishDestination ?? base.destination,
    storeDestination: overrides.storeDestination ?? base.destination,
  };
}

/** A controllable fake ToonClient with a mutable peerNegotiations map. */
class FakeClient implements ToonClientLike {
  peerNegotiations = new Map<string, unknown>();
  started = false;
  stopped = false;
  /** kind:10032 announces "discovered" for #572's maker-announce tests. */
  discoveredPeerInfo = new Map<string, IlpPeerInfo>();
  getDiscoveredPeerInfo(pubkey: string): IlpPeerInfo | undefined {
    return this.discoveredPeerInfo.get(pubkey);
  }
  /**
   * The maker's announced LEG-B `swapVerifyingContracts`, read off the raw
   * announce content by the real client (core's `parseIlpPeerInfo` drops the
   * field) — hence a separate map here, not a field of `discoveredPeerInfo`.
   */
  announcedSwapVerifyingContracts = new Map<string, Record<string, string>>();
  getSwapVerifyingContracts(
    pubkey: string
  ): Record<string, string> | undefined {
    return this.announcedSwapVerifyingContracts.get(pubkey);
  }
  channels: Record<
    string,
    { nonce: number; cumulative: bigint; depositTotal?: bigint }
  > = {};
  startImpl: () => Promise<void> = async () => {};
  publishImpl: (e: NostrEvent) => Promise<{
    success: boolean;
    eventId?: string;
    data?: string;
    error?: string;
  }> = async (e) => ({ success: true, eventId: e.id });

  async start(): Promise<{ peersDiscovered: number; mode: string }> {
    await this.startImpl();
    this.started = true;
    return { peersDiscovered: 0, mode: 'http' };
  }
  async stop(): Promise<void> {
    this.stopped = true;
  }
  getPublicKey(): string {
    return 'npub-hex';
  }
  /** The address this client's BTP session is bound under (#585). */
  ownIlpAddress: string | undefined = 'g.toon.client';
  getOwnIlpAddress(): string | undefined {
    return this.ownIlpAddress;
  }
  getEvmAddress(): string | undefined {
    return '0xabc';
  }
  getSolanaAddress(): string | undefined {
    return undefined;
  }
  getMinaAddress(): string | undefined {
    return undefined;
  }
  getNetworkStatus():
    | { evm: string; solana: string; mina: string }
    | undefined {
    return { evm: 'configured', solana: 'unconfigured', mina: 'unconfigured' };
  }
  /** Records the destination passed on the last publishEvent call. */
  lastPublishDest?: string;
  async publishEvent(
    event: NostrEvent,
    options?: { destination?: string }
  ): Promise<{
    success: boolean;
    eventId?: string;
    data?: string;
    error?: string;
  }> {
    this.lastPublishDest = options?.destination;
    return this.publishImpl(event);
  }
  async signBalanceProof(channelId: string, amount: bigint): Promise<unknown> {
    const ch = (this.channels[channelId] ??= { nonce: 0, cumulative: 0n });
    ch.nonce += 1;
    ch.cumulative += amount;
    return { channelId, signature: '0xsig' };
  }

  /**
   * The flat route price this fake connector charges for any destination
   * (ADR 0020). `null` would mean it terminates no matching route.
   */
  routePrice: bigint | null = 1000n;
  async getRoutePrice(): Promise<bigint | null> {
    return this.routePrice;
  }
  /** Records the last template signed, and returns a deterministic signed event. */
  lastSigned?: EventTemplate;
  signEvent(template: EventTemplate): NostrEvent {
    this.lastSigned = template;
    return {
      id: `signed-${template.kind}-${template.created_at}`,
      pubkey: this.getPublicKey(),
      sig: '0xsig',
      created_at: template.created_at,
      kind: template.kind,
      tags: template.tags,
      content: template.content,
    };
  }
  unwrapGiftWrap(): never {
    throw new Error('unwrapGiftWrap not exercised by client-runner tests');
  }
  uploadImpl: () => Promise<{
    success: boolean;
    txId?: string;
    eventId?: string;
    error?: string;
  }> = async () => ({ success: true, txId: 'tx-abc', eventId: 'blob-evt' });
  /** Records the destination passed on the last uploadBlob call. */
  lastUploadDest?: string;
  /** Records the blob bytes passed on the last uploadBlob call. */
  lastUploadBytes?: Uint8Array;
  async uploadBlob(params?: {
    destination?: string;
    blobData?: Uint8Array;
  }): Promise<{
    success: boolean;
    txId?: string;
    eventId?: string;
    error?: string;
  }> {
    this.lastUploadDest = params?.destination;
    this.lastUploadBytes = params?.blobData;
    return this.uploadImpl();
  }
  async openChannel(): Promise<string> {
    const id = 'chan-1';
    this.channels[id] ??= { nonce: 0, cumulative: 0n };
    return id;
  }
  getTrackedChannels(): string[] {
    return Object.keys(this.channels);
  }
  getChannelNonce(channelId: string): number {
    return this.channels[channelId]?.nonce ?? 0;
  }
  getChannelCumulativeAmount(channelId: string): bigint {
    return this.channels[channelId]?.cumulative ?? 0n;
  }
  getChannelDepositTotal(channelId: string): bigint {
    return this.channels[channelId]?.depositTotal ?? 0n;
  }
  async getBalances(): Promise<
    { chain: string; address: string; amount: string }[]
  > {
    return [
      {
        chain: 'evm',
        address: '0xself',
        amount: '5000000',
        asset: 'USDC',
        assetScale: 6,
      },
    ];
  }
  async depositToChannel(
    channelId: string,
    amount: string
  ): Promise<{ channelId: string; txHash?: string; depositTotal: string }> {
    const cur = this.channels[channelId]?.depositTotal ?? 0n;
    return {
      channelId,
      txHash: '0xdep',
      depositTotal: String(cur + BigInt(amount)),
    };
  }
  closeStateValue: 'open' | 'closing' | 'settleable' | 'settled' = 'open';
  settleableAtValue?: bigint;
  async closeChannel(channelId: string): Promise<{
    channelId: string;
    txHash?: string;
    closedAt: string;
    settleableAt: string;
  }> {
    this.closeStateValue = 'closing';
    this.settleableAtValue = 2000n;
    return {
      channelId,
      txHash: '0xclose',
      closedAt: '1000',
      settleableAt: '2000',
    };
  }
  async settleChannel(
    channelId: string
  ): Promise<{ channelId: string; txHash?: string }> {
    this.closeStateValue = 'settled';
    return { channelId, txHash: '0xsettle' };
  }
  getChannelCloseState(): 'open' | 'closing' | 'settleable' | 'settled' {
    return this.closeStateValue;
  }
  getSettleableAt(): bigint | undefined {
    return this.settleableAtValue;
  }
  async sendSwapPacket(): Promise<{ accepted: boolean; data?: string }> {
    return { accepted: true, data: 'c3dhcA==' };
  }
  /** Optional settlement-submission seam (#352); tests assign a spy. */
  settleSwapBundle?: (
    bundle: unknown
  ) => Promise<{ txHash: string; status?: 'success' | 'reverted' }>;
  async h402Fetch(): Promise<Response> {
    return new Response('hello', {
      status: 200,
      headers: { 'content-type': 'text/plain' },
    });
  }
}

/** A relay that never opens a real socket (no wsFactory call until start). */
function fakeRelay(): RelaySubscription {
  return new RelaySubscription({
    relayUrl: 'ws://relay.test',
    wsFactory: () => ({
      send: () => {},
      close: () => {},
      on: () => {},
    }),
  });
}

/** A 16-byte lowercase-hex streamNonce for the rolling-swap tests (#573). */
const STREAM_NONCE = '6e'.repeat(16);

/**
 * Build a signed rolling-swap leg-B advance payload (toon-client#573), as a
 * compliant maker would send it: a `RollingAdvancePayload` JSON envelope
 * carrying a REAL v2 EIP-712 signed EVM claim.
 */
async function rollingAdvanceBytes(opts: {
  seq: number;
  nonce: string;
  cumulativeAmount: string;
  sourceAmount: string;
  targetAmount: string;
  streamNonce?: string;
  signer?: typeof SWAP_SIGNER_ACCOUNT;
}): Promise<Uint8Array> {
  const digest = evmClaimDigest(
    { chainId: EVM_CHAIN_ID, verifyingContract: EVM_VERIFYING_CONTRACT },
    {
      channelId: EVM_CHANNEL,
      cumulativeAmount: BigInt(opts.cumulativeAmount),
      nonce: BigInt(opts.nonce),
      recipient: EVM_RECIPIENT,
    }
  );
  const sigHex = await (opts.signer ?? SWAP_SIGNER_ACCOUNT).sign({
    hash: digest,
  });
  return new TextEncoder().encode(
    JSON.stringify({
      proto: 'rolling/1',
      type: 'advance',
      streamNonce: opts.streamNonce ?? STREAM_NONCE,
      seq: opts.seq,
      claim: Buffer.from(hexToBytes(sigHex)).toString('base64'),
      channelId: EVM_CHANNEL,
      nonce: opts.nonce,
      cumulativeAmount: opts.cumulativeAmount,
      recipient: EVM_RECIPIENT,
      swapSignerAddress: SWAP_SIGNER,
      rate: '1.0',
      rateTimestamp: 1_700_000_000_000,
      sourceAmount: opts.sourceAmount,
      targetAmount: opts.targetAmount,
    })
  );
}

/**
 * A fake ROLLING-capable maker (toon-client#573): its `sendSwapPacket`
 * plays the maker's connector role — it reads the leg-A fill payload for
 * `seq`, hands a leg-B advance to the SAME `jobHandler` the daemon installed
 * on this client's config (captured via `createClient`), and reports the
 * leg-A outcome exactly as the real protocol would: FULFILLed iff the
 * daemon's handler revealed a matching preimage.
 */
class FakeRollingMakerClient extends FakeClient {
  /** Captured from `ToonClientConfig.jobHandler` at `createClient(cfg)` time. */
  jobHandler?: (job: {
    amount: bigint;
    destination: string;
    executionCondition: Uint8Array;
    expiresAt: Date;
    data: Uint8Array;
  }) => Promise<{ fulfillment: Uint8Array; data?: Uint8Array }>;
  /** Per-seq advance builder; tests control validity. Defaults to "no advance". */
  buildAdvance: (seq: number, streamNonce: string) => Promise<Uint8Array> =
    async () => new Uint8Array();

  override async sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    executionCondition?: Uint8Array;
    expiresAt?: Date;
  }): Promise<{ accepted: boolean; code?: string; message?: string }> {
    const fill = JSON.parse(new TextDecoder().decode(params.toonData)) as {
      streamNonce: string;
      seq: number;
    };
    if (!this.jobHandler) throw new Error('no jobHandler captured');
    const data = await this.buildAdvance(fill.seq, fill.streamNonce);
    try {
      await this.jobHandler({
        amount: params.amount,
        destination: params.destination,
        executionCondition: params.executionCondition ?? new Uint8Array(32),
        expiresAt: params.expiresAt ?? new Date(Date.now() + 30_000),
        data,
      });
      return { accepted: true };
    } catch (err) {
      return {
        accepted: false,
        code: 'F99',
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

/**
 * A maker with **RFQ intake** (swap#135) on top of the rolling fill loop —
 * the wire counterpart the toon-client#585 sender must actually speak.
 *
 * `sendSwapPacket` reproduces the maker's own dispatch order: try to NIP-59
 * unwrap the `data` (an RFQ and a legacy swap request are indistinguishable
 * before decryption), and only the inner rumor kind decides. Anything that
 * does not unwrap is a plain rolling FILL and goes to the base class.
 *
 * `rfqCapable = false` models a pre-#135 maker: it never answers a kind:20033,
 * which is precisely the negative capability signal the sender must fall back
 * on (spec §10.3 step 2).
 */
class FakeRfqMakerClient extends FakeRollingMakerClient {
  readonly secretKey = generateSecretKey();
  /** Turn RFQ intake off to model a legacy (pre-swap#135) maker. */
  rfqCapable = true;
  /** `R₀` the quote answers with. */
  quoteRate = '1.0';
  /** Optional per-packet cap advertised on the quote. */
  quoteMaxAmount?: string;
  /** Every RFQ request body this maker parsed off the wire. */
  readonly rfqRequests: Record<string, unknown>[] = [];
  /** Sessions registered FROM THE WIRE — nothing here registers out of band. */
  readonly sessions = new Set<string>();

  get pubkey(): string {
    return getPublicKey(this.secretKey);
  }

  override async sendSwapPacket(params: {
    destination: string;
    amount: bigint;
    toonData: Uint8Array;
    executionCondition?: Uint8Array;
    expiresAt?: Date;
  }): Promise<{
    accepted: boolean;
    data?: string;
    code?: string;
    message?: string;
  }> {
    let rumor: UnsignedEvent;
    let senderPubkey: string;
    try {
      const unwrapped = unwrapSwapPacketFromToon({
        toonData: params.toonData,
        recipientSecretKey: this.secretKey,
      });
      rumor = unwrapped.rumor;
      senderPubkey = unwrapped.senderPubkey;
    } catch {
      // Not a gift wrap → a plain rolling fill packet.
      return super.sendSwapPacket(params);
    }
    if (rumor.kind !== 20033) {
      return { accepted: false, code: 'F06', message: 'not a swap request' };
    }
    if (!this.rfqCapable) {
      // A pre-#135 maker hands kind:20033 to its LEGACY handler.
      return {
        accepted: false,
        code: 'F06',
        message: 'Unsupported rumor kind 20033',
      };
    }
    const request = JSON.parse(rumor.content) as Record<string, unknown>;
    this.rfqRequests.push(request);
    const streamNonce = String(request['streamNonce']);
    this.sessions.add(streamNonce);
    const { giftWrap } = wrapSwapPacket({
      rumor: {
        kind: 20034,
        content: JSON.stringify({
          proto: 'rolling/1',
          type: 'quote',
          streamNonce,
          rate: this.quoteRate,
          rateTimestamp: 1_700_000_000_000,
          expiresAt: 1_700_000_060_000,
          maxRateAge: 15_000,
          spreadBps: 40,
          ...(this.quoteMaxAmount !== undefined
            ? { maxAmount: this.quoteMaxAmount }
            : {}),
          swapSignerAddress: SWAP_SIGNER,
        }),
        tags: [],
        created_at: 1_700_000_000,
        pubkey: '',
      } as unknown as UnsignedEvent,
      senderSecretKey: this.secretKey,
      recipientPubkey: senderPubkey,
    });
    return {
      accepted: true,
      data: Buffer.from(JSON.stringify(giftWrap), 'utf8').toString('base64'),
    };
  }
}

describe('ClientRunner', () => {
  let client: FakeClient;
  let runner: ClientRunner;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'toon-runner-'));
    // Isolate from the user's real ~/.toon-client (persisted targets.json,
    // channel stores) so tests never read or write live state.
    prevHome = process.env['TOON_CLIENT_HOME'];
    process.env['TOON_CLIENT_HOME'] = tmpDir;
    client = new FakeClient();
    runner = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reports bootstrapping before ready, then ready after bootstrap', async () => {
    runner.start();
    expect(runner.isBootstrapping()).toBe(true);
    expect(runner.getStatus().bootstrapping).toBe(true);
    await runner.bootstrap();
    expect(runner.isReady()).toBe(true);
    expect(runner.getStatus().ready).toBe(true);
  });

  it('getStatus includes feePerEvent from config', () => {
    const status = runner.getStatus();
    expect(status.feePerEvent).toBe('1');
  });

  it('getStatus advertises the git capability so a skewed rig can gate (#306)', () => {
    // rig capability-checks this field BEFORE delegating to /git/* — its
    // presence is what distinguishes this build from an old daemon that 404s.
    expect(runner.getStatus().capabilities).toContain('git');
  });

  it('injects the apex negotiation into the ToonClient', async () => {
    await runner.bootstrap();
    expect(client.peerNegotiations.get('proxy')).toMatchObject({
      chainType: 'evm',
      settlementAddress: '0xapex',
      tokenNetwork: '0xtn',
    });
  });

  it('routes apex child peers through the same apex channel (one on-chain open)', async () => {
    // A client whose channelManager exposes the peerChannels map, like the real
    // ToonClient. Child peers must reuse the open apex channel, not open a 2nd.
    const childClient = new FakeClient();
    const peerChannels = new Map<string, string>();
    (childClient as unknown as { channelManager: unknown }).channelManager = {
      peerChannels,
    };
    const openSpy = vi.spyOn(childClient, 'openChannel');
    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
        apexChildPeers: ['store', 'swap'],
      }),
      createClient: () => childClient,
      createRelay: fakeRelay,
    });
    await r.bootstrap();

    // Each child gets the apex negotiation injected...
    for (const peer of ['store', 'swap']) {
      expect(childClient.peerNegotiations.get(peer)).toMatchObject({
        chainType: 'evm',
        settlementAddress: '0xapex',
        tokenNetwork: '0xtn',
      });
      // ...and is pre-mapped to the already-open apex channel.
      expect(peerChannels.get(peer)).toBe('chan-1');
    }
    // The apex channel opened exactly once; children reuse it (no re-deposit).
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('skips child-peer routing when none are configured (back-compat)', async () => {
    await runner.bootstrap();
    expect(client.peerNegotiations.has('store')).toBe(false);
    expect(client.peerNegotiations.has('swap')).toBe(false);
  });

  it('persists the apex channelId after first open', async () => {
    await runner.bootstrap();
    const saved = JSON.parse(
      readFileSync(join(tmpDir, 'apex-channels.json'), 'utf8')
    );
    expect(saved['g.proxy|evm'].channelId).toBe('chan-1');
    expect(saved['g.proxy|evm'].context).toMatchObject({
      chainType: 'evm',
      chainId: 84532,
      recipient: '0xapex',
    });
  });

  it('resumes (tracks) the saved channel on restart instead of re-opening', async () => {
    // Seed a saved apex channel + a client whose channelManager records tracking.
    writeFileSync(
      join(tmpDir, 'apex-channels.json'),
      JSON.stringify({
        'g.proxy|evm': {
          channelId: 'existing-chan',
          context: {
            chainType: 'evm',
            chainId: 84532,
            tokenNetworkAddress: '0xtn',
            recipient: '0xapex',
          },
        },
      })
    );
    const tracked: { id: string }[] = [];
    const trackingClient = new FakeClient();
    const openSpy = vi.spyOn(trackingClient, 'openChannel');
    // Give the fake a channelManager.trackChannel like the real ToonClient.
    (trackingClient as unknown as { channelManager: unknown }).channelManager =
      {
        trackChannel: (id: string) => {
          tracked.push({ id });
          trackingClient.channels[id] = { nonce: 7, cumulative: 7n };
        },
      };
    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenNetwork: '0xtn',
        },
      }),
      createClient: () => trackingClient,
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    expect(r.isReady()).toBe(true);
    expect(tracked).toEqual([{ id: 'existing-chan' }]);
    expect(openSpy).not.toHaveBeenCalled(); // no re-open / re-deposit
    // Publishes continue from the resumed channel.
    const res = await r.publish({ event: { id: 'e' } as NostrEvent });
    expect(res.channelId).toBe('existing-chan');
  });

  it('ADOPTS the resumed channel so the first paid write cannot open a second (#489)', async () => {
    writeFileSync(
      join(tmpDir, 'apex-channels.json'),
      JSON.stringify({
        'g.proxy|evm': {
          channelId: 'existing-chan',
          context: {
            chainType: 'evm',
            chainId: 84532,
            tokenNetworkAddress: '0xtn',
            recipient: '0xapex',
          },
        },
      })
    );
    const adopted: [string, string][] = [];
    const trackingClient = new FakeClient();
    (
      trackingClient as unknown as {
        channelManager: unknown;
        adoptChannel: (d: string, c: string) => Promise<void>;
      }
    ).channelManager = {
      trackChannel: (id: string) => {
        trackingClient.channels[id] = { nonce: 7, cumulative: 7n };
      },
    };
    (
      trackingClient as unknown as {
        adoptChannel: (d: string, c: string) => Promise<void>;
      }
    ).adoptChannel = async (destination: string, channelId: string) => {
      adopted.push([destination, channelId]);
    };

    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenNetwork: '0xtn',
        },
      }),
      createClient: () => trackingClient,
      createRelay: fakeRelay,
    });
    await r.bootstrap();

    // Tracking alone left the client's lazy-open path unaware of the channel —
    // this is the hand-off that stops the next write locking new collateral.
    expect(adopted).toEqual([['g.proxy', 'existing-chan']]);
  });

  /**
   * The apex store is keyed `destination|chain` — an ILP NAME, not a node. The
   * devnet apex `g.toon` was retired 2026-08-14 and other nodes took over the
   * names under it; both key fields kept matching, so the runner resumed,
   * adopted AND re-bound a channel the node now answering has no record of.
   * Every paid write came back `F01 - claim rejected: names a channel this
   * connector has no record of` until the record was deleted by hand.
   */
  it('does NOT resume a saved channel whose counterparty was replaced — re-resolves instead', async () => {
    writeFileSync(
      join(tmpDir, 'apex-channels.json'),
      JSON.stringify({
        'g.proxy|evm': {
          channelId: 'retired-chan',
          context: {
            chainType: 'evm',
            chainId: 84532,
            tokenNetworkAddress: '0xtn',
            recipient: '0xretired',
          },
        },
      })
    );
    const tracked: string[] = [];
    const adopted: [string, string][] = [];
    const trackingClient = new FakeClient();
    const openSpy = vi.spyOn(trackingClient, 'openChannel');
    (trackingClient as unknown as { channelManager: unknown }).channelManager =
      {
        trackChannel: (id: string) => tracked.push(id),
      };
    (
      trackingClient as unknown as {
        adoptChannel: (d: string, c: string) => Promise<void>;
      }
    ).adoptChannel = async (destination: string, channelId: string) => {
      adopted.push([destination, channelId]);
    };

    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          // The node answering `g.proxy` today is NOT the one the record names.
          settlementAddress: '0xapex',
          tokenNetwork: '0xtn',
        },
      }),
      createClient: () => trackingClient,
      createRelay: fakeRelay,
    });
    await r.bootstrap();

    // Nothing dead was tracked, adopted or re-bound…
    expect(tracked).not.toContain('retired-chan');
    expect(adopted).toEqual([]);
    // …the channel was re-resolved against the counterparty announced now
    // (`openChannel` binds an existing channel with it where there is one)…
    expect(openSpy).toHaveBeenCalledWith('g.proxy');

    const saved = JSON.parse(
      readFileSync(join(tmpDir, 'apex-channels.json'), 'utf8')
    ) as Record<string, { channelId: string; supersededAt?: string }>;
    expect(saved['g.proxy|evm']?.channelId).toBe('chan-1');
    // …and the retired record is ARCHIVED, not dropped: it may still hold an
    // on-chain deposit, so deleting it would strand those funds.
    expect(saved['g.proxy|evm|superseded:retired-chan']?.channelId).toBe(
      'retired-chan'
    );
    expect(saved['g.proxy|evm|superseded:retired-chan']?.supersededAt).toEqual(
      expect.any(String)
    );
  });

  it('resumes a LEGACY saved channel with no recorded counterparty and back-fills it', async () => {
    // Written before the counterparty was validated: unverified, NOT stale.
    // Refusing it would open (and fund) a second on-chain channel for nothing.
    writeFileSync(
      join(tmpDir, 'apex-channels.json'),
      JSON.stringify({
        'g.proxy|evm': {
          channelId: 'legacy-chan',
          context: {
            chainType: 'evm',
            chainId: 84532,
            tokenNetworkAddress: '0xtn',
          },
        },
      })
    );
    const tracked: string[] = [];
    const trackingClient = new FakeClient();
    const openSpy = vi.spyOn(trackingClient, 'openChannel');
    (trackingClient as unknown as { channelManager: unknown }).channelManager =
      {
        trackChannel: (id: string) => tracked.push(id),
      };

    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenNetwork: '0xtn',
        },
      }),
      createClient: () => trackingClient,
      createRelay: fakeRelay,
    });
    await r.bootstrap();

    expect(tracked).toEqual(['legacy-chan']);
    expect(openSpy).not.toHaveBeenCalled();
    // Back-filled from the announce, so the NEXT start is verifiable rather
    // than unverifiable forever.
    const saved = JSON.parse(
      readFileSync(join(tmpDir, 'apex-channels.json'), 'utf8')
    ) as Record<string, { context: { recipient?: string } }>;
    expect(saved['g.proxy|evm']?.context.recipient).toBe('0xapex');
  });

  it('records lastError when bootstrap fails and stays not-ready', async () => {
    client.startImpl = async () => {
      throw new Error('BTP never connected');
    };
    await runner.bootstrap();
    expect(runner.isReady()).toBe(false);
    expect(runner.getStatus().lastError).toContain('BTP never connected');
  });

  it('publish throws NotReadyError while bootstrapping', async () => {
    await expect(
      runner.publish({ event: { id: 'x' } as any })
    ).rejects.toBeInstanceOf(NotReadyError);
  });

  it('publish signs a claim, advances the nonce, and returns it', async () => {
    await runner.bootstrap();
    const event = { id: 'evt1' } as NostrEvent;
    const res = await runner.publish({ event });
    expect(res.eventId).toBe('evt1');
    expect(res.channelId).toBe('chan-1');
    expect(res.nonce).toBe(1);
    // Reports the truthful fee paid (the configured per-event fee, 1n).
    expect(res.feePaid).toBe('1');
    const res2 = await runner.publish({ event: { id: 'evt2' } as NostrEvent });
    expect(res2.nonce).toBe(2);
  });

  it('publish reports the fee override as feePaid', async () => {
    await runner.bootstrap();
    const res = await runner.publish({
      event: { id: 'e' } as NostrEvent,
      fee: '5',
    });
    expect(res.feePaid).toBe('5');
  });

  it('publish surfaces a relay rejection as PublishRejectedError', async () => {
    await runner.bootstrap();
    client.publishImpl = async () => ({
      success: false,
      error: 'F06 no parent',
    });
    await expect(
      runner.publish({ event: { id: 'e' } as NostrEvent })
    ).rejects.toBeInstanceOf(PublishRejectedError);
  });

  it('publishUnsigned builds the event, signs with the held key, and publishes', async () => {
    await runner.bootstrap();
    const res = await runner.publishUnsigned({
      kind: 1,
      content: 'hello',
      tags: [['t', 'toon']],
    });
    expect(client.lastSigned?.kind).toBe(1);
    expect(client.lastSigned?.content).toBe('hello');
    expect(client.lastSigned?.tags).toEqual([['t', 'toon']]);
    expect(res.channelId).toBe('chan-1');
    expect(res.nonce).toBe(1);
    expect(res.eventId).toMatch(/^signed-1-/);
  });

  it('publishUnsigned validates the model-authored payload', async () => {
    await runner.bootstrap();
    await expect(runner.publishUnsigned({ kind: -1 })).rejects.toBeInstanceOf(
      InvalidPayloadError
    );
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      runner.publishUnsigned({ kind: 1, tags: ['not-an-array'] as any })
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it('uploadMedia uploads to Arweave then publishes a referencing media event', async () => {
    await runner.bootstrap();
    const res = await runner.uploadMedia({
      dataBase64: Buffer.from('img-bytes').toString('base64'),
      mime: 'image/png',
      kind: 20,
    });
    expect(res.txId).toBe('tx-abc');
    // An upload pays twice (blob leg + reference-event leg), so feePaid is the
    // sum of both legs — here 2 × the configured per-event fee (1n).
    expect(res.feePaid).toBe('2');
    // Primary gateway is ar.io; the others travel as `fallback` mirrors.
    expect(res.url).toBe('https://ar-io.dev/tx-abc');
    expect(client.lastSigned?.kind).toBe(20);
    const imeta = client.lastSigned?.tags?.[0] ?? [];
    expect(imeta[0]).toBe('imeta');
    expect(imeta[1]).toBe('url https://ar-io.dev/tx-abc');
    expect(imeta).toContain('fallback https://arweave.net/tx-abc');
    expect(imeta).toContain('fallback https://permagate.io/tx-abc');
  });

  it('uploadMedia honors a custom config.arweaveGateways list', async () => {
    const c = new FakeClient();
    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
        arweaveGateways: ['https://my.gw', 'https://backup.gw'],
      }),
      createClient: () => c,
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    const res = await r.uploadMedia({
      dataBase64: Buffer.from('x').toString('base64'),
      mime: 'image/png',
      kind: 20,
    });
    expect(res.url).toBe('https://my.gw/tx-abc');
    const imeta = c.lastSigned?.tags?.[0] ?? [];
    expect(imeta[1]).toBe('url https://my.gw/tx-abc');
    expect(imeta).toContain('fallback https://backup.gw/tx-abc');
    expect(imeta).not.toContain('fallback https://arweave.net/tx-abc');
  });

  it('uploadMedia surfaces a store upload failure as PublishRejectedError', async () => {
    await runner.bootstrap();
    client.uploadImpl = async () => ({
      success: false,
      error: 'F99 store down',
    });
    await expect(
      runner.uploadMedia({ dataBase64: 'AAAA' })
    ).rejects.toBeInstanceOf(PublishRejectedError);
  });

  it('uploadMedia reads bytes from filePath instead of inline base64', async () => {
    await runner.bootstrap();
    const path = join(tmpDir, 'pic.bin');
    const bytes = Buffer.from('file-bytes-on-disk');
    writeFileSync(path, bytes);
    const res = await runner.uploadMedia({
      filePath: path,
      mime: 'image/png',
      kind: 20,
    });
    expect(res.txId).toBe('tx-abc');
    // The store leg received exactly the on-disk bytes (no base64 round-trip).
    expect(client.lastUploadBytes).toBeInstanceOf(Uint8Array);
    expect(Buffer.from(client.lastUploadBytes!)).toEqual(bytes);
  });

  it('uploadMedia rejects supplying BOTH dataBase64 and filePath', async () => {
    await runner.bootstrap();
    const path = join(tmpDir, 'both.bin');
    writeFileSync(path, Buffer.from('x'));
    await expect(
      runner.uploadMedia({
        dataBase64: Buffer.from('x').toString('base64'),
        filePath: path,
      })
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it('uploadMedia rejects supplying NEITHER dataBase64 nor filePath', async () => {
    await runner.bootstrap();
    await expect(runner.uploadMedia({ kind: 20 })).rejects.toBeInstanceOf(
      InvalidPayloadError
    );
  });

  it('uploadMedia surfaces an unreadable filePath as InvalidPayloadError', async () => {
    await runner.bootstrap();
    await expect(
      runner.uploadMedia({ filePath: join(tmpDir, 'does-not-exist.bin') })
    ).rejects.toBeInstanceOf(InvalidPayloadError);
  });

  it('uploadMedia enforces a configured uploadAllowedRoot for filePath', async () => {
    const c = new FakeClient();
    const allowedRoot = join(tmpDir, 'allowed');
    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
        uploadAllowedRoot: allowedRoot,
      }),
      createClient: () => c,
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    // Outside the root → rejected.
    const outside = join(tmpDir, 'outside.bin');
    writeFileSync(outside, Buffer.from('x'));
    await expect(r.uploadMedia({ filePath: outside })).rejects.toBeInstanceOf(
      InvalidPayloadError
    );
    // Inside the root → accepted.
    mkdirSync(allowedRoot, { recursive: true });
    const inside = join(allowedRoot, 'ok.bin');
    writeFileSync(inside, Buffer.from('inside-bytes'));
    const res = await r.uploadMedia({ filePath: inside });
    expect(res.txId).toBe('tx-abc');
  });

  // ── Split write destinations (publish → relay, upload → store) ──────────────
  const splitApex = {
    destination: 'g.proxy.relay.store',
    peerId: 'store',
    chain: 'evm' as const,
    chainKey: 'evm:base:84532',
    chainId: 84532,
    settlementAddress: '0xapex',
    tokenNetwork: '0xtn',
  };
  function splitRunner(c: FakeClient): ClientRunner {
    return new ClientRunner({
      config: makeConfig({
        destination: 'g.proxy.relay.store',
        publishDestination: 'g.proxy.relay',
        storeDestination: 'g.proxy.store',
        apex: splitApex,
      }),
      createClient: () => c,
      createRelay: fakeRelay,
    });
  }

  it('publish routes to publishDestination by default (not the apex anchor)', async () => {
    const c = new FakeClient();
    const r = splitRunner(c);
    await r.bootstrap();
    await r.publish({ event: { id: 'evtA' } as NostrEvent });
    expect(c.lastPublishDest).toBe('g.proxy.relay');
  });

  it('publish honors an explicit per-call destination over the default', async () => {
    const c = new FakeClient();
    const r = splitRunner(c);
    await r.bootstrap();
    await r.publish({
      event: { id: 'evtB' } as NostrEvent,
      destination: 'g.custom.dest',
    });
    expect(c.lastPublishDest).toBe('g.custom.dest');
  });

  it('uploadMedia sends the blob to storeDestination and the reference event to publishDestination', async () => {
    const c = new FakeClient();
    const r = splitRunner(c);
    await r.bootstrap();
    await r.uploadMedia({
      dataBase64: Buffer.from('img').toString('base64'),
      kind: 20,
    });
    expect(c.lastUploadDest).toBe('g.proxy.store'); // blob → store backend
    expect(c.lastPublishDest).toBe('g.proxy.relay'); // NIP-94 ref event → relay
  });

  // ── Split store UPLINK: a second connector, not just a renamed destination
  //    (issue #536 correction — the relay and store connectors are
  //    independent boxes with no forwarding between them, so reaching the
  //    store needs its own BTP endpoint). ──────────────────────────────────
  describe('split store uplink (issue #536 correction)', () => {
    const STORE_BTP_URL = 'ws://store-apex.test/btp';

    function storeSplitRunner(
      relayClient: FakeClient,
      storeClient: FakeClient
    ): ClientRunner {
      return new ClientRunner({
        config: makeConfig({
          destination: 'g.toon.relay',
          publishDestination: 'g.toon.relay',
          storeDestination: 'g.toon.ario',
          storeBtpUrl: STORE_BTP_URL,
        }),
        createClient: (cfg) =>
          cfg.btpUrl === STORE_BTP_URL ? storeClient : relayClient,
        createRelay: fakeRelay,
      });
    }

    it('auto-registers a second (store) apex from storeBtpUrl and bootstraps it', async () => {
      const relayClient = new FakeClient();
      const storeClient = new FakeClient();
      const r = storeSplitRunner(relayClient, storeClient);
      await r.bootstrap();
      const apexes = r.getTargets().apexes;
      const btpUrls = apexes.map((a) => a.btpUrl).sort();
      expect(btpUrls).toEqual([STORE_BTP_URL, 'ws://apex.test/btp'].sort());
      const storeTarget = apexes.find((a) => a.btpUrl === STORE_BTP_URL);
      expect(storeTarget?.isDefault).toBe(true);
      expect(storeTarget?.ready).toBe(true);
      expect(storeClient.started).toBe(true);
    });

    it('bootstraps the two default apexes SEQUENTIALLY — both open channels from one wallet, so concurrent opens collide on the account nonce', async () => {
      const relayClient = new FakeClient();
      const storeClient = new FakeClient();
      const order: string[] = [];
      const trace = (name: string, client: FakeClient): void => {
        client.startImpl = async (): Promise<void> => {
          order.push(`${name}:enter`);
          await Promise.resolve();
          order.push(`${name}:exit`);
        };
      };
      trace('relay', relayClient);
      trace('store', storeClient);

      const r = storeSplitRunner(relayClient, storeClient);
      await r.bootstrap();

      // Each leg's bootstrap completes before the next one starts. Under
      // `Promise.all` the order interleaves (relay:enter, store:enter, …),
      // which live on devnet meant the second on-chain `openChannel` was
      // rejected as `already known` and that uplink never went ready.
      expect(order).toEqual([
        'relay:enter',
        'relay:exit',
        'store:enter',
        'store:exit',
      ]);
    });

    it('a failing relay leg still leaves the store leg bootstrapped', async () => {
      const relayClient = new FakeClient();
      const storeClient = new FakeClient();
      relayClient.startImpl = async (): Promise<void> => {
        throw new Error('nonce too low');
      };
      const r = storeSplitRunner(relayClient, storeClient);
      await r.bootstrap();
      const apexes = r.getTargets().apexes;
      expect(apexes.find((a) => a.btpUrl === STORE_BTP_URL)?.ready).toBe(true);
      expect(apexes.find((a) => a.btpUrl === 'ws://apex.test/btp')?.ready).toBe(
        false
      );
    });

    it('the auto-registered store apex is not removable (config-seeded default)', async () => {
      const relayClient = new FakeClient();
      const storeClient = new FakeClient();
      const r = storeSplitRunner(relayClient, storeClient);
      await r.bootstrap();
      await expect(r.removeApex(STORE_BTP_URL)).rejects.toThrow(/default/i);
    });

    it('uploadMedia sends the blob through the store apex and the reference event through the relay apex', async () => {
      const relayClient = new FakeClient();
      const storeClient = new FakeClient();
      const r = storeSplitRunner(relayClient, storeClient);
      await r.bootstrap();
      await r.uploadMedia({
        dataBase64: Buffer.from('img').toString('base64'),
        kind: 20,
      });
      // The blob leg went through the STORE client, never the relay client.
      expect(storeClient.lastUploadDest).toBe('g.toon.ario');
      expect(relayClient.lastUploadDest).toBeUndefined();
      // The NIP-94 reference event went through the RELAY client, never store.
      expect(relayClient.lastPublishDest).toBe('g.toon.relay');
      expect(storeClient.lastPublishDest).toBeUndefined();
    });

    it('falls back to the single (default) apex when storeBtpUrl is unset — back-compat', async () => {
      const c = new FakeClient();
      const r = new ClientRunner({
        config: makeConfig({
          destination: 'g.toon.relay',
          publishDestination: 'g.toon.relay',
          storeDestination: 'g.toon.ario',
        }),
        createClient: () => c,
        createRelay: fakeRelay,
      });
      await r.bootstrap();
      expect(r.getTargets().apexes).toHaveLength(1);
      await r.uploadMedia({
        dataBase64: Buffer.from('img').toString('base64'),
      });
      expect(c.lastUploadDest).toBe('g.toon.ario');
      expect(c.lastPublishDest).toBe('g.toon.relay');
    });

    it('an explicit btpUrl still pins BOTH legs to the same named apex', async () => {
      const relayClient = new FakeClient();
      const storeClient = new FakeClient();
      const r = storeSplitRunner(relayClient, storeClient);
      await r.bootstrap();
      await r.uploadMedia({
        dataBase64: Buffer.from('img').toString('base64'),
        btpUrl: STORE_BTP_URL,
      });
      // Both the blob upload AND the signing client are the named (store) apex.
      expect(storeClient.lastUploadDest).toBe('g.toon.ario');
      expect(storeClient.lastSigned).toBeDefined();
    });
  });

  it('lists channels with nonce, cumulative, deposit total + available balance', async () => {
    await runner.bootstrap();
    await runner.publish({ event: { id: 'e1' } as NostrEvent, fee: '5' });
    // Collateral locked at open; available = deposit − cumulative spent.
    client.channels['chan-1']!.depositTotal = 100n;
    const { channels } = runner.getChannels();
    expect(channels).toEqual([
      {
        channelId: 'chan-1',
        nonce: 1,
        cumulativeAmount: '5',
        depositTotal: '100',
        availableBalance: '95',
        closeState: 'open',
      },
    ]);
  });

  it('getBalances wraps the client read into the { balances: [...] } wire shape (#200)', async () => {
    await runner.bootstrap();
    const res = await runner.getBalances();
    expect(Array.isArray(res.balances)).toBe(true);
    expect(res.balances[0]).toMatchObject({
      chain: 'evm',
      address: '0xself',
      amount: '5000000',
    });
  });

  it('getBalances reads the identity-level wallet even with zero apexes registered', async () => {
    // Reading your own on-chain balance is a pure wallet-keys + chain-RPC
    // operation — it must not depend on any payment peer. Drop every apex
    // (including the default) and prove balances still come back.
    (runner as unknown as { apexes: Map<string, unknown> }).apexes.clear();
    const res = await runner.getBalances();
    expect(Array.isArray(res.balances)).toBe(true);
    expect(res.balances[0]).toMatchObject({
      chain: 'evm',
      address: '0xself',
      amount: '5000000',
    });
  });

  it('getBalances fast-fails a stalled provider read, attributing the balances handler not relay/apex (#199)', async () => {
    await runner.bootstrap();
    // A provider that always rejects exercises the bounded-retry → fast-fail
    // path without waiting the full per-attempt timeout.
    vi.spyOn(client, 'getBalances').mockRejectedValue(
      new Error('RPC ECONNRESET')
    );
    await expect(runner.getBalances()).rejects.toBeInstanceOf(
      BalancesUnavailableError
    );
    const err = await runner.getBalances().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BalancesUnavailableError);
    expect((err as BalancesUnavailableError).retryable).toBe(true);
    expect((err as Error).message).toMatch(/provider|balances control handler/);
    // Attribution clears the relay/apex rather than blaming them.
    expect((err as Error).message).toMatch(/not the relay or apex/);
  });

  it('maps getNetworkStatus into per-chain ChainStatus[]', async () => {
    await runner.bootstrap();
    const net = runner.getStatus().network;
    expect(net).toEqual([
      { chain: 'evm', ready: true, detail: 'configured' },
      { chain: 'solana', ready: false, detail: 'unconfigured' },
      { chain: 'mina', ready: false, detail: 'unconfigured' },
    ]);
  });

  it('swap streams via streamSwap, VERIFIES the claim, persists it, and maps it (#352)', async () => {
    await runner.bootstrap();
    const claim = await signedEvmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
      sourceAmount: 1000n,
    });
    vi.mocked(streamSwap).mockResolvedValue(swapResult([claim]));

    const res = await runner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      // #595: legacy is opt-in now — this suite exercises the legacy body.
      rolling: 'auto' as const,
      swapSignerAddress: SWAP_SIGNER,
    });

    // streamSwap got the request params (default single packet).
    const arg = vi.mocked(streamSwap).mock.calls[0]![0];
    expect(arg.swapIlpAddress).toBe('g.proxy.swap');
    expect(arg.swapPubkey).toBe('cd'.repeat(32));
    expect(arg.totalAmount).toBe(1000n);
    expect(arg.chainRecipient).toBe(EVM_RECIPIENT);
    expect(arg.packetCount).toBe(1);

    // The accumulated claim is mapped (claimBytes → base64) and VERIFIED.
    expect(res.accepted).toBe(true);
    expect(res.packetsAccepted).toBe(1);
    expect(res.cumulativeTarget).toBe('999');
    expect(res.state).toBe('completed');
    expect(res.claims[0]).toMatchObject({
      sourceAmount: '1000',
      targetAmount: '999',
      claim: Buffer.from(claim.claimBytes).toString('base64'),
      channelId: EVM_CHANNEL,
      recipient: EVM_RECIPIENT,
      swapSignerAddress: SWAP_SIGNER,
      claimId: 'claim-1',
      verified: true,
    });
    expect(res.claimsVerified).toBe(1);
    expect(res.claimsRejected).toBe(0);
    expect(res.valueReceived).toBe('999');
    // Settlement metadata survived the round trip — no wire-skew warning. The
    // only warning here is #595's legacy-path notice, which this call opted
    // into explicitly (`rolling: 'auto'`).
    expect(res.warning).not.toMatch(/swapSignerAddress/);
    expect(res.warning).toMatch(/LEGACY/);

    // The verified claim is PERSISTED as the channel watermark, reflected in
    // the received-claims surface (`GET /swap/claims`).
    const listed = runner.listSwapClaims().claims;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      chain: EVM_PAIR.to.chain,
      channelId: EVM_CHANNEL,
      nonce: '1',
      cumulativeAmount: '999',
      recipient: EVM_RECIPIENT,
      swapSignerAddress: SWAP_SIGNER,
    });
  });

  it("swap sources the leg-B verifying contract from the MAKER's own kind:10032 announce, not just local config (#572/#583)", async () => {
    // A daemon whose config carries NO swapVerifyingContracts at all (the
    // live-devnet failure mode: the operator hadn't hand-configured the
    // maker's deployment locally) can still verify — the maker's own announce
    // supplies the verifyingContract.
    const noConfig = new ClientRunner({
      config: makeConfig({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: { btpUrl: 'ws://apex.test/btp' } as any,
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    client.announcedSwapVerifyingContracts.set(
      'cd'.repeat(32),
      EVM_VERIFYING_CONTRACTS
    );
    await noConfig.bootstrap();
    const claim = await signedEvmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
    });
    vi.mocked(streamSwap).mockResolvedValue(swapResult([claim]));

    const res = await noConfig.swap(
      swapReq({ swapSignerAddress: SWAP_SIGNER })
    );

    expect(res.accepted).toBe(true);
    expect(res.claimsVerified).toBe(1);
    expect(res.claims[0]!.verified).toBe(true);
    await noConfig.stop();
  });

  it("swap: local config swapVerifyingContracts OVERRIDES the maker's announce (#572/#583)", async () => {
    // The announce carries a DIFFERENT (wrong/stale) contract for the chain;
    // the daemon's own config, when set, wins — a counterparty must never be
    // the sole authority on what verifies its own signature. The claim is
    // signed against the config's contract (EVM_VERIFYING_CONTRACTS).
    client.announcedSwapVerifyingContracts.set('cd'.repeat(32), {
      [EVM_PAIR.to.chain]: '0x' + '99'.repeat(20),
    });
    await runner.bootstrap();
    const claim = await signedEvmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
    });
    vi.mocked(streamSwap).mockResolvedValue(swapResult([claim]));

    const res = await runner.swap(swapReq({ swapSignerAddress: SWAP_SIGNER }));

    expect(res.accepted).toBe(true);
    expect(res.claimsVerified).toBe(1);
  });

  it('swap warns when accepted claims are missing swapSignerAddress (pre-rename swap peer)', async () => {
    // A sdk <2.0.0 swap peer emits `millSignerAddress` in its FULFILL
    // settlement metadata; sdk ≥2's decodeFulfillMetadata silently drops the
    // unknown field, so the accumulated claim arrives WITHOUT
    // swapSignerAddress. That claim is unsettleable (buildSettlementTx →
    // MISSING_SETTLEMENT_METADATA) — the runner must say so at swap time.
    await runner.bootstrap();
    const pair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    };
    vi.mocked(streamSwap).mockResolvedValue({
      state: 'completed',
      claims: [
        {
          packetIndex: 0,
          sourceAmount: 1000n,
          targetAmount: 999n,
          claimBytes: new Uint8Array([1, 2, 3, 4]),
          swapEphemeralPubkey: 'ab'.repeat(32),
          claimId: 'claim-1',
          channelId: '1111',
          recipient: 'SoLrecipient',
          // swapSignerAddress absent: dropped by decodeFulfillMetadata.
          nonce: '1',
          cumulativeAmount: '999',
          pair,
          receivedAt: 0,
        },
      ],
      rejections: [],
      errors: [],
      abortReason: 'complete',
      cumulativeSource: 1000n,
      cumulativeTarget: 999n,
      packetsSent: 1,
      packetsScheduled: 1,
    } as unknown as Awaited<ReturnType<typeof streamSwap>>);

    const res = await runner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
      // #595: legacy is opt-in now — this suite exercises the legacy body.
      rolling: 'auto' as const,
    });

    // Claims still surface (the payment already happened) …
    expect(res.accepted).toBe(true);
    expect(res.claims[0]).not.toHaveProperty('swapSignerAddress');
    // … but the response carries a loud, actionable skew warning.
    expect(res.warning).toMatch(/swapSignerAddress/);
    expect(res.warning).toMatch(/MISSING_SETTLEMENT_METADATA/);
    expect(res.warning).toMatch(/millSignerAddress/);
  });

  // A packet that THROWS before it is sent lands on the sdk's `errors[]`, not
  // `rejections[]`. The runner used to map only `rejections`, so this whole
  // class of failure came back as a bare
  // `{accepted:false, packetsAccepted:0, state:'failed', abortReason:'complete'}`
  // with no cause anywhere — the sdk only rewrites 'complete' → 'all-rejected'
  // when there are rejections and NO errors, so that exact shape IS the
  // signature of the local error path.
  it('swap surfaces sdk errors[] when a packet throws before it is sent — not a bare abortReason:"complete"', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockResolvedValue({
      state: 'failed',
      claims: [],
      rejections: [],
      errors: [
        {
          packetIndex: 0,
          cause: Object.assign(
            new Error(
              'sendSwapPacket failed: PEER_NOT_NEGOTIATED (g.toon.swap.maker)'
            ),
            { name: 'TargetError' }
          ),
        },
      ],
      abortReason: 'complete',
      cumulativeSource: 0n,
      cumulativeTarget: 0n,
      packetsSent: 0,
      packetsScheduled: 1,
    } as unknown as Awaited<ReturnType<typeof streamSwap>>);

    const res = await runner.swap(swapReq());

    expect(res.accepted).toBe(false);
    expect(res.packetsAccepted).toBe(0);
    // The diagnostic pair is preserved as-is …
    expect(res.state).toBe('failed');
    expect(res.abortReason).toBe('complete');
    // … and the cause is now reachable without a debugger.
    expect(res.errors).toHaveLength(1);
    expect(res.errors?.[0]).toMatchObject({
      packetIndex: 0,
      name: 'TargetError',
      message: expect.stringContaining('PEER_NOT_NEGOTIATED'),
    });
    // With no maker REJECT to report, the local throw supplies code/message.
    expect(res.code).toBe('LOCAL_SEND_FAILED');
    expect(res.message).toMatch(/PEER_NOT_NEGOTIATED/);
    expect(res.warning).toMatch(/FAILED LOCALLY/);
    expect(res.warning).toMatch(/btpUrl/);
  });

  it('swap passes the daemon logger into streamSwap so stream_swap.* events are written somewhere', async () => {
    const lines: string[] = [];
    const logged = new ClientRunner({
      config: makeConfig(),
      createClient: () => client,
      createRelay: fakeRelay,
      logger: (m) => lines.push(m),
    });
    await logged.bootstrap();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));

    await logged.swap(swapReq());

    const lastCall = vi.mocked(streamSwap).mock.calls.at(-1);
    expect(lastCall).toBeDefined();
    const logger = lastCall?.[0].logger;
    expect(logger).toBeDefined();
    // Exercise the adapter the way the sdk does: ONE structured event object.
    logger?.error({
      event: 'stream_swap.send_failed',
      packetIndex: 0,
      error: 'PEER_NOT_NEGOTIATED',
    });
    expect(lines.some((l) => l.includes('stream_swap.send_failed'))).toBe(true);
    expect(lines.some((l) => l.includes('PEER_NOT_NEGOTIATED'))).toBe(true);
    await logged.stop();
  });

  it('[#585] senderConditions with no streamNonce no longer throws — the RFQ probe decides the path, and under explicit `auto` a maker that cannot answer keeps the legacy one', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockClear();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    const pair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    };
    // `swapPubkey` here is a placeholder, not a real secp256k1 point, so the
    // gift wrap cannot even be built — the harshest way the probe can fail.
    // With `rolling: 'auto'` asked for explicitly it STILL falls through to a
    // working legacy swap rather than throwing (#595 changed only the
    // DEFAULT: `senderConditions` is not, and never was, a path selector).
    const res = await runner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
      // #595: legacy is opt-in now — this suite exercises the legacy body.
      rolling: 'auto' as const,
      senderConditions: true,
    });
    expect(streamSwap).toHaveBeenCalledTimes(1);
    expect(res.rolling).toMatchObject({
      probed: false,
      used: false,
      fallbackReason: 'send-failed',
    });
  });

  it('[#585] `rolling: "off"` with streamNonce is a validation error — the two ask for opposite paths', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockClear();
    await expect(
      runner.swap({
        destination: 'g.proxy.swap',
        amount: '1000',
        swapPubkey: 'cd'.repeat(32),
        pair: EVM_PAIR,
        chainRecipient: EVM_RECIPIENT,
        rolling: 'off',
        streamNonce: STREAM_NONCE,
      })
    ).rejects.toThrow(InvalidPayloadError);
    expect(streamSwap).not.toHaveBeenCalled();
  });

  it('swap with senderConditions + streamNonce drives the ROLLING path: a FRESH non-zero condition per packet, verified via the maker leg-B advance (#573)', async () => {
    const maker = new FakeRollingMakerClient();
    let capturedJobHandler: typeof maker.jobHandler | undefined;
    const rollingRunner = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
      }),
      createClient: (cfg) => {
        maker.jobHandler = cfg.jobHandler as typeof maker.jobHandler;
        capturedJobHandler = maker.jobHandler;
        return maker;
      },
      createRelay: fakeRelay,
    });
    await rollingRunner.bootstrap();
    expect(capturedJobHandler).toBeDefined();

    maker.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(500 * seq),
        sourceAmount: '500',
        targetAmount: '500',
      });
    const sendSpy = vi.spyOn(maker, 'sendSwapPacket');

    const res = await rollingRunner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      packetCount: 2,
      senderConditions: true,
      streamNonce: STREAM_NONCE,
    });

    expect(res.accepted).toBe(true);
    expect(res.packetsAccepted).toBe(2);
    expect(res.claims).toHaveLength(2);
    expect(res.claims.every((c) => c.verified)).toBe(true);
    expect(res.cumulativeSource).toBe('1000');

    // The underlying client received one FRESH sender-chosen condition per packet.
    expect(sendSpy).toHaveBeenCalledTimes(2);
    const conditions = sendSpy.mock.calls.map(
      (c) =>
        (c[0] as unknown as { executionCondition?: Uint8Array })
          .executionCondition
    );
    for (const condition of conditions) {
      expect(condition).toBeInstanceOf(Uint8Array);
      expect(condition).toHaveLength(32);
      expect(condition!.some((b) => b !== 0)).toBe(true);
    }
    expect(conditions[0]).not.toEqual(conditions[1]);
  });

  it('[#583] the ROLLING path sources the leg-B contract from the MAKER announce — a daemon holding only the leg-A tokenNetworks still verifies', async () => {
    // The live 2026-08-16 failure, reproduced at the seam that produced it:
    // a swap that succeeded on the wire (packet accepted, state completed)
    // delivered `claimsVerified: 0` / `valueReceived: "0"` because this path
    // seeded leg-B verification from the daemon's `tokenNetworks` — the
    // leg-A TokenNetwork the client PAYS the maker through.
    const maker = new FakeRollingMakerClient();
    const legAOnly = new ClientRunner({
      config: makeConfig({
        toonClientConfig: {
          btpUrl: 'ws://apex.test/btp',
          // ONLY leg A configured, exactly like the live ~/.toon-client
          // config.json. No swapVerifyingContracts anywhere locally.
          tokenNetworks: EVM_TOKEN_NETWORKS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
      createClient: (cfg) => {
        maker.jobHandler = cfg.jobHandler as typeof maker.jobHandler;
        return maker;
      },
      createRelay: fakeRelay,
    });
    // …and the maker announces its RollingSwapChannel (swap#134).
    maker.announcedSwapVerifyingContracts.set(
      'cd'.repeat(32),
      EVM_VERIFYING_CONTRACTS
    );
    await legAOnly.bootstrap();
    maker.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(1000 * seq),
        sourceAmount: '1000',
        targetAmount: '1000',
      });

    const res = await legAOnly.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      packetCount: 1,
      senderConditions: true,
      streamNonce: STREAM_NONCE,
    });

    expect(res.accepted).toBe(true);
    expect(res.packetsAccepted).toBe(1);
    expect(res.claims).toHaveLength(1);
    expect(res.claims[0]!.verified).toBe(true);
    // The pinned watermark records the LEG-B contract, never leg A.
    expect(legAOnly.listSwapClaims().claims[0]!.cumulativeAmount).toBe('1000');
    await legAOnly.stop();
  });

  // ── toon-client#585: the RFQ makes the rolling path REACHABLE ─────────────
  //
  // Every test below goes through the real `swap()` entry point with NO
  // `streamNonce` and NO out-of-band registration anywhere — which is the
  // whole acceptance criterion. The maker fake unwraps a real NIP-59 gift
  // wrap and seals a real kind:20034 back, so these exercise the wire, not
  // session bookkeeping.

  /** Boot a runner whose single apex client is an RFQ-capable maker fake. */
  async function rfqRunner(
    configure: (maker: FakeRfqMakerClient) => void = () => undefined
  ): Promise<{ runner: ClientRunner; maker: FakeRfqMakerClient }> {
    const maker = new FakeRfqMakerClient();
    configure(maker);
    const runner585 = new ClientRunner({
      config: makeConfig({}),
      createClient: (cfg) => {
        maker.jobHandler = cfg.jobHandler as typeof maker.jobHandler;
        return maker;
      },
      createRelay: fakeRelay,
    });
    maker.announcedSwapVerifyingContracts.set(
      maker.pubkey,
      EVM_VERIFYING_CONTRACTS
    );
    await runner585.bootstrap();
    maker.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(1000 * seq),
        sourceAmount: '1000',
        targetAmount: '1000',
        streamNonce: [...maker.sessions][0] ?? STREAM_NONCE,
      });
    return { runner: runner585, maker };
  }

  it('[#585] REACHABILITY: a stock swap() with no streamNonce establishes the session ON THE WIRE and fills against it', async () => {
    vi.mocked(streamSwap).mockClear();
    const { runner: r, maker } = await rfqRunner();

    const res = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
    });

    // The maker learned the session from a kind:20033 packet, not a method call.
    expect(maker.rfqRequests).toHaveLength(1);
    const [rfq] = maker.rfqRequests;
    if (!rfq) throw new Error('the maker parsed no RFQ off the wire');
    expect(rfq['proto']).toBe('rolling/1');
    expect(rfq['type']).toBe('rfq');
    expect(rfq['senderIlpAddress']).toBe('g.toon.client');
    expect(rfq['chainRecipient']).toBe(EVM_RECIPIENT);
    expect(rfq['sizeHint']).toBe('1000');
    expect(rfq['pair']).toEqual({
      from: EVM_PAIR.from,
      to: EVM_PAIR.to,
    });
    expect(maker.sessions.size).toBe(1);

    // …and the swap actually ran on the rolling path against it.
    expect(res.accepted).toBe(true);
    expect(res.claims).toHaveLength(1);
    expect(res.claims[0]?.verified).toBe(true);
    expect(res.rolling).toMatchObject({
      probed: true,
      used: true,
      streamNonce: [...maker.sessions][0],
      rate: '1.0',
      maxRateAge: 15_000,
      spreadBps: 40,
    });
    // The LEGACY path was never entered.
    expect(streamSwap).not.toHaveBeenCalled();
    await r.stop();
  });

  it('[#595] the SAME call against a maker with no RFQ intake THROWS, naming the maker, its ILP address and the reason', async () => {
    vi.mocked(streamSwap).mockClear();
    const { runner: r, maker } = await rfqRunner((m) => {
      m.rfqCapable = false;
    });
    const sendSpy = vi.spyOn(maker, 'sendSwapPacket');

    const err = await r
      .swap({
        destination: 'g.proxy.swap',
        amount: '1000',
        swapPubkey: maker.pubkey,
        pair: EVM_PAIR,
        chainRecipient: EVM_RECIPIENT,
      })
      .then(
        () => undefined,
        (e: unknown) => e
      );

    // The failure is the named one, not a silent downgrade.
    expect(err).toBeInstanceOf(RollingUnavailableError);
    const unavailable = err as RollingUnavailableError;
    expect(unavailable.reason).toBe('rejected');
    expect(unavailable.swapPubkey).toBe(maker.pubkey);
    expect(unavailable.destination).toBe('g.proxy.swap');
    expect(unavailable.probed).toBe(true);
    // Everything a stranded caller needs is IN the message, not only in fields.
    expect(unavailable.message).toContain(maker.pubkey);
    expect(unavailable.message).toContain('g.proxy.swap');
    expect(unavailable.message).toContain('rejected');
    expect(unavailable.message).toContain('F06');
    // Exactly ONE packet left this client: the probe. No legacy swap ran.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(maker.sessions.size).toBe(0);
    expect(streamSwap).not.toHaveBeenCalled();
    await r.stop();
  });

  it('[#595] an explicit `rolling: "auto"` still falls back to legacy — annotated AND warned, never silent', async () => {
    vi.mocked(streamSwap).mockClear();
    const claim = await signedEvmClaim({
      nonce: '1',
      cumulativeAmount: '1000',
      targetAmount: 1000n,
    });
    vi.mocked(streamSwap).mockResolvedValue(swapResult([claim]));
    const { runner: r, maker } = await rfqRunner((m) => {
      m.rfqCapable = false;
    });

    const res = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      rolling: 'auto',
    });

    // Succeeded — the escape hatch still WORKS, unchanged.
    expect(res.accepted).toBe(true);
    expect(streamSwap).toHaveBeenCalledTimes(1);
    expect(res.rolling).toMatchObject({
      probed: true,
      used: false,
      fallbackReason: 'rejected',
    });
    expect(res.rolling?.fallbackMessage).toContain('F06');
    // …and it is no longer possible to take the weaker path without seeing it.
    expect(res.warning).toMatch(/LEGACY/);
    expect(res.warning).toMatch(/rejected/);
    await r.stop();
  });

  it('[#595] a probe that THROWS locally throws by default, and falls back under explicit `auto`', async () => {
    vi.mocked(streamSwap).mockClear();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    const { runner: r, maker } = await rfqRunner();
    vi.spyOn(maker, 'sendSwapPacket').mockRejectedValue(
      new Error('PEER_NOT_NEGOTIATED (g.proxy.swap)')
    );
    const req = {
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
    };

    await expect(r.swap(req)).rejects.toThrow(RollingUnavailableError);
    await expect(r.swap(req)).rejects.toThrow(/PEER_NOT_NEGOTIATED/);
    expect(streamSwap).not.toHaveBeenCalled();

    const res = await r.swap({ ...req, rolling: 'auto' });
    expect(streamSwap).toHaveBeenCalledTimes(1);
    expect(res.rolling).toMatchObject({
      probed: true,
      used: false,
      fallbackReason: 'send-failed',
    });
    await r.stop();
  });

  it('[#595] an explicit `rolling: "require"` is the default, and refuses the same way', async () => {
    vi.mocked(streamSwap).mockClear();
    const { runner: r, maker } = await rfqRunner((m) => {
      m.rfqCapable = false;
    });
    await expect(
      r.swap({
        destination: 'g.proxy.swap',
        amount: '1000',
        swapPubkey: maker.pubkey,
        pair: EVM_PAIR,
        chainRecipient: EVM_RECIPIENT,
        rolling: 'require',
      })
    ).rejects.toThrow(/did not establish a rolling session \(reason: rejected\)/);
    expect(streamSwap).not.toHaveBeenCalled();
    await r.stop();
  });

  it('[#595] `rolling: "off"` pays for no probe at all — and says so on the response', async () => {
    vi.mocked(streamSwap).mockClear();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    const { runner: r, maker } = await rfqRunner();
    const sendSpy = vi.spyOn(maker, 'sendSwapPacket');
    const res = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      rolling: 'off',
    });
    expect(sendSpy).not.toHaveBeenCalled();
    expect(maker.rfqRequests).toHaveLength(0);
    expect(streamSwap).toHaveBeenCalledTimes(1);
    // #595: it used to leave NO `rolling` block at all, so a legacy swap was
    // indistinguishable from a rolling one downstream.
    expect(res.rolling).toMatchObject({
      probed: false,
      used: false,
      fallbackReason: 'off',
    });
    expect(res.warning).toMatch(/LEGACY/);
    await r.stop();
  });

  it('[#595] `swapDefaults.rolling: "off"` turns the probe off daemon-wide, still annotated', async () => {
    vi.mocked(streamSwap).mockClear();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    const maker = new FakeRfqMakerClient();
    const r = new ClientRunner({
      config: makeConfig({ swapDefaults: { rolling: 'off' } }),
      createClient: () => maker,
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    const res = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
    });
    expect(maker.rfqRequests).toHaveLength(0);
    expect(streamSwap).toHaveBeenCalledTimes(1);
    expect(res.rolling).toMatchObject({ fallbackReason: 'off' });
    await r.stop();
  });

  it('[#595] `swapDefaults.rolling: "auto"` restores the fleet-wide fallback for one release', async () => {
    vi.mocked(streamSwap).mockClear();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    const maker = new FakeRfqMakerClient();
    maker.rfqCapable = false;
    const r = new ClientRunner({
      config: makeConfig({ swapDefaults: { rolling: 'auto' } }),
      createClient: () => maker,
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    const res = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
    });
    expect(streamSwap).toHaveBeenCalledTimes(1);
    expect(res.rolling).toMatchObject({ used: false, probed: true });
    await r.stop();
  });

  it("[#585] an explicit senderIlpAddress wins over the client's own — it is the leg-B destination and has no fallback", async () => {
    const { runner: r, maker } = await rfqRunner();
    await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      senderIlpAddress: 'g.proxy.agents.one',
    });
    expect(maker.rfqRequests[0]?.['senderIlpAddress']).toBe(
      'g.proxy.agents.one'
    );
    await r.stop();
  });

  it('[#585/#595] a client that cannot state its own receive address never opens a session whose leg B cannot arrive — and now says so out loud', async () => {
    vi.mocked(streamSwap).mockClear();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    const { runner: r, maker } = await rfqRunner((m) => {
      m.ownIlpAddress = undefined;
    });
    const req = {
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
    };
    // A LOCAL reason still names itself rather than downgrading quietly.
    await expect(r.swap(req)).rejects.toThrow(/no-sender-address/);
    expect(maker.rfqRequests).toHaveLength(0);
    expect(streamSwap).not.toHaveBeenCalled();

    const res = await r.swap({ ...req, rolling: 'auto' });
    expect(maker.rfqRequests).toHaveLength(0);
    expect(res.rolling).toMatchObject({
      probed: false,
      used: false,
      fallbackReason: 'no-sender-address',
    });
    expect(streamSwap).toHaveBeenCalledTimes(1);
    await r.stop();
  });

  it("[#585] the floor is armed from the QUOTE's R₀, not the advertised pair rate", async () => {
    const { runner: r, maker } = await rfqRunner((m) => {
      m.quoteRate = '2.0';
    });
    const res = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      // The advertised rate is 1.0; the quote says 2.0. 50 bps off the QUOTE
      // is 1.99 — off the advertised rate it would have been 0.995.
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      floorBps: 50,
    });
    expect(res.minExchangeRate).toBe('1.99');
    await r.stop();
  });

  it('[#585] the probe pays the route price, not the swap notional', async () => {
    const { runner: r, maker } = await rfqRunner();
    maker.routePrice = 42n;
    const sendSpy = vi.spyOn(maker, 'sendSwapPacket');
    await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
    });
    expect(sendSpy.mock.calls[0]?.[0]?.amount).toBe(42n);
    // …and rfqAmount pins it outright.
    sendSpy.mockClear();
    maker.rfqRequests.length = 0;
    maker.sessions.clear();
    await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      rfqAmount: '7',
    });
    expect(sendSpy.mock.calls[0]?.[0]?.amount).toBe(7n);
    await r.stop();
  });

  it('[#585] a quote maxAmount splits the stream instead of sending one over-cap packet', async () => {
    const { runner: r, maker } = await rfqRunner((m) => {
      m.quoteMaxAmount = '400';
    });
    const sendSpy = vi.spyOn(maker, 'sendSwapPacket');
    await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: maker.pubkey,
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
    });
    // 1 RFQ probe + ⌈1000/400⌉ = 3 fills.
    expect(sendSpy).toHaveBeenCalledTimes(4);
    for (const call of sendSpy.mock.calls.slice(1)) {
      expect(call[0]?.amount).toBeLessThanOrEqual(400n);
    }
    await r.stop();
  });

  it('[#583] a rolling claim with NO leg-B contract from either source fails MISSING_SWAP_VERIFYING_CONTRACT, not SIGNER_MISMATCH', async () => {
    const maker = new FakeRollingMakerClient();
    const noneKnown = new ClientRunner({
      config: makeConfig({
        toonClientConfig: {
          btpUrl: 'ws://apex.test/btp',
          tokenNetworks: EVM_TOKEN_NETWORKS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
      createClient: (cfg) => {
        maker.jobHandler = cfg.jobHandler as typeof maker.jobHandler;
        return maker;
      },
      createRelay: fakeRelay,
    });
    // The maker announces NOTHING for leg B (a pre-swap#134 maker).
    await noneKnown.bootstrap();
    maker.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(1000 * seq),
        sourceAmount: '1000',
        targetAmount: '1000',
      });

    const res = await noneKnown.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      packetCount: 1,
      senderConditions: true,
      streamNonce: STREAM_NONCE,
    });

    expect(res.claims).toHaveLength(0);
    const reject = res.rejections?.[0];
    expect(reject).toBeDefined();
    // The whole point: it names the missing contract instead of blaming a key.
    expect(reject!.message).toContain('MISSING_SWAP_VERIFYING_CONTRACT');
    expect(reject!.message).not.toContain('SIGNER_MISMATCH');
    expect(reject!.message).toContain('RollingSwapChannel');
    await noneKnown.stop();
  });

  it('the CRUX (#573 AC): a withheld/failed leg-B verification never reveals leg A — no collectable claim for that packet', async () => {
    const maker = new FakeRollingMakerClient();
    const rollingRunner = new ClientRunner({
      config: makeConfig(),
      createClient: (cfg) => {
        maker.jobHandler = cfg.jobHandler as typeof maker.jobHandler;
        return maker;
      },
      createRelay: fakeRelay,
    });
    await rollingRunner.bootstrap();

    // seq 1 is signed by the WRONG key — the daemon's leg-B verification
    // must fail it, so no preimage is ever revealed and the maker's connector
    // has nothing valid to relay upstream on leg A (spec R5/R8's coupled
    // unwind — this is the property #573 makes reachable, not extra logic).
    const OTHER_SIGNER = privateKeyToAccount(
      '0x8975a7907e8f3b5db9d6ae3d44d16adaa3db1401b7a9fdfd433278077178bdc8'
    );
    maker.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(500 * seq),
        sourceAmount: '500',
        targetAmount: '500',
        ...(seq === 1 ? { signer: OTHER_SIGNER } : {}),
      });

    const res = await rollingRunner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      packetCount: 2,
      senderConditions: true,
      streamNonce: STREAM_NONCE,
    });

    // Packet 1 (bad signature): no collectable claim — leg A never revealed.
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections?.[0]?.packetIndex).toBe(0);
    // Packet 2 (valid, maker reuses nonce 2 as its own watermark advances):
    // still collected — one packet's withheld leg B doesn't sink the stream.
    expect(res.claims).toHaveLength(1);
    expect(res.claims[0]?.nonce).toBe('2');
    expect(res.cumulativeSource).toBe('500');
    expect(res.state).toBe('failed');
  });

  it('a rolling swap that delivers NOTHING says so, and names `rolling: "off"`', async () => {
    // The live shape after swap#148: the RFQ succeeds, a session is
    // established, and then every leg B is undeliverable — the maker unwinds
    // and answers leg A with F99. `rolling: "auto"` cannot fall back here
    // (its fallback covers RFQ *failure*), and re-running the fill as legacy
    // is exactly what would risk double-paying. So the result has to be
    // self-diagnosing instead: a caller reading only
    // `leg B failed; fill not executed` has no way to know the legacy path is
    // right there and working.
    class UndeliverableLegBMaker extends FakeRollingMakerClient {
      override async sendSwapPacket(): Promise<{
        accepted: boolean;
        code?: string;
        message?: string;
      }> {
        // Never reaches the jobHandler — nothing crosses the wire to us.
        return {
          accepted: false,
          code: 'F99',
          message: 'leg B failed; fill not executed',
        };
      }
    }
    const maker = new UndeliverableLegBMaker();
    const rollingRunner = new ClientRunner({
      config: makeConfig(),
      createClient: (cfg) => {
        maker.jobHandler = cfg.jobHandler as typeof maker.jobHandler;
        return maker;
      },
      createRelay: fakeRelay,
    });
    await rollingRunner.bootstrap();

    const res = await rollingRunner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      packetCount: 1,
      senderConditions: true,
      streamNonce: STREAM_NONCE,
    });

    expect(res.accepted).toBe(false);
    expect(res.packetsAccepted).toBe(0);
    // The diagnosis the old warning never gave.
    expect(res.warning).toContain('rolling: "off"');
    expect(res.warning).toContain('delivered');
    // …without ever claiming it retried anything on the caller's behalf.
    expect(res.warning).toContain('NOT retried as legacy');
    await rollingRunner.stop();
  });

  it('swap without senderConditions keeps the legacy path: no condition injected', async () => {
    await runner.bootstrap();
    const pair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    };
    const sendSpy = vi.spyOn(client, 'sendSwapPacket');

    vi.mocked(streamSwap).mockImplementation(async (params) => {
      await (
        params.client as unknown as {
          sendSwapPacket(p: unknown): Promise<unknown>;
        }
      ).sendSwapPacket({
        destination: params.swapIlpAddress,
        amount: 1000n,
        toonData: new Uint8Array([0]),
      });
      return {
        state: 'completed',
        claims: [],
        rejections: [],
        errors: [],
        abortReason: 'complete',
        cumulativeSource: 1000n,
        cumulativeTarget: 999n,
        packetsSent: 1,
        packetsScheduled: 1,
      } as unknown as Awaited<ReturnType<typeof streamSwap>>;
    });

    await runner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
      // #595: legacy is opt-in now — this suite exercises the legacy body.
      rolling: 'auto' as const,
    });

    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(
      (sendSpy.mock.calls[0]![0] as unknown as Record<string, unknown>)[
        'executionCondition'
      ]
    ).toBeUndefined();
  });

  it('swap surfaces a swap peer rejection (no claims) as not-accepted', async () => {
    await runner.bootstrap();
    const pair = {
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
      to: { assetCode: 'USDC', assetScale: 6, chain: 'solana:devnet' },
      rate: '1.0',
    };
    vi.mocked(streamSwap).mockResolvedValue({
      state: 'failed',
      claims: [],
      rejections: [
        {
          packetIndex: 0,
          sourceAmount: 1000n,
          code: 'F99',
          message: 'Payment rejected',
        },
      ],
      errors: [],
      abortReason: 'all-rejected',
      cumulativeSource: 0n,
      cumulativeTarget: 0n,
      packetsSent: 1,
      packetsScheduled: 1,
    } as unknown as Awaited<ReturnType<typeof streamSwap>>);

    const res = await runner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair,
      chainRecipient: 'SoLrecipient',
      // #595: legacy is opt-in now — this suite exercises the legacy body.
      rolling: 'auto' as const,
    });
    expect(res.accepted).toBe(false);
    expect(res.packetsAccepted).toBe(0);
    expect(res.code).toBe('F99');
    expect(res.message).toBe('Payment rejected');
  });

  // ── Rolling-swap sender defenses (#351): floor, controller, telemetry ──────

  /** The pair used across the #351 defense tests (advertised rate 4.0). */
  const DEFENSE_PAIR = {
    from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:base:84532' },
    to: { assetCode: 'MINA', assetScale: 6, chain: 'mina:devnet' },
    rate: '4.0',
  };
  const DEFENSE_SWAP = {
    destination: 'g.proxy.swap',
    amount: '1000',
    swapPubkey: 'cd'.repeat(32),
    pair: DEFENSE_PAIR,
    chainRecipient: 'SoLrecipient',
    // #595: the #351 sender defenses under test here are `streamSwap`
    // features, so this fixture asks for the legacy path EXPLICITLY. Under
    // the default (`rolling: 'require'`) an unanswered probe now throws.
    rolling: 'auto' as const,
  };
  /** Minimal completed StreamSwapResult, override what the test needs. */
  function defenseSwapResult(
    overrides: Record<string, unknown> = {}
  ): Awaited<ReturnType<typeof streamSwap>> {
    return {
      state: 'completed',
      claims: [],
      rejections: [],
      errors: [],
      abortReason: 'complete',
      cumulativeSource: 0n,
      cumulativeTarget: 0n,
      packetsSent: 0,
      packetsScheduled: 0,
      ...overrides,
    } as unknown as Awaited<ReturnType<typeof streamSwap>>;
  }

  it('swap passes minExchangeRate through and surfaces a BELOW_FLOOR halt (#351)', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    vi.mocked(streamSwap).mockResolvedValue(
      defenseSwapResult({
        state: 'failed',
        rejections: [
          {
            packetIndex: 0,
            sourceAmount: 1000n,
            code: 'BELOW_FLOOR',
            message: 'tape rate 3.9000 below floor 3.98',
          },
        ],
        abortReason: 'below-floor',
      })
    );

    const res = await runner.swap({ ...DEFENSE_SWAP, minExchangeRate: '3.98' });

    // The hard floor reached the sdk verbatim.
    const arg = vi.mocked(streamSwap).mock.calls[0]![0];
    expect(arg.minExchangeRate).toBe('3.98');
    // The breach halted the stream and is surfaced on the response.
    expect(res.accepted).toBe(false);
    expect(res.state).toBe('failed');
    expect(res.code).toBe('BELOW_FLOOR');
    expect(res.abortReason).toBe('below-floor');
    expect(res.rejections).toEqual([
      {
        packetIndex: 0,
        sourceAmount: '1000',
        code: 'BELOW_FLOOR',
        message: 'tape rate 3.9000 below floor 3.98',
      },
    ]);
    // Consent surface: the armed floor is echoed for the host to show.
    expect(res.minExchangeRate).toBe('3.98');
  });

  it('swap derives the floor from floorBps against the advertised rate (spec §5 R₀ × (1 − tolerance))', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    vi.mocked(streamSwap).mockResolvedValue(defenseSwapResult());
    // 50 bps under the advertised 4.0 → 3.98, exact decimal-string math.
    const res = await runner.swap({ ...DEFENSE_SWAP, floorBps: 50 });
    expect(vi.mocked(streamSwap).mock.calls[0]![0].minExchangeRate).toBe(
      '3.98'
    );
    expect(res.minExchangeRate).toBe('3.98');
  });

  it('deriveFloorRate does exact decimal math and validates its inputs', () => {
    expect(deriveFloorRate('4.0', 50)).toBe('3.98');
    expect(deriveFloorRate('3.9800', 50)).toBe('3.9601');
    expect(deriveFloorRate('1', 0)).toBe('1');
    expect(deriveFloorRate('0.000001', 2500)).toBe('0.00000075');
    expect(deriveFloorRate('4.0', undefined)).toBeUndefined();
    expect(() => deriveFloorRate('4.0', 10000)).toThrow(InvalidPayloadError);
    expect(() => deriveFloorRate('4.0', -1)).toThrow(InvalidPayloadError);
    expect(() => deriveFloorRate('4.0', 0.5)).toThrow(InvalidPayloadError);
    expect(() => deriveFloorRate('4e-2', 50)).toThrow(InvalidPayloadError);
  });

  it('swap with defaults off sends the byte-identical legacy request (only local-only onPacket/logger added)', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    vi.mocked(streamSwap).mockResolvedValue(defenseSwapResult());
    await runner.swap(DEFENSE_SWAP);
    const arg = vi.mocked(streamSwap).mock.calls[0]![0];
    // Exactly the legacy key set plus the two LOCAL-ONLY observability hooks
    // (`onPacket` telemetry, `logger` diagnostics — neither touches the wire):
    // no floor, no controller, no expiry stamping, no abort signal.
    expect(Object.keys(arg).sort()).toEqual(
      [
        'chainRecipient',
        'client',
        'logger',
        'onPacket',
        'pair',
        'packetCount',
        'senderSecretKey',
        'swapIlpAddress',
        'swapPubkey',
        'totalAmount',
      ].sort()
    );
    expect(arg.packetCount).toBe(1);
    expect(arg.minExchangeRate).toBeUndefined();
    expect(arg.controller).toBeUndefined();
    expect(arg.packetExpiryMs).toBeUndefined();
    expect(arg.signal).toBeUndefined();
  });

  it('swap engages the adaptive controller when configured, replacing the even split (#351)', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    vi.mocked(streamSwap).mockImplementation(async (params) => {
      // The controller is live: it sizes packets and accepts observations.
      const ctrl = params.controller!;
      const delta = ctrl.nextDelta(1000n);
      expect(delta).toBeGreaterThanOrEqual(1n);
      expect(delta).toBeLessThanOrEqual(1000n);
      expect(ctrl.window).toBeGreaterThanOrEqual(1);
      await ctrl.observe({ resolution: 'fulfill', rttMs: 50 });
      return defenseSwapResult();
    });
    await runner.swap({
      ...DEFENSE_SWAP,
      controller: { advertisedSpread: 0.004, maxPacketAmount: '100' },
    });
    const arg = vi.mocked(streamSwap).mock.calls[0]![0];
    expect(arg.controller).toBeDefined();
    // EXACTLY ONE of controller/packetCount (sdk contract): no even split.
    expect(arg.packetCount).toBeUndefined();
  });

  it('swap rejects controller + packetCount (mutually exclusive) and a missing advertisedSpread', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    vi.mocked(streamSwap).mockResolvedValue(defenseSwapResult());
    await expect(
      runner.swap({
        ...DEFENSE_SWAP,
        packetCount: 2,
        controller: { advertisedSpread: 0.004 },
      })
    ).rejects.toThrow(InvalidPayloadError);
    await expect(
      runner.swap({
        ...DEFENSE_SWAP,
        controller: { advertisedSpread: 0 },
      })
    ).rejects.toThrow(/advertisedSpread/);
    expect(streamSwap).not.toHaveBeenCalled();
  });

  it('swap persists controller state per-(chain, maker, pair) and reloads it on the next swap (#351)', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    const controllerParams = { advertisedSpread: 0.004 };

    // Swap 1: cold start. Seed δ via nextDelta, persist via observe.
    vi.mocked(streamSwap).mockImplementation(async (params) => {
      const ctrl = params.controller as AdaptiveDeltaController;
      ctrl.nextDelta(BigInt(DEFENSE_SWAP.amount)); // seeds δ_0 = 1000/256 = 3
      await ctrl.observe({ resolution: 'fulfill', rttMs: 100 });
      return defenseSwapResult();
    });
    await runner.swap({ ...DEFENSE_SWAP, controller: controllerParams });

    // State landed in the daemon data dir, keyed by the canonical tuple.
    const stateFile = join(tmpDir, 'swap-controller-state.json');
    const key = swapControllerStateKey({
      makerPubkey: DEFENSE_SWAP.swapPubkey,
      pair: DEFENSE_PAIR,
    });
    const persisted = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<
      string,
      { v: number; delta: string }
    >;
    expect(Object.keys(persisted)).toEqual([key]);
    expect(persisted[key]).toMatchObject({ v: 1, delta: '3' });

    // Swap 2 (same tuple): the controller resumes from the persisted ramp
    // instead of starting cold.
    let resumedDelta: string | undefined;
    vi.mocked(streamSwap).mockImplementation(async (params) => {
      resumedDelta = (params.controller as AdaptiveDeltaController).state.delta;
      return defenseSwapResult();
    });
    await runner.swap({ ...DEFENSE_SWAP, controller: controllerParams });
    expect(resumedDelta).toBe('3');

    // A different maker is a different tuple: cold state, same file.
    vi.mocked(streamSwap).mockImplementation(async (params) => {
      resumedDelta = (params.controller as AdaptiveDeltaController).state.delta;
      return defenseSwapResult();
    });
    await runner.swap({
      ...DEFENSE_SWAP,
      swapPubkey: 'ef'.repeat(32),
      controller: controllerParams,
    });
    expect(resumedDelta).toBe('0'); // '0' = δ not yet seeded (cold start)
  });

  it('swap applies daemon-level swapDefaults, and an explicit packetCount pins the legacy split', async () => {
    const c = new FakeClient();
    const r = new ClientRunner({
      config: makeConfig({
        apex: {
          destination: 'g.proxy',
          peerId: 'proxy',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: '0xapex',
          tokenAddress: '0xusdc',
          tokenNetwork: '0xtn',
        },
        swapDefaults: {
          floorBps: 100,
          packetExpiryMs: 5000,
          controller: { advertisedSpread: 0.004 },
        },
      }),
      createClient: () => c,
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    vi.mocked(streamSwap).mockReset();
    vi.mocked(streamSwap).mockResolvedValue(defenseSwapResult());

    // No per-request knobs → daemon defaults engage everything.
    await r.swap(DEFENSE_SWAP);
    const arg = vi.mocked(streamSwap).mock.calls[0]![0];
    expect(arg.minExchangeRate).toBe('3.96'); // 4.0 × (1 − 100/10000)
    expect(arg.packetExpiryMs).toBe(5000);
    expect(arg.controller).toBeDefined();
    expect(arg.packetCount).toBeUndefined();

    // An explicit packetCount pins the legacy even split (the default
    // controller stays out); floor/expiry defaults still apply.
    await r.swap({ ...DEFENSE_SWAP, packetCount: 2 });
    const arg2 = vi.mocked(streamSwap).mock.calls[1]![0];
    expect(arg2.controller).toBeUndefined();
    expect(arg2.packetCount).toBe(2);
    expect(arg2.minExchangeRate).toBe('3.96');

    // A per-request floor beats the daemon default.
    await r.swap({ ...DEFENSE_SWAP, minExchangeRate: '3.99' });
    expect(vi.mocked(streamSwap).mock.calls[2]![0].minExchangeRate).toBe(
      '3.99'
    );
  });

  it('swap surfaces per-packet outcomes + a realized-rate summary from onPacket (#351)', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    const progress = (index: number): PacketProgress =>
      Object.freeze({
        index,
        total: 2,
        sourceAmount: 500n,
        targetAmount: 1990n,
        advertisedRate: '4.0',
        effectiveRate: 3.98,
        rateDeviation: 0.005,
        cumulativeSource: BigInt(500 * (index + 1)),
        cumulativeTarget: BigInt(1990 * (index + 1)),
        rate: '3.99',
        rateTimestamp: 1234,
        state: 'running',
      }) as PacketProgress;
    vi.mocked(streamSwap).mockImplementation(async (params) => {
      await params.onPacket!(progress(0));
      await params.onPacket!(progress(1));
      return defenseSwapResult({
        cumulativeSource: 1000n,
        cumulativeTarget: 3980n,
        packetsSent: 2,
        packetsScheduled: 2,
      });
    });

    const res = await runner.swap(DEFENSE_SWAP);
    expect(res.packets).toEqual([
      {
        index: 0,
        sourceAmount: '500',
        targetAmount: '1990',
        effectiveRate: 3.98,
        rateDeviation: 0.005,
        rate: '3.99',
        rateTimestamp: 1234,
      },
      expect.objectContaining({ index: 1 }),
    ]);
    expect(res.packetsTruncated).toBeUndefined();
    // Realized rate in whole units (equal scales): 3980 / 1000 = 3.98.
    expect(res.realizedRate).toBeCloseTo(3.98, 10);
    expect(res.abortReason).toBe('complete');
  });

  it('swap arms an abort signal from timeoutMs and reports a partial fill accurately', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    const pair = DEFENSE_PAIR;
    vi.mocked(streamSwap).mockResolvedValue(
      defenseSwapResult({
        state: 'stopped',
        abortReason: 'aborted',
        claims: [
          {
            packetIndex: 0,
            sourceAmount: 500n,
            targetAmount: 1990n,
            claimBytes: new Uint8Array([9]),
            swapEphemeralPubkey: 'ab'.repeat(32),
            swapSignerAddress: '0xswapsigner',
            pair,
            receivedAt: 0,
          },
        ],
        cumulativeSource: 500n,
        cumulativeTarget: 1990n,
        packetsSent: 2,
        packetsScheduled: 2,
      })
    );

    const res = await runner.swap({ ...DEFENSE_SWAP, timeoutMs: 60_000 });
    const arg = vi.mocked(streamSwap).mock.calls[0]![0];
    expect(arg.signal).toBeInstanceOf(AbortSignal);
    // Partial fill: one of two packets landed before the abort.
    expect(res.state).toBe('stopped');
    expect(res.abortReason).toBe('aborted');
    expect(res.packetsAccepted).toBe(1);
    expect(res.cumulativeSource).toBe('500');
    expect(res.cumulativeTarget).toBe('1990');
  });

  it('[#585] a pinned rolling session + the legacy-only adaptive controller is refused, not silently resolved either way', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    const sendSpy = vi.spyOn(client, 'sendSwapPacket');

    await expect(
      runner.swap({
        ...DEFENSE_SWAP,
        senderConditions: true,
        streamNonce: STREAM_NONCE,
        // `minExchangeRate` is NO LONGER part of the incompatibility (#585
        // armed the floor on the rolling path); `controller` still is.
        minExchangeRate: '3.98',
        controller: { advertisedSpread: 0.004 },
      })
    ).rejects.toThrow(InvalidPayloadError);

    // Neither path was ever driven — the guard fires before either fires.
    expect(streamSwap).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('[#585] a request that asks for the adaptive controller takes the LEGACY path without paying for a probe', async () => {
    await runner.bootstrap();
    vi.mocked(streamSwap).mockReset();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    const sendSpy = vi.spyOn(client, 'sendSwapPacket');

    const res = await runner.swap({
      ...DEFENSE_SWAP,
      controller: { advertisedSpread: 0.004 },
    });

    expect(sendSpy).not.toHaveBeenCalled();
    expect(streamSwap).toHaveBeenCalledTimes(1);
    expect(res.rolling).toMatchObject({
      probed: false,
      used: false,
      fallbackReason: 'controller',
    });
  });

  // ── Receive-side claim ingestion/verification/settlement (#352) ────────────

  const swapReq = (
    over: Partial<Parameters<ClientRunner['swap']>[0]> = {}
  ) => ({
    destination: 'g.proxy.swap',
    amount: '1000',
    swapPubkey: 'cd'.repeat(32),
    pair: EVM_PAIR,
    chainRecipient: EVM_RECIPIENT,
    // #595: these suites are about receive-side claim ingestion on the LEGACY
    // path, which is opt-in now — the default `rolling: 'require'` throws when
    // the probe (unbuildable against this placeholder pubkey) fails.
    rolling: 'auto' as const,
    ...over,
  });

  it('swap REJECTS a tampered claim loudly: not counted, not persisted, swap not accepted (#352)', async () => {
    await runner.bootstrap();
    // The signature covers cumulative=500 but the claim ADVERTISES 999 — a
    // maker inflating the advertised watermark beyond what it signed.
    const tampered = await signedEvmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      signedCumulative: '500',
      targetAmount: 999n,
    });
    vi.mocked(streamSwap).mockResolvedValue(swapResult([tampered]));

    const res = await runner.swap(swapReq({ swapSignerAddress: SWAP_SIGNER }));

    // The packet FULFILLed at transport level but the claim FAILED
    // verification: never counted as value received, swap not accepted.
    expect(res.accepted).toBe(false);
    expect(res.claimsVerified).toBe(0);
    expect(res.claimsRejected).toBe(1);
    expect(res.valueReceived).toBe('0');
    expect(res.claims[0]!.verified).toBe(false);
    expect(res.claims[0]!.verificationError?.code).toBe('SIGNER_MISMATCH');
    expect(res.warning).toMatch(/FAILED verification/);
    // Nothing was persisted.
    expect(runner.listSwapClaims().claims).toHaveLength(0);
  });

  it('swap REJECTS a claim signed by the wrong signer: SWAP_SIGNER_MISMATCH against the advertised address (#352)', async () => {
    await runner.bootstrap();
    const claim = await signedEvmClaim({
      nonce: '1',
      cumulativeAmount: '999',
      targetAmount: 999n,
    });
    vi.mocked(streamSwap).mockResolvedValue(swapResult([claim]));

    const res = await runner.swap(
      // Maker's ADVERTISED signer differs from the claim's self-reported one.
      swapReq({ swapSignerAddress: '0x' + 'cc'.repeat(20) })
    );

    expect(res.accepted).toBe(false);
    expect(res.claims[0]!.verificationError?.code).toBe('SWAP_SIGNER_MISMATCH');
    expect(res.valueReceived).toBe('0');
    expect(runner.listSwapClaims().claims).toHaveLength(0);
  });

  it('swap REJECTS a non-monotonic nonce/cumulative against the persisted watermark (#352)', async () => {
    await runner.bootstrap();
    const first = await signedEvmClaim({
      nonce: '2',
      cumulativeAmount: '2000',
      targetAmount: 2000n,
    });
    vi.mocked(streamSwap).mockResolvedValue(swapResult([first]));
    await runner.swap(swapReq());

    // A replayed/stale claim: same nonce, same cumulative — validly signed.
    const replay = await signedEvmClaim({
      nonce: '2',
      cumulativeAmount: '2000',
      targetAmount: 2000n,
    });
    vi.mocked(streamSwap).mockResolvedValue(swapResult([replay]));
    const res = await runner.swap(swapReq());

    expect(res.accepted).toBe(false);
    expect(res.claims[0]!.verificationError?.code).toBe('NON_MONOTONIC_NONCE');
    expect(res.valueReceived).toBe('0');
    // The watermark still holds the FIRST claim.
    expect(runner.listSwapClaims().claims[0]).toMatchObject({
      nonce: '2',
      cumulativeAmount: '2000',
    });
  });

  it('swap folds N packets into ONE per-channel watermark with summed value (#352)', async () => {
    await runner.bootstrap();
    const claims = [
      await signedEvmClaim({
        nonce: '1',
        cumulativeAmount: '300',
        targetAmount: 300n,
        packetIndex: 0,
      }),
      await signedEvmClaim({
        nonce: '2',
        cumulativeAmount: '600',
        targetAmount: 300n,
        packetIndex: 1,
      }),
      await signedEvmClaim({
        nonce: '3',
        cumulativeAmount: '900',
        targetAmount: 300n,
        packetIndex: 2,
      }),
    ];
    vi.mocked(streamSwap).mockResolvedValue(
      swapResult(claims, { source: 900n, target: 900n })
    );

    const res = await runner.swap(swapReq({ packetCount: 3 }));
    expect(res.claimsVerified).toBe(3);
    expect(res.valueReceived).toBe('900');

    // One persisted entry — the final watermark.
    const listed = runner.listSwapClaims().claims;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ nonce: '3', cumulativeAmount: '900' });
  });

  it('persisted received claims survive a daemon restart (#352)', async () => {
    const storePath = join(tmpDir, 'received-claims.json');
    const mkRunner = () =>
      new ClientRunner({
        config: makeConfig({ receivedClaimStorePath: storePath }),
        createClient: () => client,
        createRelay: fakeRelay,
      });
    const first = mkRunner();
    await first.bootstrap();
    vi.mocked(streamSwap).mockResolvedValue(
      swapResult([
        await signedEvmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ])
    );
    await first.swap(swapReq());
    expect(first.listSwapClaims().claims).toHaveLength(1);
    await first.stop();

    // A FRESH runner (daemon restart) reads the same store file.
    const second = mkRunner();
    const listed = second.listSwapClaims().claims;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({
      chain: EVM_PAIR.to.chain,
      channelId: EVM_CHANNEL,
      nonce: '1',
      cumulativeAmount: '999',
      swapSignerAddress: SWAP_SIGNER,
    });
    await second.stop();
  });

  it('settleSwapClaims builds ONE settlement with the final watermark and submits it via the client (#352)', async () => {
    // Chain plumbing configured: RollingSwapChannel + RPC for the target chain.
    const settleRunner = new ClientRunner({
      config: makeConfig({
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: {
          btpUrl: 'ws://apex.test/btp',
          swapVerifyingContracts: EVM_VERIFYING_CONTRACTS,
          chainRpcUrls: { [EVM_PAIR.to.chain]: 'http://127.0.0.1:8545' },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    const settleSpy = vi.fn(async () => ({
      txHash: '0xsettletx',
      status: 'success' as const,
    }));
    client.settleSwapBundle = settleSpy;
    await settleRunner.bootstrap();

    // Three verified advances → one persisted watermark.
    vi.mocked(streamSwap).mockResolvedValue(
      swapResult([
        await signedEvmClaim({
          nonce: '1',
          cumulativeAmount: '300',
          targetAmount: 300n,
          packetIndex: 0,
        }),
        await signedEvmClaim({
          nonce: '2',
          cumulativeAmount: '600',
          targetAmount: 300n,
          packetIndex: 1,
        }),
        await signedEvmClaim({
          nonce: '3',
          cumulativeAmount: '900',
          targetAmount: 300n,
          packetIndex: 2,
        }),
      ])
    );
    await settleRunner.swap(swapReq({ packetCount: 3 }));

    const settle = await settleRunner.settleSwapClaims({});
    expect(settle.results).toHaveLength(1);
    const r = settle.results[0]!;
    expect(r.built).toBe(true);
    expect(r.submitted).toBe(true);
    expect(r.txHash).toBe('0xsettletx');
    // ONE on-chain close with the FINAL watermark, not three.
    expect(r.nonce).toBe('3');
    expect(r.cumulativeAmount).toBe('900');
    expect(settleSpy).toHaveBeenCalledTimes(1);
    expect(typeof r.unsignedTx).toBe('string');

    // The watermark is marked settled…
    expect(settleRunner.listSwapClaims().claims[0]).toMatchObject({
      settledNonce: '3',
      settleTxHash: '0xsettletx',
    });
    // …so a re-run skips it instead of double-spending gas.
    const again = await settleRunner.settleSwapClaims({});
    expect(again.results[0]!.error?.code).toBe('ALREADY_SETTLED');
    expect(settleSpy).toHaveBeenCalledTimes(1);
    await settleRunner.stop();
  });

  it('settleSwapClaims survives config drift across a restart: the pinned verifyingContract (#572) carries the settle (env-gated seam, #352)', async () => {
    // The v2 receive path needs swapVerifyingContracts to INGEST an EVM claim,
    // so seed a watermark with a configured runner, then settle with one whose
    // config was dropped (config drift across a restart). Issue #572:
    // the contract the claim verified against is now PINNED onto the entry at
    // ingest time, so settlement still finds it even though config drifted.
    const storePath = join(tmpDir, 'received-claims.json');
    const seeded = new ClientRunner({
      config: makeConfig({ receivedClaimStorePath: storePath }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    await seeded.bootstrap();
    vi.mocked(streamSwap).mockResolvedValue(
      swapResult([
        await signedEvmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ])
    );
    await seeded.swap(swapReq());
    expect(seeded.listSwapClaims().claims).toHaveLength(1);
    await seeded.stop();

    // A runner reading the same store but with NO swapVerifyingContracts
    // configured still builds+settles: the entry's own pinned
    // verifyingContract covers it.
    const noConfig = new ClientRunner({
      config: makeConfig({
        receivedClaimStorePath: storePath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: { btpUrl: 'ws://apex.test/btp' } as any,
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    const res = await noConfig.settleSwapClaims({ submit: false });
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.built).toBe(true);
    expect(res.results[0]!.error).toBeUndefined();
  });

  it('settleSwapClaims is result-shaped when a LEGACY entry (no pinned verifyingContract, pre-#572) also has no config (env-gated seam, #352)', async () => {
    const storePath = join(tmpDir, 'received-claims.json');
    const seeded = new ClientRunner({
      config: makeConfig({ receivedClaimStorePath: storePath }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    await seeded.bootstrap();
    vi.mocked(streamSwap).mockResolvedValue(
      swapResult([
        await signedEvmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ])
    );
    await seeded.swap(swapReq());
    expect(seeded.listSwapClaims().claims).toHaveLength(1);
    await seeded.stop();

    // Simulate a watermark persisted BEFORE #572 pinned verifyingContract at
    // ingest time — strip it from the store file on disk.
    const stored = JSON.parse(readFileSync(storePath, 'utf-8')) as Record<
      string,
      { verifyingContract?: string }
    >;
    for (const value of Object.values(stored)) delete value.verifyingContract;
    writeFileSync(storePath, JSON.stringify(stored, null, 2), 'utf-8');

    // A runner reading that legacy store with NO swapVerifyingContracts
    // configured → the tx cannot even be BUILT; the failure is result-shaped
    // with an actionable code, never a throw. Post-#583 that code names the
    // LEG-B contract specifically, so the next reader is not sent hunting for
    // a key problem that does not exist.
    const noConfig = new ClientRunner({
      config: makeConfig({
        receivedClaimStorePath: storePath,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: { btpUrl: 'ws://apex.test/btp' } as any,
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    const res = await noConfig.settleSwapClaims({});
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.built).toBe(false);
    expect(res.results[0]!.submitted).toBe(false);
    expect(res.results[0]!.error?.code).toBe('MISSING_SWAP_VERIFYING_CONTRACT');
    expect(res.results[0]!.error?.message).toContain('RollingSwapChannel');
    await noConfig.stop();
  });

  it('settleSwapClaims submit:false builds without submitting; no RPC yields the tx unsubmitted (#352)', async () => {
    const dryRunner = new ClientRunner({
      config: makeConfig({
        // Leg-B contract configured, but NO RPC url — build works, submit can't.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: {
          btpUrl: 'ws://apex.test/btp',
          swapVerifyingContracts: EVM_VERIFYING_CONTRACTS,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    await dryRunner.bootstrap();
    vi.mocked(streamSwap).mockResolvedValue(
      swapResult([
        await signedEvmClaim({
          nonce: '1',
          cumulativeAmount: '999',
          targetAmount: 999n,
        }),
      ])
    );
    await dryRunner.swap(swapReq());

    // Dry run: built, not submitted, no error.
    const dry = await dryRunner.settleSwapClaims({ submit: false });
    expect(dry.results[0]!).toMatchObject({ built: true, submitted: false });
    expect(dry.results[0]!.error).toBeUndefined();
    expect(typeof dry.results[0]!.unsignedTx).toBe('string');

    // Real run without an RPC configured: still result-shaped.
    const noRpc = await dryRunner.settleSwapClaims({});
    expect(noRpc.results[0]!.built).toBe(true);
    expect(noRpc.results[0]!.submitted).toBe(false);
    expect(noRpc.results[0]!.error?.code).toBe('NO_RPC_CONFIGURED');
    await dryRunner.stop();
  });

  it('subscribe + getEvents delegate to the relay subscription', async () => {
    const { subId } = runner.subscribe({ filters: { kinds: [1] } });
    expect(typeof subId).toBe('string');
    expect(runner.getEvents({}).events).toEqual([]);
  });

  it('throws if peerNegotiations layout changed', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).peerNegotiations = undefined;
    await runner.bootstrap();
    expect(runner.getStatus().lastError).toContain(
      'peerNegotiations layout changed'
    );
  });

  it('reports a direct transport (no anon/HS overlay)', () => {
    const r = new ClientRunner({
      config: makeConfig(),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    expect(r.getStatus().transport.type).toBe('direct');
  });
});

// ── 1-to-many: dynamic relays + apexes, fan-out reads, persistence ──────────

/** A relay factory backed by drivable fake sockets, honoring onEvent wiring. */
function relayFactory(): {
  createRelay: (opts: {
    relayUrl: string;
    onEvent: (subId: string, event: NostrEvent) => void;
  }) => RelaySubscription;
  emit: (relayUrl: string, subId: string, event: NostrEvent) => void;
} {
  const handlersByUrl = new Map<
    string,
    Record<string, (a?: unknown) => void>
  >();
  const createRelay = (opts: {
    relayUrl: string;
    onEvent: (subId: string, event: NostrEvent) => void;
  }): RelaySubscription => {
    const handlers: Record<string, (a?: unknown) => void> = {};
    handlersByUrl.set(opts.relayUrl, handlers);
    return new RelaySubscription({
      relayUrl: opts.relayUrl,
      onEvent: opts.onEvent,
      wsFactory: () =>
        ({
          send: () => {},
          close: () => {},
          on: (ev: string, cb: (a?: unknown) => void) => {
            handlers[ev] = cb;
          },
        }) as never,
    });
  };
  const emit = (relayUrl: string, subId: string, event: NostrEvent): void =>
    handlersByUrl
      .get(relayUrl)
      ?.['message']?.(JSON.stringify(['EVENT', subId, event]));
  return { createRelay, emit };
}

function note(id: string): NostrEvent {
  return {
    id,
    pubkey: 'p'.repeat(64),
    created_at: 1,
    kind: 1,
    tags: [],
    sig: 's'.repeat(128),
    content: 'hi',
  };
}

function apexAnnouncement(
  ilpAddress: string,
  notice?: Record<string, unknown>
): NostrEvent {
  return {
    id: 'd'.repeat(64),
    pubkey: 'e'.repeat(64),
    created_at: 1,
    kind: ILP_PEER_INFO_KIND,
    tags: [],
    sig: 'f'.repeat(128),
    content: JSON.stringify({
      ilpAddress,
      btpEndpoint: 'ws://apex2.example/btp',
      assetCode: 'USD',
      assetScale: 6,
      supportedChains: ['evm:base:84532'],
      settlementAddresses: { 'evm:base:84532': '0xS2' },
      ...(notice ? { notice } : {}),
    }),
  };
}

describe('ClientRunner multi-target', () => {
  let dir: string;
  let targetsPath: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'toon-mt-'));
    targetsPath = join(dir, 'targets.json');
    // Isolate per-apex channel stores (configDir()) from the user's real home.
    prevHome = process.env['TOON_CLIENT_HOME'];
    process.env['TOON_CLIENT_HOME'] = dir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  function build(opts: { trustedNoticePubkeys?: readonly string[] } = {}) {
    const { createRelay, emit } = relayFactory();
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
      }),
      createClient: () => new FakeClient(),
      createRelay,
      targetsPath,
      trustedNoticePubkeys: opts.trustedNoticePubkeys ?? [],
    });
    return { runner, emit };
  }

  it('fans out a subscription across relays and merges reads with one cursor', async () => {
    const { runner, emit } = build();
    runner.start();
    await runner.addRelay('ws://relay2.test');

    const { subId, relays } = runner.subscribe({ filters: { kinds: [1] } });
    expect(relays.sort()).toEqual(['ws://relay.test', 'ws://relay2.test']);

    emit('ws://relay.test', subId, note('1'.repeat(64)));
    emit('ws://relay2.test', subId, note('2'.repeat(64)));

    const first = runner.getEvents({});
    expect(first.events.map((e) => e.id)).toEqual([
      '1'.repeat(64),
      '2'.repeat(64),
    ]);
    // Cursor advances; a second drain past it is empty.
    expect(runner.getEvents({ cursor: first.cursor }).events).toEqual([]);
  });

  it('de-dups the same event seen on two relays', async () => {
    const { runner, emit } = build();
    runner.start();
    await runner.addRelay('ws://relay2.test');
    const { subId } = runner.subscribe({ filters: { kinds: [1] } });
    emit('ws://relay.test', subId, note('9'.repeat(64)));
    emit('ws://relay2.test', subId, note('9'.repeat(64)));
    expect(runner.getEvents({}).events).toHaveLength(1);
  });

  it('scopes a read to one relay via relayUrl', async () => {
    const { runner, emit } = build();
    runner.start();
    await runner.addRelay('ws://relay2.test');
    const { subId } = runner.subscribe({ filters: { kinds: [1] } });
    emit('ws://relay.test', subId, note('a'.repeat(64)));
    emit('ws://relay2.test', subId, note('b'.repeat(64)));
    const scoped = runner.getEvents({ relayUrl: 'ws://relay2.test' });
    expect(scoped.events.map((e) => e.id)).toEqual(['b'.repeat(64)]);
  });

  it('addRelay persists and getTargets reflects it; default relay is not removable', async () => {
    const { runner } = build();
    runner.start();
    await runner.addRelay('ws://relay2.test');
    expect(
      runner
        .getTargets()
        .relays.map((r) => r.relayUrl)
        .sort()
    ).toEqual(['ws://relay.test', 'ws://relay2.test']);
    expect(loadTargets(targetsPath).relays).toEqual([
      { relayUrl: 'ws://relay2.test' },
    ]);
    expect(() => runner.removeRelay('ws://relay.test')).toThrow(/default/i);
    runner.removeRelay('ws://relay2.test');
    expect(runner.getTargets().relays.map((r) => r.relayUrl)).toEqual([
      'ws://relay.test',
    ]);
    expect(loadTargets(targetsPath).relays).toEqual([]);
  });

  it('replays a persisted relay on construction', async () => {
    const { createRelay } = relayFactory();
    // Seed the store, then construct a fresh runner pointed at it.
    const seed = new ClientRunner({
      config: makeConfig({ apexChannelStorePath: join(dir, 'a.json') }),
      createClient: () => new FakeClient(),
      createRelay,
      targetsPath,
    });
    seed.start();
    await seed.addRelay('ws://persisted.test');

    const fresh = new ClientRunner({
      config: makeConfig({ apexChannelStorePath: join(dir, 'a.json') }),
      createClient: () => new FakeClient(),
      createRelay,
      targetsPath,
    });
    fresh.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(fresh.getTargets().relays.map((r) => r.relayUrl)).toContain(
      'ws://persisted.test'
    );
  });

  it('discovers + adds an apex from a relay announcement (persisted)', async () => {
    const { runner, emit } = build();
    runner.start();
    // Pre-buffer the apex's kind:10032 on the discovery relay.
    emit(
      'ws://relay.test',
      'apex-discovery-g.other.town',
      apexAnnouncement('g.other.town')
    );

    const res = await runner.addApex({
      ilpAddress: 'g.other.town',
      relayUrl: 'ws://relay.test',
    });
    expect(res.btpUrl).toBe('ws://apex2.example/btp');
    const apexes = runner.getTargets().apexes;
    expect(apexes.map((a) => a.btpUrl)).toContain('ws://apex2.example/btp');
    expect(loadTargets(targetsPath).apexes.map((a) => a.btpUrl)).toEqual([
      'ws://apex2.example/btp',
    ]);
  });

  // A direct-dialled swap maker (kept OUT of the relay connector's routing
  // table on purpose, reached at its own advertised btpEndpoint) is
  // unreachable through the seeded apex. `swap()` selects its apex client via
  // `selectApex(req.btpUrl)`, so the request's btpUrl must actually get there
  // — otherwise every swap goes out on the default apex regardless.
  it('swap sends on the apex named by btpUrl, not the config-seeded default (selectApex)', async () => {
    const { createRelay, emit } = relayFactory();
    const created: FakeClient[] = [];
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
      }),
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
      createRelay,
      targetsPath,
    });
    runner.start();
    emit(
      'ws://relay.test',
      'apex-discovery-g.toon.swap.maker',
      apexAnnouncement('g.toon.swap.maker')
    );
    const added = await runner.addApex({
      ilpAddress: 'g.toon.swap.maker',
      relayUrl: 'ws://relay.test',
    });
    expect(added.btpUrl).toBe('ws://apex2.example/btp');
    await runner.bootstrap();

    vi.mocked(streamSwap).mockClear();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    await runner.swap({
      destination: 'g.toon.swap.maker',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      // #595: legacy is opt-in now — this suite exercises the legacy body.
      rolling: 'auto' as const,
      btpUrl: 'ws://apex2.example/btp',
    });

    // One client per apex: [0] is the default/identity client, [1] the
    // discovered maker apex. The swap must have streamed on the LATTER.
    const defaultClient = created[0];
    const makerClient = created[1];
    expect(makerClient).toBeDefined();
    const usedClient = vi.mocked(streamSwap).mock.calls[0]?.[0].client;
    expect(usedClient).toBe(makerClient);
    expect(usedClient).not.toBe(defaultClient);
    await runner.stop();
  });

  // Same maker, no `btpUrl` on the request. The negotiation for a registered
  // apex is injected into THAT apex's client alone, under the peer id
  // `resolvePeerId` returns for its destination (`g.toon.swap.maker` →
  // `maker`). Defaulting the swap to the config-seeded apex therefore hands
  // `sendSwapPacket` a destination that client never negotiated: resolution
  // falls back to the raw destination as the key, nothing is registered under
  // a full ILP address, and every packet dies locally with
  // `No negotiation metadata for peer "g.toon.swap.maker"` (observed on
  // devnet). The destination must pick the apex that owns it.
  it('swap without btpUrl streams on the apex that OWNS the destination, whose client holds the negotiation', async () => {
    const { createRelay, emit } = relayFactory();
    const created: FakeClient[] = [];
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
      }),
      createClient: () => {
        const c = new FakeClient();
        created.push(c);
        return c;
      },
      createRelay,
      targetsPath,
    });
    runner.start();
    emit(
      'ws://relay.test',
      'apex-discovery-g.toon.swap.maker',
      apexAnnouncement('g.toon.swap.maker')
    );
    await runner.addApex({
      ilpAddress: 'g.toon.swap.maker',
      relayUrl: 'ws://relay.test',
    });
    await runner.bootstrap();

    vi.mocked(streamSwap).mockClear();
    vi.mocked(streamSwap).mockResolvedValue(swapResult([]));
    await runner.swap({
      destination: 'g.toon.swap.maker',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      // #595: legacy is opt-in now — this suite exercises the legacy body.
      rolling: 'auto' as const,
      // NO btpUrl — the destination alone must find its apex.
    });

    const defaultClient = created[0];
    const makerClient = created[1];
    expect(makerClient).toBeDefined();
    const usedClient = vi.mocked(streamSwap).mock.calls[0]?.[0].client;
    expect(usedClient).toBe(makerClient);
    expect(usedClient).not.toBe(defaultClient);
    // The seam the live send resolves through: the negotiation is registered
    // under the peer id, on the client the swap actually streams on — so
    // `resolvePeerId('g.toon.swap.maker')` hits `maker` on identity and never
    // rides `peerIdForClaim`'s raw-destination fallback.
    expect(makerClient?.peerNegotiations.has('maker')).toBe(true);
    expect(makerClient?.peerNegotiations.has('g.toon.swap.maker')).toBe(false);
    expect(defaultClient?.peerNegotiations.has('maker')).toBe(false);
    await runner.stop();
  });

  it('swap to an unregistered apex throws TargetError instead of silently using the default', async () => {
    const { runner } = build();
    runner.start();
    await runner.bootstrap();
    vi.mocked(streamSwap).mockClear();
    await expect(
      runner.swap({
        destination: 'g.toon.swap.maker',
        amount: '1000',
        swapPubkey: 'cd'.repeat(32),
        pair: EVM_PAIR,
        chainRecipient: EVM_RECIPIENT,
        btpUrl: 'ws://nope/btp',
      })
    ).rejects.toBeInstanceOf(TargetError);
    expect(streamSwap).not.toHaveBeenCalled();
    await runner.stop();
  });

  // issue #550 round 3: config.ts now threads the daemon's resolved relay into
  // `toonClientConfig.relayUrl` (previously pinned to `''`) so ToonClient's
  // discoveryTracker feed has something to subscribe to. `deriveApexClientConfig`
  // builds a DISCOVERED apex's client config by spreading that same base — this
  // pins that the spread doesn't drop `relayUrl` along the way, so every
  // per-apex client (not just the default/identity one) gets fed.
  it('threads the daemon relay into a discovered apex client config too (issue #550)', async () => {
    const { createRelay, emit } = relayFactory();
    const createdConfigs: { relayUrl?: string }[] = [];
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
        toonClientConfig: {
          btpUrl: 'ws://apex.test/btp',
          swapVerifyingContracts: EVM_VERIFYING_CONTRACTS,
          relayUrl: 'ws://relay.test',
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any,
      }),
      createClient: (cfg) => {
        createdConfigs.push(cfg);
        return new FakeClient();
      },
      createRelay,
      targetsPath,
    });
    runner.start();
    emit(
      'ws://relay.test',
      'apex-discovery-g.other.town',
      apexAnnouncement('g.other.town')
    );
    await runner.addApex({
      ilpAddress: 'g.other.town',
      relayUrl: 'ws://relay.test',
    });

    // One config for the default/identity client, one for the discovered apex.
    expect(createdConfigs.length).toBe(2);
    for (const cfg of createdConfigs) {
      expect(cfg.relayUrl).toBe('ws://relay.test');
    }
  });

  it('publish to an unknown apex throws; default apex is not removable', async () => {
    const { runner } = build();
    runner.start();
    await runner.bootstrap();
    await expect(
      runner.publish({ event: note('c'.repeat(64)), btpUrl: 'ws://nope/btp' })
    ).rejects.toThrow(/no such apex/i);
    await expect(runner.removeApex('ws://apex.test/btp')).rejects.toThrow(
      /default/i
    );
  });
});

// ── Proxy-mode (no BTP) negotiation + lazy channel open + read-only (#69) ─────
describe('ClientRunner — proxy mode (#69)', () => {
  let prevHome: string | undefined;
  let prevProxy: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'toon-runner-proxy-'));
    prevHome = process.env['TOON_CLIENT_HOME'];
    prevProxy = process.env['TOON_CLIENT_PROXY_URL'];
    process.env['TOON_CLIENT_HOME'] = tmpDir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = prevHome;
    if (prevProxy === undefined) delete process.env['TOON_CLIENT_PROXY_URL'];
    else process.env['TOON_CLIENT_PROXY_URL'] = prevProxy;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A proxy-mode config: no btpUrl, a synthesized apex negotiation, proxy set. */
  function proxyConfig(): ResolvedDaemonConfig {
    return makeConfig({
      hasUplink: true,
      proxyUrl: 'https://proxy.test',
      destination: 'g.proxy.relay',
      apexChannelStorePath: join(tmpDir, 'apex-channels.json'),
      apex: {
        destination: 'g.proxy.relay',
        peerId: 'relay',
        chain: 'evm',
        chainKey: 'evm:devnet:31337',
        chainId: 31337,
        settlementAddress: '0xConnectorSettle',
        tokenAddress: '0xUSDC',
        tokenNetwork: '0xTokenNetwork',
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      toonClientConfig: { proxyUrl: 'https://proxy.test' } as any,
    });
  }

  it('injects the apex negotiation in proxy mode WITHOUT a BTP socket', async () => {
    const client = new FakeClient();
    const openSpy = vi.spyOn(client, 'openChannel');
    const runner = new ClientRunner({
      config: proxyConfig(),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    await runner.bootstrap();
    expect(runner.isReady()).toBe(true);
    // Negotiation injected under the apex peerId (last ILP segment "relay").
    expect(client.peerNegotiations.get('relay')).toMatchObject({
      chainType: 'evm',
      chainId: 31337,
      settlementAddress: '0xConnectorSettle',
      tokenNetwork: '0xTokenNetwork',
    });
    // Channel open is DEFERRED at bootstrap (fund-after-start flow).
    expect(openSpy).not.toHaveBeenCalled();
  });

  it('opens the channel lazily on first publish and persists it (proxy mode)', async () => {
    const client = new FakeClient();
    const openSpy = vi.spyOn(client, 'openChannel');
    const runner = new ClientRunner({
      config: proxyConfig(),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    await runner.bootstrap();
    const res = await runner.publish({
      event: { id: 'evt-proxy' } as NostrEvent,
    });
    expect(openSpy).toHaveBeenCalledTimes(1); // opened on first write
    expect(res.channelId).toBe('chan-1');
    expect(res.nonce).toBe(1);
    // Persisted for restart-resume, keyed by (destination|chain).
    const saved = JSON.parse(
      readFileSync(join(tmpDir, 'apex-channels.json'), 'utf8')
    );
    expect(saved['g.proxy.relay|evm'].channelId).toBe('chan-1');
    expect(saved['g.proxy.relay|evm'].context).toMatchObject({
      chainType: 'evm',
      chainId: 31337,
      recipient: '0xConnectorSettle',
    });
    // A second publish reuses the channel (no second open).
    await runner.publish({ event: { id: 'evt2' } as NostrEvent });
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it('surfaces a trusted announcer notice via getStatus (default-apex discovery, #544)', async () => {
    const { createRelay, emit } = relayFactory();
    const runner = new ClientRunner({
      config: makeConfig({
        hasUplink: true,
        proxyUrl: 'https://proxy.test',
        destination: 'g.proxy.relay',
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(tmpDir, 'apex-channels.json'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: { proxyUrl: 'https://proxy.test' } as any,
      }),
      createClient: () => new FakeClient(),
      createRelay,
      trustedNoticePubkeys: ['e'.repeat(64)], // apexAnnouncement's pubkey
    });
    runner.start();
    emit(
      'ws://relay.test',
      'apex-discovery-g.proxy.relay',
      apexAnnouncement('g.proxy.relay', {
        id: 'n1',
        severity: 'action-required',
        summary: 'Rotate your keys',
        url: 'https://example.test/notice/n1',
      })
    );
    await runner.bootstrap();
    expect(runner.getStatus().notice).toEqual({
      id: 'n1',
      severity: 'action-required',
      summary: 'Rotate your keys',
      url: 'https://example.test/notice/n1',
    });
  });

  it('omits notice from an untrusted announcer (default-apex discovery, #544)', async () => {
    const { createRelay, emit } = relayFactory();
    const runner = new ClientRunner({
      config: makeConfig({
        hasUplink: true,
        proxyUrl: 'https://proxy.test',
        destination: 'g.proxy.relay',
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(tmpDir, 'apex-channels.json'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: { proxyUrl: 'https://proxy.test' } as any,
      }),
      createClient: () => new FakeClient(),
      createRelay,
      trustedNoticePubkeys: ['not-the-announcer'],
    });
    runner.start();
    emit(
      'ws://relay.test',
      'apex-discovery-g.proxy.relay',
      apexAnnouncement('g.proxy.relay', {
        id: 'n1',
        severity: 'info',
        summary: 'Untrusted',
        url: 'https://example.test/notice/n1',
      })
    );
    await runner.bootstrap();
    expect(runner.getStatus().notice).toBeUndefined();
  });

  it('omits notice when the trusted announce carries none (default-apex discovery, #544)', async () => {
    const { createRelay, emit } = relayFactory();
    const runner = new ClientRunner({
      config: makeConfig({
        hasUplink: true,
        proxyUrl: 'https://proxy.test',
        destination: 'g.proxy.relay',
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(tmpDir, 'apex-channels.json'),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: { proxyUrl: 'https://proxy.test' } as any,
      }),
      createClient: () => new FakeClient(),
      createRelay,
      trustedNoticePubkeys: ['e'.repeat(64)],
    });
    runner.start();
    emit(
      'ws://relay.test',
      'apex-discovery-g.proxy.relay',
      apexAnnouncement('g.proxy.relay')
    );
    await runner.bootstrap();
    expect(runner.getStatus().notice).toBeUndefined();
  });

  it('read-only daemon (no uplink) serves reads but rejects writes (#69)', async () => {
    const client = new FakeClient();
    const runner = new ClientRunner({
      config: makeConfig({
        hasUplink: false,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        toonClientConfig: {} as any,
      }),
      createClient: () => client,
      createRelay: fakeRelay,
    });
    runner.start();
    // No apex bootstrap is kicked off in read-only mode.
    await runner.bootstrap();
    expect(runner.isBootstrapping()).toBe(false);
    // Reads still work (subscribe returns a sub id, no uplink needed).
    const sub = runner.subscribe({ filters: { kinds: [1] } });
    expect(sub.subId).toBeTruthy();
    // Writes are rejected with an actionable "configure an uplink" message.
    await expect(
      runner.publish({ event: { id: 'e' } as NostrEvent })
    ).rejects.toBeInstanceOf(TargetError);
    await expect(runner.openChannel()).rejects.toThrow(/read-only|uplink/i);
  });
});

describe('ClientRunner — async faucet drip jobs', () => {
  let runner: ClientRunner;
  let prevHome: string | undefined;
  /** A promise whose resolve/reject we control to drive the background job. */
  function deferred<T>(): {
    promise: Promise<T>;
    resolve: (v: T) => void;
    reject: (e: unknown) => void;
  } {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  /** Flush microtasks so the background .then/.catch can update the job. */
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'toon-runner-fund-'));
    prevHome = process.env['TOON_CLIENT_HOME'];
    process.env['TOON_CLIENT_HOME'] = tmpDir;
    vi.mocked(faucetFund).mockReset();
    runner = new ClientRunner({
      config: makeConfig({ faucetUrl: 'http://faucet.test' }),
      createClient: () => new FakeClient(),
      createRelay: fakeRelay,
    });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns a pending snapshot immediately and does not block on the faucet', () => {
    // A never-settling faucet — the call must still return synchronously-fast.
    vi.mocked(faucetFund).mockReturnValue(
      deferred<{ response: unknown }>().promise
    );
    const snap = runner.fundWallet();
    expect(snap.status).toBe('pending');
    expect(snap.chain).toBe('evm');
    expect(snap.address).toBe('0xabc');
    expect(snap.faucetUrl).toBe('http://faucet.test');
    expect(typeof snap.startedAt).toBe('number');
    expect(snap.finishedAt).toBeUndefined();
    expect(vi.mocked(faucetFund)).toHaveBeenCalledTimes(1);
  });

  it('transitions pending → success when the faucet resolves', async () => {
    const d = deferred<{ response: unknown }>();
    vi.mocked(faucetFund).mockReturnValue(d.promise);
    runner.fundWallet();
    expect(runner.getFundStatus('evm').jobs[0]!.status).toBe('pending');
    d.resolve({ response: { ok: true, faucet: 'drip' } });
    await flush();
    const job = runner.getFundStatus('evm').jobs[0]!;
    expect(job.status).toBe('success');
    expect(job.response).toEqual({ ok: true, faucet: 'drip' });
    expect(typeof job.finishedAt).toBe('number');
    expect(job.error).toBeUndefined();
  });

  it('transitions pending → error when the faucet rejects (no unhandled rejection)', async () => {
    const d = deferred<{ response: unknown }>();
    vi.mocked(faucetFund).mockReturnValue(d.promise);
    runner.fundWallet();
    d.reject(new Error('faucet 500'));
    await flush();
    const job = runner.getFundStatus('evm').jobs[0]!;
    expect(job.status).toBe('error');
    expect(job.error).toMatch(/faucet 500/);
    expect(typeof job.finishedAt).toBe('number');
  });

  it('marks a faucet TIMEOUT as status "timeout" (not "error") since the drip may still land', async () => {
    const d = deferred<{ response: unknown }>();
    vi.mocked(faucetFund).mockReturnValue(d.promise);
    runner.fundWallet();
    d.reject(new Error('Faucet request timed out after 30000ms'));
    await flush();
    const job = runner.getFundStatus('evm').jobs[0]!;
    expect(job.status).toBe('timeout');
    expect(job.error).toMatch(/re-check balances/i);
  });

  it('is idempotent while pending: a second call does not launch a second drip', () => {
    vi.mocked(faucetFund).mockReturnValue(
      deferred<{ response: unknown }>().promise
    );
    const first = runner.fundWallet();
    const second = runner.fundWallet();
    expect(vi.mocked(faucetFund)).toHaveBeenCalledTimes(1);
    expect(second.status).toBe('pending');
    expect(second.startedAt).toBe(first.startedAt);
  });

  it('allows a fresh drip once the previous one settled', async () => {
    const d1 = deferred<{ response: unknown }>();
    vi.mocked(faucetFund).mockReturnValueOnce(d1.promise);
    runner.fundWallet();
    d1.resolve({ response: {} });
    await flush();
    expect(runner.getFundStatus('evm').jobs[0]!.status).toBe('success');
    // A second call after settlement re-drips (status no longer 'pending').
    vi.mocked(faucetFund).mockReturnValueOnce(
      deferred<{ response: unknown }>().promise
    );
    runner.fundWallet();
    expect(vi.mocked(faucetFund)).toHaveBeenCalledTimes(2);
    expect(runner.getFundStatus('evm').jobs[0]!.status).toBe('pending');
  });

  it('getFundStatus returns all jobs, or just the requested chain', () => {
    vi.mocked(faucetFund).mockReturnValue(
      deferred<{ response: unknown }>().promise
    );
    runner.fundWallet({ chain: 'evm' });
    runner.fundWallet({ chain: 'solana', address: 'So1' });
    expect(runner.getFundStatus().jobs).toHaveLength(2);
    expect(runner.getFundStatus('solana').jobs).toHaveLength(1);
    expect(runner.getFundStatus('solana').jobs[0]!.address).toBe('So1');
    expect(runner.getFundStatus('mina').jobs).toHaveLength(0);
  });

  it('throws when no faucet is configured', () => {
    const noFaucet = new ClientRunner({
      config: makeConfig(),
      createClient: () => new FakeClient(),
      createRelay: fakeRelay,
    });
    expect(() => noFaucet.fundWallet()).toThrow(InvalidPayloadError);
  });

  it('throws when no address is resolvable for the chain', () => {
    // FakeClient has no solana/mina address and none is passed.
    expect(() => runner.fundWallet({ chain: 'mina' })).toThrow(
      InvalidPayloadError
    );
  });
});

/**
 * A REPLAYED apex target's negotiation is a CACHE, not a fact — re-validate it
 * against the live announce before anything trusts it (toon-client#581).
 *
 * `replayPersistedTargets` → `instantiateApex` used to take
 * `~/.toon-client/targets.json`'s negotiation verbatim, and
 * `discoverApexNegotiation` only ran when there was no negotiation at all. So
 * the "currently-announced" address the counterparty check #578/#580 added
 * compares a channel record against could itself be the stale cache: recorded
 * `0xf29fd62c…` vs injected `0xf29fd62c…` read as `match`, and the dead channel
 * was resumed exactly as before. `0xf29fd62c…` is the retired `g.toon` apex,
 * destroyed 2026-08-14 — the one path where that whole guard was defeated.
 */
describe('replayed apex negotiation revalidation (toon-client#581)', () => {
  /** The retired `g.toon` apex, still sitting in the live targets.json. */
  const RETIRED = '0xf29fd62c4848b9573c9b90adbf61b664f386d9cf';
  /** What the node answering that name announces TODAY. */
  const LIVE = '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff';
  const RETIRED_BTP = 'ws://retired.example/btp';
  const APEX_ADDRESS = 'g.other.town';

  let dir: string;
  let targetsPath: string;
  let prevHome: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'toon-revalidate-'));
    targetsPath = join(dir, 'targets.json');
    prevHome = process.env['TOON_CLIENT_HOME'];
    process.env['TOON_CLIENT_HOME'] = dir;
    // `makeConfig` defaults `apexChannelStorePath` under the shared `tmpDir`.
    tmpDir = dir;
  });
  afterEach(() => {
    if (prevHome === undefined) delete process.env['TOON_CLIENT_HOME'];
    else process.env['TOON_CLIENT_HOME'] = prevHome;
    rmSync(dir, { recursive: true, force: true });
  });

  /**
   * A kind:10032 for `APEX_ADDRESS`. `settlementAddress: null` announces the
   * address away — a node that is up but can no longer settle, the fast
   * stand-in for "this apex is gone" (a truly absent announce is the same
   * branch, reached via a 15s discovery timeout).
   */
  function announce(settlementAddress: string | null) {
    return {
      id: '1'.repeat(64),
      pubkey: 'e'.repeat(64),
      created_at: 1,
      kind: ILP_PEER_INFO_KIND,
      tags: [],
      sig: 'f'.repeat(128),
      content: JSON.stringify({
        ilpAddress: APEX_ADDRESS,
        btpEndpoint: RETIRED_BTP,
        assetCode: 'USD',
        assetScale: 6,
        supportedChains: ['evm:base:84532'],
        settlementAddresses:
          settlementAddress === null
            ? {}
            : { 'evm:base:84532': settlementAddress },
      }),
    } as NostrEvent;
  }

  /** Seed targets.json exactly as a previous session left it. */
  function seedStaleTarget(): void {
    saveApexTarget(
      {
        btpUrl: RETIRED_BTP,
        negotiation: {
          destination: APEX_ADDRESS,
          peerId: 'town',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: RETIRED,
        },
        feePerEvent: '7',
        discoveredFrom: 'ws://relay.test',
      },
      targetsPath
    );
  }

  /** Start a runner over the seeded store, with the given announce buffered. */
  async function replay(announced: NostrEvent | undefined): Promise<{
    runner: ClientRunner;
    clients: FakeClient[];
  }> {
    const { createRelay, emit } = relayFactory();
    const clients: FakeClient[] = [];
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        // Revalidation is the PROXY-mode path (BTP mode's legacy bootstrap
        // does its own discovery).
        proxyUrl: 'http://proxy.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
      }),
      createClient: () => {
        const c = new FakeClient();
        clients.push(c);
        return c;
      },
      createRelay,
      targetsPath,
    });
    runner.start();
    if (announced) {
      emit('ws://relay.test', `apex-discovery-${APEX_ADDRESS}`, announced);
    }
    // Discovery polls the relay buffer every 250ms.
    await new Promise((r) => setTimeout(r, 600));
    return { runner, clients };
  }

  it('injects the ANNOUNCED settlement address, not the persisted one', async () => {
    seedStaleTarget();
    const { runner, clients } = await replay(announce(LIVE));

    const apex = runner
      .getTargets()
      .apexes.find((a) => a.btpUrl === RETIRED_BTP);
    expect(apex?.ready).toBe(true);

    // This is the right-hand side of #580's counterparty check. Before this
    // fix it was the cache itself, so `recorded === injected` always matched.
    const injected = clients
      .map((c) => c.peerNegotiations.get('town'))
      .find((n) => n !== undefined) as { settlementAddress: string };
    expect(injected.settlementAddress).toBe(LIVE);
    expect(injected.settlementAddress).not.toBe(RETIRED);
  });

  it('re-persists the drifted target so the correction happens ONCE', async () => {
    seedStaleTarget();
    await replay(announce(LIVE));

    const stored = loadTargets(targetsPath).apexes.find(
      (a) => a.btpUrl === RETIRED_BTP
    );
    expect(stored?.negotiation.settlementAddress).toBe(LIVE);
    // The rest of the record survives the rewrite.
    expect(stored?.feePerEvent).toBe('7');
    expect(stored?.discoveredFrom).toBe('ws://relay.test');
  });

  it('leaves an AGREEING store untouched', async () => {
    saveApexTarget(
      {
        btpUrl: RETIRED_BTP,
        negotiation: {
          destination: APEX_ADDRESS,
          peerId: 'town',
          chain: 'evm',
          chainKey: 'evm:base:84532',
          chainId: 84532,
          settlementAddress: LIVE,
        },
        feePerEvent: '7',
      },
      targetsPath
    );
    const before = readFileSync(targetsPath, 'utf-8');

    await replay(announce(LIVE));

    expect(readFileSync(targetsPath, 'utf-8')).toBe(before);
  });

  it('falls back to the persisted negotiation when the apex no longer announces — and says so', async () => {
    seedStaleTarget();
    // An announce with no usable settlement chain fails discovery outright
    // (the fast stand-in for "this apex is gone").
    const { runner, clients } = await replay(announce(null));

    const apex = runner
      .getTargets()
      .apexes.find((a) => a.btpUrl === RETIRED_BTP);
    // Still usable — refusing to come up would be worse than a warned-about
    // cache — but the doubt is SURFACED rather than swallowed.
    expect(apex?.ready).toBe(true);
    expect(apex?.lastError).toMatch(/could not be re-validated/i);
    expect(apex?.lastError).toMatch(/F01/);

    const injected = clients
      .map((c) => c.peerNegotiations.get('town'))
      .find((n) => n !== undefined) as { settlementAddress: string };
    expect(injected.settlementAddress).toBe(RETIRED);
    // The unverified record is NOT rewritten.
    expect(
      loadTargets(targetsPath).apexes[0]?.negotiation.settlementAddress
    ).toBe(RETIRED);
  });

  it('does not re-discover a FRESHLY discovered apex (addApex already read the announce)', async () => {
    const { createRelay, emit } = relayFactory();
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        proxyUrl: 'http://proxy.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
      }),
      createClient: () => new FakeClient(),
      createRelay,
      targetsPath,
    });
    runner.start();
    emit('ws://relay.test', `apex-discovery-${APEX_ADDRESS}`, announce(LIVE));

    const added = await runner.addApex({
      ilpAddress: APEX_ADDRESS,
      relayUrl: 'ws://relay.test',
    });

    expect(added.ready).toBe(true);
    expect(
      runner.getTargets().apexes.find((a) => a.btpUrl === RETIRED_BTP)
        ?.lastError
    ).toBeUndefined();
  });
});

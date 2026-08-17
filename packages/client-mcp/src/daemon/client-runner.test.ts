import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  type CreateClient,
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
  /** Sign over a DIFFERENT cumulative than advertised (a tampered advance). */
  signedCumulativeAmount?: string;
  /** Maker's quote-tape rate for this fill; defaults to '1.0'. */
  rate?: string;
}): Promise<Uint8Array> {
  const digest = evmClaimDigest(
    { chainId: EVM_CHAIN_ID, verifyingContract: EVM_VERIFYING_CONTRACT },
    {
      channelId: EVM_CHANNEL,
      cumulativeAmount: BigInt(
        opts.signedCumulativeAmount ?? opts.cumulativeAmount
      ),
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
      rate: opts.rate ?? '1.0',
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
  // A ROLLING-capable fake (toon-client#598: the legacy sender is gone, so
  // every swap test in this describe block — including the receive-side
  // claim-ingestion suite below — now drives the rolling path). Plain
  // `FakeClient` behaviour is preserved for every non-swap test since
  // `FakeRollingMakerClient` only overrides `sendSwapPacket`.
  let client: FakeRollingMakerClient;
  let runner: ClientRunner;
  let prevHome: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'toon-runner-'));
    // Isolate from the user's real ~/.toon-client (persisted targets.json,
    // channel stores) so tests never read or write live state.
    prevHome = process.env['TOON_CLIENT_HOME'];
    process.env['TOON_CLIENT_HOME'] = tmpDir;
    client = new FakeRollingMakerClient();
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
      createClient: (cfg) => {
        client.jobHandler = cfg.jobHandler as typeof client.jobHandler;
        return client;
      },
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

  // toon-client#598: the legacy sender that used to back this suite is gone
  // (ADR 0003 — rolling is the only swap protocol). The plain
  // "streams via the legacy sender, VERIFIES the claim..." case is now redundant
  // with the rolling-path REACHABILITY test below (it exercises the exact
  // same receive-side verify/persist logic, just over the wire this fake
  // drives directly); it is not re-added here.

  it("swap: local config swapVerifyingContracts OVERRIDES the maker's announce (#572/#583)", async () => {
    // The announce carries a DIFFERENT (wrong/stale) contract for the chain;
    // the daemon's own config, when set, wins — a counterparty must never be
    // the sole authority on what verifies its own signature. The claim is
    // signed against the config's contract (EVM_VERIFYING_CONTRACTS).
    client.announcedSwapVerifyingContracts.set('cd'.repeat(32), {
      [EVM_PAIR.to.chain]: '0x' + '99'.repeat(20),
    });
    await runner.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '999',
        sourceAmount: '1000',
        targetAmount: '999',
      });

    const res = await runner.swap(swapReq({ swapSignerAddress: SWAP_SIGNER }));

    expect(res.accepted).toBe(true);
    expect(res.claimsVerified).toBe(1);
  });

  // toon-client#598: the #349 wire-skew guard ("warns when accepted claims
  // are missing swapSignerAddress") lived ONLY in the deleted legacy body —
  // `swapRolling` never carried it (there is no pre-rename rolling peer to
  // skew against: the rolling wire format always carries
  // `swapSignerAddress`), so this coverage is genuinely gone, not ported.

  // toon-client#598: the sdk `errors[]` mapping this proved lived in the
  // deleted legacy body. Its rolling-path equivalent is
  // '[#596] a locally-failed rolling send populates errors[] / abortReason
  // "complete" / code LOCAL_SEND_FAILED' below.

  it('swap passes the daemon logger into the rolling fill loop so a withheld packet is logged', async () => {
    const lines: string[] = [];
    const maker = new FakeRollingMakerClient();
    const logged = new ClientRunner({
      config: makeConfig(),
      createClient: (cfg) => {
        maker.jobHandler = cfg.jobHandler as typeof maker.jobHandler;
        return maker;
      },
      createRelay: fakeRelay,
      logger: (m) => lines.push(m),
    });
    await logged.bootstrap();
    // Default `buildAdvance` (no advance built) means the maker never sends a
    // well-formed leg-B advance, so the fill is rejected — exercising the
    // runner's own `this.log(...)` diagnostics on the rolling path (there is
    // no sdk logger adapter to plug into any more).
    await logged.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      streamNonce: STREAM_NONCE,
    });

    expect(lines.some((l) => l.includes('REJECTED'))).toBe(true);
    await logged.stop();
  });

  // toon-client#598: both halves of this test proved the LEGACY fallback
  // (`rolling: 'auto'` keeping a broken RFQ probe alive) — deleted outright,
  // no rolling equivalent to port (there is no fallback any more).

  // toon-client#598: `rolling: 'off'` no longer exists to conflict with a
  // pinned `streamNonce` — deleted outright.

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
    await r.stop();
  });

  it('[#595] the SAME call against a maker with no RFQ intake THROWS, naming the maker, its ILP address and the reason', async () => {
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
    // Exactly ONE packet left this client: the probe.
    expect(sendSpy).toHaveBeenCalledTimes(1);
    expect(maker.sessions.size).toBe(0);
    await r.stop();
  });

  // toon-client#598: `rolling: 'auto'`/`'off'`/`'require'` and the matching
  // daemon-level default are gone (ADR 0003 — rolling is the only swap
  // protocol, so the knob was removed rather than narrowed). The four tests
  // that used to live here proved only fallback/annotation/off-switch
  // behaviour for a path that no longer exists; nothing here has a rolling
  // equivalent to port. `[#595] the SAME call against a maker with no RFQ
  // intake THROWS` above already covers throw-by-default (there is no other
  // default to distinguish it from any more).

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

  it('[#585] a client that cannot state its own receive address never opens a session whose leg B cannot arrive', async () => {
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
    // A LOCAL reason still names itself rather than silently proceeding.
    await expect(r.swap(req)).rejects.toThrow(/no-sender-address/);
    expect(maker.rfqRequests).toHaveLength(0);
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

  // ── toon-client#596: rolling-path observability parity with legacy ────────

  it('[#596] a locally-failed rolling send populates errors[] / abortReason "complete" / code LOCAL_SEND_FAILED — distinct from a maker rejection', async () => {
    // A packet that THROWS before the maker ever answers (a transport/
    // peer-resolution failure) is a different diagnosis than a maker/leg-B
    // REJECT, and pre-#596 both landed in `rejections[]` under a synthetic
    // `T00` — indistinguishable from a real maker "no".
    class ThrowingSendMaker extends FakeRollingMakerClient {
      override async sendSwapPacket(): Promise<{
        accepted: boolean;
        code?: string;
        message?: string;
      }> {
        throw new Error('ECONNRESET');
      }
    }
    const maker = new ThrowingSendMaker();
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
    expect(res.rejections ?? []).toHaveLength(0);
    expect(res.errors).toHaveLength(1);
    expect(res.errors?.[0]).toMatchObject({
      packetIndex: 0,
      message: 'ECONNRESET',
      name: 'Error',
    });
    expect(res.code).toBe('LOCAL_SEND_FAILED');
    expect(res.message).toBe('ECONNRESET');
    // Mirrors the legacy path's documented quirk: a fully-local failure keeps
    // `abortReason: 'complete'` (the rewrite to `all-rejected` only fires
    // when there were rejections and NO errors) — `state: 'failed'` +
    // `packetsAccepted: 0` is the signature to read `errors[]` against.
    expect(res.abortReason).toBe('complete');
    expect(res.state).toBe('failed');
    expect(res.warning).toContain('FAILED LOCALLY');
    await rollingRunner.stop();
  });

  it('[#596] `timeoutMs` bounds the rolling fill loop: a slow maker gets a partial fill, `abortReason: "aborted"`, `state: "stopped"`', async () => {
    class SlowMaker extends FakeRollingMakerClient {
      override async sendSwapPacket(params: {
        destination: string;
        amount: bigint;
        toonData: Uint8Array;
        executionCondition?: Uint8Array;
        expiresAt?: Date;
      }): Promise<{ accepted: boolean; code?: string; message?: string }> {
        await new Promise((r) => setTimeout(r, 50));
        return super.sendSwapPacket(params);
      }
    }
    const maker = new SlowMaker();
    const rollingRunner = new ClientRunner({
      config: makeConfig(),
      createClient: (cfg) => {
        maker.jobHandler = cfg.jobHandler as typeof maker.jobHandler;
        return maker;
      },
      createRelay: fakeRelay,
    });
    await rollingRunner.bootstrap();
    maker.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(500 * seq),
        sourceAmount: '500',
        targetAmount: '500',
      });

    const res = await rollingRunner.swap({
      destination: 'g.proxy.swap',
      amount: '900',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      packetCount: 3,
      senderConditions: true,
      streamNonce: STREAM_NONCE,
      // Each fill takes ~50ms; a 10ms budget elapses after the first, so the
      // 2nd and 3rd are never attempted.
      timeoutMs: 10,
    });

    expect(res.claims.length).toBeGreaterThanOrEqual(1);
    expect(res.claims.length).toBeLessThan(3);
    expect(res.abortReason).toBe('aborted');
    expect(res.state).toBe('stopped');
    expect(res.warning).toContain('timeoutMs');
    // The partial fill is reported exactly, not discarded.
    expect(BigInt(res.cumulativeSource)).toBeGreaterThan(0n);
    await rollingRunner.stop();
  });

  it('[#596] a rolling `SwapResponse` carries `packets[]` — one entry per fill, with per-packet rate/rateTimestamp from that fill\'s own advance', async () => {
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
    maker.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(500 * seq),
        sourceAmount: '500',
        targetAmount: '500',
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

    expect(res.state).toBe('completed');
    expect(res.abortReason).toBe('complete');
    expect(res.packets).toHaveLength(2);
    expect(res.packets?.[0]).toMatchObject({
      index: 0,
      sourceAmount: '500',
      targetAmount: '500',
      effectiveRate: 1,
      rateDeviation: 0,
      rate: '1.0',
      rateTimestamp: 1_700_000_000_000,
    });
    expect(res.errors ?? []).toHaveLength(0);
    await rollingRunner.stop();
  });

  // toon-client#598: "keeps the legacy path" and "surfaces a swap peer
  // rejection (no claims) as not-accepted" both tested LEGACY-only mechanics.
  // The rejection-surfacing intent is already covered on the rolling path by
  // 'a rolling swap that delivers NOTHING says so...' and 'the CRUX (#573
  // AC)' above (a maker/leg-B "no" reported as not-accepted with zero
  // claims) — not re-added here.

  // ── Rolling-swap sender defenses (#351): floor, daemon defaults ────────────
  //
  // The adaptive δ/W controller (its request/daemon-default knobs) was
  // DROPPED, not ported (toon-client#597/#598 — see `swapRolling`'s doc
  // comment on `client-runner.ts`): every controller-specific test that used
  // to live here (engage/mutex/persistence/pinned-session-refusal/
  // legacy-without-probe) tested a capability that no longer exists and is
  // not re-added. The floor (`minExchangeRate`/`floorBps`) and
  // `swapDefaults.floorBps` DO still exist on the rolling path — ported below.

  it('swap withholds a below-floor rolling fill and echoes the armed floor (#351)', async () => {
    await runner.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '900',
        sourceAmount: '1000',
        targetAmount: '900',
      });

    const res = await runner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      streamNonce: STREAM_NONCE,
      // Pair rate 1.0; 900/1000 delivered is below a 0.95 floor.
      minExchangeRate: '0.95',
    });

    // The breach withheld the fill: no claim, no leg-A reveal, no value paid.
    expect(res.accepted).toBe(false);
    expect(res.claims).toHaveLength(0);
    expect(res.state).toBe('failed');
    // Rejections-only (no local errors) rewrites abortReason (mirrors the
    // legacy path's documented 'below-floor'/'all-rejected' quirk).
    expect(res.abortReason).toBe('all-rejected');
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections?.[0]?.code).toBe('ROLLING_ADVANCE_REJECTED');
    expect(res.rejections?.[0]?.message).toMatch(/withheld/);
    expect(res.rejections?.[0]?.message).toContain('950');
    // Consent surface: the armed floor is echoed for the host to show.
    expect(res.minExchangeRate).toBe('0.95');
  });

  it('swap derives the floor from floorBps against the advertised rate and arms it on the rolling path (spec §5 R₀ × (1 − tolerance))', async () => {
    await runner.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '850',
        sourceAmount: '1000',
        targetAmount: '850',
      });

    // 1000 bps under the advertised 1.0 → 0.9, exact decimal-string math;
    // 850/1000 delivered is below that derived floor (entitled 900).
    const res = await runner.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      streamNonce: STREAM_NONCE,
      floorBps: 1000,
    });

    expect(res.minExchangeRate).toBe('0.9');
    expect(res.accepted).toBe(false);
    expect(res.rejections?.[0]?.message).toContain('900');
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

  it('swap applies the daemon-level swapDefaults.floorBps on the rolling path, a per-request floor overrides it, and an explicit packetCount pins the split', async () => {
    const c = new FakeRollingMakerClient();
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
        swapDefaults: { floorBps: 500 },
      }),
      createClient: (cfg) => {
        c.jobHandler = cfg.jobHandler as typeof c.jobHandler;
        return c;
      },
      createRelay: fakeRelay,
    });
    await r.bootstrap();
    let perPacketAmount = '1000';
    // A running total across ALL swap() calls in this test (not just the
    // packets within one call) — the channel watermark persists between
    // calls on the same runner, so nonce/cumulativeAmount must keep
    // advancing across calls too, not just within a call's own packets.
    let totalSent = 0;
    c.buildAdvance = (seq) => {
      totalSent += Number(perPacketAmount);
      return rollingAdvanceBytes({
        seq,
        nonce: String(totalSent),
        cumulativeAmount: String(totalSent),
        sourceAmount: perPacketAmount,
        targetAmount: perPacketAmount,
      });
    };

    // No per-request knob → the daemon default (5% off the advertised 1.0)
    // arms the floor even though this fill clears it easily.
    const res = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      streamNonce: STREAM_NONCE,
    });
    expect(res.accepted).toBe(true);
    expect(res.minExchangeRate).toBe('0.95');
    expect(res.realizedRate).toBeCloseTo(1, 10);

    // A per-request floor beats the daemon default.
    const res2 = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      streamNonce: STREAM_NONCE,
      minExchangeRate: '0.5',
    });
    expect(res2.minExchangeRate).toBe('0.5');

    // An explicit packetCount pins the split (2 packets instead of a single
    // even fill) — floor/defaults still apply to each.
    perPacketAmount = '500';
    const sendSpy = vi.spyOn(c, 'sendSwapPacket');
    const res3 = await r.swap({
      destination: 'g.proxy.swap',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      streamNonce: STREAM_NONCE,
      packetCount: 2,
    });
    expect(sendSpy).toHaveBeenCalledTimes(2);
    expect(res3.packetsAccepted).toBe(2);
    expect(res3.minExchangeRate).toBe('0.95');
    await r.stop();
  });

  // toon-client#598: "swap surfaces per-packet outcomes... from onPacket" and
  // "swap arms an abort signal from timeoutMs..." tested the LEGACY sdk's
  // `onPacket` callback / `AbortSignal` plumbing. Their rolling-path
  // equivalents ('[#596] a rolling `SwapResponse` carries `packets[]`...' and
  // '[#596] `timeoutMs` bounds the rolling fill loop...' above) already cover
  // per-packet telemetry and partial-fill-on-timeout; not re-added here.

  // ── Receive-side claim ingestion/verification/settlement (#352) ────────────

  // toon-client#598: this suite used to reach receive-side claim
  // verification/persistence via the legacy mock purely as an easy way to
  // seed an accepted claim — `ingestAndReveal`, the received-claim store and
  // settlement are NOT deleted and still need coverage. Pinning a
  // `streamNonce` (skips the RFQ probe) reaches the exact same
  // `ingestReceivedClaims` check ladder over the rolling wire, via
  // `client.buildAdvance` instead of a mocked legacy sender.
  const swapReq = (
    over: Partial<Parameters<ClientRunner['swap']>[0]> = {}
  ) => ({
    destination: 'g.proxy.swap',
    amount: '1000',
    swapPubkey: 'cd'.repeat(32),
    pair: EVM_PAIR,
    chainRecipient: EVM_RECIPIENT,
    streamNonce: STREAM_NONCE,
    ...over,
  });

  it('swap REJECTS a tampered claim loudly: not counted, not persisted, swap not accepted (#352)', async () => {
    await runner.bootstrap();
    // The signature covers cumulative=500 but the claim ADVERTISES 999 — a
    // maker inflating the advertised watermark beyond what it signed.
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '999',
        signedCumulativeAmount: '500',
        sourceAmount: '1000',
        targetAmount: '999',
      });

    const res = await runner.swap(swapReq({ swapSignerAddress: SWAP_SIGNER }));

    // The claim FAILED verification: never counted as value received, no
    // leg-A reveal, swap not accepted. On the rolling path a failed-verify
    // advance is a REJECTION (leg B is never revealed), not a `claims[]`
    // entry with `verified:false` — the legacy path's shape.
    expect(res.accepted).toBe(false);
    expect(res.claims).toHaveLength(0);
    expect(res.rejections).toHaveLength(1);
    expect(res.rejections?.[0]?.message).toContain('SIGNER_MISMATCH');
    // Nothing was persisted.
    expect(runner.listSwapClaims().claims).toHaveLength(0);
  });

  it('swap REJECTS a claim signed by the wrong signer: SWAP_SIGNER_MISMATCH against the advertised address (#352)', async () => {
    await runner.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '999',
        sourceAmount: '1000',
        targetAmount: '999',
      });

    const res = await runner.swap(
      // Maker's ADVERTISED signer differs from the claim's self-reported one.
      swapReq({ swapSignerAddress: '0x' + 'cc'.repeat(20) })
    );

    expect(res.accepted).toBe(false);
    expect(res.claims).toHaveLength(0);
    expect(res.rejections?.[0]?.message).toContain('SWAP_SIGNER_MISMATCH');
    expect(runner.listSwapClaims().claims).toHaveLength(0);
  });

  it('swap REJECTS a non-monotonic nonce/cumulative against the persisted watermark (#352)', async () => {
    await runner.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '2',
        cumulativeAmount: '2000',
        sourceAmount: '1000',
        targetAmount: '2000',
      });
    await runner.swap(swapReq());

    // A replayed/stale claim: same nonce, same cumulative — validly signed.
    // (`buildAdvance` above already builds exactly this shape again.)
    const res = await runner.swap(swapReq());

    expect(res.accepted).toBe(false);
    expect(res.claims).toHaveLength(0);
    expect(res.rejections?.[0]?.message).toContain('NON_MONOTONIC_NONCE');
    // The watermark still holds the FIRST claim.
    expect(runner.listSwapClaims().claims[0]).toMatchObject({
      nonce: '2',
      cumulativeAmount: '2000',
    });
  });

  it('swap folds N packets into ONE per-channel watermark with summed value (#352)', async () => {
    await runner.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(300 * seq),
        sourceAmount: '300',
        targetAmount: '300',
      });

    const res = await runner.swap(swapReq({ amount: '900', packetCount: 3 }));
    expect(res.claimsVerified).toBe(3);
    expect(res.valueReceived).toBe('900');

    // One persisted entry — the final watermark.
    const listed = runner.listSwapClaims().claims;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ nonce: '3', cumulativeAmount: '900' });
  });

  /** Wire a fresh runner's rolling `jobHandler` onto the shared `client`. */
  const withClient: CreateClient = (cfg) => {
    client.jobHandler = cfg.jobHandler as typeof client.jobHandler;
    return client;
  };

  it('persisted received claims survive a daemon restart (#352)', async () => {
    const storePath = join(tmpDir, 'received-claims.json');
    const mkRunner = () =>
      new ClientRunner({
        config: makeConfig({ receivedClaimStorePath: storePath }),
        createClient: withClient,
        createRelay: fakeRelay,
      });
    const first = mkRunner();
    await first.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '999',
        sourceAmount: '1000',
        targetAmount: '999',
      });
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
      createClient: withClient,
      createRelay: fakeRelay,
    });
    const settleSpy = vi.fn(async () => ({
      txHash: '0xsettletx',
      status: 'success' as const,
    }));
    client.settleSwapBundle = settleSpy;
    await settleRunner.bootstrap();

    // Three verified advances → one persisted watermark.
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: String(seq),
        cumulativeAmount: String(300 * seq),
        sourceAmount: '300',
        targetAmount: '300',
      });
    await settleRunner.swap(swapReq({ amount: '900', packetCount: 3 }));

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
      createClient: withClient,
      createRelay: fakeRelay,
    });
    await seeded.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '999',
        sourceAmount: '1000',
        targetAmount: '999',
      });
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
      createClient: withClient,
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
      createClient: withClient,
      createRelay: fakeRelay,
    });
    await seeded.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '999',
        sourceAmount: '1000',
        targetAmount: '999',
      });
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
      createClient: withClient,
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
      createClient: withClient,
      createRelay: fakeRelay,
    });
    await dryRunner.bootstrap();
    client.buildAdvance = (seq) =>
      rollingAdvanceBytes({
        seq,
        nonce: '1',
        cumulativeAmount: '999',
        sourceAmount: '1000',
        targetAmount: '999',
      });
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
    const created: FakeRollingMakerClient[] = [];
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
      }),
      createClient: (cfg) => {
        const c = new FakeRollingMakerClient();
        c.jobHandler = cfg.jobHandler as typeof c.jobHandler;
        c.buildAdvance = (seq) =>
          rollingAdvanceBytes({
            seq,
            nonce: String(seq),
            cumulativeAmount: String(1000 * seq),
            sourceAmount: '1000',
            targetAmount: '1000',
          });
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

    // One client per apex: [0] is the default/identity client, [1] the
    // discovered maker apex. The swap must have streamed on the LATTER.
    const defaultClient = created[0];
    const makerClient = created[1];
    expect(makerClient).toBeDefined();
    const defaultSpy = defaultClient && vi.spyOn(defaultClient, 'sendSwapPacket');
    const makerSpy = makerClient && vi.spyOn(makerClient, 'sendSwapPacket');

    const res = await runner.swap({
      destination: 'g.toon.swap.maker',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      streamNonce: STREAM_NONCE,
      btpUrl: 'ws://apex2.example/btp',
    });

    expect(res.accepted).toBe(true);
    expect(makerSpy).toHaveBeenCalledTimes(1);
    expect(defaultSpy).not.toHaveBeenCalled();
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
    const created: FakeRollingMakerClient[] = [];
    const runner = new ClientRunner({
      config: makeConfig({
        relayUrl: 'ws://relay.test',
        apexChannelStorePath: join(dir, 'apex-channels.json'),
      }),
      createClient: (cfg) => {
        const c = new FakeRollingMakerClient();
        c.jobHandler = cfg.jobHandler as typeof c.jobHandler;
        c.buildAdvance = (seq) =>
          rollingAdvanceBytes({
            seq,
            nonce: String(seq),
            cumulativeAmount: String(1000 * seq),
            sourceAmount: '1000',
            targetAmount: '1000',
          });
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

    const defaultClient = created[0];
    const makerClient = created[1];
    expect(makerClient).toBeDefined();
    const defaultSpy = defaultClient && vi.spyOn(defaultClient, 'sendSwapPacket');
    const makerSpy = makerClient && vi.spyOn(makerClient, 'sendSwapPacket');

    const res = await runner.swap({
      destination: 'g.toon.swap.maker',
      amount: '1000',
      swapPubkey: 'cd'.repeat(32),
      pair: EVM_PAIR,
      chainRecipient: EVM_RECIPIENT,
      streamNonce: STREAM_NONCE,
      // NO btpUrl — the destination alone must find its apex.
    });

    expect(res.accepted).toBe(true);
    expect(makerSpy).toHaveBeenCalledTimes(1);
    expect(defaultSpy).not.toHaveBeenCalled();
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

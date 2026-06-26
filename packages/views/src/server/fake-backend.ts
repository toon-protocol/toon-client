/**
 * In-memory fake backend: a seeded "relay" for reads + writes that append to the
 * same store (so a published note / follow / reaction shows up on the next
 * `toon_query`, making the agent-driven journey feel real). No network, no keys,
 * no payments — good enough to exercise the generative-UI loop while core/sdk
 * are in flux.
 */

import { type NostrEvent, type NostrFilter } from '../types.js';
import {
  type AppBackend,
  type AppStatus,
  type BalanceView,
  type ChannelView,
  type FundWalletView,
  type PublishResult,
  type SwapRequest,
  type SwapResponse,
  type UploadResult,
} from './backend.js';

const SELF = 'fakeself00000000000000000000000000000000000000000000000000000000';
const ALICE = 'a11ce0000000000000000000000000000000000000000000000000000000aaaa';
const BOB = 'b0b0000000000000000000000000000000000000000000000000000000000bbb';

function ev(e: Partial<NostrEvent> & { kind: number; id: string }): NostrEvent {
  return {
    pubkey: e.pubkey ?? ALICE,
    created_at: e.created_at ?? 1_700_000_000,
    tags: e.tags ?? [],
    content: e.content ?? '',
    sig: e.sig ?? 'fakesig',
    ...e,
  };
}

/** A small but representative dataset spanning the supported NIPs. */
function seed(): NostrEvent[] {
  return [
    // profiles (kind:0)
    ev({ id: 'p_alice', kind: 0, pubkey: ALICE, content: JSON.stringify({ name: 'alice', about: 'building toon', nip05: 'alice@toon.dev' }) }),
    ev({ id: 'p_bob', kind: 0, pubkey: BOB, content: JSON.stringify({ name: 'bob', about: 'just here for the pics' }) }),
    // notes (kind:1) — a tiny thread
    ev({ id: 'n_root', kind: 1, pubkey: ALICE, content: 'gm — first post over TOON', created_at: 1_700_000_100 }),
    ev({ id: 'n_reply', kind: 1, pubkey: BOB, content: 'gm! looks great', created_at: 1_700_000_200, tags: [['e', 'n_root', '', 'root'], ['p', ALICE]] }),
    // follows (kind:3)
    ev({ id: 'f_self', kind: 3, pubkey: SELF, created_at: 1_700_000_050, tags: [['p', ALICE]] }),
    // reactions (kind:7)
    ev({ id: 'r1', kind: 7, pubkey: BOB, content: '+', tags: [['e', 'n_root'], ['p', ALICE]] }),
    // forge: repo (30617) + issue (1621)
    ev({ id: 'repo1', kind: 30617, pubkey: ALICE, tags: [['d', 'toon'], ['name', 'toon'], ['description', 'pay-to-write nostr'], ['r', 'HEAD', 'main']] }),
    ev({ id: 'issue1', kind: 1621, pubkey: BOB, content: 'reads should be free', tags: [['subject', 'Free reads'], ['a', `30617:${ALICE}:toon`], ['t', 'design']] }),
    // media: a picture post (kind:20, NIP-68 + NIP-92 imeta)
    ev({ id: 'pic1', kind: 20, pubkey: ALICE, content: 'sunset over the mempool', tags: [['title', 'Sunset'], ['imeta', 'url https://arweave.net/seed-pic', 'm image/png'], ['t', 'photo']] }),
  ];
}

function matches(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.ids && !filter.ids.includes(event.id)) return false;
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.authors && !filter.authors.includes(event.pubkey)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const [key, values] of Object.entries(filter)) {
    if (!key.startsWith('#') || !Array.isArray(values)) continue;
    const letter = key.slice(1);
    const hit = event.tags.some((t) => t[0] === letter && t[1] !== undefined && (values as string[]).includes(t[1]));
    if (!hit) return false;
  }
  return true;
}

export class FakeBackend implements AppBackend {
  private events: NostrEvent[] = seed();
  private seq = 0;
  /** Fixed base so ids/timestamps are deterministic across a session. */
  private clock = 1_700_001_000;

  /**
   * Deterministic pay-to-write status stub. The confirm UX renders this fee +
   * chain so its snapshot is stable; the real daemon (#16) returns live values
   * with no UI change. No payment, no network.
   */
  status(): Promise<AppStatus> {
    return Promise.resolve({ feePerEvent: '1', settlementChain: 'base', asset: 'USDC' });
  }

  query(filter: NostrFilter): Promise<NostrEvent[]> {
    const out = this.events
      .filter((e) => matches(e, filter))
      .sort((a, b) => b.created_at - a.created_at);
    const limited = filter.limit !== undefined ? out.slice(0, filter.limit) : out;
    return Promise.resolve(limited);
  }

  publish(req: { kind: number; content?: string; tags?: string[][] }): Promise<PublishResult> {
    const id = `w_${++this.seq}`;
    const event = ev({
      id,
      kind: req.kind,
      pubkey: SELF,
      content: req.content ?? '',
      tags: req.tags ?? [],
      created_at: ++this.clock,
    });
    // Replaceable kinds (0/3): drop the prior self event so reads reflect the latest.
    if (req.kind === 0 || req.kind === 3) {
      this.events = this.events.filter((e) => !(e.kind === req.kind && e.pubkey === SELF));
    }
    this.events.push(event);
    return Promise.resolve({ eventId: id, channelId: 'fake-channel', nonce: this.seq });
  }

  uploadMedia(req: {
    dataBase64: string;
    mime?: string;
    kind?: number;
    caption?: string;
    tags?: string[][];
  }): Promise<UploadResult> {
    const txId = `fake-${++this.seq}`;
    const url = `https://arweave.net/${txId}`;
    const kind = req.kind ?? 1063;
    const mime = req.mime ?? 'application/octet-stream';
    const mediaTags: string[][] =
      kind === 1063
        ? [['url', url], ['m', mime], ...(req.tags ?? [])]
        : [['imeta', `url ${url}`, `m ${mime}`], ...(req.tags ?? [])];
    const id = `w_${this.seq}`;
    this.events.push(
      ev({ id, kind, pubkey: SELF, content: req.caption ?? '', tags: mediaTags, created_at: ++this.clock })
    );
    return Promise.resolve({ eventId: id, url, txId, channelId: 'fake-channel', nonce: this.seq });
  }

  /**
   * Pre-open a payment channel. Deterministic id so the example renders the
   * same receipt every time. No keys, no settlement — the real daemon (#16)
   * delegates to `control-client.openChannel`.
   */
  openChannel(req: { destination?: string }): Promise<{ channelId: string }> {
    const channelId = `fake-channel-${++this.seq}${req.destination ? `-${req.destination}` : ''}`;
    return Promise.resolve({ channelId });
  }

  /**
   * Run a swap. Returns a canned `SwapResponse` with one `SwapClaim` derived
   * deterministically from the request (rate applied to the source amount) so
   * the settlement receipt is reproducible. No signing happens here.
   */
  swap(req: SwapRequest): Promise<SwapResponse> {
    const seq = ++this.seq;
    const rate = Number.parseFloat(req.pair.rate) || 1;
    const source = req.amount;
    const target = String(Math.floor((Number.parseFloat(source) || 0) * rate));
    const claim: SwapResponse['claims'][number] = {
      sourceAmount: source,
      targetAmount: target,
      claim: Buffer.from(`fake-claim-${seq}`).toString('base64'),
      channelId: `fake-target-channel-${seq}`,
      recipient: req.chainRecipient,
      swapSignerAddress: '0x000000000000000000000000000000000000dEaD',
      claimId: `fake-claim-id-${seq}`,
      nonce: String(seq),
      cumulativeAmount: target,
    };
    return Promise.resolve({
      accepted: true,
      packetsAccepted: req.packetCount ?? 1,
      claims: [claim],
      cumulativeSource: source,
      cumulativeTarget: target,
      state: 'completed',
    });
  }

  /**
   * Tracked channels with deterministic balances so the wallet/channel-list
   * atoms render stably. available = depositTotal − cumulativeAmount.
   */
  channels(): Promise<{ channels: ChannelView[] }> {
    return Promise.resolve({
      channels: [
        { channelId: 'fake-channel-1', nonce: 12, cumulativeAmount: '4500000', depositTotal: '10000000', availableBalance: '5500000' },
        { channelId: 'fake-channel-2', nonce: 3, cumulativeAmount: '800000', depositTotal: '2000000', availableBalance: '1200000' },
      ],
    });
  }

  /** Deterministic per-chain wallet balances (USDC, micro-units). */
  balances(): Promise<{ balances: BalanceView[] }> {
    return Promise.resolve({
      balances: [
        { chain: 'evm', address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', amount: '125500000', asset: 'USDC', assetScale: 6 },
        { chain: 'solana', address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', amount: '48200000', asset: 'USDC', assetScale: 6 },
      ],
    });
  }

  /** Canned faucet drip echo (devnet). */
  fundWallet(req: { chain?: string; address?: string }): Promise<FundWalletView> {
    return Promise.resolve({
      chain: req.chain ?? 'evm',
      address: req.address ?? '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
      faucetUrl: 'https://faucet.devnet.toonprotocol.dev',
    });
  }

  /** Test helper: total events currently in the store. */
  size(): number {
    return this.events.length;
  }
}

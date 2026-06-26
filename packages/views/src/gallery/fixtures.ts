/**
 * Gallery fixtures — realistic, deterministic NostrEvents + a daemon status
 * snapshot used by the dev-only visual harness (see `gallery.tsx`). Plain data,
 * no network: media URLs are inline SVG data URIs so images render offline, and
 * pubkeys/ids are fixed hex so avatars/colours stay stable across screenshots.
 *
 * NOT shipped in the bundle — `gallery.html` is a dev-server-only entry.
 */
import { type NostrEvent } from '../types.js';

/** A tiny inline SVG data URI so media atoms render real pixels offline. */
function svg(label: string, from: string, to: string): string {
  const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="500">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${from}"/><stop offset="1" stop-color="${to}"/>
    </linearGradient></defs>
    <rect width="800" height="500" fill="url(#g)"/>
    <text x="40" y="460" font-family="ui-sans-serif,system-ui" font-size="34"
      fill="rgba(255,255,255,0.9)" font-weight="600">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(doc)}`;
}

// ── Identities ───────────────────────────────────────────────────────────────
export const PK = {
  ada: 'a1d4e0c2f3b59617a8b2c0d4e6f80911223344556677889900aabbccddeeff01',
  satoshi: 'b2e5f1d3a4c60728b9c3d1e5f7091122334455667788990011bbccddeeff0102',
  grace: 'c3f602e4b5d71839cad4e2f60810223344556677889900112233ccddeeff0203',
  linus: 'd40713f5c6e8294adbe5f30719112233445566778899001122334455667788aa',
} as const;

const HOUR = 3600;
const NOW = 1_780_000_000; // fixed "now" for deterministic relative times

function evt(e: Partial<NostrEvent> & { id: string; kind: number; pubkey: string }): NostrEvent {
  return { created_at: NOW, tags: [], content: '', sig: 'sig', ...e };
}

// ── kind:0 profiles ──────────────────────────────────────────────────────────
export const PROFILES: NostrEvent[] = [
  evt({
    id: 'p_ada',
    kind: 0,
    pubkey: PK.ada,
    content: JSON.stringify({
      name: 'ada',
      display_name: 'Ada Lovelace',
      about: 'Writing the first programs and the first paid notes. Reads are free; the message is the money.',
      nip05: 'ada@toonprotocol.dev',
      picture: '',
    }),
  }),
  evt({
    id: 'p_satoshi',
    kind: 0,
    pubkey: PK.satoshi,
    content: JSON.stringify({
      name: 'satoshi',
      display_name: 'Satoshi',
      about: 'Peer-to-peer everything.',
      nip05: 'satoshi@toonprotocol.dev',
    }),
  }),
  evt({
    id: 'p_grace',
    kind: 0,
    pubkey: PK.grace,
    content: JSON.stringify({ name: 'grace', display_name: 'Grace Hopper', about: 'Compilers, ships, nanoseconds.' }),
  }),
];

const PROFILE_BY_PK = new Map(PROFILES.map((p) => [p.pubkey, p]));
export function profileFor(pubkey: string): NostrEvent | undefined {
  return PROFILE_BY_PK.get(pubkey) ?? PROFILES[0];
}

// ── kind:1 notes (feed) ──────────────────────────────────────────────────────
export const NOTES: NostrEvent[] = [
  evt({
    id: 'n_1',
    kind: 1,
    pubkey: PK.ada,
    created_at: NOW - 2 * 60,
    content:
      'Just shipped the pay-to-write flow. Every note settles a channel claim — the message literally is the money. ⚡',
  }),
  evt({
    id: 'n_2',
    kind: 1,
    pubkey: PK.satoshi,
    created_at: NOW - 40 * 60,
    content: 'Reads are free, writes are paid. Turns out that is the whole spam filter.',
  }),
  evt({
    id: 'n_3',
    kind: 1,
    pubkey: PK.grace,
    created_at: NOW - 5 * HOUR,
    content:
      'Posting a picture from the lab today.\n\nMedia bytes live on Arweave; the event just carries the imeta.',
    tags: [
      [
        'imeta',
        `url ${svg('grace@lab.jpg', '#6d28d9', '#db2777')}`,
        'm image/svg+xml',
        'dim 800x500',
        'alt the lab',
      ],
    ],
  }),
  evt({
    id: 'n_4',
    kind: 1,
    pubkey: PK.ada,
    created_at: NOW - 26 * HOUR,
    content: 'Threading works too — replies flow oldest-first so the conversation reads top to bottom.',
  }),
];

// ── kind:7 reactions targeting n_1 ───────────────────────────────────────────
export const REACTIONS: NostrEvent[] = [
  evt({ id: 'r_1', kind: 7, pubkey: PK.satoshi, content: '+', tags: [['e', 'n_1'], ['p', PK.ada]] }),
  evt({ id: 'r_2', kind: 7, pubkey: PK.grace, content: '+', tags: [['e', 'n_1'], ['p', PK.ada]] }),
  evt({ id: 'r_3', kind: 7, pubkey: PK.ada, content: '🔥', tags: [['e', 'n_1'], ['p', PK.ada]] }),
  evt({ id: 'r_4', kind: 7, pubkey: PK.satoshi, content: '⚡', tags: [['e', 'n_1'], ['p', PK.ada]] }),
];

// ── thread: root note + replies (kind:1 referencing root) ────────────────────
export const THREAD_ROOT: NostrEvent = evt({
  id: 't_root',
  kind: 1,
  pubkey: PK.ada,
  created_at: NOW - 3 * HOUR,
  content: 'How should fees scale — per event, or per byte?',
});
export const THREAD_REPLIES: NostrEvent[] = [
  evt({
    id: 't_r1',
    kind: 1,
    pubkey: PK.satoshi,
    created_at: NOW - 2 * HOUR,
    content: 'Per byte. It makes the cost legible: you can see the price in the composer as you type.',
    tags: [['e', 't_root', '', 'root']],
  }),
  evt({
    id: 't_r2',
    kind: 1,
    pubkey: PK.grace,
    created_at: NOW - 1 * HOUR,
    content: 'Agreed. Per-byte also discourages bloat without a hard size cap.',
    tags: [['e', 't_root', '', 'root']],
  }),
];

// ── media posts (kind:20) ────────────────────────────────────────────────────
export const MEDIA_POSTS: NostrEvent[] = [
  evt({
    id: 'm_1',
    kind: 20,
    pubkey: PK.grace,
    content: 'Sunrise over the harbour.',
    tags: [
      ['title', 'Harbour'],
      ['imeta', `url ${svg('harbour.jpg', '#0ea5e9', '#6366f1')}`, 'm image/svg+xml', 'dim 800x500'],
      ['t', 'photography'],
    ],
  }),
];

// ── forge: repo (30617), issues (1621), PRs (1617), comments (1622) ──────────
export const REPOS: NostrEvent[] = [
  evt({
    id: 'repo_1',
    kind: 30617,
    pubkey: PK.linus,
    content: '',
    tags: [
      ['d', 'toon-client'],
      ['name', 'toon-client'],
      ['description', 'The TOON protocol client: pay-to-write Nostr over Interledger.'],
      ['head', 'main'],
    ],
  }),
];
export const ISSUES: NostrEvent[] = [
  evt({
    id: 'issue_1',
    kind: 1621,
    pubkey: PK.ada,
    content: 'The render harness should screenshot every atom in light and dark.',
    tags: [['subject', 'Add a visual gallery for the atoms'], ['a', '30617:' + PK.linus + ':toon-client'], ['t', 'enhancement']],
  }),
  evt({
    id: 'issue_2',
    kind: 1621,
    pubkey: PK.grace,
    content: 'Pure-grayscale theme reads as a templated default. Needs an intentional palette.',
    tags: [['subject', 'Theme: replace default shadcn grays'], ['a', '30617:' + PK.linus + ':toon-client'], ['t', 'design']],
  }),
];
export const PRS: NostrEvent[] = [
  evt({
    id: 'pr_1',
    kind: 1617,
    pubkey: PK.satoshi,
    content: 'Adds the gallery + mock bridge.',
    tags: [['subject', 'feat: visual gallery harness'], ['c', 'abc1234'], ['c', 'def5678'], ['base-branch', 'main']],
  }),
];
export const COMMENTS: NostrEvent[] = [
  evt({ id: 'c_1', kind: 1622, pubkey: PK.grace, created_at: NOW - 90 * 60, content: 'Love this — finally I can see what I am building.', tags: [['e', 'issue_1']] }),
  evt({ id: 'c_2', kind: 1622, pubkey: PK.ada, created_at: NOW - 30 * 60, content: 'Adding dark-mode panels next to each light one.', tags: [['e', 'issue_1']] }),
];

// ── live daemon status (toon_status) ─────────────────────────────────────────
export const STATUS = {
  feePerEvent: '0.0002',
  settlementChain: 'base',
  asset: 'USDC',
  uptimeMs: (26 * HOUR + 14 * 60) * 1000,
  ready: true,
  bootstrapping: false,
  identity: {
    nostrPubkey: 'npub1ada' + 'q'.repeat(48),
    evmAddress: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F',
    solanaAddress: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs',
  },
  transport: { type: 'btp', btpUrl: 'wss://connector.devnet.toonprotocol.dev:443' },
  relay: {
    url: 'wss://relay.devnet.toonprotocol.dev',
    connected: true,
    buffered: 128,
    subscriptions: ['feed', 'profile', 'reactions'],
  },
  network: [
    { chain: 'base', ready: true },
    { chain: 'solana', ready: true },
    { chain: 'mina', ready: false, detail: 'channel funding pending' },
  ],
};

/** Live wallet-read fixtures (toon_channels / toon_balances seams). */
export const WALLET_CHANNELS = [
  { channelId: '0xCH4NN3L00aa11bb22cc33dd44ee55ff', nonce: 42, cumulativeAmount: '4500000', depositTotal: '10000000', availableBalance: '5500000' },
  { channelId: '0xCH4NN3L99zz88yy77xx66ww55vv44uu', nonce: 7, cumulativeAmount: '800000', depositTotal: '2000000', availableBalance: '1200000' },
];
export const WALLET_BALANCES = [
  { chain: 'evm', address: '0x71C7656EC7ab88b098defB751B7401B5f6d8976F', amount: '125500000', asset: 'USDC', assetScale: 6 },
  { chain: 'solana', address: '7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs', amount: '48200000', asset: 'USDC', assetScale: 6 },
  { chain: 'mina', address: 'B62qiTKpEPjGTSHZrtM8uXiKgn8So916pLmNJKDhKeyJvpW2im4oG6', amount: '0', asset: 'MINA', assetScale: 9 },
];

/** Channel / swap fixtures for the DeFi atoms (props-driven). */
export const CHANNELS = [
  { channelId: '0xCH4NN3L00aa11bb22cc33dd44ee55ff', nonce: 42, cumulativeAmount: '12.5000 USDC' },
  { channelId: '0xCH4NN3L99zz88yy77xx66ww55vv44uu', nonce: 7, cumulativeAmount: '3.2000 USDC' },
];
export const SWAP_PAIR = { from: { assetCode: 'USDC' }, to: { assetCode: 'SOL' }, rate: '0.0061' };
export const SETTLEMENT_RECEIPT = {
  accepted: true,
  state: 'completed',
  cumulativeSource: '10.0000 USDC',
  cumulativeTarget: '0.0610 SOL',
  packetsAccepted: 3,
  claims: [
    { claimId: 'clm_aa11bb', channelId: '0xCH4NN3L00aa11bb22cc33dd44', nonce: '8', targetAmount: '0.0203 SOL' },
    { claimId: 'clm_cc22dd', channelId: '0xCH4NN3L00aa11bb22cc33dd44', nonce: '9', targetAmount: '0.0203 SOL' },
    { claimId: 'clm_ee33ff', channelId: '0xCH4NN3L00aa11bb22cc33dd44', nonce: '10', targetAmount: '0.0204 SOL' },
  ],
};

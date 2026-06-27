/**
 * Pure atom catalog — Node-safe metadata (no React).
 *
 * This is the single source of truth for which atom ids exist, what kinds they
 * render, and which writes they expose. The client-side React registry
 * ({@link ./atoms/registry}) is asserted to match this list in tests, and the
 * server-side `toon_atoms` tool + ViewSpec validator allowlist read from here so
 * `@toon-protocol/client-mcp` never imports the React bundle.
 */

import { FUND_WALLET_TOOL, OPEN_CHANNEL_TOOL, SWAP_TOOL } from './tool-names.js';

export interface AtomWriteMeta {
  name: string;
  spendy?: boolean;
}

export interface AtomMeta {
  id: string;
  description: string;
  /** Event kinds this atom is the default renderer for. */
  kinds?: number[];
  /** Write tools this atom can fire. */
  writes?: AtomWriteMeta[];
  /** Human/agent-readable hint of the props the atom accepts. */
  propsSchema?: Record<string, string>;
}

export const ATOM_CATALOG: AtomMeta[] = [
  // layout
  {
    id: 'stack',
    description: 'Vertical (default) or horizontal stack of child nodes.',
    propsSchema: { direction: "'row' | 'col'", gap: 'number (tailwind gap step)' },
  },
  { id: 'section', description: 'Titled section wrapper.', propsSchema: { title: 'string' } },
  { id: 'card', description: 'Bordered card container.' },
  {
    id: 'tabs',
    description: 'Tabbed container; one child node per tab. Use for multi-section journeys.',
    propsSchema: { labels: 'string[] (tab names, in child order)' },
  },

  // social
  { id: 'profile-header', description: 'NIP-01 kind:0 profile header (avatar, name, nip05, bio).', kinds: [0] },
  {
    id: 'note-card',
    description:
      'NIP-01 kind:1 text note, rendered as an X-style post (author header with ' +
      'a Follow button, body + inline media, action bar). Optional "reply" ' +
      '(kind:1), "react"/Like (kind:7 "+"), and "follow" (kind:3) actions — all ' +
      'paid writes via toon_publish_unsigned.',
    kinds: [1],
    writes: [{ name: 'toon_publish_unsigned' }],
  },
  { id: 'reaction-bar', description: 'NIP-25 kind:7 reaction counts; optional "react" action.', kinds: [7] },
  {
    id: 'follow-button',
    description: 'NIP-02 follow/unfollow (publishes kind:3).',
    writes: [{ name: 'toon_publish_unsigned' }],
    propsSchema: { label: 'string' },
  },
  {
    id: 'composer',
    description: 'Text composer that publishes a note (kind:1) via its "post" action.',
    writes: [{ name: 'toon_publish_unsigned' }],
    propsSchema: { placeholder: 'string', label: 'string' },
  },
  {
    id: 'pay-confirm',
    description:
      'Pay-to-write moment: compose a note, then a confirm step shows the live ' +
      'fee + settlement chain (from toon_status) with Confirm/Cancel. Confirm ' +
      'fires the "confirm" action (toon_publish_unsigned) and renders a receipt ' +
      'with the published eventId — "the message is the money".',
    writes: [{ name: 'toon_publish_unsigned' }],
    propsSchema: { placeholder: 'string', label: 'string (compose button label)' },
  },

  // media
  {
    id: 'media-embed',
    description: 'Render image/video streamed from Arweave (NIP-68/71/94).',
    kinds: [20, 21, 22, 1063],
  },
  {
    id: 'media-uploader',
    description:
      'Compose & publish a media POST: pick a file (image, video, pdf, audio, …) ' +
      'via the in-app picker, preview it, add an OPTIONAL caption/text, then ' +
      'Publish — uploads to Arweave and publishes a reference event in one paid ' +
      'write. The caption becomes the event content, so an image/video + text is ' +
      'a real post (kind:20 picture, 21 video, 1063 NIP-94 file for everything ' +
      'else — chosen automatically from the MIME). Spendy. This IS the ' +
      'post-with-media path; use it whenever the user wants to post/upload a ' +
      'picture, video, or file with or without a caption. No URL needed.',
    writes: [{ name: 'toon_upload', spendy: true }],
    propsSchema: {
      label: 'string',
      accept: "string (optional MIME filter, e.g. 'image/*'; default any)",
      captionPlaceholder: 'string (optional placeholder for the caption field)',
    },
  },

  // forge
  { id: 'repo-card', description: 'NIP-34 kind:30617 repository card.', kinds: [30617] },
  {
    id: 'issue-card',
    description: 'NIP-34 kind:1621 issue; optional "comment" action.',
    kinds: [1621],
    writes: [{ name: 'toon_publish_unsigned' }],
  },
  { id: 'pr-card', description: 'NIP-34 kind:1617 patch/PR summary (status, commits, base).', kinds: [1617] },
  {
    id: 'comment-thread',
    description: 'NIP-34 kind:1622 comment list; optional "comment" action.',
    kinds: [1622],
    writes: [{ name: 'toon_publish_unsigned' }],
  },

  // defi
  {
    id: 'channel-card',
    description:
      'Read-only: shows tracked payment channels (channelId, nonce, cumulative ' +
      'amount). Optional "open" action pre-opens a channel.',
    kinds: [],
    writes: [{ name: OPEN_CHANNEL_TOOL }],
    propsSchema: { destination: 'string (optional ILP destination for "open")' },
  },
  {
    id: 'swap-form',
    description:
      'Interactive: collects swap params and fires a cross-asset swap. Spendy.',
    writes: [{ name: SWAP_TOOL, spendy: true }],
    propsSchema: {
      destination: 'string (swap peer ILP destination)',
      swapPubkey: 'string (swap peer 64-char hex Nostr pubkey)',
      pair: 'SwapPair ({ from, to, rate, … })',
      chainRecipient: 'string (payout address on pair.to.chain)',
      label: 'string (submit button label)',
    },
  },
  {
    id: 'settlement-receipt',
    description:
      'Read-only render of a SwapResponse / SwapClaim[] (target amount, chain ' +
      'claim, channelId, tx/claim id, nonce). No writes.',
  },

  // onboard
  {
    id: 'onboard-card',
    description:
      'Onboarding / get-started card: walks a new user through claiming an ' +
      'identity and opening a payment channel before they pay-to-write. Optional ' +
      '"publish" action publishes their initial kind:0 profile.',
    writes: [{ name: 'toon_publish_unsigned' }],
    propsSchema: {
      pubkey: 'string (the user’s Nostr pubkey, hex)',
      steps: 'string[] (optional checklist of get-started steps)',
      label: 'string (optional publish-profile button label)',
    },
  },
  {
    id: 'profile-editor',
    description:
      'Edit/create a NIP-01 kind:0 profile: input fields for name, display_name, ' +
      'picture (URL), about, and nip05, serialized into the kind:0 content JSON ' +
      'and published via toon_publish_unsigned ({ kind: 0, content }) through a ' +
      'pay-to-write confirm. Bind a kind:0 event to pre-fill the form (unknown ' +
      'fields are preserved on republish). The "publish" action fires the write.',
    writes: [{ name: 'toon_publish_unsigned' }],
    propsSchema: {
      label: 'string (optional save-button label)',
    },
  },

  // content — generic, props-driven primitives for ANY structured (non-event)
  // data: daemon status, write targets, balances, identity. Compose these inside
  // layout atoms instead of falling back to plain text. No event kinds.
  {
    id: 'heading',
    description: 'A heading/title for a section of arbitrary content.',
    propsSchema: { text: 'string', level: '1 | 2 | 3 (heading level, default 1)' },
  },
  {
    id: 'text',
    description: 'A paragraph / label of plain text.',
    propsSchema: { text: 'string', muted: 'boolean (render dimmed, optional)' },
  },
  {
    id: 'stat',
    description: 'A labeled metric (KPI) with an optional status colour.',
    propsSchema: {
      label: 'string',
      value: 'string | number',
      tone: "'default' | 'success' | 'warn' | 'danger' (optional)",
    },
  },
  {
    id: 'key-value',
    description: 'A definition list of aligned label → value rows (for details / identity / targets).',
    propsSchema: { rows: '{ label: string, value: string | number }[]' },
  },
  {
    id: 'badge',
    description: 'A small status pill.',
    propsSchema: {
      label: 'string',
      tone: "'default' | 'success' | 'warn' | 'danger' (optional)",
    },
  },

  // status — daemon health dashboard
  {
    id: 'client-status',
    description:
      'Daemon status dashboard: reads live toon_status and renders the ready/' +
      'bootstrapping state (badge), uptime, settlement chain + fee, relay (url, ' +
      'connected, buffered, subscriptions), transport, per-chain readiness, and ' +
      'identity (npub + chain addresses). No props; use to answer "show me my status".',
  },

  // wallet — manage wallets + payment channels (live reads from toon_balances /
  // toon_channels; faucet via toon_fund_wallet). No key material in the UI.
  {
    id: 'wallet-overview',
    description:
      'Wallet dashboard: per-chain address (with copy-to-share) from the live ' +
      'identity, enriched with on-chain token balance (toon_balances) when ' +
      'available. Optional devnet "Fund" action drips faucet test funds (receives, ' +
      'not a spend). Use to answer "show my wallet" / "what is my address".',
    writes: [{ name: FUND_WALLET_TOOL }],
  },
  {
    id: 'channel-list',
    description:
      'Live list of tracked payment channels (read from toon_channels): channelId, ' +
      'nonce watermark, and available (spendable) balance / locked deposit. The ' +
      'read variant of channel-card; use to answer "show my channels".',
  },
  {
    id: 'deposit-form',
    description:
      'Deposit additional on-chain collateral into an open channel: pick a channel ' +
      '(from toon_channels) + an amount, then a spendy signed deposit via ' +
      'toon_channel_deposit. Shows the new deposit total on success. EVM today.',
    writes: [{ name: 'toon_channel_deposit', spendy: true }],
  },
  {
    id: 'withdraw-flow',
    description:
      'Withdraw collateral from a channel: close → wait the settlement grace ' +
      'period → settle. A stepper + live countdown to settleableAt; Settle stays ' +
      'disabled until the grace period elapses. Two spendy signed on-chain txs ' +
      '(toon_channel_close, toon_channel_settle). EVM today.',
    writes: [
      { name: 'toon_channel_close', spendy: true },
      { name: 'toon_channel_settle', spendy: true },
    ],
  },

  // loading — placeholders the agent renders WHILE it works out the real view.
  // Render one of these as a first toon_render, then replace with the finished
  // ViewSpec once the journey is resolved. No data binds, no kinds.
  {
    id: 'skeleton',
    description:
      'Pulsing placeholder silhouette to render while the real view loads. ' +
      'Use as an immediate first render, then replace with the finished view.',
    propsSchema: {
      variant: "'lines' | 'avatar' | 'card' (default 'lines')",
      lines: 'number (line count for the lines variant, default 3)',
      width: 'string (optional max-width, e.g. "24rem")',
    },
  },
  {
    id: 'loading',
    description:
      'A spinner with an optional status line. Set `message` to narrate what ' +
      'you are doing (e.g. "Resolving balances…") while you compute the real view.',
    propsSchema: {
      message: 'string (status line, optional)',
      size: "'sm' | 'md' | 'lg' (optional)",
    },
  },
  {
    id: 'progress-steps',
    description:
      'A numbered stepper for a multi-step journey (e.g. Close → Wait → Settle). ' +
      'Steps before `active` show as done, `active` is highlighted, later steps ' +
      'are pending; mark a failed step with `error`.',
    propsSchema: {
      steps: 'string[] (step labels in order)',
      active: 'number (0-based index of the current step)',
      error: 'number (0-based index of a failed step, optional)',
    },
  },

  // fallback
  { id: 'generic-event', description: 'Fallback: decoded JSON + tags for any kind without a bespoke atom.' },
];

/** All catalog atom ids (the ViewSpec validator allowlist). */
export const CATALOG_ATOM_IDS: ReadonlySet<string> = new Set(ATOM_CATALOG.map((a) => a.id));

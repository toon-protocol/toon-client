/**
 * Example ViewSpecs — reference compositions the agent can learn from (surfaced
 * in the `toon_atoms` tool result) and reuse as journey starting points.
 *
 * These are plain data (Node-safe). They demonstrate the grammar: layout atoms
 * arranging domain atoms, `bind` for free reads, `kindAuto` feeds, and `actions`
 * wiring write tools.
 */

import { type ViewSpec } from './spec.js';
import {
  buildFeedFilter,
  buildProfileFilter,
  buildRepoListFilter,
  buildIssueListFilter,
  buildCommentFilter,
  buildEventByIdFilter,
  buildMediaFeedFilter,
} from './filters.js';
import { OPEN_CHANNEL_TOOL, PUBLISH_TOOL, SWAP_TOOL, UPLOAD_TOOL } from './tool-names.js';

/** A social feed: composer to post + a kindAuto note feed. */
export function feedView(): ViewSpec {
  return {
    title: 'Feed',
    root: {
      atom: 'stack',
      children: [
        { atom: 'composer', actions: { post: { tool: PUBLISH_TOOL, args: { kind: 1 } } } },
        { atom: 'note-card', bind: { query: buildFeedFilter(undefined, 50), kindAuto: true } },
      ],
    },
  };
}

/**
 * The headline pay-to-write journey: a `pay-confirm` atom that previews the
 * note, shows the live fee + settlement chain (pulled from `toon_status`), and
 * on Confirm fires `toon_publish_unsigned` and renders the receipt with the real
 * eventId — "the message is the money". Below it, the live note feed so the
 * just-posted note shows up.
 */
export function payToWriteView(): ViewSpec {
  return {
    title: 'Pay to write',
    root: {
      atom: 'stack',
      children: [
        {
          atom: 'pay-confirm',
          props: { label: 'Pay to post' },
          actions: { confirm: { tool: PUBLISH_TOOL, args: { kind: 1 } } },
        },
        { atom: 'note-card', bind: { query: buildFeedFilter(undefined, 50), kindAuto: true } },
      ],
    },
  };
}

/** A profile page: header + follow button + that author's notes. */
export function profileView(pubkey: string): ViewSpec {
  return {
    title: 'Profile',
    root: {
      atom: 'stack',
      children: [
        { atom: 'profile-header', bind: { query: buildProfileFilter([pubkey]) } },
        {
          atom: 'follow-button',
          props: { label: 'Follow' },
          actions: { follow: { tool: PUBLISH_TOOL, args: { kind: 3, tags: [['p', pubkey]] } } },
        },
        { atom: 'note-card', bind: { query: buildFeedFilter([pubkey], 50), kindAuto: true } },
      ],
    },
  };
}

/** A thread: the root note, its replies, and a reply composer. */
export function threadView(rootId: string): ViewSpec {
  return {
    title: 'Thread',
    root: {
      atom: 'stack',
      children: [
        { atom: 'note-card', bind: { query: buildEventByIdFilter([rootId]), kindAuto: true } },
        { atom: 'note-card', bind: { query: buildCommentFilter([rootId]), kindAuto: true } },
        {
          atom: 'composer',
          props: { placeholder: 'Reply…', label: 'Reply' },
          actions: { post: { tool: PUBLISH_TOOL, args: { kind: 1, tags: [['e', rootId, '', 'root']] } } },
        },
      ],
    },
  };
}

/** A forge view: repo list, then issues for a repo. */
export function forgeView(ownerPubkey: string, repoId: string): ViewSpec {
  return {
    title: 'Forge',
    root: {
      atom: 'tabs',
      props: { labels: ['Repos', 'Issues'] },
      children: [
        {
          atom: 'section',
          props: { title: 'Repositories' },
          children: [{ atom: 'repo-card', bind: { query: buildRepoListFilter(), kindAuto: true } }],
        },
        {
          atom: 'section',
          props: { title: 'Issues' },
          children: [
            { atom: 'issue-card', bind: { query: buildIssueListFilter(ownerPubkey, repoId), kindAuto: true } },
          ],
        },
      ],
    },
  };
}

/** A media gallery + uploader. */
export function mediaView(): ViewSpec {
  return {
    title: 'Media',
    root: {
      atom: 'stack',
      children: [
        { atom: 'media-uploader', props: { label: 'Post a picture' }, actions: { upload: { tool: UPLOAD_TOOL, args: { kind: 20 }, spendy: true } } },
        { atom: 'media-embed', bind: { query: buildMediaFeedFilter(undefined, 30), kindAuto: true } },
      ],
    },
  };
}

/** An onboarding journey: get-started card + the new user's profile header. */
export function onboardView(pubkey: string): ViewSpec {
  return {
    title: 'Get started',
    root: {
      atom: 'stack',
      children: [
        {
          atom: 'onboard-card',
          props: { pubkey, label: 'Publish profile' },
          actions: { publish: { tool: PUBLISH_TOOL, args: { kind: 0 } } },
        },
        { atom: 'profile-header', bind: { query: buildProfileFilter([pubkey]) } },
      ],
    },
  };
}

/** A DeFi panel: pre-open a channel, run a swap, show the settlement receipt. */
export function swapView(): ViewSpec {
  return {
    title: 'Swap',
    root: {
      atom: 'tabs',
      props: { labels: ['Channel', 'Swap', 'Receipt'] },
      children: [
        { atom: 'channel-card', actions: { open: { tool: OPEN_CHANNEL_TOOL } } },
        {
          atom: 'swap-form',
          props: { label: 'Swap' },
          actions: { swap: { tool: SWAP_TOOL, spendy: true, confirmLabel: 'Confirm swap' } },
        },
        { atom: 'settlement-receipt' },
      ],
    },
  };
}

/**
 * Daemon status dashboard: a single `client-status` atom. It reads the live
 * `toon_status` itself (no bind/props), so this is the answer to "show me my
 * status" — render this instead of falling back to plain text.
 */
export function clientStatusView(): ViewSpec {
  return {
    title: 'Client status',
    root: { atom: 'client-status' },
  };
}

/**
 * A generic info view composed from content primitives — the pattern for
 * rendering ANY non-event structured data (targets, identity, balances). Here:
 * a heading, an aligned label→value list, and a status badge. Swap the rows for
 * whatever the agent has in hand.
 */
export function infoView(): ViewSpec {
  return {
    title: 'Identity',
    root: {
      atom: 'card',
      children: [
        {
          atom: 'stack',
          children: [
            { atom: 'heading', props: { text: 'Identity', level: 2 } },
            {
              atom: 'key-value',
              props: {
                rows: [
                  { label: 'npub', value: 'npub1<…>' },
                  { label: 'EVM', value: '0x<…>' },
                  { label: 'Settlement', value: 'evm' },
                ],
              },
            },
            { atom: 'badge', props: { label: 'ready', tone: 'success' } },
          ],
        },
      ],
    },
  };
}

export interface ExampleView {
  name: string;
  description: string;
  spec: ViewSpec;
}

/** Concrete examples (with placeholder ids) for the agent to pattern-match on. */
export const EXAMPLE_VIEWSPECS: ExampleView[] = [
  { name: 'feed', description: 'Social feed with a post composer.', spec: feedView() },
  { name: 'pay-to-write', description: 'Compose → confirm fee/chain → publish → receipt (the message is the money).', spec: payToWriteView() },
  { name: 'profile', description: 'A profile header, follow button, and the author’s notes.', spec: profileView('<pubkey-hex>') },
  { name: 'thread', description: 'A note with its replies and a reply composer.', spec: threadView('<root-event-id>') },
  { name: 'forge', description: 'Tabbed repos + issues (NIP-34).', spec: forgeView('<owner-pubkey>', '<repo-id>') },
  { name: 'media', description: 'Media gallery with an uploader.', spec: mediaView() },
  { name: 'onboard', description: 'Get-started card + the new user’s profile header.', spec: onboardView('<pubkey-hex>') },
  { name: 'swap', description: 'Open a channel, run a swap, show the settlement receipt.', spec: swapView() },
  { name: 'client-status', description: 'Daemon health dashboard (ready/relay/chains/identity) from live toon_status — answers "show me my status".', spec: clientStatusView() },
  { name: 'info', description: 'Generic info view from content primitives (heading + key-value + badge) — the pattern for any non-event data.', spec: infoView() },
];

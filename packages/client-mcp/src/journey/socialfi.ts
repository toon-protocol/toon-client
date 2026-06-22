import {
  buildProfileFilter,
  buildFeedFilter,
  buildFollowListFilter,
  buildFileMetadataFilter,
  PUBLISH_TOOL,
  UPLOAD_TOOL,
} from '@toon-protocol/views';
import type { JourneyPlan, JourneyState } from './types.js';

function pubkeyFromState(state: JourneyState, fallback?: string): string {
  const onboard = state['onboard'] as { identity?: { nostrPubkey?: string } } | undefined;
  return onboard?.identity?.nostrPubkey ?? fallback ?? '';
}

/**
 * The canonical five-step SocialFi journey:
 * onboard → publish profile (kind:0) → publish note (kind:1) → follow (kind:3)
 * → DVM media upload (kind:1063) with media-embed read-back.
 *
 * Pass `opts.pubkey` to seed the panel bind-queries with the user's pubkey
 * without waiting for the onboard step to surface it; the follow step's
 * buildInput also reads it from `state['onboard'].identity.nostrPubkey` so
 * the correct pubkey is used in the kind:3 tags even when opts is omitted.
 */
export function socialFiJourney(opts?: { pubkey?: string }): JourneyPlan {
  return {
    id: 'socialfi',
    title: 'SocialFi Journey',
    steps: [
      // ── Step 1: onboard ─────────────────────────────────────────────────────
      {
        id: 'onboard',
        toolName: 'toon_status',
        buildInput: () => ({}),
        renderPanel: (data) => {
          const s = data as { ready?: boolean } | undefined;
          return {
            title: 'Onboard',
            root: {
              atom: 'section',
              props: { title: s?.ready ? 'Ready to publish' : 'Connecting…' },
              children: [{ atom: 'card', children: [{ atom: 'generic-event' }] }],
            },
          };
        },
      },

      // ── Step 2: publish profile (kind:0) ────────────────────────────────────
      {
        id: 'publish-profile',
        toolName: 'toon_publish_unsigned',
        buildInput: () => ({
          kind: 0,
          content: JSON.stringify({ name: 'TOON User', about: 'Published via the SocialFi journey.' }),
        }),
        renderPanel: (_data, state) => ({
          title: 'Profile',
          root: {
            atom: 'profile-header',
            bind: { query: buildProfileFilter([pubkeyFromState(state, opts?.pubkey)]) },
          },
        }),
      },

      // ── Step 3: publish note (kind:1) ───────────────────────────────────────
      {
        id: 'publish-note',
        toolName: 'toon_publish_unsigned',
        buildInput: () => ({
          kind: 1,
          content: 'Hello from TOON Protocol!',
        }),
        renderPanel: (_data, state) => ({
          title: 'Note',
          root: {
            atom: 'stack',
            children: [
              {
                atom: 'composer',
                props: { placeholder: "What's happening?", label: 'Post' },
                actions: { post: { tool: PUBLISH_TOOL, args: { kind: 1 } } },
              },
              {
                atom: 'note-card',
                bind: { query: buildFeedFilter([pubkeyFromState(state, opts?.pubkey)], 50), kindAuto: true },
              },
            ],
          },
        }),
      },

      // ── Step 4: follow (kind:3) ─────────────────────────────────────────────
      {
        id: 'follow',
        toolName: 'toon_publish_unsigned',
        buildInput: (state: JourneyState) => {
          const pubkey = pubkeyFromState(state, opts?.pubkey);
          return { kind: 3, tags: [['p', pubkey]] };
        },
        renderPanel: (_data, state) => {
          const pubkey = pubkeyFromState(state, opts?.pubkey);
          return {
            title: 'Follow',
            root: {
              atom: 'stack',
              children: [
                {
                  atom: 'follow-button',
                  props: { label: 'Follow' },
                  actions: { follow: { tool: PUBLISH_TOOL, args: { kind: 3, tags: [['p', pubkey]] } } },
                },
                {
                  atom: 'note-card',
                  bind: { query: buildFollowListFilter(pubkey), kindAuto: true },
                },
              ],
            },
          };
        },
      },

      // ── Step 5: DVM upload (kind:1063) + media-embed read-back ──────────────
      // Use toon_status (read-only) for the auto-call; the actual upload is
      // user-initiated via the panel's media-uploader action (spendy, confirmed).
      {
        id: 'dvm-upload',
        toolName: 'toon_status',
        buildInput: () => ({}),
        renderPanel: (_data, state) => ({
          title: 'Media Upload',
          root: {
            atom: 'stack',
            children: [
              {
                atom: 'media-uploader',
                props: { label: 'Upload media' },
                actions: {
                  upload: {
                    tool: UPLOAD_TOOL,
                    args: { kind: 1063 },
                    spendy: true,
                    confirmLabel: 'Upload to Arweave (spendy)',
                  },
                },
              },
              {
                atom: 'media-embed',
                bind: { query: buildFileMetadataFilter([pubkeyFromState(state, opts?.pubkey)], 30), kindAuto: true },
              },
            ],
          },
        }),
      },
    ],
  };
}

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
import { PUBLISH_TOOL, UPLOAD_TOOL } from './tool-names.js';

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

export interface ExampleView {
  name: string;
  description: string;
  spec: ViewSpec;
}

/** Concrete examples (with placeholder ids) for the agent to pattern-match on. */
export const EXAMPLE_VIEWSPECS: ExampleView[] = [
  { name: 'feed', description: 'Social feed with a post composer.', spec: feedView() },
  { name: 'profile', description: 'A profile header, follow button, and the author’s notes.', spec: profileView('<pubkey-hex>') },
  { name: 'thread', description: 'A note with its replies and a reply composer.', spec: threadView('<root-event-id>') },
  { name: 'forge', description: 'Tabbed repos + issues (NIP-34).', spec: forgeView('<owner-pubkey>', '<repo-id>') },
  { name: 'media', description: 'Media gallery with an uploader.', spec: mediaView() },
];

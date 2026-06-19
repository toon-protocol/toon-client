/**
 * Pure atom catalog — Node-safe metadata (no React).
 *
 * This is the single source of truth for which atom ids exist, what kinds they
 * render, and which writes they expose. The client-side React registry
 * ({@link ./atoms/registry}) is asserted to match this list in tests, and the
 * server-side `toon_atoms` tool + ViewSpec validator allowlist read from here so
 * `@toon-protocol/client-mcp` never imports the React bundle.
 */

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
  { id: 'note-card', description: 'NIP-01 kind:1 text note; optional "reply" action.', kinds: [1] },
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

  // media
  {
    id: 'media-embed',
    description: 'Render image/video streamed from Arweave (NIP-68/71/94).',
    kinds: [20, 21, 22, 1063],
  },
  {
    id: 'media-uploader',
    description: 'Upload media to Arweave then publish a media event. Spendy.',
    writes: [{ name: 'toon_upload_media', spendy: true }],
    propsSchema: { label: 'string' },
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

  // fallback
  { id: 'generic-event', description: 'Fallback: decoded JSON + tags for any kind without a bespoke atom.' },
];

/** All catalog atom ids (the ViewSpec validator allowlist). */
export const CATALOG_ATOM_IDS: ReadonlySet<string> = new Set(ATOM_CATALOG.map((a) => a.id));

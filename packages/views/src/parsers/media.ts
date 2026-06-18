/**
 * Media-NIP parsers.
 *
 * NIP-92 `imeta` tags        → MediaVariant[] (inline media on any event)
 * NIP-94 kind:1063 file meta → FileMetadata
 * NIP-68 kind:20 picture     → MediaPost (kind 'picture')
 * NIP-71 kind:21/22 video    → MediaPost (kind 'video')
 *
 * Media bytes themselves live on Arweave (uploaded via the kind:5094 blob DVM);
 * these parsers only surface the URLs/hashes/dimensions for rendering.
 */

import { type NostrEvent, getTagValue, getTagValues } from '../types.js';

/** A single media variant (one resolution/encoding of an image or video). */
export interface MediaVariant {
  url: string;
  mime?: string;
  /** SHA-256 hex of the file (`x` field). */
  hash?: string;
  /** Dimensions as `<width>x<height>`. */
  dim?: string;
  alt?: string;
  blurhash?: string;
  /** Fallback mirror URLs. */
  fallbacks: string[];
}

/**
 * Parse a single NIP-92 `imeta` tag.
 * Form: `["imeta", "url https://…", "m image/png", "x <hash>", "dim 800x600", …]`.
 * Each element after the tag name is a space-delimited `key value` pair;
 * `value` may itself contain spaces (e.g. `alt a cat`).
 */
export function parseImeta(tag: string[]): MediaVariant | null {
  if (tag[0] !== 'imeta') return null;

  const fields: Record<string, string> = {};
  const fallbacks: string[] = [];
  for (let i = 1; i < tag.length; i++) {
    const entry = tag[i];
    if (!entry) continue;
    const sp = entry.indexOf(' ');
    if (sp === -1) continue;
    const key = entry.slice(0, sp);
    const value = entry.slice(sp + 1);
    if (key === 'fallback') fallbacks.push(value);
    else if (!(key in fields)) fields[key] = value;
  }

  const url = fields['url'];
  if (!url) return null;

  const variant: MediaVariant = { url, fallbacks };
  if (fields['m']) variant.mime = fields['m'];
  if (fields['x']) variant.hash = fields['x'];
  if (fields['dim']) variant.dim = fields['dim'];
  if (fields['alt']) variant.alt = fields['alt'];
  if (fields['blurhash']) variant.blurhash = fields['blurhash'];
  return variant;
}

/** Extract all NIP-92 inline media variants from an event's tags. */
export function parseInlineMedia(event: NostrEvent): MediaVariant[] {
  return event.tags
    .filter((t) => t[0] === 'imeta')
    .map(parseImeta)
    .filter((v): v is MediaVariant => v !== null);
}

/** Parsed NIP-94 file metadata event (kind:1063). */
export interface FileMetadata {
  eventId: string;
  authorPubkey: string;
  createdAt: number;
  url: string;
  mime?: string;
  hash?: string;
  size?: number;
  dim?: string;
  summary?: string;
  caption: string;
}

/** Parse a kind:1063 NIP-94 file metadata event. */
export function parseFileMetadata(event: NostrEvent): FileMetadata | null {
  if (event.kind !== 1063) return null;

  const url = getTagValue(event.tags, 'url');
  if (!url) return null;

  const meta: FileMetadata = {
    eventId: event.id,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    url,
    caption: event.content,
  };
  const mime = getTagValue(event.tags, 'm');
  const hash = getTagValue(event.tags, 'x');
  const sizeStr = getTagValue(event.tags, 'size');
  const dim = getTagValue(event.tags, 'dim');
  const summary = getTagValue(event.tags, 'summary');
  if (mime) meta.mime = mime;
  if (hash) meta.hash = hash;
  if (dim) meta.dim = dim;
  if (summary) meta.summary = summary;
  if (sizeStr) {
    const size = Number(sizeStr);
    if (Number.isFinite(size)) meta.size = size;
  }
  return meta;
}

/** Kinds carrying a media-first post. */
export const MEDIA_POST_KINDS = [20, 21, 22] as const;

/** Parsed media-first post (NIP-68 picture kind:20, NIP-71 video kind:21/22). */
export interface MediaPost {
  eventId: string;
  authorPubkey: string;
  createdAt: number;
  mediaType: 'picture' | 'video';
  /** True for NIP-71 short-form video (kind:22). */
  short: boolean;
  title?: string;
  content: string;
  variants: MediaVariant[];
  hashtags: string[];
  durationSec?: number;
}

/** Parse a kind:20/21/22 media post. */
export function parseMediaPost(event: NostrEvent): MediaPost | null {
  if (!MEDIA_POST_KINDS.includes(event.kind as (typeof MEDIA_POST_KINDS)[number])) {
    return null;
  }

  const variants = parseInlineMedia(event);
  const post: MediaPost = {
    eventId: event.id,
    authorPubkey: event.pubkey,
    createdAt: event.created_at,
    mediaType: event.kind === 20 ? 'picture' : 'video',
    short: event.kind === 22,
    content: event.content,
    variants,
    hashtags: getTagValues(event.tags, 't'),
  };
  const title = getTagValue(event.tags, 'title');
  if (title) post.title = title;
  const durationStr = getTagValue(event.tags, 'duration');
  if (durationStr) {
    const d = Number(durationStr);
    if (Number.isFinite(d)) post.durationSec = d;
  }
  return post;
}

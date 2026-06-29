/**
 * Media gallery atom — an Album-style responsive grid of media events (NIP-68
 * pictures, NIP-71 videos, NIP-94 files, and any note carrying NIP-92 `imeta`).
 * Each event contributes one tile; tapping a tile opens an in-component
 * fullscreen lightbox that renders the full media via {@link InlineMediaList}
 * (the same gateway-fallback embed the feed uses), with prev/next paging across
 * the gallery.
 *
 * Every image tile carries alt text — the publisher's `imeta alt` when present,
 * else a stable positional label — so the grid is navigable by assistive tech.
 */

import { type FC, useState } from 'react';
import { X, ChevronLeft, ChevronRight, Images, Play } from 'lucide-react';
import { arweaveGatewayCandidates } from '@toon-protocol/arweave';
import { Button } from '@/components/ui/button.js';
import {
  type MediaVariant,
  parseMediaPost,
  parseFileMetadata,
  parseInlineMedia,
} from '../parsers/media.js';
import { type NostrEvent } from '../types.js';
import { type Atom, type AtomRenderProps } from './types.js';
import { InlineMediaList } from './media.js';

/** One gallery tile: the source event + the variant shown as its thumbnail. */
interface GalleryItem {
  event: NostrEvent;
  variant: MediaVariant;
  variants: MediaVariant[];
  video: boolean;
}

function isVideoVariant(variant: MediaVariant): boolean {
  return variant.mime?.startsWith('video/') ?? false;
}

/**
 * Collect renderable media variants from any supported event (NIP-68/71 posts,
 * NIP-94 files, else NIP-92 inline `imeta`). Mirrors the feed's media resolution
 * so a gallery shows exactly what a note's media-embed would.
 */
function variantsFor(event: NostrEvent): { variants: MediaVariant[]; video: boolean } {
  const post = parseMediaPost(event);
  if (post) return { variants: post.variants, video: post.mediaType === 'video' };
  const file = parseFileMetadata(event);
  if (file) {
    const v: MediaVariant = { url: file.url, fallbacks: [] };
    if (file.mime) v.mime = file.mime;
    if (file.dim) v.dim = file.dim;
    if (file.caption) v.alt = file.caption;
    return { variants: [v], video: file.mime?.startsWith('video/') ?? false };
  }
  return { variants: parseInlineMedia(event), video: false };
}

/** Build the gallery items, dropping events that carry no renderable media. */
function galleryItems(events: NostrEvent[]): GalleryItem[] {
  const items: GalleryItem[] = [];
  for (const event of events) {
    const { variants, video } = variantsFor(event);
    const variant = variants[0];
    if (!variant) continue;
    items.push({ event, variant, variants, video: video || isVideoVariant(variant) });
  }
  return items;
}

/** A single grid tile, with gateway-fallback image loading + guaranteed alt. */
const GalleryTile: FC<{ item: GalleryItem; index: number; onOpen: () => void }> = ({
  item,
  index,
  onOpen,
}) => {
  const candidates = arweaveGatewayCandidates(item.variant.url, item.variant.fallbacks);
  const [idx, setIdx] = useState(0);
  const src = candidates[idx] ?? item.variant.url;
  const onError = (): void => setIdx((i) => (i + 1 < candidates.length ? i + 1 : i));
  // Always supply alt text: the publisher's, else a stable positional label.
  const alt = item.variant.alt?.trim() || `Media item ${index + 1}`;

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open ${alt}`}
      className="group relative aspect-square overflow-hidden rounded-lg border border-border bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      {item.video ? (
        <>
          <video
            src={src}
            muted
            playsInline
            preload="metadata"
            className="size-full object-cover"
            onError={onError}
          />
          <span
            aria-hidden="true"
            className="absolute inset-0 flex items-center justify-center bg-black/20 text-white transition-colors group-hover:bg-black/30"
          >
            <Play className="size-7 fill-current" />
          </span>
        </>
      ) : (
        <img
          src={src}
          alt={alt}
          loading="lazy"
          className="size-full object-cover transition-transform group-hover:scale-[1.03]"
          onError={onError}
        />
      )}
    </button>
  );
};

/** Fullscreen lightbox overlay: the full media + prev/next + close. */
const Lightbox: FC<{
  items: GalleryItem[];
  index: number;
  onClose: () => void;
  onStep: (delta: number) => void;
}> = ({ items, index, onClose, onStep }) => {
  const item = items[index];
  if (!item) return null;
  const alt = item.variant.alt?.trim() || `Media item ${index + 1}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`${alt} (${index + 1} of ${items.length})`}
      className="fixed inset-0 z-50 flex flex-col bg-black/90 p-3"
    >
      <div className="flex items-center justify-between text-white">
        <span className="text-xs tabular-nums opacity-80">
          {index + 1} / {items.length}
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close lightbox"
          className="text-white hover:bg-white/10 hover:text-white"
          onClick={onClose}
        >
          <X aria-hidden="true" className="size-5" />
        </Button>
      </div>
      <div className="flex min-h-0 flex-1 items-center gap-2">
        {items.length > 1 ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Previous media"
            className="shrink-0 text-white hover:bg-white/10 hover:text-white"
            onClick={() => onStep(-1)}
          >
            <ChevronLeft aria-hidden="true" className="size-6" />
          </Button>
        ) : null}
        <div className="flex min-w-0 flex-1 items-center justify-center overflow-auto">
          <InlineMediaList variants={item.variants} />
        </div>
        {items.length > 1 ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Next media"
            className="shrink-0 text-white hover:bg-white/10 hover:text-white"
            onClick={() => onStep(1)}
          >
            <ChevronRight aria-hidden="true" className="size-6" />
          </Button>
        ) : null}
      </div>
    </div>
  );
};

const MediaGallery: FC<AtomRenderProps> = ({ events }) => {
  const items = galleryItems(events);
  // The currently open lightbox tile, or null when the grid is at rest.
  const [open, setOpen] = useState<number | null>(null);

  if (items.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        <Images aria-hidden="true" className="mx-auto mb-1 size-5 opacity-60" />
        No media to show.
      </div>
    );
  }

  return (
    <div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map((item, i) => (
          <GalleryTile
            key={item.event.id}
            item={item}
            index={i}
            onOpen={() => setOpen(i)}
          />
        ))}
      </div>
      {open !== null ? (
        <Lightbox
          items={items}
          index={open}
          onClose={() => setOpen(null)}
          onStep={(delta) =>
            setOpen((cur) =>
              cur === null ? cur : (cur + delta + items.length) % items.length
            )
          }
        />
      ) : null}
    </div>
  );
};

export const mediaGalleryAtoms: Atom[] = [{ id: 'media-gallery', Component: MediaGallery }];

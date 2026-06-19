/** Media atoms — NIP-68/71 posts + NIP-94 files (read), and the spendy uploader. */
import { type FC } from 'react';
import { type MediaVariant, parseMediaPost, parseFileMetadata, parseInlineMedia } from '../parsers/media.js';
import { type NostrEvent } from '../types.js';
import { type Atom, type AtomRenderProps } from './types.js';

function isVideo(variant: MediaVariant): boolean {
  return variant.mime?.startsWith('video/') ?? false;
}

/** Collect renderable media variants from any supported event. */
function variantsFor(event: NostrEvent): { variants: MediaVariant[]; video: boolean } {
  const post = parseMediaPost(event);
  if (post) return { variants: post.variants, video: post.mediaType === 'video' };
  const file = parseFileMetadata(event);
  if (file) {
    const v: MediaVariant = { url: file.url, fallbacks: [] };
    if (file.mime) v.mime = file.mime;
    if (file.dim) v.dim = file.dim;
    return { variants: [v], video: file.mime?.startsWith('video/') ?? false };
  }
  return { variants: parseInlineMedia(event), video: false };
}

const MediaEmbed: FC<AtomRenderProps> = ({ events }) => {
  const event = events[0];
  if (!event) return null;
  const { variants } = variantsFor(event);
  if (variants.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {variants.map((v, i) =>
        isVideo(v) ? (
          // eslint-disable-next-line jsx-a11y/media-has-caption
          <video key={i} src={v.url} controls className="max-h-96 w-full rounded-md" />
        ) : (
          <img
            key={i}
            src={v.url}
            alt={v.alt ?? ''}
            className="max-h-96 w-full rounded-md object-contain"
          />
        )
      )}
    </div>
  );
};

const MediaUploader: FC<AtomRenderProps> = ({ props, actions }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Upload media';
  return (
    <button
      type="button"
      disabled={!actions['upload']}
      className="rounded-md border border-dashed border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
      onClick={() => void actions['upload']?.()}
    >
      {label} <span className="text-xs text-muted-foreground">(pays to publish)</span>
    </button>
  );
};

export const mediaAtoms: Atom[] = [
  { id: 'media-embed', kinds: [20, 21, 22, 1063], Component: MediaEmbed },
  {
    id: 'media-uploader',
    writes: [{ name: 'toon_upload_media', spendy: true }],
    Component: MediaUploader,
  },
];

/** Media atoms — NIP-68/71 posts + NIP-94 files (read), and the spendy uploader. */
import { useRef, useState, type FC } from 'react';
import { type MediaVariant, parseMediaPost, parseFileMetadata, parseInlineMedia } from '../parsers/media.js';
import { arweaveGatewayCandidates } from '@toon-protocol/arweave';
import { type NostrEvent } from '../types.js';
import { type Atom, type AtomRenderProps } from './types.js';

function isVideo(variant: MediaVariant): boolean {
  return variant.mime?.startsWith('video/') ?? false;
}

/**
 * Render one media variant, re-pointing Arweave-addressable URLs through the
 * gateway-preference list and falling through to the next gateway (then the
 * publisher's own `imeta` mirrors) when a source fails to load.
 */
const MediaVariantView: FC<{ variant: MediaVariant }> = ({ variant }) => {
  const candidates = arweaveGatewayCandidates(variant.url, variant.fallbacks);
  const [idx, setIdx] = useState(0);
  const src = candidates[idx] ?? variant.url;
  const onError = (): void =>
    setIdx((i) => (i + 1 < candidates.length ? i + 1 : i));

  return isVideo(variant) ? (
    // eslint-disable-next-line jsx-a11y/media-has-caption
    <video src={src} controls className="max-h-96 w-full rounded-md" onError={onError} />
  ) : (
    <img
      src={src}
      alt={variant.alt ?? ''}
      className="max-h-96 w-full rounded-md object-contain"
      onError={onError}
    />
  );
};

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

/** Renders a list of NIP-92 media variants (image → img, video → video). */
export const InlineMediaList: FC<{ variants: MediaVariant[] }> = ({ variants }) => {
  if (variants.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {variants.map((v, i) => (
        <MediaVariantView key={i} variant={v} />
      ))}
    </div>
  );
};

const MediaEmbed: FC<AtomRenderProps> = ({ events }) => {
  const event = events[0];
  if (!event) return null;
  const { variants } = variantsFor(event);
  return <InlineMediaList variants={variants} />;
};

const MediaUploader: FC<AtomRenderProps> = ({ props, actions }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Upload media';
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadedOk, setUploadedOk] = useState(false);
  const [uploadError, setUploadError] = useState(false);

  const handleFile = async (file: File): Promise<void> => {
    setBusy(true);
    setUploadedOk(false);
    setUploadError(false);
    try {
      const buf = await new Promise<ArrayBuffer>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.onerror = () => reject(reader.error);
        reader.readAsArrayBuffer(file);
      });
      const bytes = new Uint8Array(buf);
      let binary = '';
      const chunk = 8192;
      for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
      }
      const dataBase64 = btoa(binary);
      const outcome = await actions['upload']?.({ dataBase64, mime: file.type || undefined });
      if (outcome?.ok === false) {
        setUploadError(true);
      } else {
        setUploadedOk(true);
      }
    } catch {
      setUploadError(true);
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*"
        className="sr-only"
        disabled={busy || !actions['upload']}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void handleFile(file);
        }}
      />
      <button
        type="button"
        disabled={busy || !actions['upload']}
        className="rounded-md border border-dashed border-border px-3 py-2 text-sm hover:bg-muted disabled:opacity-50"
        onClick={() => inputRef.current?.click()}
      >
        {busy ? 'Uploading…' : label}{' '}
        <span className="text-xs text-muted-foreground">(pays to publish)</span>
      </button>
      {uploadedOk && (
        <p className="text-xs text-muted-foreground">Uploaded successfully.</p>
      )}
      {uploadError && (
        <p className="text-xs text-destructive">Upload failed.</p>
      )}
    </div>
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

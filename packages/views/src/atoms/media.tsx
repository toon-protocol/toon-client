/** Media atoms — NIP-68/71 posts + NIP-94 files (read), and the spendy uploader. */
import { useRef, useState, type FC } from 'react';
import { ImagePlus, Loader2 } from 'lucide-react';
import { type MediaVariant, parseMediaPost, parseFileMetadata, parseInlineMedia } from '../parsers/media.js';
import { arweaveGatewayCandidates } from '@toon-protocol/arweave';
import { type NostrEvent } from '../types.js';
import { type Atom, type AtomRenderProps, SPENDY_CANCELLED } from './types.js';

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

/**
 * Compose the uploader's error line: the recognizable "Upload failed" label,
 * suffixed with the real underlying error (the daemon labels which leg —
 * Arweave upload vs. post-upload publish — failed) when one is present. Falls
 * back to the bare label when no diagnostic string is available.
 */
function uploadErrorMessage(detail?: string): string {
  const trimmed = detail?.trim();
  return trimmed ? `Upload failed: ${trimmed}` : 'Upload failed.';
}

const MediaUploader: FC<AtomRenderProps> = ({ props, actions }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Upload media';
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [uploadedOk, setUploadedOk] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  const handleFile = async (file: File): Promise<void> => {
    setBusy(true);
    setUploadedOk(false);
    setUploadError(null);
    setCancelled(false);
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
        if (outcome.error === SPENDY_CANCELLED) {
          // The user/host DECLINED the spend at the consent prompt — benign and
          // user-initiated, not an upload failure. Surface it neutrally (no
          // bytes were ever uploaded) rather than as a scary "Upload failed".
          setCancelled(true);
        } else {
          // A real leg failure: surface the underlying error so the failing leg
          // (Arweave upload vs. post-upload kind:20 publish) is diagnosable from
          // the UI; the daemon labels each leg in its error text. Keep the
          // recognizable "Upload failed" affordance as a prefix, degrading
          // gracefully to it alone when no error string is present.
          setUploadError(uploadErrorMessage(outcome.error));
        }
      } else {
        setUploadedOk(true);
      }
    } catch (err) {
      setUploadError(
        uploadErrorMessage(err instanceof Error ? err.message : String(err))
      );
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
        className="group flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-7 text-center transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
        onClick={() => inputRef.current?.click()}
      >
        {busy ? (
          <Loader2 aria-hidden="true" className="size-6 animate-spin text-muted-foreground" />
        ) : (
          <ImagePlus
            aria-hidden="true"
            className="size-6 text-muted-foreground transition-colors group-hover:text-primary"
          />
        )}
        <span className="text-sm font-medium">{busy ? 'Uploading…' : label}</span>
        <span className="text-xs text-muted-foreground">
          Image or video · <span className="text-primary/80">pays to publish</span>
        </span>
      </button>
      {uploadedOk && (
        <p className="text-xs text-muted-foreground">Uploaded successfully.</p>
      )}
      {cancelled && (
        <p className="text-xs text-muted-foreground">Upload cancelled — nothing was published or paid.</p>
      )}
      {uploadError && (
        <p className="text-xs text-destructive whitespace-pre-wrap break-words">{uploadError}</p>
      )}
    </div>
  );
};

export const mediaAtoms: Atom[] = [
  { id: 'media-embed', kinds: [20, 21, 22, 1063], Component: MediaEmbed },
  {
    id: 'media-uploader',
    writes: [{ name: 'toon_upload', spendy: true }],
    Component: MediaUploader,
  },
];

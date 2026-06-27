/** Media atoms — NIP-68/71 posts + NIP-94 files (read), and the spendy uploader. */
import { useEffect, useRef, useState, type FC } from 'react';
import { Check, FileUp, FileText, Loader2, X } from 'lucide-react';
import { CopyButton } from '../components/copy-button.js';
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

/**
 * The publish kind for an uploaded file's MIME: NIP-68 picture (20) for images,
 * NIP-71 video (21) for video, NIP-94 generic file metadata (1063) for anything
 * else (pdf, audio, archives, …). Passed as a runtime arg so it overrides the
 * spec's static `kind` — one uploader handles any file type correctly.
 */
function nip94KindForMime(mime: string | undefined): number {
  if (mime?.startsWith('image/')) return 20;
  if (mime?.startsWith('video/')) return 21;
  return 1063;
}

/** Convert file bytes to base64 for the `dataBase64` upload arg (chunked to
 * avoid a huge spread call on large buffers). */
function bytesToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

const MediaUploader: FC<AtomRenderProps> = ({ props, actions }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Upload a file';
  // Default to accepting ANY file; a spec may restrict via `accept` (e.g. "image/*").
  const accept = typeof props['accept'] === 'string' ? props['accept'] : undefined;
  const captionPlaceholder =
    typeof props['captionPlaceholder'] === 'string'
      ? props['captionPlaceholder']
      : 'Add a caption… (optional)';
  const inputRef = useRef<HTMLInputElement>(null);
  // A post is a two-step compose: pick a file (staged + previewed), optionally
  // write a caption, then Publish (the paid write). This lets the user review +
  // caption before paying, and threads the caption into the kind:20/21 content.
  const [staged, setStaged] = useState<{ file: File; previewUrl: string } | null>(null);
  const [caption, setCaption] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploadedOk, setUploadedOk] = useState(false);
  const [result, setResult] = useState<{ url?: string; mime?: string } | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);

  // Revoke the object URL when the staged file changes or on unmount.
  useEffect(() => {
    const url = staged?.previewUrl;
    return () => {
      if (url) URL.revokeObjectURL(url);
    };
  }, [staged]);

  const stageFile = (file: File): void => {
    setStaged((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return { file, previewUrl: URL.createObjectURL(file) };
    });
    setUploadedOk(false);
    setResult(null);
    setUploadError(null);
    setCancelled(false);
  };

  const clearStaged = (): void => {
    setStaged((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    setCaption('');
    if (inputRef.current) inputRef.current.value = '';
  };

  const publish = async (): Promise<void> => {
    if (!staged) return;
    const { file } = staged;
    setBusy(true);
    setUploadError(null);
    setCancelled(false);
    try {
      const dataBase64 = bytesToBase64(await file.arrayBuffer());
      const text = caption.trim();
      const outcome = await actions['upload']?.({
        dataBase64,
        mime: file.type || undefined,
        kind: nip94KindForMime(file.type),
        // The caption becomes the kind:20/21 event content — an image/video with
        // text is a *post*, not a bare file. Omitted when empty (image-only post).
        ...(text ? { caption: text } : {}),
      });
      if (outcome?.ok === false) {
        if (outcome.error === SPENDY_CANCELLED) {
          // The user/host DECLINED the spend at the consent prompt — benign and
          // user-initiated, not an upload failure. Surface it neutrally (no
          // bytes were ever uploaded) and KEEP the staged file + caption so they
          // can retry without re-picking.
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
        // Echo the publish receipt: the Arweave URL (from `uploadMedia`'s
        // `{ url, txId, eventId }`) so the UI shows the media + a copyable link,
        // not just "completed". Clear the compose state — the post is published.
        const data = (outcome?.data ?? {}) as { url?: unknown };
        setResult({
          url: typeof data.url === 'string' ? data.url : undefined,
          mime: file.type || undefined,
        });
        setUploadedOk(true);
        clearStaged();
      }
    } catch (err) {
      setUploadError(
        uploadErrorMessage(err instanceof Error ? err.message : String(err))
      );
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || !actions['upload'];
  const stagedIsImage = staged?.file.type.startsWith('image/') ?? false;
  const stagedIsVideo = staged?.file.type.startsWith('video/') ?? false;

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        {...(accept ? { accept } : {})}
        className="sr-only"
        disabled={disabled}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) stageFile(file);
        }}
      />
      {!staged ? (
        <button
          type="button"
          disabled={disabled}
          className="group flex flex-col items-center gap-2 rounded-xl border border-dashed border-border bg-muted/30 px-4 py-7 text-center transition-colors hover:border-primary/50 hover:bg-accent/40 focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
          onClick={() => inputRef.current?.click()}
        >
          <FileUp
            aria-hidden="true"
            className="size-6 text-muted-foreground transition-colors group-hover:text-primary"
          />
          <span className="text-sm font-medium">{label}</span>
          <span className="text-xs text-muted-foreground">
            Image, video, or any file · <span className="text-primary/80">pays to publish</span>
          </span>
        </button>
      ) : (
        <div className="flex flex-col gap-2 rounded-xl border border-border bg-muted/20 p-3">
          {/* Media preview */}
          {stagedIsImage ? (
            <img
              src={staged.previewUrl}
              alt="Selected media preview"
              className="max-h-72 w-full rounded-md object-contain"
            />
          ) : stagedIsVideo ? (
            <video src={staged.previewUrl} controls className="max-h-72 w-full rounded-md" />
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <FileText aria-hidden="true" className="size-4 shrink-0" />
              <span className="truncate">{staged.file.name}</span>
            </div>
          )}
          <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
            <span className="truncate">{staged.file.name}</span>
            <button
              type="button"
              disabled={busy}
              className="flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:text-foreground disabled:opacity-50"
              onClick={() => {
                clearStaged();
                inputRef.current?.click();
              }}
            >
              <X aria-hidden="true" className="size-3" /> change
            </button>
          </div>
          {/* Caption → kind:20/21 content */}
          <textarea
            value={caption}
            disabled={busy}
            onChange={(e) => setCaption(e.target.value)}
            placeholder={captionPlaceholder}
            rows={2}
            className="w-full resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-sm focus-visible:border-primary/60 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
          />
          <button
            type="button"
            disabled={disabled}
            className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/40 disabled:opacity-50"
            onClick={() => void publish()}
          >
            {busy ? (
              <>
                <Loader2 aria-hidden="true" className="size-4 animate-spin" /> Publishing…
              </>
            ) : (
              <>
                <FileUp aria-hidden="true" className="size-4" /> Publish post · pays to publish
              </>
            )}
          </button>
        </div>
      )}
      {uploadedOk && (
        <div className="mt-1 flex flex-col gap-2 rounded-lg border border-border bg-muted/30 p-3">
          <div className="flex items-center gap-1.5 text-xs font-medium text-primary">
            <Check aria-hidden="true" className="size-3.5" />
            Uploaded &amp; published to Arweave
          </div>
          {result?.url ? (
            <>
              {result.mime?.startsWith('image/') ? (
                <img
                  src={result.url}
                  alt="Uploaded image"
                  className="max-h-72 w-full rounded-md object-contain"
                />
              ) : result.mime?.startsWith('video/') ? (
                <video src={result.url} controls className="max-h-72 w-full rounded-md" />
              ) : (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <FileText aria-hidden="true" className="size-4 shrink-0" />
                  <span className="truncate">{result.mime ?? 'file'} stored on Arweave</span>
                </div>
              )}
              <div className="flex items-center gap-2">
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 flex-1 truncate font-mono text-xs text-primary underline-offset-2 hover:underline"
                >
                  {result.url}
                </a>
                <CopyButton value={result.url} label="Copy file URL" />
              </div>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">Uploaded successfully.</p>
          )}
        </div>
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

/** Interactive atoms that hold local UI state (composer, tabs, pay-confirm). */
import { Children, useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { ArrowLeft, CircleCheck, Coins, Loader2, Paperclip, X } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MonoId } from '@/components/mono-id.js';
import { type Atom, type AtomRenderProps, type AtomStatus, SPENDY_CANCELLED } from './types.js';
import { byteLength } from './social-ui.js';
import { bytesToBase64, RelayConfirmation, usePublishConfirmation } from './media.js';

/**
 * The shared composer surface: an auto-sizing textarea over a footer toolbar
 * that carries the byte counter (TOON fees scale with encoded bytes) and the
 * primary action. Used by both the free `composer` and the paid `pay-confirm`
 * idle phase so the two read as the same control.
 */
const ComposerSurface: FC<{
  value: string;
  onChange: (next: string) => void;
  placeholder: string;
  actionLabel: string;
  actionIcon?: ReactNode;
  disabled: boolean;
  onSubmit: () => void;
  /** Optional staged-media preview rendered above the textarea. */
  preview?: ReactNode;
  /** Optional footer-left control (e.g. an attach-media button). */
  attach?: ReactNode;
}> = ({ value, onChange, placeholder, actionLabel, actionIcon, disabled, onSubmit, preview, attach }) => {
  const bytes = byteLength(value);
  return (
    // Inherit the host surface (no opaque slab): a bordered, faintly-lifted input
    // that the focus ring defines — not a painted card that reads as a separate
    // widget against the transparent feed below it.
    <div className="rounded-xl border border-border bg-muted/20 focus-within:border-ring focus-within:bg-transparent focus-within:ring-3 focus-within:ring-ring/30">
      {preview ? <div className="px-3 pt-3">{preview}</div> : null}
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="min-h-14 resize-none border-0 bg-transparent px-3.5 pt-3.5 text-base focus-visible:border-0 focus-visible:ring-0 md:text-sm"
      />
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div className="flex items-center gap-2">
          {attach}
          {/* The byte counter is fee-relevant only once there's content — hide it
              at rest so the composer doesn't read as a debug tool ("0 bytes"). */}
          {bytes > 0 ? (
            <span
              className="font-mono text-xs text-muted-foreground tabular-nums"
              aria-label={`${bytes} bytes, the unit pay-to-write fees scale with`}
              title="Fees scale with encoded bytes"
            >
              {bytes} {bytes === 1 ? 'byte' : 'bytes'}
            </span>
          ) : null}
        </div>
        <Button size="sm" disabled={disabled} onClick={onSubmit}>
          {actionIcon}
          {actionLabel}
        </Button>
      </div>
    </div>
  );
};

const Composer: FC<AtomRenderProps> = ({ props, actions }) => {
  const [text, setText] = useState('');
  const [staged, setStaged] = useState<{ file: File; previewUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const placeholder =
    typeof props['placeholder'] === 'string' ? props['placeholder'] : "What's happening?";
  const label = typeof props['label'] === 'string' ? props['label'] : 'Post';
  const accept = typeof props['accept'] === 'string' ? props['accept'] : undefined;
  // A text post can OPTIONALLY carry media: attach a file and it publishes via
  // toon_upload as a kind:1 note with NIP-92 imeta (rendered inline by the feed),
  // instead of a bare text note via toon_publish_unsigned. Pure uploads use the
  // dedicated `media-uploader` atom instead.
  const canAttach = !!actions['upload'];
  const value = text.trim();

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
    setError(null);
  };
  const clearStaged = (): void => {
    setStaged((prev) => {
      if (prev) URL.revokeObjectURL(prev.previewUrl);
      return null;
    });
    if (inputRef.current) inputRef.current.value = '';
  };

  const submit = async (): Promise<void> => {
    if (busy) return;
    setError(null);
    if (staged) {
      if (!actions['upload']) return;
      setBusy(true);
      try {
        const dataBase64 = bytesToBase64(await staged.file.arrayBuffer());
        // kind:1 → the daemon publishes a note carrying the uploaded media as
        // NIP-92 imeta; the caption (post text) becomes the note content.
        const outcome = await actions['upload']({
          kind: 1,
          dataBase64,
          mime: staged.file.type || undefined,
          ...(value ? { caption: value } : {}),
        });
        if (!outcome || outcome.ok !== false) {
          setText('');
          clearStaged();
        } else if (outcome.error !== SPENDY_CANCELLED) {
          // Keep the staged file + text so the user can retry; a declined spend
          // is benign and silent.
          setError(outcome.error ?? 'Post failed.');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
      return;
    }
    // Text-only post: optimistic clear (fire-and-forget), as before.
    if (!value || !actions['post']) return;
    void actions['post']({ content: value });
    setText('');
  };

  const canSubmit =
    !busy && (staged ? !!actions['upload'] : !!value && !!actions['post']);
  const isImage = staged?.file.type.startsWith('image/') ?? false;
  const isVideo = staged?.file.type.startsWith('video/') ?? false;

  const preview = staged ? (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 p-2">
      {isImage ? (
        <img src={staged.previewUrl} alt="" className="size-12 shrink-0 rounded object-cover" />
      ) : isVideo ? (
        <video src={staged.previewUrl} className="size-12 shrink-0 rounded object-cover" />
      ) : (
        <Paperclip aria-hidden="true" className="size-5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{staged.file.name}</span>
      <button
        type="button"
        disabled={busy}
        aria-label="Remove attachment"
        className="shrink-0 rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-50"
        onClick={clearStaged}
      >
        <X aria-hidden="true" className="size-3.5" />
      </button>
    </div>
  ) : undefined;

  const attach = canAttach ? (
    <button
      type="button"
      disabled={busy}
      aria-label="Attach media or file"
      title="Attach media or file"
      className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent/50 hover:text-primary disabled:opacity-50"
      onClick={() => inputRef.current?.click()}
    >
      <Paperclip aria-hidden="true" className="size-4" />
    </button>
  ) : undefined;

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={inputRef}
        type="file"
        {...(accept ? { accept } : {})}
        className="sr-only"
        disabled={busy}
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) stageFile(file);
        }}
      />
      <ComposerSurface
        value={text}
        onChange={setText}
        placeholder={placeholder}
        actionLabel={busy ? 'Posting…' : label}
        disabled={!canSubmit}
        onSubmit={() => void submit()}
        {...(preview ? { preview } : {})}
        {...(attach ? { attach } : {})}
      />
      {error ? (
        <p className="px-1 text-xs text-destructive whitespace-pre-wrap break-words">{error}</p>
      ) : null}
    </div>
  );
};

const Tabs: FC<AtomRenderProps> = ({ props, children }) => {
  const labels = Array.isArray(props['labels'])
    ? (props['labels'] as unknown[]).map(String)
    : [];
  const panels = Children.toArray(children);
  const [active, setActive] = useState(0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-0 border-b border-border">
        {panels.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActive(i)}
            className={
              'px-4 py-2 text-sm font-medium transition-colors ' +
              (i === active
                ? '-mb-px border-b-2 border-primary text-foreground'
                : 'text-muted-foreground hover:text-foreground')
            }
          >
            {labels[i] ?? `Tab ${i + 1}`}
          </button>
        ))}
      </div>
      <div>{panels[active] ?? null}</div>
    </div>
  );
};

type PayPhase = 'idle' | 'confirming' | 'publishing' | 'receipt';

const PayConfirm: FC<AtomRenderProps> = ({ props, actions, readStatus, loadMore }) => {
  const placeholder =
    typeof props['placeholder'] === 'string' ? props['placeholder'] : "What's happening?";
  const label = typeof props['label'] === 'string' ? props['label'] : 'Pay to post';

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<PayPhase>('idle');
  const [status, setStatus] = useState<AtomStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<{ feePaid?: string; balanceAfter?: string } | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Optimistic pending→confirmed: once published, poll the free read seam for the
  // event id and flip to "confirmed" when a relay serves it back. A slow/absent
  // read stays "pending (unconfirmed)" — never a false "failed" (the message was
  // already paid for + broadcast).
  const confirmState = usePublishConfirmation(eventId, loadMore);

  useEffect(() => {
    if (phase !== 'confirming' || status || statusError || !readStatus) return;
    let cancelled = false;
    void readStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatusError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [phase, status, statusError, readStatus]);

  const review = (): void => {
    if (!text.trim() || !actions['confirm']) return;
    setFailed(null);
    setPhase('confirming');
  };

  const cancel = (): void => setPhase('idle');

  const confirm = async (): Promise<void> => {
    const value = text.trim();
    if (!value || !actions['confirm']) return;
    setPhase('publishing');
    const outcome = await actions['confirm']({ content: value });
    if (!outcome || outcome.ok === false) {
      setFailed(outcome?.error ?? 'unknown');
      setPhase('confirming');
      return;
    }
    // Prefer the TRUTHFUL fee the daemon actually charged (PublishResponse.feePaid)
    // over the pre-write per-event estimate; surface the post-write balance too.
    const data = (outcome.data ?? {}) as { feePaid?: string; channelBalanceAfter?: string };
    setReceipt({ feePaid: data.feePaid, balanceAfter: data.channelBalanceAfter });
    setEventId(outcome.eventId ?? null);
    setPhase('receipt');
  };

  const reset = (): void => {
    setText('');
    setStatus(null);
    setStatusError(false);
    setEventId(null);
    setReceipt(null);
    setFailed(null);
    setPhase('idle');
  };

  const assetSuffix = status?.asset ? ` ${status.asset}` : '';
  const feeLabel = status
    ? `${status.feePerEvent}${assetSuffix}`
    : statusError
      ? 'unavailable'
      : '…';
  const chainLabel = status ? status.settlementChain : statusError ? 'unknown' : '…';
  // The receipt shows what was actually charged; fall back to the estimate only
  // if the daemon didn't report a fee (older daemon).
  const paidLabel = receipt?.feePaid ? `${receipt.feePaid}${assetSuffix}` : feeLabel;
  const bytes = byteLength(text.trim());

  if (phase === 'receipt') {
    return (
      <div className="overflow-hidden rounded-xl border border-primary/30 bg-card">
        <div className="flex items-center gap-2.5 border-b border-primary/20 bg-primary/5 px-4 py-3">
          <CircleCheck aria-hidden="true" className="size-5 text-primary" />
          <div>
            <div className="font-semibold leading-tight">Posted — and paid</div>
            <p className="text-xs text-muted-foreground">The message is the money.</p>
          </div>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 px-4 py-3 text-xs">
          <dt className="text-muted-foreground">Event</dt>
          <dd>{eventId ? <MonoId value={eventId} prefixLen={12} suffixLen={6} /> : '—'}</dd>
          <dt className="text-muted-foreground">Status</dt>
          <dd>
            <RelayConfirmation state={confirmState} />
          </dd>
          <dt className="text-muted-foreground">Fee paid</dt>
          <dd className="font-medium">
            {paidLabel} on {chainLabel}
          </dd>
          {receipt?.balanceAfter ? (
            <>
              <dt className="text-muted-foreground">Balance</dt>
              <dd className="font-medium tabular-nums">
                {receipt.balanceAfter}
                {assetSuffix} left
              </dd>
            </>
          ) : null}
        </dl>
        <div className="flex justify-end border-t border-border px-4 py-2.5">
          <Button variant="outline" size="sm" onClick={reset}>
            Post another
          </Button>
        </div>
      </div>
    );
  }

  if (phase === 'confirming' || phase === 'publishing') {
    const publishing = phase === 'publishing';
    return (
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Coins aria-hidden="true" className="size-4 text-primary" />
          <span className="text-sm font-semibold">Confirm pay-to-write</span>
        </div>
        <div className="flex flex-col gap-3 px-4 py-3">
          <blockquote className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border-l-2 border-primary/40 bg-muted/50 px-3 py-2 text-sm">
            {text}
          </blockquote>
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Fee</dt>
              <dd className="font-medium tabular-nums">{feeLabel}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Settles on</dt>
              <dd className="font-medium">{chainLabel}</dd>
            </div>
            <div className="flex items-center gap-1.5">
              <dt className="text-muted-foreground">Size</dt>
              <dd className="font-mono font-medium tabular-nums">{bytes} bytes</dd>
            </div>
          </dl>
          <p className="text-xs text-muted-foreground">
            Posting pays the fee above per event. <span className="text-foreground/80">
              This is permanent</span> — the note is broadcast to relays and can't be
            unpublished, and the fee is non-refundable. The message is the money.
          </p>
          {failed ? (
            <p className="text-xs text-destructive">Publish failed: {failed}</p>
          ) : null}
        </div>
        <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
          <Button variant="outline" size="sm" disabled={publishing} onClick={cancel}>
            <ArrowLeft aria-hidden="true" />
            Back
          </Button>
          <Button size="sm" disabled={publishing || statusError} onClick={() => void confirm()}>
            {publishing ? (
              <>
                <Loader2 aria-hidden="true" className="animate-spin" />
                Publishing…
              </>
            ) : (
              <>
                <Coins aria-hidden="true" />
                Confirm &amp; pay
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <ComposerSurface
      value={text}
      onChange={setText}
      placeholder={placeholder}
      actionLabel={label}
      actionIcon={<Coins aria-hidden="true" />}
      disabled={!text.trim() || !actions['confirm']}
      onSubmit={review}
    />
  );
};

export const interactiveAtoms: Atom[] = [
  {
    id: 'composer',
    writes: [{ name: 'toon_publish_unsigned' }, { name: 'toon_upload', spendy: true }],
    Component: Composer,
  },
  { id: 'tabs', Component: Tabs },
  { id: 'pay-confirm', writes: [{ name: 'toon_publish_unsigned' }], Component: PayConfirm },
];

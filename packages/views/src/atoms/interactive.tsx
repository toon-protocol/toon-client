/** Interactive atoms that hold local UI state (composer, tabs, pay-confirm). */
import { Children, useEffect, useState, type FC, type ReactNode } from 'react';
import { ArrowLeft, CircleCheck, Coins, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MonoId } from '@/components/mono-id.js';
import { type Atom, type AtomRenderProps, type AtomStatus } from './types.js';
import { byteLength } from './social-ui.js';

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
}> = ({ value, onChange, placeholder, actionLabel, actionIcon, disabled, onSubmit }) => {
  const bytes = byteLength(value);
  return (
    <div className="rounded-xl border border-border bg-card focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30">
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="min-h-20 resize-none border-0 bg-transparent px-3.5 pt-3.5 text-base focus-visible:border-0 focus-visible:ring-0 md:text-sm"
      />
      <div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
        <span
          className="font-mono text-xs text-muted-foreground tabular-nums"
          aria-label={`${bytes} bytes, the unit pay-to-write fees scale with`}
          title="Fees scale with encoded bytes"
        >
          {bytes} {bytes === 1 ? 'byte' : 'bytes'}
        </span>
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
  const placeholder =
    typeof props['placeholder'] === 'string' ? props['placeholder'] : "What's happening?";
  const label = typeof props['label'] === 'string' ? props['label'] : 'Post';

  const submit = (): void => {
    const value = text.trim();
    if (!value || !actions['post']) return;
    void actions['post']({ content: value });
    setText('');
  };

  return (
    <ComposerSurface
      value={text}
      onChange={setText}
      placeholder={placeholder}
      actionLabel={label}
      disabled={!text.trim() || !actions['post']}
      onSubmit={submit}
    />
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

const PayConfirm: FC<AtomRenderProps> = ({ props, actions, readStatus }) => {
  const placeholder =
    typeof props['placeholder'] === 'string' ? props['placeholder'] : "What's happening?";
  const label = typeof props['label'] === 'string' ? props['label'] : 'Pay to post';

  const [text, setText] = useState('');
  const [phase, setPhase] = useState<PayPhase>('idle');
  const [status, setStatus] = useState<AtomStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [eventId, setEventId] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);

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
    setEventId(outcome.eventId ?? null);
    setPhase('receipt');
  };

  const reset = (): void => {
    setText('');
    setStatus(null);
    setStatusError(false);
    setEventId(null);
    setFailed(null);
    setPhase('idle');
  };

  const feeLabel = status
    ? `${status.feePerEvent}${status.asset ? ` ${status.asset}` : ''}`
    : statusError
      ? 'unavailable'
      : '…';
  const chainLabel = status ? status.settlementChain : statusError ? 'unknown' : '…';
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
          <dt className="text-muted-foreground">Fee paid</dt>
          <dd className="font-medium">
            {feeLabel} on {chainLabel}
          </dd>
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
            Posting pays the fee above per event. The message is the money.
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
  { id: 'composer', writes: [{ name: 'toon_publish_unsigned' }], Component: Composer },
  { id: 'tabs', Component: Tabs },
  { id: 'pay-confirm', writes: [{ name: 'toon_publish_unsigned' }], Component: PayConfirm },
];

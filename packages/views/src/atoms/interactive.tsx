/** Interactive atoms that hold local UI state (composer, tabs, pay-confirm). */
import { Children, useEffect, useState, type FC } from 'react';
import { Button } from '@/components/ui/button.js';
import { Textarea } from '@/components/ui/textarea.js';
import { MonoId } from '@/components/mono-id.js';
import { type Atom, type AtomRenderProps, type AtomStatus } from './types.js';

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
    <div className="flex flex-col gap-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={3}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!text.trim() || !actions['post']}
          onClick={submit}
        >
          {label}
        </Button>
      </div>
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
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setStatusError(true); });
    return () => { cancelled = true; };
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
    : statusError ? 'unavailable' : '…';
  const chainLabel = status ? status.settlementChain : statusError ? 'unknown' : '…';

  if (phase === 'receipt') {
    return (
      <div className="rounded-lg border-l-2 border-primary bg-primary/5 p-4">
        <div className="mb-1 font-semibold text-primary">Posted — and paid.</div>
        <p className="mb-3 text-xs text-muted-foreground">The message is the money.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Event</dt>
          <dd>{eventId ? <MonoId value={eventId} prefixLen={12} suffixLen={6} /> : '—'}</dd>
          <dt className="text-muted-foreground">Fee paid</dt>
          <dd>{feeLabel} on {chainLabel}</dd>
        </dl>
        <div className="mt-3 flex justify-end">
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
      <div className="flex flex-col gap-3 rounded-lg border-l-2 border-ring bg-card p-4">
        <div className="font-semibold text-sm">Confirm pay-to-write</div>
        <blockquote className="whitespace-pre-wrap rounded-md border-l-2 border-primary/40 bg-muted/50 px-3 py-2 text-sm">
          {text}
        </blockquote>
        <p className="text-xs text-muted-foreground">
          Sending this message pays{' '}
          <span className="font-medium text-foreground">{feeLabel}</span> per event, settling on{' '}
          <span className="font-medium text-foreground">{chainLabel}</span>. The message is the money.
        </p>
        {failed ? (
          <p className="text-xs text-destructive">Publish failed: {failed}</p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" disabled={publishing} onClick={cancel}>
            Cancel
          </Button>
          <Button size="sm" disabled={publishing} onClick={() => void confirm()}>
            {publishing ? 'Publishing…' : 'Confirm & pay'}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={3}
      />
      <div className="flex justify-end">
        <Button
          size="sm"
          disabled={!text.trim() || !actions['confirm']}
          onClick={review}
        >
          {label}
        </Button>
      </div>
    </div>
  );
};

export const interactiveAtoms: Atom[] = [
  { id: 'composer', writes: [{ name: 'toon_publish_unsigned' }], Component: Composer },
  { id: 'tabs', Component: Tabs },
  { id: 'pay-confirm', writes: [{ name: 'toon_publish_unsigned' }], Component: PayConfirm },
];

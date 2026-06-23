/** Interactive atoms that hold local UI state (composer, tabs, pay-confirm). */
import { Children, useEffect, useState, type FC } from 'react';
import { type Atom, type AtomRenderProps, type AtomStatus } from './types.js';

/** A text composer that publishes a note (kind:1) via its `post` action. */
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
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-none rounded-md border border-input bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!text.trim() || !actions['post']}
          onClick={submit}
          className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {label}
        </button>
      </div>
    </div>
  );
};

/**
 * Tabbed container. `props.labels: string[]` names the tabs; each child node is
 * one tab panel (in order). Lets the agent compose a multi-section journey
 * (e.g. Feed / Profile / Forge) in one view.
 */
const Tabs: FC<AtomRenderProps> = ({ props, children }) => {
  const labels = Array.isArray(props['labels'])
    ? (props['labels'] as unknown[]).map(String)
    : [];
  const panels = Children.toArray(children);
  const [active, setActive] = useState(0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1 border-b border-border">
        {panels.map((_, i) => (
          <button
            key={i}
            type="button"
            onClick={() => setActive(i)}
            className={
              'px-3 py-1.5 text-sm font-medium ' +
              (i === active
                ? 'border-b-2 border-primary text-foreground'
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

/**
 * The flagship pay-to-write moment: "sending a message and sending money are the
 * same action." A single atom holding the state machine
 *
 *   idle → confirming (preview + live fee + chain + Confirm/Cancel)
 *        → publishing → receipt (real eventId + fee paid + "message = money")
 *
 * The fee + settlement chain are fetched live via `readStatus` (`toon_status`),
 * never hardcoded — against the fake backend it shows the stub fee; against the
 * real daemon (#16) the same UI shows the live fee with no change here. The
 * publish itself fires the wired `confirm` action (`toon_publish_unsigned`); the
 * receipt renders the `eventId` the runtime surfaces back on the outcome.
 */
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

  // Fetch the live fee/chain when entering the confirm step (never hardcoded).
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

  const cancel = (): void => {
    setPhase('idle');
  };

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

  if (phase === 'receipt') {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/5 p-3">
        <div className="text-sm font-semibold text-primary">Posted — and paid.</div>
        <p className="text-xs text-muted-foreground">The message is the money.</p>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
          <dt className="text-muted-foreground">Event</dt>
          <dd className="break-all font-mono">{eventId ?? '—'}</dd>
          <dt className="text-muted-foreground">Fee paid</dt>
          <dd>
            {feeLabel} on {chainLabel}
          </dd>
        </dl>
        <div className="flex justify-end">
          <button
            type="button"
            onClick={reset}
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted"
          >
            Post another
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'confirming' || phase === 'publishing') {
    const publishing = phase === 'publishing';
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
        <div className="text-sm font-semibold">Confirm pay-to-write</div>
        <blockquote className="whitespace-pre-wrap rounded-md border-l-2 border-primary/50 bg-muted/40 p-2 text-sm">
          {text}
        </blockquote>
        <div className="text-xs text-muted-foreground">
          Sending this message pays <span className="font-medium text-foreground">{feeLabel}</span>{' '}
          per event, settling on <span className="font-medium text-foreground">{chainLabel}</span>.
          The message is the money.
        </div>
        {failed ? (
          <div className="text-xs text-destructive">Publish failed: {failed}</div>
        ) : null}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            disabled={publishing}
            onClick={cancel}
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={publishing}
            onClick={() => void confirm()}
            className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            {publishing ? 'Publishing…' : 'Confirm & pay'}
          </button>
        </div>
      </div>
    );
  }

  // idle — compose
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="w-full resize-none rounded-md border border-input bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex justify-end">
        <button
          type="button"
          disabled={!text.trim() || !actions['confirm']}
          onClick={review}
          className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {label}
        </button>
      </div>
    </div>
  );
};

export const interactiveAtoms: Atom[] = [
  { id: 'composer', writes: [{ name: 'toon_publish_unsigned' }], Component: Composer },
  { id: 'tabs', Component: Tabs },
  { id: 'pay-confirm', writes: [{ name: 'toon_publish_unsigned' }], Component: PayConfirm },
];

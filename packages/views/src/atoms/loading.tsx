/**
 * Loading / placeholder atoms.
 *
 * These carry no event `kinds` and no data binds — they're pure, props-driven
 * surfaces the agent renders *immediately* (as a first `toon_render`) while it
 * works out the real user journey, then replaces with the finished view. Three
 * shapes:
 *   - `skeleton`      — pulsing silhouettes that mimic the layout to come.
 *   - `loading`       — a spinner + an optional status line the agent narrates.
 *   - `progress-steps`— a numbered stepper for multi-step journeys (e.g.
 *                       Close → Wait → Settle), reused by the withdraw flow.
 *
 * All colour rides the design tokens, so light/dark are handled for free.
 */
import { type FC } from 'react';
import { Check, X } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton.js';
import { Spinner } from '@/components/ui/spinner.js';
import { cn } from '@/lib/utils.js';
import { type Atom, type AtomRenderProps } from './types.js';

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;

const int = (v: unknown, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;

/** Pulsing placeholder. `variant` picks the silhouette; `lines` sizes the list. */
const SkeletonAtom: FC<AtomRenderProps> = ({ props }) => {
  const variant =
    props['variant'] === 'avatar' || props['variant'] === 'card' ? props['variant'] : 'lines';
  const lines = Math.min(12, Math.max(1, int(props['lines'], 3)));
  const width = str(props['width']) || undefined;

  if (variant === 'avatar') {
    return (
      <div className="flex items-center gap-3" role="status" aria-busy="true" aria-label="Loading">
        <Skeleton className="size-10 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-3 w-2/3" />
        </div>
      </div>
    );
  }

  if (variant === 'card') {
    return (
      <div
        className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4"
        role="status"
        aria-busy="true"
        aria-label="Loading"
      >
        <div className="flex items-center gap-3">
          <Skeleton className="size-9 shrink-0 rounded-full" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <Skeleton className="h-3.5 w-1/3" />
            <Skeleton className="h-3 w-1/4" />
          </div>
        </div>
        <Skeleton className="h-24 w-full rounded-lg" />
      </div>
    );
  }

  // lines
  return (
    <div
      className="flex flex-col gap-2"
      style={width ? { maxWidth: width } : undefined}
      role="status"
      aria-busy="true"
      aria-label="Loading"
    >
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn('h-3.5', i === lines - 1 ? 'w-2/3' : 'w-full')} />
      ))}
    </div>
  );
};

const LOADING_TEXT = { sm: 'text-xs', md: 'text-sm', lg: 'text-base' } as const;

/** Spinner + an optional status line the agent sets to narrate its work. */
const LoadingAtom: FC<AtomRenderProps> = ({ props }) => {
  const message = str(props['message']) || 'Working…';
  const size = props['size'] === 'sm' || props['size'] === 'lg' ? props['size'] : 'md';
  return (
    <div
      className="flex items-center gap-2.5 rounded-xl border border-border bg-card px-4 py-3 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <Spinner size={size} />
      <span className={LOADING_TEXT[size]}>{message}</span>
    </div>
  );
};

type StepState = 'done' | 'active' | 'pending' | 'error';

/**
 * A vertical numbered stepper. `active` is the 0-based current step; steps
 * before it read as done (check), the active one is ringed, later ones are
 * muted. An optional `error` index marks a failed step.
 */
const ProgressSteps: FC<AtomRenderProps> = ({ props }) => {
  const steps = Array.isArray(props['steps']) ? (props['steps'] as unknown[]).map((s) => str(s)) : [];
  if (steps.length === 0) return null;
  const active = Math.max(0, int(props['active'], 0));
  const errorIdx = typeof props['error'] === 'number' ? Math.trunc(props['error']) : -1;

  const stateOf = (i: number): StepState => {
    if (i === errorIdx) return 'error';
    if (i < active) return 'done';
    if (i === active) return 'active';
    return 'pending';
  };

  return (
    <ol className="flex flex-col" role="list" aria-label="Progress">
      {steps.map((label, i) => {
        const state = stateOf(i);
        const last = i === steps.length - 1;
        return (
          <li key={i} className="flex gap-3" aria-current={state === 'active' ? 'step' : undefined}>
            {/* marker + connector rail */}
            <div className="flex flex-col items-center">
              <span
                className={cn(
                  'flex size-6 shrink-0 items-center justify-center rounded-full font-mono text-xs font-semibold',
                  state === 'done' && 'bg-primary text-primary-foreground',
                  state === 'active' && 'bg-primary/10 text-primary ring-2 ring-inset ring-primary/40',
                  state === 'pending' && 'bg-muted text-muted-foreground',
                  state === 'error' && 'bg-destructive text-destructive-foreground'
                )}
              >
                {state === 'done' ? (
                  <Check aria-hidden="true" className="size-3.5" />
                ) : state === 'error' ? (
                  <X aria-hidden="true" className="size-3.5" />
                ) : (
                  i + 1
                )}
              </span>
              {!last ? (
                <span
                  className={cn('w-px flex-1', i < active ? 'bg-primary/40' : 'bg-border')}
                  style={{ minHeight: '1.25rem' }}
                  aria-hidden="true"
                />
              ) : null}
            </div>
            {/* label */}
            <div className={cn('pb-4 text-sm', last && 'pb-0')}>
              <span
                className={cn(
                  state === 'active' && 'font-medium text-foreground',
                  state === 'done' && 'text-foreground',
                  state === 'pending' && 'text-muted-foreground',
                  state === 'error' && 'font-medium text-destructive'
                )}
              >
                {label}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
};

export const loadingAtoms: Atom[] = [
  { id: 'skeleton', Component: SkeletonAtom },
  { id: 'loading', Component: LoadingAtom },
  { id: 'progress-steps', Component: ProgressSteps },
];

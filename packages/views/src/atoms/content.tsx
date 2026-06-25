/**
 * Generic content primitives — the props-driven vocabulary the agent composes
 * with to render arbitrary, non-event structured data (daemon status, write
 * targets, balances, identity) without falling back to plain text. Like
 * `composer`/`tabs`, these are pure and carry no event `kinds`: they render
 * exactly what the ViewSpec hands them.
 */
import { type FC } from 'react';
import { cn } from '@/lib/utils.js';
import { Badge } from '@/components/ui/badge.js';
import { type Atom, type AtomRenderProps } from './types.js';

/** Status tone → semantic colour, shared by `stat` and `badge`. */
export type Tone = 'default' | 'success' | 'warn' | 'danger';

const TONE_TEXT: Record<Tone, string> = {
  default: 'text-foreground',
  success: 'text-emerald-600 dark:text-emerald-400',
  warn: 'text-amber-600 dark:text-amber-400',
  danger: 'text-destructive',
};

/** shadcn badge variant for each tone (the pill colours). */
const TONE_BADGE: Record<Tone, 'secondary' | 'default' | 'destructive'> = {
  default: 'secondary',
  success: 'default',
  warn: 'secondary',
  danger: 'destructive',
};

export function toTone(value: unknown): Tone {
  return value === 'success' || value === 'warn' || value === 'danger' ? value : 'default';
}

const str = (v: unknown, fallback = ''): string =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;

const Heading: FC<AtomRenderProps> = ({ props }) => {
  const text = str(props['text']);
  if (!text) return null;
  const level = props['level'] === 2 || props['level'] === 3 ? props['level'] : 1;
  const cls =
    level === 1
      ? 'text-lg font-semibold tracking-tight'
      : level === 2
        ? 'text-base font-semibold'
        : 'text-sm font-semibold uppercase tracking-wide text-muted-foreground';
  if (level === 2) return <h2 className={cls}>{text}</h2>;
  if (level === 3) return <h3 className={cls}>{text}</h3>;
  return <h1 className={cls}>{text}</h1>;
};

const Text: FC<AtomRenderProps> = ({ props }) => {
  const text = str(props['text']);
  if (!text) return null;
  const muted = props['muted'] === true;
  return (
    <p className={cn('text-sm leading-relaxed', muted && 'text-muted-foreground')}>{text}</p>
  );
};

const Stat: FC<AtomRenderProps> = ({ props }) => {
  const label = str(props['label']);
  const value = str(props['value'], '—');
  const tone = toTone(props['tone']);
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      <span className={cn('text-xl font-semibold tabular-nums', TONE_TEXT[tone])}>{value}</span>
    </div>
  );
};

const KeyValue: FC<AtomRenderProps> = ({ props }) => {
  const rows = Array.isArray(props['rows'])
    ? (props['rows'] as unknown[])
        .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
        .map((r) => ({ label: str(r['label']), value: str(r['value'], '—') }))
    : [];
  if (rows.length === 0) return null;
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map((row, i) => (
        <div key={i} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words text-right font-medium tabular-nums">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
};

const BadgeAtom: FC<AtomRenderProps> = ({ props }) => {
  const label = str(props['label']);
  if (!label) return null;
  const tone = toTone(props['tone']);
  return <Badge variant={TONE_BADGE[tone]}>{label}</Badge>;
};

export const contentAtoms: Atom[] = [
  { id: 'heading', Component: Heading },
  { id: 'text', Component: Text },
  { id: 'stat', Component: Stat },
  { id: 'key-value', Component: KeyValue },
  { id: 'badge', Component: BadgeAtom },
];

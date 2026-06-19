/** Layout atoms — the agent's arrangement vocabulary. */
import { type FC } from 'react';
import { cn } from '../lib/cn.js';
import { type Atom, type AtomRenderProps } from './types.js';

const Stack: FC<AtomRenderProps> = ({ props, children }) => {
  const direction = props['direction'] === 'row' ? 'flex-row' : 'flex-col';
  const gap = typeof props['gap'] === 'number' ? props['gap'] : 3;
  return <div className={cn('flex', direction, `gap-${gap}`)}>{children}</div>;
};

const Section: FC<AtomRenderProps> = ({ props, children }) => {
  const title = typeof props['title'] === 'string' ? props['title'] : undefined;
  return (
    <section className="flex flex-col gap-2">
      {title ? (
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
          {title}
        </h2>
      ) : null}
      {children}
    </section>
  );
};

const Card: FC<AtomRenderProps> = ({ children }) => (
  <div className="rounded-lg border border-border bg-card p-4 text-card-foreground shadow-sm">
    {children}
  </div>
);

export const layoutAtoms: Atom[] = [
  { id: 'stack', Component: Stack },
  { id: 'section', Component: Section },
  { id: 'card', Component: Card },
];

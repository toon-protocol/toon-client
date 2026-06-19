/**
 * Fallback atom — renders any event the registry has no bespoke atom for as
 * decoded JSON + raw tags. Guarantees non-zero coverage for every kind and is
 * also where the runtime degrades unknown/invalid nodes.
 */
import { type FC } from 'react';
import { type Atom, type AtomRenderProps } from './types.js';

export const GENERIC_ATOM_ID = 'generic-event';

const GenericEvent: FC<AtomRenderProps> = ({ events, props }) => {
  const message = typeof props['message'] === 'string' ? props['message'] : undefined;
  return (
    <div className="flex flex-col gap-2">
      {message ? <div className="text-sm text-muted-foreground">{message}</div> : null}
      {events.map((evt) => (
        <div key={evt.id} className="rounded-md border border-border p-3 font-mono text-xs">
          <div className="mb-1 text-muted-foreground">
            kind {evt.kind} · {evt.id.slice(0, 12)}…
          </div>
          {evt.content ? <pre className="whitespace-pre-wrap break-words">{evt.content}</pre> : null}
          {evt.tags.length > 0 ? (
            <pre className="mt-1 whitespace-pre-wrap break-words text-muted-foreground">
              {JSON.stringify(evt.tags)}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
};

export const fallbackAtom: Atom = { id: GENERIC_ATOM_ID, Component: GenericEvent };

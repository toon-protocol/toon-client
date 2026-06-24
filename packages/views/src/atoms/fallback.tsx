/**
 * Fallback atom — renders any event the registry has no bespoke atom for as
 * decoded JSON + raw tags. Guarantees non-zero coverage for every kind.
 */
import { type FC } from 'react';
import { MonoId } from '@/components/mono-id.js';
import { type Atom, type AtomRenderProps } from './types.js';

export const GENERIC_ATOM_ID = 'generic-event';

const GenericEvent: FC<AtomRenderProps> = ({ events, props }) => {
  const message = typeof props['message'] === 'string' ? props['message'] : undefined;
  return (
    <div className="flex flex-col gap-2">
      {message ? (
        <p className="text-sm text-muted-foreground">{message}</p>
      ) : null}
      {events.map((evt) => (
        <div
          key={evt.id}
          className="rounded-md border border-border bg-muted/30 p-3 font-mono text-xs"
        >
          <div className="mb-2 flex items-center gap-2 text-muted-foreground">
            <span>kind {evt.kind}</span>
            <span>·</span>
            <MonoId value={evt.id} />
          </div>
          {evt.content ? (
            <pre className="whitespace-pre-wrap break-words text-foreground">{evt.content}</pre>
          ) : null}
          {evt.tags.length > 0 ? (
            <pre className="mt-1.5 whitespace-pre-wrap break-words text-muted-foreground">
              {JSON.stringify(evt.tags, null, 2)}
            </pre>
          ) : null}
        </div>
      ))}
    </div>
  );
};

export const fallbackAtom: Atom = { id: GENERIC_ATOM_ID, Component: GenericEvent };

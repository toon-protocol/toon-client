/** Interactive atoms that hold local UI state (composer, tabs). */
import { Children, useState, type FC } from 'react';
import { type Atom, type AtomRenderProps } from './types.js';

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

export const interactiveAtoms: Atom[] = [
  { id: 'composer', writes: [{ name: 'toon_publish_unsigned' }], Component: Composer },
  { id: 'tabs', Component: Tabs },
];

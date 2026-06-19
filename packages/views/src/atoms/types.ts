/**
 * Atom contract.
 *
 * Atoms are pure, presentational, single-responsibility React components keyed
 * by a stable `id`. The runtime resolves a node's data binding (free reads) and
 * wires its write actions, then hands the atom already-resolved props. Atoms
 * never call the bridge directly — they invoke the `actions` the runtime built.
 */

import { type FC, type ReactNode } from 'react';
import { type NostrEvent } from '../types.js';

/** A wired write action; runtimeArgs are merged over the ViewSpec's static args. */
export type AtomAction = (runtimeArgs?: Record<string, unknown>) => void | Promise<void>;

export interface AtomRenderProps {
  /** Events resolved from the node's `bind` (empty when there is no binding). */
  events: NostrEvent[];
  /** Static props from the ViewSpec node. */
  props: Record<string, unknown>;
  /** Write actions declared on the node, wired to the bridge by the runtime. */
  actions: Record<string, AtomAction>;
  /** Rendered child nodes. */
  children: ReactNode;
  /** Render one event via its kind's default atom (for feeds/lists/kindAuto). */
  renderEvent: (event: NostrEvent) => ReactNode;
}

/** A registered atom. */
export interface Atom {
  id: string;
  /** Event kinds this atom is the default renderer for (kindAuto / feeds). */
  kinds?: number[];
  /** Write tools this atom can fire (informational; the runtime wires them). */
  writes?: { name: string; spendy?: boolean }[];
  Component: FC<AtomRenderProps>;
}

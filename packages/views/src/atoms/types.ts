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

/**
 * Outcome of a wired write action, surfaced from the runtime so atoms can render
 * a receipt with the real published `eventId`. A trimmed projection of the
 * bridge's `ToolOutcome`: `ok` is `false` when the action was declined (spendy
 * confirm) or the tool reported failure; `eventId` / `data` carry the publish
 * response (`structuredContent`) on success.
 */
export interface ActionOutcome {
  ok: boolean;
  /** Published event id when the tool returned one (e.g. `toon_publish_unsigned`). */
  eventId?: string;
  /** Raw structured payload from the tool result. */
  data?: unknown;
  /** Error text when `ok` is false. */
  error?: string;
}

/** A wired write action; runtimeArgs are merged over the ViewSpec's static args.
 * Resolves to an {@link ActionOutcome} (`ok` plus the published `eventId`/`data`),
 * or `void` if the call site doesn't read it. */
export type AtomAction = (
  runtimeArgs?: Record<string, unknown>
) => ActionOutcome | void | Promise<ActionOutcome | void>;

/** Per-chain settlement readiness, mirrored from the daemon `toon_status`. */
export interface AtomChainStatus {
  chain: string;
  ready: boolean;
  detail?: string;
}

/**
 * The current daemon + pay-to-write status, as surfaced by the `toon_status`
 * tool. Atoms that show a fee (e.g. the pay-confirm receipt) read the
 * `feePerEvent`/`settlementChain`/`asset` fields via
 * {@link AtomRenderProps.readStatus} rather than hardcoding them; the richer
 * fields below let the `client-status` dashboard render the whole daemon health
 * snapshot (ready state, uptime, relay, transport, per-chain readiness,
 * identity) from the same single read seam. All non-fee fields are optional so
 * older render paths / minimal stubs keep working.
 */
export interface AtomStatus {
  feePerEvent: string;
  settlementChain: string;
  asset?: string;
  /** Daemon process uptime, ms. */
  uptimeMs?: number;
  /** True once a channel is open and the client can publish. */
  ready?: boolean;
  /** True while the BTP session / channel are still coming up. */
  bootstrapping?: boolean;
  /** Identity: Nostr pubkey (hex) + optional per-chain addresses. */
  identity?: {
    nostrPubkey?: string;
    evmAddress?: string;
    solanaAddress?: string;
    minaAddress?: string;
  };
  /** Write transport (BTP) summary. */
  transport?: {
    type?: string;
    btpUrl?: string;
  };
  /** Read-relay connection summary. */
  relay?: {
    url?: string;
    connected?: boolean;
    buffered?: number;
    subscriptions?: string[];
  };
  /** Per-chain settlement readiness, when a network tier is configured. */
  network?: AtomChainStatus[];
  /** Last non-fatal bootstrap error, if any. */
  lastError?: string;
}

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
  /**
   * Fetch the live pay-to-write status (`toon_status`) — the fee + settlement
   * chain to show before a paid write. Wired to the bridge by the runtime;
   * `undefined` only in older render paths / tests that don't provide it. Atoms
   * never call the bridge directly, so this is the single read seam for the fee.
   */
  readStatus?: () => Promise<AtomStatus>;
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

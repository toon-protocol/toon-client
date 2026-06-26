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
 * Sentinel `error` value a wired spendy action returns when the user/host
 * DECLINES the consent prompt (vs. a real tool/leg failure). This is benign and
 * user-initiated — atoms must not render it as a failure. Shared by the runtime
 * (which produces it) and atoms (which special-case it in their UX).
 */
export const SPENDY_CANCELLED = 'cancelled';

/**
 * Outcome of a wired write action, surfaced from the runtime so atoms can render
 * a receipt with the real published `eventId`. A trimmed projection of the
 * bridge's `ToolOutcome`: `ok` is `false` when the action was declined (spendy
 * confirm) or the tool reported failure; `eventId` / `data` carry the publish
 * response (`structuredContent`) on success. A decline sets `error` to
 * {@link SPENDY_CANCELLED} (benign) rather than a tool error string.
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

/**
 * One tracked payment channel, as surfaced by the `toon_channels` read seam
 * ({@link AtomRenderProps.readChannels}). `availableBalance` (= depositTotal −
 * cumulativeAmount) is the spendable figure the wallet / channel-list atoms show.
 * All amounts are base (micro) units as decimal strings.
 */
export interface AtomChannel {
  channelId: string;
  nonce: number;
  cumulativeAmount: string;
  depositTotal?: string;
  availableBalance?: string;
}

/**
 * One on-chain wallet token balance, as surfaced by the `toon_balances` read
 * seam ({@link AtomRenderProps.readBalances}).
 */
export interface AtomBalance {
  /** Chain family (`'evm'` | `'solana'` | `'mina'`). */
  chain: string;
  /** The wallet address holding the balance. */
  address: string;
  /** Token amount in base (micro) units, decimal string. */
  amount: string;
  /** Human asset code, e.g. `'USDC'`. */
  asset?: string;
  /** Decimal places for `amount`, when known. */
  assetScale?: number;
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
  /**
   * Fetch the tracked payment channels (`toon_channels`) — channelId, nonce,
   * cumulative spent, locked deposit, and available (spendable) balance. Wired
   * to the bridge by the runtime; `undefined` only in older render paths / tests.
   */
  readChannels?: () => Promise<AtomChannel[]>;
  /**
   * Fetch the on-chain wallet token balances (`toon_balances`) per configured
   * chain. Wired to the bridge by the runtime; `undefined` only in older render
   * paths / tests that don't provide it.
   */
  readBalances?: () => Promise<AtomBalance[]>;
  /**
   * Resolve an author's kind:0 profile event by pubkey, lazily and cached for
   * the session. A feed bind only carries the notes (`kinds:[1]`), so an atom
   * cannot find the author's metadata in its own `events`; this seam lets it
   * pull the kind:0 on demand. Returns the newest kind:0 for the pubkey, or
   * `null` when the author has never published one. Wired to the bridge by the
   * runtime (atoms never call the bridge directly); `undefined` only in older
   * render paths / tests that don't provide it.
   */
  resolveProfile?: (pubkey: string) => Promise<NostrEvent | null>;
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

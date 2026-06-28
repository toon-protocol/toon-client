/**
 * Engagement spend-budget — a pre-authorized session allowance for cheap
 * micro-writes.
 *
 * Social engagement on TOON (like = kind:7, follow = kind:3, repost = kind:6) is
 * a paid write: each one settles a payment-channel claim. Showing the full
 * per-action {@link ConsentProvider} prompt before every like is far too heavy
 * for a high-frequency action. So engagement uses a PRE-AUTHORIZED BUDGET: the
 * user approves a small allowance ONCE per session, then likes/follows debit a
 * local counter SILENTLY (no modal) until it runs out — at which point we
 * re-prompt to top up. Larger writes (compose/post, upload, swap, channel ops)
 * keep their per-action consent; the budget governs ONLY engagement micro-writes.
 *
 * This layers OVER {@link ConsentProvider}: it reuses the same `toon_status`
 * read seam for the live fee/asset, and falls back to the per-action consent gate
 * when the fee can't be read (so a spend is never silently auto-approved on a
 * stale/unknown fee). The allowance lives in React state only — it never
 * persists across reloads, so a stale session can't silently keep spending.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { Coins } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import type { AtomStatus } from './atoms/types.js';
import {
  useConsentGate,
  type ConsentGate,
  type ConsentOptions,
} from './spendy-consent.js';

/**
 * How many engagement micro-writes one authorization covers: the allowance is
 * `feePerEvent × this`. A small, comprehensible bucket ("up to ~20 likes /
 * follows") rather than an open-ended grant. Exported so tests can drive the
 * exhaustion boundary without hardcoding the count.
 */
export const ENGAGEMENT_BUDGET_EVENTS = 20;

/**
 * Gate an engagement micro-write against the session budget. Same shape as
 * {@link ConsentGate} so it drops into the runtime's action wiring in place of
 * the per-action consent: resolves `true` to proceed (debited), `false` to
 * decline. Unlike the consent gate it is usually SILENT — it only renders a
 * prompt on the first authorization and on a top-up after exhaustion.
 */
export type EngagementGate = ConsentGate;

/** The session budget snapshot a UI affordance reads (the engagement-bar meter). */
export interface EngagementBudgetState {
  /** True once the user has authorized an allowance this session. */
  authorized: boolean;
  /** Remaining spend, in base (micro) units. */
  remaining: number;
  /** The full allowance granted, in base (micro) units. */
  total: number;
  /** Human asset code (e.g. `'USDC'`), when known. */
  asset?: string;
  /** The per-event engagement fee, in base units, when known. */
  feePerEvent?: number;
  /** Open the (re-)authorization prompt to top the budget back up. */
  requestTopUp: () => void;
}

const EngagementGateContext = createContext<EngagementGate>(() => Promise.resolve(true));
const EngagementBudgetContext = createContext<EngagementBudgetState>({
  authorized: false,
  remaining: 0,
  total: 0,
  requestTopUp: () => {},
});

/** The gate the runtime routes engagement micro-writes through. */
export function useEngagementGate(): EngagementGate {
  return useContext(EngagementGateContext);
}

/** Read the live session budget (for the engagement-bar affordance). */
export function useEngagementBudget(): EngagementBudgetState {
  return useContext(EngagementBudgetContext);
}

/** The authoritative session allowance (counter), held in a ref + state mirror. */
interface Allowance {
  total: number;
  remaining: number;
  fee: number;
  asset?: string;
}

/** A pending budget prompt: the first authorization or a post-exhaustion top-up. */
interface BudgetPrompt {
  mode: 'authorize' | 'topup';
  fee: number;
  asset?: string;
  allowance: number;
}

/**
 * Mounts the engagement-budget layer and provides the {@link EngagementGate}
 * plus the {@link EngagementBudgetState}. Must sit INSIDE a
 * {@link ConsentProvider} so it can fall back to the per-action consent gate when
 * the fee is unavailable. `readStatus` is the same live `toon_status` seam the
 * consent modal uses — atoms never call the bridge directly.
 */
export const BudgetProvider: FC<{
  children: ReactNode;
  readStatus?: () => Promise<AtomStatus>;
}> = ({ children, readStatus }) => {
  // Per-action consent fallback (fee unavailable) — provided by the enclosing
  // ConsentProvider, so a spend is never auto-approved on an unknown fee.
  const consentGate = useConsentGate();

  // The counter is held in a ref (authoritative, read/written synchronously in
  // the gate so rapid clicks debit correctly) with a state mirror that drives
  // the affordance re-render. Both are React state only → reset on reload.
  const allowanceRef = useRef<Allowance | null>(null);
  const [allowance, setAllowanceState] = useState<Allowance | null>(null);
  const setAllowance = useCallback((next: Allowance | null): void => {
    allowanceRef.current = next;
    setAllowanceState(next);
  }, []);

  const [prompt, setPrompt] = useState<BudgetPrompt | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);
  // Cache the fee/asset for the session (engagement fee doesn't change mid-flow).
  const statusRef = useRef<{ fee: number; asset?: string } | null>(null);

  const readFee = useCallback(async (): Promise<{ fee: number; asset?: string } | null> => {
    if (statusRef.current) return statusRef.current;
    if (!readStatus) return null;
    try {
      const s = await readStatus();
      const fee = Number(s.feePerEvent);
      // A non-positive / non-finite fee is unusable — refuse to budget on it.
      if (!Number.isFinite(fee) || fee <= 0) return null;
      const resolved = { fee, asset: s.asset };
      statusRef.current = resolved;
      return resolved;
    } catch {
      return null;
    }
  }, [readStatus]);

  const settle = useCallback((ok: boolean): void => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt(null);
    resolve?.(ok);
  }, []);

  // Open the (re-)authorization prompt. `onConfirm` applies the budget change
  // (debit-this-action vs. refill) when the user approves.
  const openPrompt = useCallback(
    (mode: 'authorize' | 'topup', fee: number, asset: string | undefined, onConfirm: () => void): void => {
      // A new prompt supersedes any in-flight one (decline the stale request).
      resolverRef.current?.(false);
      resolverRef.current = (ok: boolean) => {
        if (ok) onConfirm();
      };
      setPrompt({ mode, fee, asset, allowance: fee * ENGAGEMENT_BUDGET_EVENTS });
    },
    []
  );

  const requestEngagement = useCallback<EngagementGate>(
    (message, opts) =>
      new Promise<boolean>((resolve) => {
        void readFee().then((status) => {
          if (!status) {
            // No reliable fee → fall back to the full per-action consent rather
            // than silently spending against an unknown amount.
            void consentGate(message, opts).then(resolve);
            return;
          }
          const { fee, asset } = status;
          const cur = allowanceRef.current;
          if (cur && cur.remaining >= fee) {
            // Silent debit — the whole point of the budget. No modal.
            setAllowance({ ...cur, remaining: cur.remaining - fee });
            resolve(true);
            return;
          }
          // First authorization (no allowance) or exhausted (top-up): prompt,
          // then on approval grant the allowance and debit THIS action.
          const total = fee * ENGAGEMENT_BUDGET_EVENTS;
          const mode: 'authorize' | 'topup' = cur ? 'topup' : 'authorize';
          // Replace the superseding resolver so it resolves THIS gate promise.
          resolverRef.current?.(false);
          resolverRef.current = (ok: boolean) => {
            if (ok) setAllowance({ total, remaining: total - fee, fee, asset });
            resolve(ok);
          };
          setPrompt({ mode, fee, asset, allowance: total });
        });
      }),
    [readFee, consentGate, setAllowance]
  );

  const requestTopUp = useCallback((): void => {
    void readFee().then((status) => {
      if (!status) return;
      const { fee, asset } = status;
      const total = fee * ENGAGEMENT_BUDGET_EVENTS;
      const mode: 'authorize' | 'topup' = allowanceRef.current ? 'topup' : 'authorize';
      // A manual top-up refills to the full allowance — no action is pending, so
      // nothing is debited here.
      openPrompt(mode, fee, asset, () => setAllowance({ total, remaining: total, fee, asset }));
    });
  }, [readFee, openPrompt, setAllowance]);

  const budgetState = useMemo<EngagementBudgetState>(
    () => ({
      authorized: allowance !== null,
      remaining: allowance?.remaining ?? 0,
      total: allowance?.total ?? 0,
      ...(allowance?.asset ? { asset: allowance.asset } : {}),
      ...(allowance ? { feePerEvent: allowance.fee } : {}),
      requestTopUp,
    }),
    [allowance, requestTopUp]
  );

  const assetSuffix = prompt?.asset ? ` ${prompt.asset}` : '';
  const isTopUp = prompt?.mode === 'topup';

  return (
    <EngagementGateContext.Provider value={requestEngagement}>
      <EngagementBudgetContext.Provider value={budgetState}>
        {children}
        {prompt !== null ? (
          <div
            role="dialog"
            aria-modal="true"
            aria-label="Engagement budget"
            // Top-anchored, matching the consent modal — the host gives MCP apps
            // a tall fixed-height iframe, so a centered overlay lands off-screen.
            className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 p-4 pt-6 backdrop-blur-sm"
          >
            <div className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card shadow-lg">
              <div className="flex items-center gap-2 border-b border-border px-4 py-3">
                <Coins aria-hidden="true" className="size-4 text-primary" />
                <span className="text-sm font-semibold">
                  {isTopUp ? 'Engagement budget used up' : 'Allow engagement spending'}
                </span>
              </div>
              <div className="flex flex-col gap-2.5 px-4 py-3">
                <p className="text-sm text-muted-foreground">
                  {isTopUp
                    ? 'Your likes & follows budget for this session is spent.'
                    : 'Approve a small allowance for likes & follows this session, so they go through without a prompt each time.'}
                </p>
                <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
                  <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">Allowance</dt>
                    <dd className="font-medium tabular-nums">
                      {`${prompt.allowance}${assetSuffix}`}
                    </dd>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">Per like / follow</dt>
                    <dd className="font-medium tabular-nums">{`${prompt.fee}${assetSuffix}`}</dd>
                  </div>
                </dl>
                <p className="text-xs text-muted-foreground">
                  Engagement spends are{' '}
                  <span className="text-foreground/80">non-refundable</span>. We debit
                  this allowance silently until it runs out, then ask again.
                </p>
              </div>
              <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
                <Button variant="outline" size="sm" onClick={() => settle(false)}>
                  Cancel
                </Button>
                <Button size="sm" onClick={() => settle(true)}>
                  <Coins aria-hidden="true" />
                  {isTopUp ? 'Re-authorize' : 'Allow'}
                </Button>
              </div>
            </div>
          </div>
        ) : null}
      </EngagementBudgetContext.Provider>
    </EngagementGateContext.Provider>
  );
};

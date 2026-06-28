/**
 * Shared post-action refresh signal.
 *
 * The runtime bumps a `refreshNonce` after every SUCCESSFUL write action (see
 * `buildActions` in runtime.tsx). Read-bearing atoms (and the feed `useBind`)
 * call this hook with that nonce and fold the returned counter into their read
 * `useEffect` dependency array, so the rendered data re-fetches IN PLACE after a
 * mutation — no re-render from the agent.
 *
 * Two kinds of staleness are covered:
 *   - immediate: the moment the action resolves, re-read (the nonce bump).
 *   - settlement-delayed: faucet drips + relay propagation can land a beat after
 *     the tool call returns, so we re-read again after each delay in `delaysMs`.
 *
 * The initial mount (nonce 0) does NOT fire — the atom's own mount-time read
 * already covers first paint. Timers are cleared on the next bump / unmount, so
 * there are no leaks and no setState-after-unmount. Reads must never bump the
 * nonce themselves (only write actions do), so this can't loop.
 */
import { useEffect, useState } from 'react';

/** Default settlement-retry cadence: one re-read ~1.5s after the action. */
const DEFAULT_DELAYS_MS: readonly number[] = [1500];

export function useRefreshTick(
  refreshNonce: number | undefined,
  delaysMs: readonly number[] = DEFAULT_DELAYS_MS
): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    // Skip the initial mount — the atom's own read effect handles first paint.
    if (!refreshNonce) return;
    // Re-read immediately, then once more after each settlement delay.
    setTick((t) => t + 1);
    const timers = delaysMs.map((ms) => setTimeout(() => setTick((t) => t + 1), ms));
    return () => {
      for (const t of timers) clearTimeout(t);
    };
    // Only the integer nonce drives re-fetch; delaysMs is a stable call-site literal.
  }, [refreshNonce]);
  return tick;
}

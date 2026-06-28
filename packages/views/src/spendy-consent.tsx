/**
 * In-iframe spendy-consent prompt.
 *
 * Spendy writes (e.g. `toon_upload`, `toon_swap`) must show the user a consent
 * prompt before any payment-channel claim is spent. The runtime cannot use
 * `window.confirm` for this: the TOON app runs inside a host-controlled iframe
 * sandboxed WITHOUT `allow-modals`, so `window.confirm()` is suppressed by the
 * browser and returns `false` immediately — the prompt never renders and the
 * spend is silently auto-rejected (issue toon-client#170). Nor does the MCP
 * Apps host (`@modelcontextprotocol/ext-apps`) expose a native consent/elicit
 * primitive to wire a host prompt to.
 *
 * So consent is RENDERED REACT UI inside the iframe — the same proven surface
 * the `pay-confirm` atom uses — exposed to the runtime as an async gate over
 * React context. `ViewSpecRenderer` mounts the {@link ConsentProvider}; the
 * runtime's action wiring calls {@link useConsentGate} to await a real,
 * dismissible prompt.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { Coins } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import type { AtomStatus } from './atoms/types.js';

/**
 * Options refining a consent prompt. `showWriteFee` surfaces the live
 * pay-to-write fee — only meaningful for per-event writes (publish/upload); a
 * swap/deposit's cost is its own amount, carried in the message, not this fee.
 */
export interface ConsentOptions {
  showWriteFee?: boolean;
}

/**
 * Request consent for a spendy action; resolves `true` to proceed (pay) or
 * `false` to decline. The default (no provider mounted — e.g. SSR/worker render
 * paths or tests that don't exercise consent) auto-approves, matching the prior
 * non-browser fallback; the runtime still gates on the bridge's injected
 * `confirm` first when one is present.
 */
export type ConsentGate = (message: string, opts?: ConsentOptions) => Promise<boolean>;

const ConsentContext = createContext<ConsentGate>(() => Promise.resolve(true));

/** Read the active consent gate (the {@link ConsentProvider} modal, or auto-approve). */
export function useConsentGate(): ConsentGate {
  return useContext(ConsentContext);
}

/** A pending consent prompt: the action message + its refining options. */
interface ConsentPrompt {
  message: string;
  opts: ConsentOptions;
}

/**
 * Mounts the consent modal and provides a {@link ConsentGate} to descendants.
 * The gate returns a promise that settles when the user confirms or cancels the
 * rendered prompt — no native `window.confirm`, so it works inside the
 * no-`allow-modals` host iframe.
 *
 * When `readStatus` is supplied (the live `toon_status` reader the pay-confirm
 * atom uses), the prompt is SPECIFIC rather than a bare label: it surfaces the
 * settlement chain, the pay-to-write fee (for per-event writes), and an explicit
 * non-refundable / irreversible warning — so the user approves a concrete spend.
 */
export const ConsentProvider: FC<{
  children: ReactNode;
  readStatus?: () => Promise<AtomStatus>;
}> = ({ children, readStatus }) => {
  const [prompt, setPrompt] = useState<ConsentPrompt | null>(null);
  const [status, setStatus] = useState<AtomStatus | null>(null);
  const [statusError, setStatusError] = useState(false);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const requestConsent = useCallback<ConsentGate>(
    (message, opts) =>
      new Promise<boolean>((resolve) => {
        // A new prompt supersedes any in-flight one (decline the stale request).
        resolverRef.current?.(false);
        resolverRef.current = resolve;
        setStatus(null);
        setStatusError(false);
        setPrompt({ message, opts: opts ?? {} });
      }),
    []
  );

  // Fetch the live fee/chain once a prompt opens, so the modal can show the
  // concrete spend instead of a generic label.
  useEffect(() => {
    if (!prompt || status || statusError || !readStatus) return;
    let cancelled = false;
    void readStatus()
      .then((s) => {
        if (!cancelled) setStatus(s);
      })
      .catch(() => {
        if (!cancelled) setStatusError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [prompt, status, statusError, readStatus]);

  const settle = useCallback((ok: boolean): void => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setPrompt(null);
    resolve?.(ok);
  }, []);

  const assetSuffix = status?.asset ? ` ${status.asset}` : '';
  const showFee = prompt?.opts.showWriteFee === true;

  return (
    <ConsentContext.Provider value={requestConsent}>
      {children}
      {prompt !== null ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Confirm spend"
          // Anchor the prompt to the TOP of the iframe, not vertically centered.
          // The host gives MCP apps a tall fixed-height iframe (no auto-resize),
          // so a centered overlay lands in the middle of a long feed — below the
          // visible window, forcing the user to scroll to find it. Top-anchoring
          // keeps it where the composer/first notes sit, which is usually in
          // view. (The fuller fix is a host-native or inline-at-action consent;
          // tracked as a follow-up.)
          className="fixed inset-0 z-50 flex items-start justify-center bg-background/80 p-4 pt-6 backdrop-blur-sm"
        >
          <div className="w-full max-w-sm overflow-hidden rounded-xl border border-border bg-card shadow-lg">
            <div className="flex items-center gap-2 border-b border-border px-4 py-3">
              <Coins aria-hidden="true" className="size-4 text-primary" />
              <span className="text-sm font-semibold">Confirm spend</span>
            </div>
            <div className="flex flex-col gap-2.5 px-4 py-3">
              <p className="text-sm text-muted-foreground">{prompt.message}</p>
              {readStatus ? (
                <dl className="flex flex-wrap items-center gap-x-6 gap-y-1 text-xs">
                  {showFee ? (
                    <div className="flex items-center gap-1.5">
                      <dt className="text-muted-foreground">Fee</dt>
                      <dd className="font-medium tabular-nums">
                        {status
                          ? `${status.feePerEvent}${assetSuffix}`
                          : statusError
                            ? 'unavailable'
                            : '…'}
                      </dd>
                    </div>
                  ) : null}
                  <div className="flex items-center gap-1.5">
                    <dt className="text-muted-foreground">Settles on</dt>
                    <dd className="font-medium">
                      {status ? status.settlementChain : statusError ? 'unknown' : '…'}
                    </dd>
                  </div>
                </dl>
              ) : null}
              <p className="text-xs text-muted-foreground">
                Spends are <span className="text-foreground/80">non-refundable</span> and
                can&apos;t be undone.
              </p>
            </div>
            <div className="flex justify-end gap-2 border-t border-border px-4 py-2.5">
              <Button variant="outline" size="sm" onClick={() => settle(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => settle(true)}>
                <Coins aria-hidden="true" />
                Confirm &amp; pay
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </ConsentContext.Provider>
  );
};

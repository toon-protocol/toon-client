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
  useRef,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { Coins } from 'lucide-react';
import { Button } from '@/components/ui/button.js';

/**
 * Request consent for a spendy action; resolves `true` to proceed (pay) or
 * `false` to decline. The default (no provider mounted — e.g. SSR/worker render
 * paths or tests that don't exercise consent) auto-approves, matching the prior
 * non-browser fallback; the runtime still gates on the bridge's injected
 * `confirm` first when one is present.
 */
export type ConsentGate = (message: string) => Promise<boolean>;

const ConsentContext = createContext<ConsentGate>(() => Promise.resolve(true));

/** Read the active consent gate (the {@link ConsentProvider} modal, or auto-approve). */
export function useConsentGate(): ConsentGate {
  return useContext(ConsentContext);
}

/**
 * Mounts the consent modal and provides a {@link ConsentGate} to descendants.
 * The gate returns a promise that settles when the user confirms or cancels the
 * rendered prompt — no native `window.confirm`, so it works inside the
 * no-`allow-modals` host iframe.
 */
export const ConsentProvider: FC<{ children: ReactNode }> = ({ children }) => {
  const [message, setMessage] = useState<string | null>(null);
  const resolverRef = useRef<((ok: boolean) => void) | null>(null);

  const requestConsent = useCallback<ConsentGate>(
    (msg) =>
      new Promise<boolean>((resolve) => {
        // A new prompt supersedes any in-flight one (decline the stale request).
        resolverRef.current?.(false);
        resolverRef.current = resolve;
        setMessage(msg);
      }),
    []
  );

  const settle = useCallback((ok: boolean): void => {
    const resolve = resolverRef.current;
    resolverRef.current = null;
    setMessage(null);
    resolve?.(ok);
  }, []);

  return (
    <ConsentContext.Provider value={requestConsent}>
      {children}
      {message !== null ? (
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
            <p className="px-4 py-3 text-sm text-muted-foreground">{message}</p>
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

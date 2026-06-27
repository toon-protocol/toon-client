import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';

/**
 * Best-effort synchronous copy via the legacy `document.execCommand('copy')` over
 * a hidden textarea. Unlike the async Clipboard API this works inside a host
 * iframe that is NOT granted the `clipboard-write` permission policy. Returns
 * whether the copy succeeded.
 */
function legacyCopy(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = value;
  ta.setAttribute('readonly', '');
  // Keep it off-screen and inert so selecting it doesn't scroll/flash the page.
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '0';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  ta.setSelectionRange(0, value.length);
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}

/**
 * Copy-to-share affordance. A quiet ghost icon button that copies `value` to the
 * clipboard and flips to a check for ~1.5s.
 *
 * The TOON app runs inside the host's iframe, which is generally NOT granted the
 * `clipboard-write` permission policy — so `navigator.clipboard.writeText`
 * rejects with `NotAllowedError` there (the same iframe-sandbox limitation that
 * suppresses `window.confirm`; see spendy-consent.tsx). The earlier version had
 * no rejection handler, so the click silently did nothing. We now try the async
 * Clipboard API first and fall back to the legacy `execCommand` path, which
 * still works in a sandboxed frame. `label` names what's being copied for
 * assistive tech.
 */
export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = React.useState(false);

  const onCopy = React.useCallback(() => {
    const succeed = (): void => setCopied(true);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(value).then(succeed, () => {
        // Permission policy blocked the async API inside the host iframe — fall
        // back to the legacy command, which copies from a sandboxed frame.
        if (legacyCopy(value)) succeed();
      });
      return;
    }
    if (legacyCopy(value)) succeed();
  }, [value]);

  React.useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={copied ? `${label} — copied` : label}
      className={cn('text-muted-foreground hover:text-foreground', className)}
      onClick={onCopy}
    >
      {copied ? (
        <Check aria-hidden="true" className="text-primary" />
      ) : (
        <Copy aria-hidden="true" />
      )}
    </Button>
  );
}

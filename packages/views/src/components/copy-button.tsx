import * as React from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { cn } from '@/lib/utils.js';

/**
 * Copy-to-share affordance. A quiet ghost icon button that copies `value` to the
 * clipboard and flips to a check for ~1.5s. `navigator.clipboard` is guarded so
 * it degrades to a no-op (disabled) in SSR / non-secure contexts rather than
 * throwing. `label` names what's being copied for assistive tech.
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
  const canCopy =
    typeof navigator !== 'undefined' && !!navigator.clipboard;

  const onCopy = React.useCallback(() => {
    if (!canCopy) return;
    void navigator.clipboard.writeText(value).then(() => setCopied(true));
  }, [canCopy, value]);

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
      disabled={!canCopy}
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

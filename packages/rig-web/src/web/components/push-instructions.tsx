import { useCallback, useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useRigConfig } from '@/hooks/use-rig-config';
import type { RepoMetadata } from '../nip34-parsers.js';

/**
 * Where "how do I fund a TOON identity and push?" is documented — the
 * `@toon-protocol/rig` package README (install, daemon vs standalone payment
 * modes, fee model).
 */
const RIG_CLI_DOCS_URL =
  'https://github.com/toon-protocol/toon-client/tree/main/packages/rig#readme';

/**
 * Best-effort synchronous copy via the legacy `document.execCommand('copy')`
 * over a hidden textarea. Same approach as the views copy-button: the async
 * Clipboard API rejects when the page is embedded without the
 * `clipboard-write` permission policy, while the legacy command still works.
 * Returns whether the copy succeeded.
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
 * Neutralize a value for interpolation into the copy-paste shell snippet.
 *
 * `repoId` is the kind:30617 `d` tag — raw, attacker-publishable event content
 * with no charset guarantee — and the snippet is pasted straight into a
 * terminal, so an embedded newline would smuggle an extra executable line
 * into the clipboard (command injection via paste). Control characters are
 * stripped outright (they are never legitimate in a repo id, pubkey, or relay
 * URL), and anything outside a conservative safe charset is single-quoted
 * with `'` → `'\''` escaping so the shell treats it as one literal word.
 */
function shellQuote(value: string): string {
  // eslint-disable-next-line no-control-regex -- stripping control chars is the point
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '');
  if (/^[A-Za-z0-9._:/@-]+$/.test(cleaned)) return cleaned;
  return `'${cleaned.replace(/'/g, `'\\''`)}'`;
}

/**
 * The paste-and-run setup commands for contributing to a specific repo with
 * the `rig` CLI: install `@toon-protocol/rig`, persist the repo's `a`-tag
 * addressing (`30617:<owner>:<repoId>`) as the `toon.*` git config keys the
 * CLI reads, and push. Key spellings match what `rig push` itself persists
 * (git config keys are case-insensitive; `toon.repoid` is the CLI's
 * canonical form).
 */
export function buildPushSnippet(
  repoId: string,
  ownerPubkey: string,
  relayUrl: string,
): string {
  return [
    'npm i -g @toon-protocol/rig',
    `git config toon.repoid ${shellQuote(repoId)}`,
    `git config toon.owner ${shellQuote(ownerPubkey)}`,
    `git config toon.relay ${shellQuote(relayUrl)}`,
    'rig push',
  ].join('\n');
}

/**
 * "Push to this repo" affordance: a compact popover with a copyable setup
 * snippet pre-filled from the repo's actual context (repoId from the
 * kind:30617 `d` tag, owner from the announcement pubkey, relay from the
 * rig's active relay config).
 *
 * The Rig itself stays read-only — this is a hand-off to the `rig` CLI, which
 * runs on the contributor's machine and owns the paid-write confirm flow. No
 * daemon probing happens from the browser.
 */
export function PushInstructions({ metadata }: { metadata: RepoMetadata }) {
  const { relayUrl } = useRigConfig();
  const snippet = buildPushSnippet(metadata.repoId, metadata.ownerPubkey, relayUrl);

  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const succeed = (): void => setCopied(true);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(snippet).then(succeed, () => {
        // Permission policy blocked the async API — fall back to the legacy
        // command, which still copies from a restricted context.
        if (legacyCopy(snippet)) succeed();
      });
      return;
    }
    if (legacyCopy(snippet)) succeed();
  }, [snippet]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button size="sm" className="gap-1.5">
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M3.5 3.75a.25.25 0 01.25-.25h8.5a.25.25 0 01.25.25v8.5a.25.25 0 01-.25.25h-8.5a.25.25 0 01-.25-.25v-8.5zM3.75 2A1.75 1.75 0 002 3.75v8.5c0 .966.784 1.75 1.75 1.75h8.5A1.75 1.75 0 0014 12.25v-8.5A1.75 1.75 0 0012.25 2h-8.5zm4.78 3.22a.75.75 0 00-1.06 0L5.72 6.97a.75.75 0 001.06 1.06l.47-.47v2.69a.75.75 0 001.5 0V7.56l.47.47a.75.75 0 101.06-1.06L8.53 5.22z" />
          </svg>
          Push
          <svg className="ml-0.5 h-3 w-3 opacity-60" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M4.427 7.427l3.396 3.396a.25.25 0 00.354 0l3.396-3.396A.25.25 0 0011.396 7H4.604a.25.25 0 00-.177.427z" />
          </svg>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[26rem] max-w-[calc(100vw-2rem)] p-4" align="end">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Push to this repo</h3>
            <p className="text-xs text-muted-foreground">
              The Rig is read-only — pushes happen from your terminal via the{' '}
              <code className="font-mono">rig</code> CLI.
            </p>
          </div>
          <div className="relative rounded-md border bg-muted/50">
            <pre className="overflow-x-auto p-3 pr-10 font-mono text-xs leading-relaxed">
              {snippet}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={copied ? 'Copy setup commands — copied' : 'Copy setup commands'}
              className="absolute right-1 top-1 text-muted-foreground hover:text-foreground"
              onClick={onCopy}
            >
              {copied ? (
                <Check aria-hidden="true" className="text-primary" />
              ) : (
                <Copy aria-hidden="true" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Writes are paid and permanent — you need a funded TOON identity. See the{' '}
            <a
              href={RIG_CLI_DOCS_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              rig CLI docs
            </a>
            .
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

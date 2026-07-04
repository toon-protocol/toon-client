import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Code2, Copy } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Button } from '@/components/ui/button';
import { useRigConfig } from '@/hooks/use-rig-config';
import type { RepoMetadata } from '../nip34-parsers.js';

/**
 * Where "how do I clone / fetch / push?" is documented — the
 * `@toon-protocol/rig` package README (install, the free read path, daemon vs
 * standalone payment modes for the paid write path).
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
 * The paste-and-run command to clone a specific repo with the `rig` CLI:
 * `rig clone <relay-url> <owner>/<repo-id>`. Mirrors GitHub's clone box — just
 * the clone command, one copyable line (the `rig` install is covered by the
 * CLI docs link in the popover, not baked into the copied command).
 *
 * Cloning is entirely FREE — it reads the kind:30617/30618 state from the
 * relay and pulls objects from Arweave gateways; no payment, channel, or
 * funded identity is involved. The clone also writes the repo's `toon.*` git
 * config and adds the relay as `origin`, so `rig fetch` / `rig push` work from
 * the cloned folder immediately (that later push is the paid path).
 *
 * The owner + relay come from safe charsets (hex/npub pubkey, ws(s):// URL),
 * but `repoId` is attacker-publishable, so the whole `<owner>/<repo-id>`
 * argument is `shellQuote`d as one token to keep a hostile `d` tag from
 * smuggling extra shell words onto the paste (a stripped newline can never
 * become a second executable line).
 */
export function buildCloneCommand(
  repoId: string,
  ownerPubkey: string,
  relayUrl: string,
): string {
  return `rig clone ${shellQuote(relayUrl)} ${shellQuote(`${ownerPubkey}/${repoId}`)}`;
}

/**
 * "Clone this repo" affordance: a compact GitHub-style popover with a copyable
 * `rig clone` command pre-filled from the repo's actual context (repoId from
 * the kind:30617 `d` tag, owner from the announcement pubkey, relay from the
 * rig's active relay config).
 *
 * This is the read path, so it's free and needs no identity — the popover is a
 * hand-off to the `rig` CLI on the reader's machine. No daemon probing or
 * payment happens from the browser. Modeled on GitHub's green "Code" button:
 * one clone command with a copy affordance.
 */
export function CloneInstructions({ metadata }: { metadata: RepoMetadata }) {
  const { relayUrl } = useRigConfig();
  const command = buildCloneCommand(metadata.repoId, metadata.ownerPubkey, relayUrl);

  const [copied, setCopied] = useState(false);
  const onCopy = useCallback(() => {
    const succeed = (): void => setCopied(true);
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(command).then(succeed, () => {
        // Permission policy blocked the async API — fall back to the legacy
        // command, which still copies from a restricted context.
        if (legacyCopy(command)) succeed();
      });
      return;
    }
    if (legacyCopy(command)) succeed();
  }, [command]);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="success" size="sm" className="gap-1.5">
          <Code2 aria-hidden="true" className="h-3.5 w-3.5" />
          Code
          <ChevronDown aria-hidden="true" className="ml-0.5 h-3 w-3 opacity-80" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[28rem] max-w-[calc(100vw-2rem)] p-4" align="end">
        <div className="space-y-3">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">Clone this repo</h3>
            <p className="text-xs text-muted-foreground">
              Reads on TOON are free — clone from your terminal with the{' '}
              <code className="font-mono">rig</code> CLI. No TOON identity needed.
            </p>
          </div>
          <div className="relative rounded-md border bg-muted/50">
            <pre className="overflow-x-auto p-3 pr-10 font-mono text-xs leading-relaxed">
              {command}
            </pre>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label={copied ? 'Copy clone command — copied' : 'Copy clone command'}
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
            The clone sets up <code className="font-mono">origin</code> for you, so{' '}
            <code className="font-mono">rig push</code> works from the folder afterwards
            (that write is paid). See the{' '}
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

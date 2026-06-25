/**
 * ConsentPrompt — the TRUSTED authorization surface for branch 3 (sandboxed
 * mcp-ui, low trust) of the NIP-on-TOON render trust gradient (toon-meta#58,
 * toon-client#90).
 *
 * ── The consent invariant ───────────────────────────────────────────────────
 * A sandboxed widget may only *request* an action; it may never *perform* one,
 * and it may never draw, style, or spoof the authorization UI. This component IS
 * that authorization UI. It is rendered by the trusted client OUTSIDE the
 * widget's iframe, using only the client's own audited primitives (`Button`,
 * `Badge`, `Separator`). It is non-themeable by construction:
 *
 *   1. Its ONLY input is a `ConsentRequest` from `@toon-protocol/client`, whose
 *      type has nowhere to carry styling/markup — only a tool name, plain
 *      arguments, and a client-fixed `trust: 'low'`.
 *   2. The tool name and arguments are rendered as TEXT (`{value}` /
 *      `JSON.stringify`), never as HTML — no `dangerouslySetInnerHTML`, ever.
 *   3. The grant/deny buttons and all chrome use fixed, client-owned classes;
 *      the widget supplies no className, style, color, or label.
 *
 * A widget that could paint this surface would collapse the whole trust gradient
 * to its lowest tier, so this file must never accept presentation input from
 * widget-controlled data. (See `consent.ts` in `@toon-protocol/client`.)
 */

import { type FC } from 'react';
import { type ConsentRequest, type ConsentDecision } from '@toon-protocol/client/render';
import { Button } from '@/components/ui/button.js';
import { Badge } from '@/components/ui/badge.js';
import { Separator } from '@/components/ui/separator.js';

export interface ConsentPromptProps {
  /**
   * The request to authorize, built by the trusted client
   * (`buildConsentRequest`) from a widget intent. Carries no presentation data.
   */
  request: ConsentRequest;
  /** Resolve the prompt with the user's decision. */
  onResolve: (decision: ConsentDecision) => void;
}

/**
 * The host-rendered authorization prompt. Always drawn outside the widget
 * iframe, in fixed trusted chrome the widget cannot influence.
 */
export const ConsentPrompt: FC<ConsentPromptProps> = ({ request, onResolve }) => {
  // Render arguments as inspectable TEXT — never as markup. A widget cannot
  // inject HTML/script through them because they are stringified, not dangerously
  // set.
  const argsText = JSON.stringify(request.arguments, null, 2);

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Authorize action requested by an untrusted widget"
      data-consent-prompt
      data-trust={request.trust}
      // Fixed, client-owned chrome. No className/style is ever taken from the
      // widget — the props type cannot supply one.
      className="flex flex-col gap-3 rounded-lg border border-destructive/40 bg-card p-4 text-card-foreground shadow-sm"
    >
      <div className="flex items-center gap-2">
        <Badge variant="destructive" data-consent-trust-badge>
          untrusted widget
        </Badge>
        <span className="text-sm font-semibold">Authorize action</span>
      </div>

      <p className="text-sm text-muted-foreground">
        A sandboxed widget is requesting to run an action on your behalf. This
        prompt is drawn by your client — the widget cannot change how it looks.
      </p>

      <Separator />

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Tool</span>
        {/* Plain text, not markup. */}
        <code data-consent-tool className="rounded bg-muted px-1.5 py-0.5 text-xs">
          {request.toolName}
        </code>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Arguments</span>
        <pre
          data-consent-args
          className="max-h-40 overflow-auto rounded bg-muted px-2 py-1.5 text-xs whitespace-pre-wrap break-words"
        >
          {argsText}
        </pre>
      </div>

      <Separator />

      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          data-consent-deny
          onClick={() => onResolve('deny')}
        >
          Deny
        </Button>
        <Button
          variant="destructive"
          size="sm"
          data-consent-grant
          onClick={() => onResolve('grant')}
        >
          Authorize
        </Button>
      </div>
    </div>
  );
};

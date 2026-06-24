/**
 * SandboxedAppRenderer — branch 3 of the NIP-on-TOON render trust gradient
 * (sandboxed mcp-ui, LOW trust). toon-meta#58, toon-client#90.
 *
 * Renders an untrusted raw widget (the `kind:31036` renderer's HTML, carried as
 * a `UIResource` with `m: text/html;profile=mcp-app`) inside a hardened,
 * sandboxed iframe via `@mcp-ui/client`'s `AppRenderer`. The widget may only
 * *request* actions over the mcp-ui bridge; this component enforces the consent
 * invariant by routing every requested action to a HOST-rendered, non-themeable
 * {@link ConsentPrompt} drawn OUTSIDE the iframe.
 *
 * Data flow of a widget-requested action:
 *
 *   widget (iframe)  --tools/call-->  AppRenderer.onCallTool   (this file)
 *        │                                   │
 *        │                          classifyIntent (trusted client)
 *        │                          ├─ 'auto'             → forward to onCallTool callback
 *        │                          └─ 'requires-consent' → render ConsentPrompt OUTSIDE
 *        │                                                   the iframe; await user
 *        │                                   ▼
 *        └──────── result / "denied" error ◄─┘  (widget NEVER performs the action)
 *
 * The widget cannot draw, style, suppress, or auto-approve the prompt: the
 * prompt is React state owned by THIS component, rendered with the client's own
 * audited primitives, and its only data input (`ConsentRequest`) carries no
 * presentation fields. See `ConsentPrompt.tsx` and `consent.ts`.
 */

import { useCallback, useState, type FC } from 'react';
import { AppRenderer } from '@mcp-ui/client';
import type { CallToolRequest, CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  buildConsentRequest,
  classifyIntent,
  type ConsentDecision,
  type ConsentRequest,
  type UiResource,
} from '@toon-protocol/client';
import { ConsentPrompt } from './ConsentPrompt.js';
import { assertSafeSandbox, BRANCH3_SANDBOX_PERMISSIONS } from './sandbox.js';

/** A host callback that actually performs an authorized tool call. */
export type PerformTool = (
  toolName: string,
  args: Record<string, unknown>
) => Promise<CallToolResult>;

export interface SandboxedAppRendererProps {
  /**
   * The untrusted widget to render, extracted from the branch-3 `kind:31036`
   * renderer by `@toon-protocol/client`'s `extractUiResource`.
   */
  resource: UiResource;
  /**
   * URL of the mcp-ui sandbox proxy HTML. Required by `@mcp-ui/client`'s
   * `AppRenderer` so the widget runs in an opaque, cross-origin frame.
   */
  sandboxUrl: URL;
  /** Logical tool name for the rendered widget (mcp-ui bookkeeping). */
  toolName?: string;
  /**
   * Perform an AUTHORIZED tool call. Invoked only after the consent gate passes
   * (auto-forward for read-only tools, or an explicit user grant otherwise).
   * Wire this to the trusted client's tool runner.
   */
  onPerform: PerformTool;
}

/** A pending consent decision, with the resolver that settles the iframe's call. */
interface PendingConsent {
  request: ConsentRequest;
  resolve: (decision: ConsentDecision) => void;
}

/** A `CallToolResult` representing a host-side denial (the widget never acts). */
function deniedResult(toolName: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `Action "${toolName}" was not authorized by the user.` }],
  };
}

export const SandboxedAppRenderer: FC<SandboxedAppRendererProps> = ({
  resource,
  sandboxUrl,
  toolName = 'mcp-app-widget',
  onPerform,
}) => {
  const [pending, setPending] = useState<PendingConsent | null>(null);

  // Belt-and-braces: never render with a sandbox that re-enables an escape token.
  assertSafeSandbox(BRANCH3_SANDBOX_PERMISSIONS);

  /**
   * The iframe → host intent channel. `@mcp-ui/client` calls this for every
   * `tools/call` the widget requests. We classify it; auto-forward read-only
   * intents; and for everything else render the host consent prompt and await
   * the user's decision before performing (or denying) the action.
   */
  const onCallTool = useCallback(
    async (params: CallToolRequest['params']): Promise<CallToolResult> => {
      const intent = {
        toolName: params.name,
        arguments: (params.arguments ?? {}) as Record<string, unknown>,
      };

      if (classifyIntent(intent) === 'auto') {
        return onPerform(intent.toolName, intent.arguments);
      }

      // requires-consent: surface a HOST-rendered prompt outside the iframe and
      // block on the user's decision. The widget cannot resolve this itself.
      const decision = await new Promise<ConsentDecision>((resolve) => {
        setPending({ request: buildConsentRequest(intent), resolve });
      });
      setPending(null);

      if (decision !== 'grant') return deniedResult(intent.toolName);
      return onPerform(intent.toolName, intent.arguments);
    },
    [onPerform]
  );

  return (
    <div data-branch="mcp-ui" data-trust="low" className="flex flex-col gap-3">
      {/*
        The untrusted widget. The hardened sandbox (no allow-same-origin) keeps
        it in an opaque origin so it can never reach the host DOM / the consent
        prompt below.
      */}
      <AppRenderer
        toolName={toolName}
        html={resource.html}
        sandbox={{ url: sandboxUrl, permissions: BRANCH3_SANDBOX_PERMISSIONS }}
        onCallTool={onCallTool}
        // Open-link requests are likewise just *requests*; deny by default —
        // the widget cannot navigate the host.
        onOpenLink={async () => ({})}
      />

      {/*
        The TRUSTED authorization surface — drawn here, OUTSIDE the iframe, only
        while a decision is pending. The widget has no handle to this subtree.
      */}
      {pending !== null && (
        <ConsentPrompt request={pending.request} onResolve={pending.resolve} />
      )}
    </div>
  );
};

/**
 * Branch 4 — generative fallback + optional `kind:31036` publish-back.
 *
 * Implements §"branch 4 — generative fallback" of the NIP-on-TOON render-side
 * spec (`skills/nip-on-toon-discovery/SKILL.md` in toon-meta) and
 * toon-protocol/toon-client#92.
 *
 * Branch 4 is reached by {@link renderDispatch} when a kind is **unknown** *and*
 * no resolvable `kind:31036` renderer exists (no `ui` tag, or nothing resolves,
 * or the resolved renderer carries no recognised `m` tag). With nothing else to
 * go on, the client generates a best-effort rendering for the unknown event's
 * shape at **low trust**.
 *
 * Design seams (per the issue's `needs:human` open questions — the model, the
 * curation policy, and the publish-back opt-in semantics are product decisions
 * the host owns, so this module hardcodes none of them):
 *
 *  - **Generator** ({@link RendererGenerator}) — the actual model call is
 *    abstracted behind an interface the host injects. The host wires its own
 *    provider/keys/prompt; this module never imports an LLM SDK. A deterministic
 *    non-LLM generator ({@link deterministicGenerator}) is provided as the
 *    default and for tests, so branch 4 always produces *something* renderable
 *    even with no model configured.
 *  - **Publish-back** — optionally republish the generated renderer as a
 *    `kind:31036` addressable event so the next client has a "known" renderer
 *    for that kind (branch 4 slowly feeds branch 1). This is a **guarded,
 *    off-by-default** capability: it only fires when the host explicitly passes
 *    `publish: { enabled: true, ... }`. The published renderer is clearly
 *    low-trust / curation-pending; the namespacing & curation policy for
 *    community-published renderers is an open question in the epic (toon#58) and
 *    is intentionally *not* built here.
 */

import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { MIME_MCP_APP, UI_RENDERER_KIND, buildUiCoordinate } from './constants.js';

/**
 * A generated renderer for an unknown event kind: an HTML `UIResource`-style
 * document plus the `m` (mimeType) tag that classifies it.
 *
 * The HTML is the raw widget body; if published back as a `kind:31036` event it
 * is rendered through branch 3 (sandboxed mcp-ui iframe) by a downstream client,
 * which is why {@link mimeType} defaults to the branch-3 selector.
 */
export interface GeneratedRenderer {
  /** The generated HTML document (the `UIResource` body). */
  html: string;
  /**
   * The `m` (mimeType) tag for the generated renderer. Defaults to
   * {@link MIME_MCP_APP} (`text/html;profile=mcp-app`) so a published renderer
   * routes through branch 3 (sandboxed, low trust) on the next client.
   */
  mimeType: string;
  /**
   * Whether this rendering came from a model (`'model'`) or the built-in
   * deterministic fallback (`'deterministic'`). Surfaced so the host can label
   * trust/provenance in the UI.
   */
  source: 'model' | 'deterministic';
}

/** Context handed to a {@link RendererGenerator}. */
export interface GenerateContext {
  /** The unknown event the client wants to render. */
  event: NostrEvent;
}

/**
 * The pluggable generator seam. A host injects its own implementation (wired to
 * whatever model endpoint, key, and prompt it has chosen — all `needs:human`
 * product decisions this module deliberately does not own).
 *
 * Implementations should be best-effort and resilient: a failed model call
 * should reject so {@link GenerativeFallbackRenderer} can fall back to the
 * deterministic generator rather than render nothing.
 */
export interface RendererGenerator {
  generate(ctx: GenerateContext): Promise<GeneratedRenderer>;
}

/** Minimal HTML-escape for embedding event data in the deterministic template. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A deterministic, non-LLM generator: renders a best-effort, dependency-free
 * "unknown kind" card from the event's shape (kind, author, tags, content). It
 * never calls a network or a model, so it is the safe default and the basis for
 * tests — given the same event it always produces the same HTML.
 *
 * The output is intentionally generic and clearly marked as a low-trust
 * fallback; it makes no claim to understand the kind's semantics.
 */
export const deterministicGenerator: RendererGenerator = {
  async generate({ event }: GenerateContext): Promise<GeneratedRenderer> {
    return { html: renderDeterministicHtml(event), mimeType: MIME_MCP_APP, source: 'deterministic' };
  },
};

/**
 * The pure HTML projection used by {@link deterministicGenerator}. Exported so
 * tests (and hosts wanting the fallback body without the Promise wrapper) can
 * assert on it directly.
 */
export function renderDeterministicHtml(event: NostrEvent): string {
  const rows = event.tags
    .filter((t) => t[0] !== undefined)
    .map(
      (t) =>
        `<tr><th>${escapeHtml(String(t[0]))}</th><td>${escapeHtml(t.slice(1).join(' '))}</td></tr>`
    )
    .join('');
  const content = event.content ? escapeHtml(event.content) : '<em>(no content)</em>';
  return [
    '<!doctype html>',
    '<section data-toon-fallback="generative" data-trust="low">',
    `<header><h1>Unknown event</h1><p>kind <code>${event.kind}</code></p></header>`,
    `<p class="toon-fallback-note">No renderer was found for this kind. This is a best-effort, low-trust fallback rendering of the event's raw shape.</p>`,
    `<dl><dt>author</dt><dd><code>${escapeHtml(event.pubkey)}</code></dd>`,
    `<dt>id</dt><dd><code>${escapeHtml(event.id)}</code></dd></dl>`,
    `<div class="toon-fallback-content">${content}</div>`,
    rows ? `<table class="toon-fallback-tags"><tbody>${rows}</tbody></table>` : '',
    '</section>',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Host-supplied signer seam used to finalize the publish-back event. */
export interface RendererSigner {
  /** The author pubkey (hex) the renderer is published under (the coordinate author). */
  getPublicKey(): string;
  /** Finalize an unsigned event template into a signed `NostrEvent`. */
  signEvent(template: EventTemplate): NostrEvent;
}

/** Host-supplied publisher seam used to broadcast the publish-back event. */
export interface RendererPublisher {
  publishEvent(event: NostrEvent): Promise<unknown>;
}

/**
 * Publish-back configuration. **Off by default**: publish-back never happens
 * unless the host passes this object with `enabled: true` *and* supplies a
 * signer and publisher. This is the explicit-enablement gate the issue requires
 * — there is no implicit / always-on publish path.
 */
export interface PublishBackOptions {
  /** Master switch. Must be `true` for any publish to occur. */
  enabled: boolean;
  /** Signs the `kind:31036` event (also supplies the coordinate author pubkey). */
  signer: RendererSigner;
  /** Broadcasts the signed event. */
  publisher: RendererPublisher;
}

/** Options for {@link GenerativeFallbackRenderer}. */
export interface GenerativeFallbackOptions {
  /**
   * The generator to use. Defaults to {@link deterministicGenerator}. A host
   * injects its model-backed generator here.
   */
  generator?: RendererGenerator;
  /**
   * Publish-back config. Omit (or pass `enabled: false`) to keep publish-back
   * off — the default. See {@link PublishBackOptions}.
   */
  publish?: PublishBackOptions;
}

/** The outcome of {@link GenerativeFallbackRenderer.render}. */
export interface GenerativeFallbackResult {
  /** The generated renderer (model output, or the deterministic fallback). */
  rendered: GeneratedRenderer;
  /** Always `'low'` — branch 4 is a low-trust path. */
  trust: 'low';
  /**
   * The signed `kind:31036` event that was published back, or `undefined` when
   * publish-back was disabled (the default) or could not run.
   */
  published?: NostrEvent;
}

/**
 * Build the unsigned `kind:31036` renderer event for a generated renderer. The
 * `d` tag is the target kind; the `m` tag is the renderer's mimeType; the body
 * is the generated HTML. The signed event's coordinate is
 * `31036:<author-pubkey>:<targetKind>` (see {@link buildUiCoordinate}).
 *
 * Exported for tests / hosts that want to inspect the event before signing.
 */
export function buildRendererEventTemplate(
  targetKind: number,
  rendered: GeneratedRenderer
): EventTemplate {
  return {
    kind: UI_RENDERER_KIND,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['d', String(targetKind)],
      ['m', rendered.mimeType],
      // Self-describing, curation-pending marker. The full curation/namespacing
      // policy for community-published renderers is an open epic question
      // (toon#58) and is intentionally not modelled here.
      ['t', 'generative-fallback'],
    ],
    content: rendered.html,
  };
}

/**
 * Branch 4 renderer: generate a best-effort rendering for an unknown event and,
 * if explicitly enabled, publish it back as a `kind:31036` renderer.
 *
 * Generation is resilient: if the injected model generator throws, the renderer
 * transparently falls back to {@link deterministicGenerator} so a rendering is
 * always produced.
 */
export class GenerativeFallbackRenderer {
  private readonly generator: RendererGenerator;
  private readonly publish?: PublishBackOptions;

  constructor(options: GenerativeFallbackOptions = {}) {
    this.generator = options.generator ?? deterministicGenerator;
    this.publish = options.publish;
  }

  /**
   * Generate a fallback rendering for `event` (low trust), optionally publishing
   * the result back as a `kind:31036` renderer when publish-back is enabled.
   */
  async render(event: NostrEvent): Promise<GenerativeFallbackResult> {
    let rendered: GeneratedRenderer;
    try {
      rendered = await this.generator.generate({ event });
    } catch {
      // Model call failed → never render nothing; use the deterministic fallback.
      rendered = await deterministicGenerator.generate({ event });
    }

    const result: GenerativeFallbackResult = { rendered, trust: 'low' };

    // Publish-back gate: only when explicitly enabled with a signer + publisher.
    if (this.publish?.enabled && this.publish.signer && this.publish.publisher) {
      const template = buildRendererEventTemplate(event.kind, rendered);
      const signed = this.publish.signer.signEvent(template);
      await this.publish.publisher.publishEvent(signed);
      result.published = signed;
    }

    return result;
  }

  /** Whether publish-back is currently enabled (for host introspection/UI). */
  get publishBackEnabled(): boolean {
    return this.publish?.enabled === true;
  }
}

/**
 * The coordinate (`31036:<author-pubkey>:<targetKind>`) a publish-back will/did
 * use for `targetKind` under `signer`'s identity. Convenience for hosts that
 * want to show or pre-resolve the coordinate.
 *
 * Throws if the signer's pubkey or `targetKind` is malformed — core's
 * {@link buildUiCoordinate} returns `null` for invalid inputs, which here can
 * only mean the host wired a bad signer.
 */
export function publishBackCoordinate(signer: RendererSigner, targetKind: number): string {
  const coord = buildUiCoordinate({ pubkey: signer.getPublicKey(), targetKind });
  if (coord === null) {
    throw new Error(
      `publishBackCoordinate: invalid renderer coordinate for pubkey=${signer.getPublicKey()} targetKind=${targetKind}`
    );
  }
  return coord;
}

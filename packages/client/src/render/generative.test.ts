import { describe, it, expect, vi } from 'vitest';
import type { NostrEvent, EventTemplate } from 'nostr-tools/pure';
import { renderDispatch } from './dispatch.js';
import { KindRegistry } from './KindRegistry.js';
import { MIME_MCP_APP, UI_RENDERER_KIND, buildUiCoordinate } from './constants.js';
import {
  GenerativeFallbackRenderer,
  deterministicGenerator,
  renderDeterministicHtml,
  buildRendererEventTemplate,
  publishBackCoordinate,
  type GeneratedRenderer,
  type RendererGenerator,
  type RendererSigner,
  type RendererPublisher,
} from './generative.js';

/** Minimal signed-event shape; only kind/tags/content matter for branch 4. */
function makeEvent(kind: number, tags: string[][] = [], content = ''): NostrEvent {
  return {
    id: 'id'.padEnd(64, '0'),
    pubkey: 'pk'.padEnd(64, 'a'),
    created_at: 1_700_000_000,
    kind,
    tags,
    content,
    sig: 'sig'.padEnd(128, '0'),
  };
}

// A fake signer that records the template and returns a deterministic signed event.
function makeSigner(pubkey = 'ab'.repeat(32)): RendererSigner & { signed?: EventTemplate } {
  const s: RendererSigner & { signed?: EventTemplate } = {
    getPublicKey: () => pubkey,
    signEvent(template: EventTemplate): NostrEvent {
      s.signed = template;
      return {
        ...template,
        id: 'rid'.padEnd(64, '0'),
        pubkey,
        sig: 'rsig'.padEnd(128, '0'),
      };
    },
  };
  return s;
}

describe('branch 4 selection via renderDispatch', () => {
  const registry = new KindRegistry<{ name: string }>().register(1, { name: 'NoteCard' });

  it('routes an unknown kind with no renderer to the generative branch', () => {
    const decision = renderDispatch({ event: makeEvent(9999) }, registry);
    expect(decision.branch).toBe('generative');
    expect(decision.trust).toBe('low');
  });
});

describe('deterministicGenerator', () => {
  it('renders an unknown event into a low-trust HTML fallback (deterministic)', async () => {
    const event = makeEvent(9999, [['title', 'Hi']], 'hello');
    const out = await deterministicGenerator.generate({ event });
    expect(out.source).toBe('deterministic');
    expect(out.mimeType).toBe(MIME_MCP_APP);
    expect(out.html).toContain('Unknown event');
    expect(out.html).toContain('9999');
    expect(out.html).toContain('hello');
    expect(out.html).toContain('data-trust="low"');
    // Same event in → same HTML out (deterministic).
    expect(out.html).toBe((await deterministicGenerator.generate({ event })).html);
  });

  it('escapes event content (no HTML injection from untrusted data)', () => {
    const html = renderDeterministicHtml(makeEvent(9999, [], '<script>x</script>'));
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('handles an event with no content', () => {
    expect(renderDeterministicHtml(makeEvent(9999))).toContain('(no content)');
  });
});

describe('GenerativeFallbackRenderer', () => {
  it('defaults to the deterministic generator when none is injected', async () => {
    const r = new GenerativeFallbackRenderer();
    const result = await r.render(makeEvent(9999));
    expect(result.trust).toBe('low');
    expect(result.rendered.source).toBe('deterministic');
    expect(result.published).toBeUndefined();
  });

  it('uses an injected model generator when provided', async () => {
    const gen: RendererGenerator = {
      generate: async (): Promise<GeneratedRenderer> => ({
        html: '<p>model output</p>',
        mimeType: MIME_MCP_APP,
        source: 'model',
      }),
    };
    const result = await new GenerativeFallbackRenderer({ generator: gen }).render(makeEvent(9999));
    expect(result.rendered.source).toBe('model');
    expect(result.rendered.html).toBe('<p>model output</p>');
  });

  it('falls back to the deterministic generator if the model generator throws', async () => {
    const gen: RendererGenerator = {
      generate: async () => {
        throw new Error('model down');
      },
    };
    const result = await new GenerativeFallbackRenderer({ generator: gen }).render(makeEvent(9999));
    expect(result.rendered.source).toBe('deterministic');
    expect(result.rendered.html).toContain('Unknown event');
  });
});

describe('publish-back gating', () => {
  it('is OFF by default — never signs or publishes', async () => {
    const signer = makeSigner();
    const publisher: RendererPublisher = { publishEvent: vi.fn(async () => undefined) };
    const r = new GenerativeFallbackRenderer();
    const result = await r.render(makeEvent(9999));
    expect(r.publishBackEnabled).toBe(false);
    expect(result.published).toBeUndefined();
    expect(publisher.publishEvent).not.toHaveBeenCalled();
    expect(signer.signed).toBeUndefined();
  });

  it('does NOT publish when enabled is false even with signer + publisher present', async () => {
    const publisher: RendererPublisher = { publishEvent: vi.fn(async () => undefined) };
    const r = new GenerativeFallbackRenderer({
      publish: { enabled: false, signer: makeSigner(), publisher },
    });
    const result = await r.render(makeEvent(9999));
    expect(result.published).toBeUndefined();
    expect(publisher.publishEvent).not.toHaveBeenCalled();
  });

  it('publishes a well-formed kind:31036 only when explicitly enabled', async () => {
    const author = 'ab'.repeat(32);
    const signer = makeSigner(author);
    const publishEvent = vi.fn(async () => undefined);
    const publisher: RendererPublisher = { publishEvent };
    const r = new GenerativeFallbackRenderer({
      publish: { enabled: true, signer, publisher },
    });
    expect(r.publishBackEnabled).toBe(true);

    const result = await r.render(makeEvent(9999));

    expect(publishEvent).toHaveBeenCalledTimes(1);
    const published = result.published;
    expect(published).toBeDefined();
    if (!published) throw new Error('expected published event');
    expect(published.kind).toBe(UI_RENDERER_KIND);
    // d tag = target kind; m tag = renderer mimeType.
    expect(published.tags).toContainEqual(['d', '9999']);
    expect(published.tags).toContainEqual(['m', MIME_MCP_APP]);
    expect(published.tags).toContainEqual(['t', 'generative-fallback']);
    expect(published.content).toBe(result.rendered.html);
    // Author = the publishing client's identity → coordinate is well-formed.
    expect(published.pubkey).toBe(author);
    expect(publishBackCoordinate(signer, 9999)).toBe(
      buildUiCoordinate({ pubkey: author, targetKind: 9999 })
    );
    expect(buildUiCoordinate({ pubkey: author, targetKind: 9999 })).toBe(
      `${UI_RENDERER_KIND}:${author}:9999`
    );
  });

  it('buildRendererEventTemplate produces the right kind/tags/content', () => {
    const rendered: GeneratedRenderer = {
      html: '<p>x</p>',
      mimeType: MIME_MCP_APP,
      source: 'deterministic',
    };
    const tpl = buildRendererEventTemplate(42, rendered);
    expect(tpl.kind).toBe(UI_RENDERER_KIND);
    expect(tpl.content).toBe('<p>x</p>');
    expect(tpl.tags).toContainEqual(['d', '42']);
    expect(tpl.tags).toContainEqual(['m', MIME_MCP_APP]);
  });
});

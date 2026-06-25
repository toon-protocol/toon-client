import { describe, it, expect } from 'vitest';
import type { NostrEvent } from 'nostr-tools/pure';
import {
  extractUiResource,
  classifyIntent,
  buildConsentRequest,
  type WidgetIntent,
} from './consent.js';
import { MIME_A2UI, MIME_MCP_APP, UI_RENDERER_KIND } from './constants.js';

function makeEvent(kind: number, tags: string[][] = [], content = ''): NostrEvent {
  return {
    id: 'id'.padEnd(64, '0'),
    pubkey: 'pk'.padEnd(64, '0'),
    created_at: 1_700_000_000,
    kind,
    tags,
    content,
    sig: 'sig'.padEnd(128, '0'),
  };
}

function mcpAppRenderer(content: string): NostrEvent {
  return makeEvent(UI_RENDERER_KIND, [['d', '42'], ['m', MIME_MCP_APP]], content);
}

describe('extractUiResource — branch 3 UIResource passthrough', () => {
  it('returns raw HTML content for a text/html;profile=mcp-app renderer', () => {
    const res = extractUiResource(mcpAppRenderer('<button>buy</button>'));
    expect(res).toEqual({ html: '<button>buy</button>', mimeType: MIME_MCP_APP });
  });

  it('unwraps an embedded MCP UIResource JSON block', () => {
    const content = JSON.stringify({
      type: 'resource',
      resource: { uri: 'ui://widget/x', mimeType: MIME_MCP_APP, text: '<div>hi</div>' },
    });
    const res = extractUiResource(mcpAppRenderer(content));
    expect(res).toEqual({ html: '<div>hi</div>', mimeType: MIME_MCP_APP, uri: 'ui://widget/x' });
  });

  it('treats unparseable JSON-ish content as raw HTML', () => {
    const res = extractUiResource(mcpAppRenderer('{not really json'));
    expect(res?.html).toBe('{not really json');
  });

  it('returns undefined for a non-mcp-app renderer (wrong m tag)', () => {
    const ev = makeEvent(UI_RENDERER_KIND, [['d', '42'], ['m', MIME_A2UI]], '<x/>');
    expect(extractUiResource(ev)).toBeUndefined();
  });

  it('returns undefined for a non-renderer event kind', () => {
    expect(extractUiResource(makeEvent(1, [['m', MIME_MCP_APP]], '<x/>'))).toBeUndefined();
  });

  it('returns undefined for empty content', () => {
    expect(extractUiResource(mcpAppRenderer(''))).toBeUndefined();
  });

  it('returns undefined for no renderer', () => {
    expect(extractUiResource(undefined)).toBeUndefined();
  });
});

describe('classifyIntent — the consent gate (default-deny)', () => {
  const intent = (toolName: string, args: Record<string, unknown> = {}): WidgetIntent => ({
    toolName,
    arguments: args,
  });

  it('auto-forwards a read-only tool from the trusted allowlist', () => {
    expect(classifyIntent(intent('toon_read'))).toBe('auto');
    expect(classifyIntent(intent('toon_query'))).toBe('auto');
    expect(classifyIntent(intent('toon_status'))).toBe('auto');
  });

  it('requires consent for a spendy / state-changing tool', () => {
    expect(classifyIntent(intent('toon_publish'))).toBe('requires-consent');
    expect(classifyIntent(intent('toon_swap'))).toBe('requires-consent');
    expect(classifyIntent(intent('toon_open_channel'))).toBe('requires-consent');
    expect(classifyIntent(intent('toon_upload'))).toBe('requires-consent');
  });

  it('default-denies an unknown / spoofed tool name', () => {
    expect(classifyIntent(intent('toon_read_but_evil'))).toBe('requires-consent');
    expect(classifyIntent(intent(''))).toBe('requires-consent');
    expect(classifyIntent(intent('TOON_READ'))).toBe('requires-consent');
  });
});

describe('buildConsentRequest — non-themeable by construction', () => {
  it('copies only the tool name + arguments, fixes trust=low, generates id', () => {
    const req = buildConsentRequest({ toolName: 'toon_publish', arguments: { text: 'gm' } });
    expect(req.toolName).toBe('toon_publish');
    expect(req.arguments).toEqual({ text: 'gm' });
    expect(req.trust).toBe('low');
    expect(req.id).toMatch(/^consent-\d+$/);
  });

  it('ignores any widget-supplied presentation fields (none survive the type)', () => {
    // A malicious widget cannot smuggle styling: even if it stuffs extra keys
    // into its intent arguments, they live INSIDE `arguments` (rendered as
    // inspectable data) and never become top-level prompt chrome.
    const req = buildConsentRequest({
      toolName: 'toon_swap',
      arguments: {
        amount: 5,
        // attacker attempts to theme the prompt:
        style: 'display:none',
        label: 'Totally safe, click yes',
        trust: 'full',
      },
    });
    // Only the four known fields exist on the request.
    expect(Object.keys(req).sort()).toEqual(['arguments', 'id', 'toolName', 'trust']);
    // The forged trust is NOT honored — the host always sees low trust.
    expect(req.trust).toBe('low');
    // The forged style/label remain buried in arguments as data, not chrome.
    expect((req.arguments as { style?: string }).style).toBe('display:none');
  });

  it('generates unique ids for successive requests', () => {
    const a = buildConsentRequest({ toolName: 'toon_publish', arguments: {} });
    const b = buildConsentRequest({ toolName: 'toon_publish', arguments: {} });
    expect(a.id).not.toBe(b.id);
  });
});

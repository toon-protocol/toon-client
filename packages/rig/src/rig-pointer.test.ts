/**
 * Tests for the per-repo Rig pointer (stage-1 redirect shell): route
 * construction, HTML safety, and the determinism the content-addressed
 * skip in `rig push` relies on.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RIG_WEB_URL,
  generateRigPointerHtml,
  rigWebRoute,
  type RigPointerOptions,
} from './rig-pointer.js';

const NPUB = 'npub1me9xmmtap3xjgza6e8hsh0xe2rxv3haektma840yrf8p2z53qmeq65a5y6';

function options(overrides: Partial<RigPointerOptions> = {}): RigPointerOptions {
  return {
    rigWebUrl: DEFAULT_RIG_WEB_URL,
    relay: 'wss://relay-ws.devnet.toonprotocol.dev',
    ownerNpub: NPUB,
    repoId: 'hello-toon',
    ...overrides,
  };
}

describe('rigWebRoute', () => {
  it('builds the hash route rig-web understands, relay inside the fragment', () => {
    expect(rigWebRoute(options())).toBe(
      `${DEFAULT_RIG_WEB_URL}/#/${NPUB}/hello-toon` +
        '?relay=wss%3A%2F%2Frelay-ws.devnet.toonprotocol.dev'
    );
  });

  it('normalizes a trailing slash on the rig-web base', () => {
    const route = rigWebRoute(options({ rigWebUrl: `${DEFAULT_RIG_WEB_URL}/` }));
    expect(route.startsWith(`${DEFAULT_RIG_WEB_URL}/#/`)).toBe(true);
  });

  it('percent-encodes route segments', () => {
    const route = rigWebRoute(options({ repoId: 'a b/c' }));
    expect(route).toContain('/a%20b%2Fc?relay=');
  });
});

describe('generateRigPointerHtml', () => {
  it('is deterministic for identical inputs (content-addressing contract)', () => {
    expect(generateRigPointerHtml(options())).toBe(
      generateRigPointerHtml(options())
    );
    expect(generateRigPointerHtml(options())).not.toBe(
      generateRigPointerHtml(options({ relay: 'wss://other.example' }))
    );
  });

  it('redirects three ways: meta refresh, script, and a visible link', () => {
    const html = generateRigPointerHtml(options());
    const target = rigWebRoute(options());
    expect(html).toContain(`content="0; url=${target}"`);
    expect(html).toContain(`location.replace(${JSON.stringify(target)})`);
    expect(html).toContain(`<a href="${target}">`);
    expect(html).toContain('<title>hello-toon — Rig</title>');
  });

  it('neutralizes hostile input in both HTML and script positions', () => {
    const html = generateRigPointerHtml(
      options({ repoId: '</script><script>alert(1)' })
    );
    // Route segments are percent-encoded, so the payload never reaches the
    // markup raw in URL positions…
    expect(html).not.toContain('</script><script>alert(1)');
    expect(html).toContain('%3C%2Fscript%3E');
    // …and the title/link text entity-escapes it.
    expect(html).toContain('&lt;/script&gt;');
    // Defense-in-depth for the one non-encoded input (the operator-config
    // rig-web base URL): `<` is <-escaped in the script position.
    const hostileBase = generateRigPointerHtml(
      options({ rigWebUrl: 'https://x.example/</script>' })
    );
    expect(hostileBase).toContain('\\u003c');
    expect(hostileBase).not.toContain('replace("https://x.example/</script>');
  });

  it('is fully self-contained (no external asset loads to rot)', () => {
    const html = generateRigPointerHtml(options());
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
  });
});

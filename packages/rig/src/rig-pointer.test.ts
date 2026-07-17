/**
 * Tests for the per-repo Rig pointer (rig-lite boot-in-place shell): route
 * construction, config pinning, HTML safety, and the determinism the
 * content-addressed skip in `rig push` relies on.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RIG_LITE_TX,
  DEFAULT_RIG_WEB_URL,
  generateRigPointerHtml,
  rigWebRoute,
  type RigPointerOptions,
} from './rig-pointer.js';

const NPUB = 'npub1me9xmmtap3xjgza6e8hsh0xe2rxv3haektma840yrf8p2z53qmeq65a5y6';

function options(overrides: Partial<RigPointerOptions> = {}): RigPointerOptions {
  return {
    rigLiteTx: DEFAULT_RIG_LITE_TX,
    gateway: 'https://arweave.net',
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
    expect(generateRigPointerHtml(options())).not.toBe(
      generateRigPointerHtml(options({ rigLiteTx: 'B'.repeat(43) }))
    );
  });

  it('boots rig-lite in place: pinned config + immutable module script', () => {
    const html = generateRigPointerHtml(options());
    expect(html).toContain(
      `window.__RIG_CONFIG__={"relay":"wss://relay-ws.devnet.toonprotocol.dev","owner":"${NPUB}","repo":"hello-toon"}`
    );
    expect(html).toContain(
      `<script type="module" src="https://arweave.net/${DEFAULT_RIG_LITE_TX}"></script>`
    );
    expect(html).toContain('<title>hello-toon — Rig</title>');
    // No redirect — the pointer renders from Arweave in place.
    expect(html).not.toContain('http-equiv="refresh"');
    expect(html).not.toContain('location.replace');
  });

  it('degrades to a full-Rig link (noscript + delayed fallback)', () => {
    const html = generateRigPointerHtml(options());
    const fullRig = rigWebRoute(options());
    expect(html).toContain('<noscript>');
    expect(html).toContain(`href="${fullRig}"`);
    expect(html).toContain('data-fallback');
  });

  it('neutralizes hostile input in HTML and script positions', () => {
    const html = generateRigPointerHtml(
      options({ repoId: '</script><script>alert(1)' })
    );
    // Script position: `<` escaped inside the JSON config string.
    expect(html).not.toContain('"repo":"</script>');
    expect(html).toContain('\\u003c');
    // HTML positions: entity-escaped title, percent-encoded route.
    expect(html).toContain('&lt;/script&gt;');
    expect(html).toContain('%3C%2Fscript%3E');
  });

  it('loads nothing external except the one immutable rig-lite module', () => {
    const html = generateRigPointerHtml(options());
    const srcs = [...html.matchAll(/src="([^"]+)"/g)].map((m) => m[1]);
    expect(srcs).toEqual([`https://arweave.net/${DEFAULT_RIG_LITE_TX}`]);
    expect(html).not.toMatch(/<link[^>]+href="https?:/);
  });
});

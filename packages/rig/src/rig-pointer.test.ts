/**
 * Tests for the per-repo Rig pointer (full-Rig boot-in-place shell): route
 * construction, config + hash-route pinning, HTML safety, and the
 * determinism the content-addressed skip in `rig push` relies on.
 */

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_RIG_WEB_BUNDLE,
  DEFAULT_RIG_WEB_URL,
  generateRigPointerHtml,
  repoHashRoute,
  rigWebRoute,
  type RigPointerOptions,
} from './rig-pointer.js';

const NPUB = 'npub1me9xmmtap3xjgza6e8hsh0xe2rxv3haektma840yrf8p2z53qmeq65a5y6';

function options(overrides: Partial<RigPointerOptions> = {}): RigPointerOptions {
  return {
    bundle: DEFAULT_RIG_WEB_BUNDLE,
    gateway: 'https://arweave.net',
    rigWebUrl: DEFAULT_RIG_WEB_URL,
    relay: 'wss://relay-ws.devnet.toonprotocol.dev',
    ownerNpub: NPUB,
    repoId: 'hello-toon',
    ...overrides,
  };
}

describe('repo routes', () => {
  it('builds the hash route rig-web understands, relay inside the fragment', () => {
    expect(repoHashRoute(options())).toBe(
      `#/${NPUB}/hello-toon?relay=wss%3A%2F%2Frelay-ws.devnet.toonprotocol.dev`
    );
    expect(rigWebRoute(options())).toBe(
      `${DEFAULT_RIG_WEB_URL}/${repoHashRoute(options())}`
    );
  });

  it('normalizes a trailing slash on the fallback base', () => {
    const route = rigWebRoute(options({ rigWebUrl: `${DEFAULT_RIG_WEB_URL}/` }));
    expect(route.startsWith(`${DEFAULT_RIG_WEB_URL}/#/`)).toBe(true);
  });

  it('percent-encodes route segments', () => {
    expect(repoHashRoute(options({ repoId: 'a b/c' }))).toContain(
      '/a%20b%2Fc?relay='
    );
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
      generateRigPointerHtml(
        options({
          bundle: { ...DEFAULT_RIG_WEB_BUNDLE, manifestTx: 'B'.repeat(43) },
        })
      )
    );
  });

  it('boots the full Rig in place: config, hash route, manifest css + entry module', () => {
    const html = generateRigPointerHtml(options());
    const base = `https://arweave.net/${DEFAULT_RIG_WEB_BUNDLE.manifestTx}`;
    expect(html).toContain(
      `window.__RIG_CONFIG__={"relay":"wss://relay-ws.devnet.toonprotocol.dev","owner":"${NPUB}","repo":"hello-toon"}`
    );
    // HashRouter route preset in the pointer's own fragment (rig-web routes
    // by hash; the config pins relay/filter, not the route).
    expect(html).toContain(`location.replace(${JSON.stringify(repoHashRoute(options()))})`);
    expect(html).toContain(
      `<link rel="stylesheet" href="${base}/${DEFAULT_RIG_WEB_BUNDLE.entryCss}">`
    );
    expect(html).toContain(
      `<script type="module" crossorigin src="${base}/${DEFAULT_RIG_WEB_BUNDLE.entryJs}"></script>`
    );
    // rig-web mounts into #app.
    expect(html).toContain('<div id="app"></div>');
    expect(html).not.toContain('http-equiv="refresh"');
  });

  it('degrades to a hosted-Rig link (noscript + delayed fallback)', () => {
    const html = generateRigPointerHtml(options());
    const fallback = rigWebRoute(options());
    expect(html).toContain('<noscript>');
    expect(html).toContain(`href="${fallback}"`);
    expect(html).toContain('data-fallback');
    // The sentinel checks the app mount, not the pointer's own markup.
    expect(html).toContain('getElementById("app")');
  });

  it('neutralizes hostile input in HTML and script positions', () => {
    const html = generateRigPointerHtml(
      options({ repoId: '</script><script>alert(1)' })
    );
    expect(html).not.toContain('"repo":"</script>');
    expect(html).toContain('\\u003c');
    expect(html).toContain('%3C%2Fscript%3E');
  });

  it('loads nothing external except the one immutable deployment', () => {
    const html = generateRigPointerHtml(options());
    const base = `https://arweave.net/${DEFAULT_RIG_WEB_BUNDLE.manifestTx}`;
    const srcs = [...html.matchAll(/(?:src|href)="(https?:[^"]+)"/g)].map(
      (m) => m[1]
    );
    // css + js from the manifest; the only other URL is the fallback link.
    expect(srcs).toEqual(
      expect.arrayContaining([
        `${base}/${DEFAULT_RIG_WEB_BUNDLE.entryCss}`,
        `${base}/${DEFAULT_RIG_WEB_BUNDLE.entryJs}`,
      ])
    );
    for (const src of srcs) {
      expect(
        src.startsWith(base) || src.startsWith(DEFAULT_RIG_WEB_URL)
      ).toBe(true);
    }
  });
});

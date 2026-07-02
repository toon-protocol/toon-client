// Tests for Rig-UI pointer HTML generation
// AC covered: AC6 (single-repo pointer), AC7 (relay-wide pointer), F7 (XSS prevention)

import { describe, it, expect } from 'vitest';

import { generatePointerHtml } from './rig-pointer-html.js';

const BASE_OPTS = {
  relay: 'wss://relay.example.com',
  rigTx: 'abc123def456',
  jsPath: 'assets/main-x1y2z3.js',
  cssPath: 'assets/style-a1b2c3.css',
};

describe('Rig-UI Pointer HTML Generation', () => {
  it('[P0] generates valid HTML with __RIG_CONFIG__ for relay-wide pointer', () => {
    const html = generatePointerHtml(BASE_OPTS);

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="utf-8">');
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('window.__RIG_CONFIG__=');
    expect(html).toContain('"relay":"wss://relay.example.com"');
    // No repo or owner in config
    expect(html).not.toContain('"repo"');
    expect(html).not.toContain('"owner"');
  });

  it('[P0] generates single-repo pointer with repo and owner in config', () => {
    const html = generatePointerHtml({
      ...BASE_OPTS,
      repo: 'my-project',
      owner: 'npub1abc',
    });

    expect(html).toContain('"repo":"my-project"');
    expect(html).toContain('"owner":"npub1abc"');
    expect(html).toContain('<title>my-project — Rig</title>');
  });

  it('[P0] relay-wide pointer title is just "Rig"', () => {
    const html = generatePointerHtml(BASE_OPTS);
    expect(html).toContain('<title>Rig</title>');
  });

  it('[P0] references canonical Rig-UI JS and CSS assets', () => {
    const html = generatePointerHtml(BASE_OPTS);

    expect(html).toContain(
      `src="https://ar-io.dev/${BASE_OPTS.rigTx}/${BASE_OPTS.jsPath}"`
    );
    expect(html).toContain(
      `href="https://ar-io.dev/${BASE_OPTS.rigTx}/${BASE_OPTS.cssPath}"`
    );
  });

  it('[P1] escapes < in relay URL to prevent </script> XSS breakout', () => {
    const html = generatePointerHtml({
      ...BASE_OPTS,
      // nosemgrep: javascript.lang.security.detect-insecure-websocket.detect-insecure-websocket
      relay: 'wss://evil</script><script>alert(1)//',
    });

    // The literal </script> must NOT appear in the output
    expect(html).not.toContain('</script><script>');
    // Instead < should be escaped as \u003c
    expect(html).toContain('\\u003c');
  });

  it('[P1] includes Content-Security-Policy meta tag', () => {
    const html = generatePointerHtml(BASE_OPTS);

    expect(html).toContain('Content-Security-Policy');
    expect(html).toContain("'unsafe-inline'");
    expect(html).toContain('https://ar-io.dev');
    expect(html).toContain('ws:');
    expect(html).toContain('wss:');
  });

  it('[P2] omits repo from config when not provided', () => {
    const html = generatePointerHtml({
      ...BASE_OPTS,
      repo: undefined,
      owner: undefined,
    });

    // Config should only have relay
    const configMatch = html.match(/window\.__RIG_CONFIG__=(\{[^}]+\})/);
    expect(configMatch).toBeTruthy();
    const config = JSON.parse(configMatch![1]);
    expect(config).toEqual({ relay: 'wss://relay.example.com' });
  });

  it('[P2] HTML is under 2KB for a typical pointer', () => {
    const html = generatePointerHtml(BASE_OPTS);
    const bytes = Buffer.from(html, 'utf-8').length;
    // Pointer includes CSP meta tag which adds ~300 bytes; still well under Arweave free tier (100KB)
    expect(bytes).toBeLessThan(2048);
  });
});

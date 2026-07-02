// @vitest-environment jsdom
// Unit tests for the boot-time #relay= fragment rewrite (issue #266):
// the documented bare `#relay=wss://…` collides with HashRouter (which
// owns the fragment) and blank-pages the app; normalizeRelayFragment
// rewrites it to the router-safe `#/?relay=…` before the router mounts.

import { describe, it, expect, afterEach } from 'vitest';

import {
  rewriteBareRelayFragment,
  normalizeRelayFragment,
} from './relay-fragment.js';

describe('rewriteBareRelayFragment', () => {
  it('[P1] rewrites the bare documented form #relay=… to #/?relay=…', () => {
    expect(rewriteBareRelayFragment('#relay=wss://relay.example')).toBe(
      '#/?relay=wss://relay.example',
    );
  });

  it('[P1] preserves URL-encoded relay values untouched', () => {
    expect(
      rewriteBareRelayFragment('#relay=wss%3A%2F%2Frelay.example%2Fws'),
    ).toBe('#/?relay=wss%3A%2F%2Frelay.example%2Fws');
  });

  it('[P2] preserves extra &-separated params after the relay value', () => {
    expect(
      rewriteBareRelayFragment('#relay=wss://relay.example&foo=bar'),
    ).toBe('#/?relay=wss://relay.example&foo=bar');
  });

  it('[P1] leaves the router-safe form #/?relay=… alone', () => {
    expect(
      rewriteBareRelayFragment('#/?relay=wss://relay.example'),
    ).toBeNull();
  });

  it('[P1] leaves ordinary route fragments alone', () => {
    expect(rewriteBareRelayFragment('#/')).toBeNull();
    expect(rewriteBareRelayFragment('#/owner/repo/issues')).toBeNull();
  });

  it('[P2] leaves an empty hash alone', () => {
    expect(rewriteBareRelayFragment('')).toBeNull();
  });

  it('[P2] rewrites an empty relay value so the index route still loads', () => {
    // `#relay=` with no value would otherwise be an unmatched route path;
    // after rewrite the config reader simply falls back to the default.
    expect(rewriteBareRelayFragment('#relay=')).toBe('#/?relay=');
  });

  it('[P2] does not rewrite malformed near-misses of the bare form', () => {
    expect(rewriteBareRelayFragment('#relay')).toBeNull();
    expect(rewriteBareRelayFragment('#relays=wss://x')).toBeNull();
    expect(rewriteBareRelayFragment('#Relay=wss://x')).toBeNull();
  });

  it('[P2] passes invalid relay values through for use-rig-config to reject', () => {
    // Validation (ws/wss scheme) is the config reader's job; the rewrite
    // only makes the fragment router-safe.
    expect(rewriteBareRelayFragment('#relay=https://not-a-ws')).toBe(
      '#/?relay=https://not-a-ws',
    );
  });
});

describe('normalizeRelayFragment', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/');
  });

  it('[P1] rewrites the location in place via history.replaceState', () => {
    window.history.replaceState(
      null,
      '',
      '/toon-client/#relay=wss://relay.example',
    );

    normalizeRelayFragment();

    expect(window.location.pathname).toBe('/toon-client/');
    expect(window.location.hash).toBe('#/?relay=wss://relay.example');
    // The config reader's matcher now finds the relay param.
    expect(window.location.hash.match(/[?&]relay=([^&]+)/)?.[1]).toBe(
      'wss://relay.example',
    );
  });

  it('[P1] does not add a history entry', () => {
    window.history.replaceState(null, '', '/#relay=wss://relay.example');
    const lengthBefore = window.history.length;

    normalizeRelayFragment();

    expect(window.history.length).toBe(lengthBefore);
  });

  it('[P2] preserves an existing query string alongside the fragment', () => {
    window.history.replaceState(
      null,
      '',
      '/app/?utm=x#relay=wss://relay.example',
    );

    normalizeRelayFragment();

    expect(window.location.search).toBe('?utm=x');
    expect(window.location.hash).toBe('#/?relay=wss://relay.example');
  });

  it('[P1] is a no-op for the router-safe form', () => {
    window.history.replaceState(null, '', '/#/?relay=wss://relay.example');

    normalizeRelayFragment();

    expect(window.location.hash).toBe('#/?relay=wss://relay.example');
  });

  it('[P1] is a no-op when there is no relay fragment', () => {
    window.history.replaceState(null, '', '/#/owner/repo');

    normalizeRelayFragment();

    expect(window.location.hash).toBe('#/owner/repo');
  });

  it('[P2] is a no-op for the legacy ?relay= query param', () => {
    window.history.replaceState(null, '', '/?relay=wss://relay.example');

    normalizeRelayFragment();

    expect(window.location.search).toBe('?relay=wss://relay.example');
    expect(window.location.hash).toBe('');
  });
});

// @vitest-environment jsdom
// Unit tests for the relay resolution order in use-rig-config (issue #266):
// injected __RIG_CONFIG__ > hash fragment `[?&]relay=` > legacy `?relay=`
// query param > VITE_DEFAULT_RELAY build-time default.

import { describe, it, expect, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';

import { RigConfigProvider, useRigConfig } from './use-rig-config.js';

const DEFAULT_RELAY = 'ws://localhost:7100';

function renderConfig() {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <RigConfigProvider>{children}</RigConfigProvider>
  );
  return renderHook(() => useRigConfig(), { wrapper }).result.current;
}

describe('useRigConfig relay resolution', () => {
  afterEach(() => {
    delete window.__RIG_CONFIG__;
    window.history.replaceState(null, '', '/');
  });

  it('[P1] reads the relay from the router-safe #/?relay= fragment', () => {
    window.history.replaceState(null, '', '/#/?relay=wss://relay.example');

    expect(renderConfig().relayUrl).toBe('wss://relay.example');
  });

  it('[P1] decodes URL-encoded relay values', () => {
    window.history.replaceState(
      null,
      '',
      '/#/?relay=wss%3A%2F%2Frelay.example%2Fws',
    );

    expect(renderConfig().relayUrl).toBe('wss://relay.example/ws');
  });

  it('[P1] reads the relay from the legacy ?relay= query param', () => {
    window.history.replaceState(null, '', '/?relay=wss://legacy.example#/');

    expect(renderConfig().relayUrl).toBe('wss://legacy.example');
  });

  it('[P2] prefers the hash fragment over the legacy query param', () => {
    window.history.replaceState(
      null,
      '',
      '/?relay=wss://legacy.example#/?relay=wss://hash.example',
    );

    expect(renderConfig().relayUrl).toBe('wss://hash.example');
  });

  it('[P1] falls back to the default when no relay param is present', () => {
    window.history.replaceState(null, '', '/#/owner/repo');

    expect(renderConfig().relayUrl).toBe(DEFAULT_RELAY);
  });

  it('[P2] rejects non-WebSocket relay values', () => {
    window.history.replaceState(null, '', '/#/?relay=https://not-a-ws');

    expect(renderConfig().relayUrl).toBe(DEFAULT_RELAY);
  });

  it('[P2] falls back to the default for an empty relay value', () => {
    // The boot rewrite turns a bare `#relay=` into `#/?relay=`; the
    // matcher requires a non-empty value, so the default applies.
    window.history.replaceState(null, '', '/#/?relay=');

    expect(renderConfig().relayUrl).toBe(DEFAULT_RELAY);
  });

  it('[P1] falls back to the default on malformed percent-encoding in the hash', () => {
    // A stray `%` (e.g. from a truncated link) makes decodeURIComponent
    // throw URIError; the provider must swallow it and use the default
    // instead of blank-paging the app during initial render.
    window.history.replaceState(null, '', '/#/?relay=wss://relay.example%');

    expect(renderConfig().relayUrl).toBe(DEFAULT_RELAY);
  });

  it('[P1] falls back to the default on malformed percent-encoding in the legacy query param', () => {
    window.history.replaceState(null, '', '/?relay=wss://relay.example%E0#/');

    expect(renderConfig().relayUrl).toBe(DEFAULT_RELAY);
  });

  it('[P2] injected __RIG_CONFIG__ wins over URL params', () => {
    window.__RIG_CONFIG__ = { relay: 'wss://injected.example' };
    window.history.replaceState(null, '', '/#/?relay=wss://hash.example');

    expect(renderConfig().relayUrl).toBe('wss://injected.example');
  });
});

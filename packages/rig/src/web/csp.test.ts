// Test ID: 8.6-UNIT-002
// AC covered: #2 (CSP for Arweave gateways)

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('CSP - 8.6-UNIT-002: Arweave gateway connect-src', () => {
  const html = readFileSync(resolve(__dirname, 'index.html'), 'utf-8');

  // Extract the CSP meta tag content
  const cspMatch = html.match(/content="([^"]*connect-src[^"]*)"/);
  const csp = cspMatch ? cspMatch[1] : '';

  it('[P1] CSP meta tag exists with connect-src directive', () => {
    expect(csp).toBeTruthy();
    expect(csp).toContain('connect-src');
  });

  it('[P1] CSP connect-src includes ar-io.dev', () => {
    expect(csp).toContain('https://ar-io.dev');
  });

  it('[P1] CSP connect-src includes arweave.net', () => {
    expect(csp).toContain('https://arweave.net');
  });

  it('[P1] CSP connect-src includes *.arweave.net wildcard', () => {
    expect(csp).toContain('https://*.arweave.net');
  });

  it('[P1] CSP connect-src includes permagate.io', () => {
    expect(csp).toContain('https://permagate.io');
  });

  it('[P1] CSP connect-src includes WebSocket protocols', () => {
    expect(csp).toContain('ws:');
    expect(csp).toContain('wss:');
  });
});

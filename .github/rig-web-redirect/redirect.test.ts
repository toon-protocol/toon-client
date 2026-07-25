// Verifies the permanent Pages redirect stub (index.html in this directory)
// still satisfies the contract that already-published Arweave rig pointers
// depend on forever: https://toon-protocol.github.io/toon-client/ must land
// on https://toon-protocol.github.io/rig/ with the URL fragment intact, and
// must work with JS disabled too. See toon-client#443.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(__dirname, 'index.html'), 'utf-8');
const TARGET = 'https://toon-protocol.github.io/rig/';

describe('rig-web Pages redirect stub', () => {
  it('redirects client-side by appending location.hash to the target origin', () => {
    const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(scriptMatch).not.toBeNull();
    const script = scriptMatch![1];
    expect(script).toContain(TARGET);
    expect(script).toContain('location.hash');
  });

  it('has a <noscript> fallback anchor pointing at the target', () => {
    const noscriptMatch = html.match(/<noscript>([\s\S]*?)<\/noscript>/);
    expect(noscriptMatch).not.toBeNull();
    const noscript = noscriptMatch![1];
    expect(noscript).toContain(`href="${TARGET}"`);
  });

  it('has a canonical link pointing at the target for the no-JS case', () => {
    expect(html).toContain(`<link rel="canonical" href="${TARGET}" />`);
  });

  it('documents that this stub is permanent because Arweave pointers embed it forever', () => {
    expect(html.toLowerCase()).toContain('arweave');
    expect(html.toLowerCase()).toContain('permanent');
  });
});

import { describe, it, expect } from 'vitest';
import {
  arweaveTxId,
  arweaveUrls,
  arweaveGatewayCandidates,
  ARWEAVE_GATEWAYS,
} from './gateways.js';

/** A syntactically valid 43-char base64url Arweave tx id. */
const TX = 'A'.repeat(40) + '_-z';

describe('arweaveTxId', () => {
  it('extracts from a path-style gateway URL', () => {
    expect(arweaveTxId(`https://arweave.net/${TX}`)).toBe(TX);
  });

  it('extracts from a path-style URL with a trailing sub-path', () => {
    expect(arweaveTxId(`https://arweave.net/${TX}/manifest`)).toBe(TX);
  });

  it('does NOT decode a sandbox subdomain (case-sensitive id, lower-cased host)', () => {
    expect(arweaveTxId(`https://${TX}.ar-io.dev/`)).toBeNull();
  });

  it('extracts from an ar:// URL', () => {
    expect(arweaveTxId(`ar://${TX}`)).toBe(TX);
  });

  it('returns null for a non-Arweave host even with a 43-char path segment', () => {
    expect(arweaveTxId(`https://cdn.example.com/${TX}`)).toBeNull();
  });

  it('returns null for an Arweave host without a valid tx id', () => {
    expect(arweaveTxId('https://arweave.net/graphql')).toBeNull();
  });

  it('returns null for a non-URL string', () => {
    expect(arweaveTxId('not a url')).toBeNull();
  });
});

describe('arweaveUrls', () => {
  it('returns ar.io primary with the other gateways as fallbacks', () => {
    const { url, fallbacks } = arweaveUrls(TX);
    expect(url).toBe(`https://ar-io.dev/${TX}`);
    expect(fallbacks).toEqual([
      `https://arweave.net/${TX}`,
      `https://permagate.io/${TX}`,
    ]);
  });

  it('honors a custom gateway list (primary first)', () => {
    const { url, fallbacks } = arweaveUrls(TX, [
      'https://my.gw',
      'https://backup.gw',
    ]);
    expect(url).toBe(`https://my.gw/${TX}`);
    expect(fallbacks).toEqual([`https://backup.gw/${TX}`]);
  });

  it('falls back to the default list when given an empty override', () => {
    expect(arweaveUrls(TX, []).url).toBe(`https://ar-io.dev/${TX}`);
  });
});

describe('arweaveGatewayCandidates', () => {
  it('expands an Arweave URL to the full gateway preference list, primary first', () => {
    const out = arweaveGatewayCandidates(`https://arweave.net/${TX}`);
    expect(out).toEqual(ARWEAVE_GATEWAYS.map((g) => `${g}/${TX}`));
    expect(out[0]).toBe(`https://ar-io.dev/${TX}`);
  });

  it('leaves a non-Arweave URL unchanged', () => {
    const url = 'https://cdn.example.com/pic.jpg';
    expect(arweaveGatewayCandidates(url)).toEqual([url]);
  });

  it('appends publisher fallbacks last, de-duplicated', () => {
    const out = arweaveGatewayCandidates(`https://arweave.net/${TX}`, [
      'https://mirror.example/x.png',
      `https://ar-io.dev/${TX}`, // already present → dropped
    ]);
    expect(out).toEqual([
      ...ARWEAVE_GATEWAYS.map((g) => `${g}/${TX}`),
      'https://mirror.example/x.png',
    ]);
  });

  it('honors a custom gateway list when expanding', () => {
    const out = arweaveGatewayCandidates(`https://arweave.net/${TX}`, [], [
      'https://my.gw',
    ]);
    expect(out).toEqual([`https://my.gw/${TX}`]);
  });
});

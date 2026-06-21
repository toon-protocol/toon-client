import { describe, it, expect } from 'vitest';
import {
  selectIlpTransport,
  readDiscoveredIlpPeer,
} from './selectIlpTransport.js';

describe('selectIlpTransport', () => {
  describe('one-shot consumers (needsDuplex: false)', () => {
    it('prefers HTTP when the peer advertises an httpEndpoint', () => {
      const choice = selectIlpTransport({
        btpEndpoint: 'ws://peer/btp',
        httpEndpoint: 'http://peer/ilp',
        supportsUpgrade: true,
      });
      expect(choice).toEqual({
        kind: 'http',
        httpEndpoint: 'http://peer/ilp',
        canUpgrade: true,
      });
    });

    it('falls back to BTP when no httpEndpoint is advertised', () => {
      const choice = selectIlpTransport({ btpEndpoint: 'ws://peer/btp' });
      expect(choice).toEqual({ kind: 'btp', btpEndpoint: 'ws://peer/btp' });
    });

    it('throws when the peer exposes no usable endpoint', () => {
      expect(() => selectIlpTransport({})).toThrow(/neither/i);
    });
  });

  describe('duplex consumers (needsDuplex: true)', () => {
    it('prefers a real BTP endpoint', () => {
      const choice = selectIlpTransport(
        { btpEndpoint: 'ws://peer/btp', httpEndpoint: 'http://peer/ilp' },
        { needsDuplex: true }
      );
      expect(choice).toEqual({ kind: 'btp', btpEndpoint: 'ws://peer/btp' });
    });

    it('uses http-upgradable when only httpEndpoint + supportsUpgrade', () => {
      const choice = selectIlpTransport(
        { httpEndpoint: 'http://peer/ilp', supportsUpgrade: true },
        { needsDuplex: true }
      );
      expect(choice).toEqual({
        kind: 'http-upgradable',
        httpEndpoint: 'http://peer/ilp',
      });
    });

    it('throws when only httpEndpoint but upgrade is unsupported', () => {
      expect(() =>
        selectIlpTransport(
          { httpEndpoint: 'http://peer/ilp', supportsUpgrade: false },
          { needsDuplex: true }
        )
      ).toThrow(/duplex/i);
    });
  });
});

describe('readDiscoveredIlpPeer', () => {
  it('reads the new toon PR #29 fields defensively', () => {
    const peerInfo = {
      ilpAddress: 'g.toon.alice',
      btpEndpoint: 'ws://peer/btp',
      httpEndpoint: 'http://peer/ilp',
      supportsUpgrade: true,
      // extra fields are ignored
      assetCode: 'USD',
    };
    expect(readDiscoveredIlpPeer(peerInfo)).toEqual({
      btpEndpoint: 'ws://peer/btp',
      httpEndpoint: 'http://peer/ilp',
      supportsUpgrade: true,
    });
  });

  it('omits absent discovery fields (pre-PR-#29 peer info)', () => {
    expect(readDiscoveredIlpPeer({ btpEndpoint: 'ws://peer/btp' })).toEqual({
      btpEndpoint: 'ws://peer/btp',
      httpEndpoint: undefined,
      supportsUpgrade: undefined,
    });
  });

  it('tolerates null / non-object input', () => {
    expect(readDiscoveredIlpPeer(null)).toEqual({
      btpEndpoint: undefined,
      httpEndpoint: undefined,
      supportsUpgrade: undefined,
    });
  });
});

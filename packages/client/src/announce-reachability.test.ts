import { describe, it, expect } from 'vitest';
import {
  ALLOW_LOOPBACK_PEERS_ENV,
  DEFAULT_ANNOUNCE_ENDPOINT_POLICY,
  announceEndpointPolicyFor,
  classifyEndpointZone,
  endpointHost,
  isAnnounceEndpointUsable,
  rejectedAnnounceEndpoint,
} from './announce-reachability.js';

describe('classifyEndpointZone', () => {
  it.each([
    ['ws://127.0.0.1:3401', 'loopback'],
    ['ws://127.13.9.2:3401', 'loopback'],
    ['http://localhost:8080/ilp', 'loopback'],
    ['ws://my-node.localhost:3000', 'loopback'],
    ['ws://[::1]:3000', 'loopback'],
    ['ws://0.0.0.0:3000', 'loopback'],
    ['ws://[::]:3000', 'loopback'],
    // The WHATWG URL parser rewrites `::ffff:127.0.0.1` to `::ffff:7f00:1`;
    // both spellings must land on the v4 semantics, not read as routable v6.
    ['ws://[::ffff:127.0.0.1]:3000', 'loopback'],
    ['ws://[::ffff:7f00:1]:3000', 'loopback'],
    ['ws://[::ffff:c0a8:132]:3000', 'private'],
    ['ws://169.254.10.4:3000', 'link-local'],
    ['http://169.254.169.254/latest/meta-data', 'link-local'],
    ['ws://[fe80::1]:3000', 'link-local'],
    ['ws://[FEBF::1]:3000', 'link-local'],
    ['ws://[FC00::1]:3000', 'private'],
    ['ws://10.0.0.4:3000', 'private'],
    ['ws://172.16.0.9:3000', 'private'],
    ['ws://172.31.255.1:3000', 'private'],
    ['ws://192.168.1.50:3000', 'private'],
    ['ws://100.101.102.103:3000', 'private'],
    ['ws://[fd00::1]:3000', 'private'],
    ['wss://relay-ws.devnet.toonprotocol.dev', 'routable'],
    ['ws://172.32.0.1:3000', 'routable'],
    ['ws://100.128.0.1:3000', 'routable'],
    ['ws://8.8.8.8:3000', 'routable'],
    ['', 'unparsable'],
  ])('%s → %s', (endpoint, zone) => {
    expect(classifyEndpointZone(endpoint)).toBe(zone);
  });

  it('reads a scheme-less host:port', () => {
    expect(classifyEndpointZone('127.0.0.1:3401')).toBe('loopback');
    expect(endpointHost('127.0.0.1:3401')).toBe('127.0.0.1');
  });

  it('lowercases and strips a trailing root dot', () => {
    expect(endpointHost('wss://Relay.Example.COM./x')).toBe(
      'relay.example.com'
    );
  });

  it('does not resolve DNS — a name that points at loopback still reads routable', () => {
    // Deliberate: this filter defends against addresses whose MEANING is
    // reader-relative, not against every way to name the local machine.
    expect(classifyEndpointZone('ws://loopback.example.com:3401')).toBe(
      'routable'
    );
  });
});

describe('the default policy', () => {
  it('refuses loopback and link-local but admits private ranges', () => {
    expect(DEFAULT_ANNOUNCE_ENDPOINT_POLICY).toEqual({
      allowLoopback: false,
      allowLinkLocal: false,
      allowPrivate: true,
    });
  });

  it('refuses the live devnet ghost maker, naming the host and the escape hatch', () => {
    const rejected = rejectedAnnounceEndpoint('ws://127.0.0.1:3401');
    expect(rejected).toBeDefined();
    expect(rejected?.zone).toBe('loopback');
    expect(rejected?.host).toBe('127.0.0.1');
    expect(rejected?.reason).toContain('ws://127.0.0.1:3401');
    expect(rejected?.reason).toContain('THIS machine');
    expect(rejected?.reason).toContain(ALLOW_LOOPBACK_PEERS_ENV);
  });

  it('admits a LAN maker and a docker-bridge maker', () => {
    expect(isAnnounceEndpointUsable('ws://192.168.1.50:3000')).toBe(true);
    expect(isAnnounceEndpointUsable('ws://172.18.0.4:3000')).toBe(true);
  });

  it('leaves an unparsable endpoint to the dial site rather than relabelling it', () => {
    expect(rejectedAnnounceEndpoint('')).toBeUndefined();
    expect(rejectedAnnounceEndpoint('not a url at all')).toBeUndefined();
  });
});

describe('announceEndpointPolicyFor', () => {
  it('rescues loopback when the announce came off a loopback relay', () => {
    const policy = announceEndpointPolicyFor({
      discoveredFrom: 'ws://localhost:7100',
      env: {},
    });
    expect(policy.allowLoopback).toBe(true);
    expect(isAnnounceEndpointUsable('ws://127.0.0.1:3000', policy)).toBe(true);
  });

  it('does NOT rescue loopback off a public relay', () => {
    const policy = announceEndpointPolicyFor({
      discoveredFrom: 'wss://relay-ws.devnet.toonprotocol.dev',
      env: {},
    });
    expect(policy.allowLoopback).toBe(false);
    expect(isAnnounceEndpointUsable('ws://127.0.0.1:3401', policy)).toBe(false);
  });

  it('honours the env escape hatch for the split local-node/remote-relay case', () => {
    const policy = announceEndpointPolicyFor({
      discoveredFrom: 'wss://relay-ws.devnet.toonprotocol.dev',
      env: { [ALLOW_LOOPBACK_PEERS_ENV]: '1' },
    });
    expect(policy.allowLoopback).toBe(true);
  });

  it('lets an explicit flag beat both the env and the rescue', () => {
    expect(
      announceEndpointPolicyFor({
        discoveredFrom: 'ws://127.0.0.1:7100',
        allowLoopback: false,
        env: { [ALLOW_LOOPBACK_PEERS_ENV]: 'true' },
      }).allowLoopback
    ).toBe(false);
  });

  it('can be tightened to refuse private ranges too', () => {
    const policy = announceEndpointPolicyFor({ allowPrivate: false, env: {} });
    expect(isAnnounceEndpointUsable('ws://10.1.2.3:3000', policy)).toBe(false);
    expect(rejectedAnnounceEndpoint('ws://10.1.2.3:3000', policy)?.zone).toBe(
      'private'
    );
  });

  it('defaults to safe when nothing at all is supplied', () => {
    expect(announceEndpointPolicyFor({ env: {} })).toEqual(
      DEFAULT_ANNOUNCE_ENDPOINT_POLICY
    );
  });
});

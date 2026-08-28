import { describe, it, expect } from 'vitest';
import { selectTransport } from './transport-select.js';
import { TransportRequiredError } from '../client/errors.js';
import { parseSelfDescription } from '../connector/self-description.js';
import type { NodeSelfDescription } from '../connector/self-description.js';

/**
 * A self-description with the fields this policy reads, built through the real
 * parser so a test can never assert against a shape the wire cannot produce.
 */
function describeNode(
  body: Record<string, unknown>,
  readFrom?: string
): NodeSelfDescription {
  return parseSelfDescription(body, readFrom);
}

const BOTH = {
  ilpAddresses: ['g.toon.store'],
  httpEndpoint: 'https://proxy.example/ilp',
  btpEndpoint: 'wss://proxy.example/ilp/btp',
  peerCarriages: ['btp', 'http'],
};

/** The devnet relay's shape: BTP-only, route `g.toon.relay`. */
const BTP_ONLY = {
  ilpAddresses: ['g.toon.relay'],
  btpEndpoint: 'wss://relay.example/ilp/btp',
  peerCarriages: ['btp'],
  requiredTransport: 'btp',
};

describe("selectTransport — 'auto'", () => {
  it('prefers HTTP when the node offers both and requires neither', () => {
    expect(selectTransport(describeNode(BOTH), 'auto')).toEqual({
      kind: 'http',
      url: 'https://proxy.example/ilp',
    });
  });

  it('defaults to auto when no preference is given', () => {
    expect(selectTransport(describeNode(BOTH))).toEqual({
      kind: 'http',
      url: 'https://proxy.example/ilp',
    });
  });

  it("honours the node's requiredTransport over the HTTP preference", () => {
    // A node sets this only when every route covering its own addresses agrees
    // on one carriage, so honouring it is not taste — it is the only way a
    // packet gets routed at all.
    const description = describeNode({
      ...BOTH,
      requiredTransport: 'btp',
    });
    expect(selectTransport(description, 'auto')).toEqual({
      kind: 'btp',
      url: 'wss://proxy.example/ilp/btp',
    });
  });

  it('falls back to BTP on a BTP-only node', () => {
    expect(selectTransport(describeNode(BTP_ONLY), 'auto')).toEqual({
      kind: 'btp',
      url: 'wss://relay.example/ilp/btp',
    });
  });

  it('falls back to BTP even with no requiredTransport, when that is the only endpoint', () => {
    const description = describeNode({
      ilpAddresses: ['g.toon.relay'],
      btpEndpoint: 'wss://relay.example/ilp/btp',
      peerCarriages: ['btp'],
    });
    expect(selectTransport(description, 'auto')).toEqual({
      kind: 'btp',
      url: 'wss://relay.example/ilp/btp',
    });
  });

  it('refuses a node that publishes no endpoint at all', () => {
    const description = describeNode({ ilpAddresses: ['g.x'], peerCarriages: [] });
    expect(() => selectTransport(description, 'auto')).toThrow(
      TransportRequiredError
    );
    expect(() => selectTransport(description, 'auto')).toThrow(/neither/i);
  });

  it('refuses a node that requires a carriage it publishes no endpoint for', () => {
    const description = describeNode({
      ilpAddresses: ['g.x'],
      httpEndpoint: 'https://proxy.example/ilp',
      peerCarriages: [],
      requiredTransport: 'btp',
    });
    const error = catchError(() => selectTransport(description, 'auto'));
    expect(error).toBeInstanceOf(TransportRequiredError);
    expect((error as TransportRequiredError).required).toBe('btp');
  });
});

describe('selectTransport — an explicit preference', () => {
  it("honours 'http' when the node publishes an httpEndpoint", () => {
    expect(selectTransport(describeNode(BOTH), 'http')).toEqual({
      kind: 'http',
      url: 'https://proxy.example/ilp',
    });
  });

  it("honours 'btp' when the node publishes a btpEndpoint", () => {
    expect(selectTransport(describeNode(BOTH), 'btp')).toEqual({
      kind: 'btp',
      url: 'wss://proxy.example/ilp/btp',
    });
  });

  it("honours an explicit 'http' even against the node's requiredTransport, so the refusal comes from the connector", () => {
    // Selecting HTTP here is how a caller deliberately provokes the `402`
    // greeting that names the required carriage (§1.4 "Transport policy").
    // Silently rerouting would hide the disagreement.
    const description = describeNode({ ...BOTH, requiredTransport: 'btp' });
    expect(selectTransport(description, 'http')).toEqual({
      kind: 'http',
      url: 'https://proxy.example/ilp',
    });
  });

  it("refuses 'http' on a BTP-only node, and says which carriage to ask for", () => {
    const error = catchError(() =>
      selectTransport(describeNode(BTP_ONLY), 'http')
    );
    expect(error).toBeInstanceOf(TransportRequiredError);
    expect((error as TransportRequiredError).required).toBe('btp');
    expect((error as Error).message).toMatch(/no http endpoint/i);
  });

  it("refuses 'btp' on a node with no btpEndpoint", () => {
    const description = describeNode({
      ilpAddresses: ['g.toon.store'],
      httpEndpoint: 'https://proxy.example/ilp',
      peerCarriages: ['http'],
    });
    const error = catchError(() => selectTransport(description, 'btp'));
    expect(error).toBeInstanceOf(TransportRequiredError);
    // The node named no required carriage, so neither does the refusal.
    expect((error as TransportRequiredError).required).toBeUndefined();
  });
});

describe('selectTransport — endpoint resolution', () => {
  it('resolves a relative endpoint against the URL the description was read from', () => {
    const description = describeNode(
      { ilpAddresses: ['g.x'], httpEndpoint: '/ilp', peerCarriages: [] },
      'https://proxy.example'
    );
    expect(selectTransport(description, 'http').url).toBe(
      'https://proxy.example/ilp'
    );
  });

  it('takes an explicit base over the one recorded on the document', () => {
    const description = describeNode(
      { ilpAddresses: ['g.x'], httpEndpoint: '/ilp', peerCarriages: [] },
      'https://recorded.example'
    );
    expect(
      selectTransport(description, 'http', 'https://override.example').url
    ).toBe('https://override.example/ilp');
  });

  it('leaves an absolute endpoint untouched, base or no base', () => {
    const description = describeNode(
      {
        ilpAddresses: ['g.x'],
        btpEndpoint: 'wss://elsewhere.example/ilp/btp',
        peerCarriages: [],
      },
      'https://proxy.example'
    );
    expect(selectTransport(description, 'btp').url).toBe(
      'wss://elsewhere.example/ilp/btp'
    );
  });

  it('passes a relative endpoint through unchanged when nothing says what it is relative to', () => {
    const description = describeNode({
      ilpAddresses: ['g.x'],
      httpEndpoint: '/ilp',
      peerCarriages: [],
    });
    expect(selectTransport(description, 'http').url).toBe('/ilp');
  });
});

/** Run `fn` and return whatever it threw, so a test can assert on the value. */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw, and it did not');
}

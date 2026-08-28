import { describe, it, expect } from 'vitest';
import {
  ToonClientError,
  NetworkError,
  ConnectorError,
  ValidationError,
  ConfigError,
  ChainUnavailableError,
  ChannelNotOpenError,
  RouteNotPricedError,
  PaymentRequiredError,
  TransportRequiredError,
  chainUnavailableMessage,
} from './errors.js';
import type { PaymentTerms } from './types.js';

describe('ToonClientError', () => {
  it('should create error with message and code', () => {
    const error = new ToonClientError('Test error', 'TEST_CODE');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_CODE');
    expect(error.name).toBe('ToonClientError');
    expect(error.cause).toBeUndefined();
  });

  it('should create error with cause', () => {
    const cause = new Error('Original error');
    const error = new ToonClientError('Test error', 'TEST_CODE', cause);
    expect(error.cause).toBe(cause);
  });

  it('should be instance of Error', () => {
    const error = new ToonClientError('Test error', 'TEST_CODE');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(ToonClientError);
  });
});

describe('NetworkError', () => {
  it('should create network error with NETWORK_ERROR code', () => {
    const error = new NetworkError('Connection failed');
    expect(error.message).toBe('Connection failed');
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.name).toBe('NetworkError');
  });

  it('should inherit from ToonClientError', () => {
    const error = new NetworkError('Connection failed');
    expect(error).toBeInstanceOf(ToonClientError);
    expect(error).toBeInstanceOf(NetworkError);
  });

  it('should preserve cause chain', () => {
    const cause = new Error('ECONNREFUSED');
    const error = new NetworkError('Connection failed', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('ConnectorError', () => {
  it('should create connector error with CONNECTOR_ERROR code', () => {
    const error = new ConnectorError('Connector unavailable');
    expect(error.message).toBe('Connector unavailable');
    expect(error.code).toBe('CONNECTOR_ERROR');
    expect(error.name).toBe('ConnectorError');
  });

  it('should inherit from ToonClientError', () => {
    const error = new ConnectorError('Connector unavailable');
    expect(error).toBeInstanceOf(ToonClientError);
    expect(error).toBeInstanceOf(ConnectorError);
  });

  it('should preserve cause chain', () => {
    const cause = new Error('500 Internal Server Error');
    const error = new ConnectorError('Connector unavailable', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('ValidationError', () => {
  it('should create validation error with VALIDATION_ERROR code', () => {
    const error = new ValidationError('Invalid input');
    expect(error.message).toBe('Invalid input');
    expect(error.code).toBe('VALIDATION_ERROR');
    expect(error.name).toBe('ValidationError');
  });

  it('should inherit from ToonClientError', () => {
    const error = new ValidationError('Invalid input');
    expect(error).toBeInstanceOf(ToonClientError);
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('should preserve cause chain', () => {
    const cause = new Error('Parse error');
    const error = new ValidationError('Invalid input', cause);
    expect(error.cause).toBe(cause);
  });
});


// ─── 1.0's own classes ──────────────────────────────────────────────────────

const TERMS: PaymentTerms = {
  destination: 'g.toon.ario',
  price: 1000n,
  httpEndpoint: 'https://node.example/ilp',
  settlements: [],
  raw: {},
};

describe('ConfigError', () => {
  it('carries the CONFIG code and its cause', () => {
    const cause = new Error('registry disagreed');
    const error = new ConfigError('the published tokenNetwork is not the registry\'s', cause);
    expect(error.code).toBe('CONFIG');
    expect(error.name).toBe('ConfigError');
    expect(error).toBeInstanceOf(ToonClientError);
    expect(error.cause).toBe(cause);
  });
});

describe('ChainUnavailableError', () => {
  it('lists the chains the node DOES offer, so the remedy is in the error', () => {
    const error = new ChainUnavailableError('nope', ['evm:84532', 'solana']);
    expect(error.code).toBe('CHAIN_UNAVAILABLE');
    expect(error.offered).toEqual(['evm:84532', 'solana']);
  });

  it('copies the offered list, so a later mutation of the caller\'s array cannot rewrite it', () => {
    const offered = ['evm:84532'];
    const error = new ChainUnavailableError('nope', offered);
    offered.push('solana');
    expect(error.offered).toEqual(['evm:84532']);
  });
});

describe('chainUnavailableMessage', () => {
  it('names the chain that was asked for when the node does not settle on it', () => {
    const message = chainUnavailableMessage('solana', ['evm:84532'], 'not-offered');
    expect(message).toContain('solana');
    expect(message).toContain('evm:84532');
  });

  it('tells a keyless client to supply a mnemonic', () => {
    expect(chainUnavailableMessage(undefined, ['solana'], 'no-key')).toContain('mnemonic');
  });

  it('says a node with no settlements can be paid for nothing', () => {
    expect(chainUnavailableMessage(undefined, [], 'none')).toContain('no settlement chains');
  });
});

describe('ChannelNotOpenError', () => {
  it('is a precondition failure, not a verdict', () => {
    const error = new ChannelNotOpenError('open a channel first');
    expect(error.code).toBe('CHANNEL_NOT_OPEN');
    expect(error).toBeInstanceOf(ToonClientError);
  });
});

describe('RouteNotPricedError', () => {
  it('carries the ROUTE_NOT_PRICED code', () => {
    const error = new RouteNotPricedError('no route');
    expect(error.code).toBe('ROUTE_NOT_PRICED');
    expect(error.name).toBe('RouteNotPricedError');
  });
});

describe('PaymentRequiredError', () => {
  it('carries the terms the greeting stated — the point of the greeting', () => {
    const error = new PaymentRequiredError('pay first', TERMS);
    expect(error.code).toBe('PAYMENT_REQUIRED');
    expect(error.terms.price).toBe(1000n);
    expect(error.terms.destination).toBe('g.toon.ario');
  });
});

describe('TransportRequiredError', () => {
  it('names the carriage the node insists on', () => {
    const error = new TransportRequiredError('btp only', { required: 'btp', terms: TERMS });
    expect(error.code).toBe('TRANSPORT_REQUIRED');
    expect(error.required).toBe('btp');
    expect(error.terms).toBe(TERMS);
  });

  it('tolerates a refusal that named no carriage', () => {
    const error = new TransportRequiredError('wrong carriage');
    expect(error.required).toBeUndefined();
    expect(error.terms).toBeUndefined();
  });
});

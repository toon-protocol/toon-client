import { describe, it, expect } from 'vitest';
import {
  CrosstownClientError,
  NetworkError,
  ConnectorError,
  ValidationError,
  UnauthorizedError,
  PeerNotFoundError,
  PeerAlreadyExistsError,
} from './errors.js';

describe('CrosstownClientError', () => {
  it('should create error with message and code', () => {
    const error = new CrosstownClientError('Test error', 'TEST_CODE');
    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_CODE');
    expect(error.name).toBe('CrosstownClientError');
    expect(error.cause).toBeUndefined();
  });

  it('should create error with cause', () => {
    const cause = new Error('Original error');
    const error = new CrosstownClientError('Test error', 'TEST_CODE', cause);
    expect(error.cause).toBe(cause);
  });

  it('should be instance of Error', () => {
    const error = new CrosstownClientError('Test error', 'TEST_CODE');
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(CrosstownClientError);
  });
});

describe('NetworkError', () => {
  it('should create network error with NETWORK_ERROR code', () => {
    const error = new NetworkError('Connection failed');
    expect(error.message).toBe('Connection failed');
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.name).toBe('NetworkError');
  });

  it('should inherit from CrosstownClientError', () => {
    const error = new NetworkError('Connection failed');
    expect(error).toBeInstanceOf(CrosstownClientError);
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

  it('should inherit from CrosstownClientError', () => {
    const error = new ConnectorError('Connector unavailable');
    expect(error).toBeInstanceOf(CrosstownClientError);
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

  it('should inherit from CrosstownClientError', () => {
    const error = new ValidationError('Invalid input');
    expect(error).toBeInstanceOf(CrosstownClientError);
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('should preserve cause chain', () => {
    const cause = new Error('Parse error');
    const error = new ValidationError('Invalid input', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('UnauthorizedError', () => {
  it('should create unauthorized error with UNAUTHORIZED code', () => {
    const error = new UnauthorizedError('Authentication failed');
    expect(error.message).toBe('Authentication failed');
    expect(error.code).toBe('UNAUTHORIZED');
    expect(error.name).toBe('UnauthorizedError');
  });

  it('should inherit from CrosstownClientError', () => {
    const error = new UnauthorizedError('Authentication failed');
    expect(error).toBeInstanceOf(CrosstownClientError);
    expect(error).toBeInstanceOf(UnauthorizedError);
  });

  it('should preserve cause chain', () => {
    const cause = new Error('401 Unauthorized');
    const error = new UnauthorizedError('Authentication failed', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('PeerNotFoundError', () => {
  it('should create peer not found error with PEER_NOT_FOUND code', () => {
    const error = new PeerNotFoundError('Peer does not exist');
    expect(error.message).toBe('Peer does not exist');
    expect(error.code).toBe('PEER_NOT_FOUND');
    expect(error.name).toBe('PeerNotFoundError');
  });

  it('should inherit from CrosstownClientError', () => {
    const error = new PeerNotFoundError('Peer does not exist');
    expect(error).toBeInstanceOf(CrosstownClientError);
    expect(error).toBeInstanceOf(PeerNotFoundError);
  });

  it('should preserve cause chain', () => {
    const cause = new Error('404 Not Found');
    const error = new PeerNotFoundError('Peer does not exist', cause);
    expect(error.cause).toBe(cause);
  });
});

describe('PeerAlreadyExistsError', () => {
  it('should create peer already exists error with PEER_ALREADY_EXISTS code', () => {
    const error = new PeerAlreadyExistsError('Duplicate peer');
    expect(error.message).toBe('Duplicate peer');
    expect(error.code).toBe('PEER_ALREADY_EXISTS');
    expect(error.name).toBe('PeerAlreadyExistsError');
  });

  it('should inherit from CrosstownClientError', () => {
    const error = new PeerAlreadyExistsError('Duplicate peer');
    expect(error).toBeInstanceOf(CrosstownClientError);
    expect(error).toBeInstanceOf(PeerAlreadyExistsError);
  });

  it('should preserve cause chain', () => {
    const cause = new Error('409 Conflict');
    const error = new PeerAlreadyExistsError('Duplicate peer', cause);
    expect(error.cause).toBe(cause);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from './retry.js';

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return result on first success', async () => {
    const operation = vi.fn().mockResolvedValue('success');
    const resultPromise = withRetry(operation, {
      maxRetries: 3,
      retryDelay: 1000,
    });

    const result = await resultPromise;

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('should retry on failure and succeed', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('Attempt 1'))
      .mockRejectedValueOnce(new Error('Attempt 2'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(operation, {
      maxRetries: 3,
      retryDelay: 1000,
    });

    // Fast-forward through retries
    await vi.advanceTimersByTimeAsync(1000); // After 1st retry delay
    await vi.advanceTimersByTimeAsync(2000); // After 2nd retry delay (exponential)

    const result = await resultPromise;

    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should throw last error after exhausting retries', async () => {
    const error1 = new Error('Attempt 1');
    const error2 = new Error('Attempt 2');
    const error3 = new Error('Attempt 3');
    const error4 = new Error('Attempt 4');

    const operation = vi
      .fn()
      .mockRejectedValueOnce(error1)
      .mockRejectedValueOnce(error2)
      .mockRejectedValueOnce(error3)
      .mockRejectedValueOnce(error4);

    const resultPromise = withRetry(operation, {
      maxRetries: 3,
      retryDelay: 1000,
    });

    // Attach a catch handler immediately to prevent unhandled rejection
    const errorPromise = resultPromise.catch((err) => err);

    // Fast-forward through all retries
    await vi.advanceTimersByTimeAsync(1000); // 1st retry
    await vi.advanceTimersByTimeAsync(2000); // 2nd retry
    await vi.advanceTimersByTimeAsync(4000); // 3rd retry

    // Wait for the promise to resolve with the error
    const error = await errorPromise;
    expect(error.message).toBe('Attempt 4');
    expect(operation).toHaveBeenCalledTimes(4); // Initial + 3 retries
  });

  it('should use exponential backoff by default', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('Attempt 1'))
      .mockRejectedValueOnce(new Error('Attempt 2'))
      .mockRejectedValueOnce(new Error('Attempt 3'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(operation, {
      maxRetries: 3,
      retryDelay: 1000,
      exponentialBackoff: true,
    });

    // Verify exponential backoff delays: 1000ms, 2000ms, 4000ms
    await vi.advanceTimersByTimeAsync(1000);
    expect(operation).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(2000);
    expect(operation).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(4000);
    expect(operation).toHaveBeenCalledTimes(4);

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('should respect maxDelay cap', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('Attempt 1'))
      .mockRejectedValueOnce(new Error('Attempt 2'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(operation, {
      maxRetries: 2,
      retryDelay: 10000,
      exponentialBackoff: true,
      maxDelay: 5000, // Cap at 5 seconds
    });

    // First retry should be capped at maxDelay (5000ms)
    await vi.advanceTimersByTimeAsync(5000);
    expect(operation).toHaveBeenCalledTimes(2);

    // Second retry should also be capped at maxDelay (5000ms)
    await vi.advanceTimersByTimeAsync(5000);
    expect(operation).toHaveBeenCalledTimes(3);

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('should use fixed delay when exponentialBackoff is false', async () => {
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new Error('Attempt 1'))
      .mockRejectedValueOnce(new Error('Attempt 2'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(operation, {
      maxRetries: 2,
      retryDelay: 1000,
      exponentialBackoff: false,
    });

    // Both retries should use fixed 1000ms delay
    await vi.advanceTimersByTimeAsync(1000);
    expect(operation).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(1000);
    expect(operation).toHaveBeenCalledTimes(3);

    const result = await resultPromise;
    expect(result).toBe('success');
  });

  it('should respect shouldRetry predicate', async () => {
    class NonRetryableError extends Error {
      name = 'NonRetryableError';
    }

    const operation = vi
      .fn()
      .mockRejectedValueOnce(new NonRetryableError('Do not retry'));

    const resultPromise = withRetry(operation, {
      maxRetries: 3,
      retryDelay: 1000,
      shouldRetry: (error) => error.name === 'RetryableError',
    });

    await expect(resultPromise).rejects.toThrow('Do not retry');
    expect(operation).toHaveBeenCalledTimes(1); // No retries
  });

  it('should retry only matching errors with shouldRetry', async () => {
    class NetworkError extends Error {
      name = 'NetworkError';
    }

    const operation = vi
      .fn()
      .mockRejectedValueOnce(new NetworkError('Network issue'))
      .mockRejectedValueOnce(new NetworkError('Network issue'))
      .mockResolvedValue('success');

    const resultPromise = withRetry(operation, {
      maxRetries: 3,
      retryDelay: 1000,
      shouldRetry: (error) => error.name === 'NetworkError',
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);

    const result = await resultPromise;
    expect(result).toBe('success');
    expect(operation).toHaveBeenCalledTimes(3);
  });

  it('should handle non-Error exceptions', async () => {
    const operation = vi.fn().mockRejectedValue('string error');

    const resultPromise = withRetry(operation, {
      maxRetries: 0,
      retryDelay: 1000,
    });

    await expect(resultPromise).rejects.toThrow('string error');
  });

  it('should handle zero retries', async () => {
    const operation = vi.fn().mockRejectedValue(new Error('Immediate fail'));

    const resultPromise = withRetry(operation, {
      maxRetries: 0,
      retryDelay: 1000,
    });

    await expect(resultPromise).rejects.toThrow('Immediate fail');
    expect(operation).toHaveBeenCalledTimes(1);
  });
});

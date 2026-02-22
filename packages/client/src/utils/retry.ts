/**
 * Configuration options for retry behavior with exponential backoff.
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries: number;
  /** Initial delay in milliseconds between retries (default: 1000) */
  retryDelay: number;
  /** Use exponential backoff for delays (default: true) */
  exponentialBackoff?: boolean;
  /** Maximum delay cap in milliseconds (default: 30000) */
  maxDelay?: number;
  /** Custom predicate to determine if an error should trigger a retry */
  shouldRetry?: (error: Error) => boolean;
}

/**
 * Executes an async operation with retry logic and exponential backoff.
 *
 * @param operation - The async function to execute
 * @param options - Retry configuration options
 * @returns The result of the successful operation
 * @throws The last error if all retries are exhausted
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   async () => fetchData(),
 *   {
 *     maxRetries: 3,
 *     retryDelay: 1000,
 *     shouldRetry: (err) => err.name === 'NetworkError'
 *   }
 * );
 * ```
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions
): Promise<T> {
  const {
    maxRetries,
    retryDelay,
    exponentialBackoff = true,
    maxDelay = 30000,
    shouldRetry,
  } = options;

  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry this error
      if (shouldRetry && !shouldRetry(lastError)) {
        throw lastError;
      }

      // If this was the last attempt, throw the error
      if (attempt === maxRetries) {
        throw lastError;
      }

      // Calculate delay with exponential backoff
      const currentDelay = exponentialBackoff
        ? Math.min(retryDelay * Math.pow(2, attempt), maxDelay)
        : retryDelay;

      // Wait before retrying
      await new Promise((resolve) => setTimeout(resolve, currentDelay));
    }
  }

  // This should never be reached, but TypeScript needs it
  throw lastError ?? new Error('Unknown error during retry');
}

/**
 * A line to a fake connector that can lose its answers: with `silent` set, a
 * claim-bearing `POST /ilp` still reaches the connector (it records the claim
 * and counts the request), but its answer never comes back. The response waits
 * until the caller gives up, and rejects as `fetch` does when its signal
 * aborts. The packet was written; its answer is lost.
 *
 * Test-only.
 */
import type { FakeTerminatingConnector } from '../wire/fake-connector.test-support.js';

export interface LossyLine {
  fetch: typeof fetch;
  silent: boolean;
}

export function lossyLine(fake: FakeTerminatingConnector): LossyLine {
  const line: LossyLine = {
    silent: false,
    fetch: async (input, init) => {
      const answer = await fake.fetch(input, init);
      if (!line.silent || !isPaidPost(String(input), init)) return answer;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    },
  };
  return line;
}

function isPaidPost(url: string, init: RequestInit | undefined): boolean {
  if ((init?.method ?? 'GET').toUpperCase() !== 'POST' || !url.endsWith('/ilp'))
    return false;
  const headers = new Headers(init?.headers);
  return headers.has('ilp-payment-channel-claim');
}

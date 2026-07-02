/**
 * Plain-fetch client for the toon-clientd loopback `/git/*` routes.
 *
 * Deliberately NOT built on `@toon-protocol/client-mcp`'s ControlClient —
 * that package depends on this one (its daemon Publisher wraps our planner),
 * so importing it back would be circular. The route conventions (loopback
 * base URL, JSON bodies, the `ErrorResponse` envelope with structured 409
 * `non_fast_forward` / 413 `oversize_objects` payloads) are mirrored here;
 * the wire types live in `../routes.ts` for client-mcp to adopt.
 */

import type {
  GitErrorEnvelope,
  GitEstimateRequest,
  GitEstimateResponse,
  GitPushRequest,
  GitPushResponse,
} from '../routes.js';

/** The daemon answered a `/git/*` route with a non-2xx error envelope. */
export class DaemonRouteError extends Error {
  constructor(
    /** HTTP status code (409 non_fast_forward, 413 oversize_objects, …). */
    public readonly status: number,
    /** The parsed error envelope (structured payloads at the top level). */
    public readonly envelope: GitErrorEnvelope
  ) {
    super(envelope.detail ?? envelope.error);
    this.name = 'DaemonRouteError';
  }
}

/** The daemon control API could not be reached at all. */
export class DaemonUnreachableError extends Error {
  constructor(
    public readonly baseUrl: string,
    cause: unknown
  ) {
    super(
      `toon-clientd control API is not reachable at ${baseUrl} — ` +
        `start the daemon (\`toon-clientd\`, shipped by @toon-protocol/client-mcp) ` +
        `and re-run, or use --standalone with TOON_CLIENT_MNEMONIC set` +
        (cause instanceof Error ? ` (${cause.message})` : '')
    );
    this.name = 'DaemonUnreachableError';
  }
}

export class DaemonGitClient {
  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl: typeof fetch
  ) {}

  gitEstimate(req: GitEstimateRequest): Promise<GitEstimateResponse> {
    return this.post<GitEstimateResponse>('/git/estimate', req);
  }

  gitPush(req: GitPushRequest): Promise<GitPushResponse> {
    return this.post<GitPushResponse>('/git/push', req);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new DaemonUnreachableError(this.baseUrl, err);
    }
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text === '' ? {} : JSON.parse(text);
    } catch {
      throw new DaemonRouteError(res.status, {
        error: 'invalid_response',
        detail: `daemon returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`,
      });
    }
    if (!res.ok) {
      const envelope =
        parsed && typeof parsed === 'object' && 'error' in parsed
          ? (parsed as GitErrorEnvelope)
          : { error: 'http_error', detail: `HTTP ${res.status}` };
      throw new DaemonRouteError(res.status, envelope);
    }
    return parsed as T;
  }
}

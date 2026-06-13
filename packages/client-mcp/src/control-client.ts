/**
 * Thin HTTP client for the `toon-clientd` localhost control plane. Used by the
 * MCP server (and any other caller) to drive the daemon without holding any
 * chain keys or long-lived connections itself.
 */

import type {
  ChannelsResponse,
  ErrorResponse,
  EventsQuery,
  EventsResponse,
  OpenChannelRequest,
  PublishRequest,
  PublishResponse,
  StatusResponse,
  SubscribeRequest,
  SubscribeResponse,
  SwapRequest,
  SwapResponse,
} from './control-api.js';

/** Error thrown when the daemon returns a non-2xx response. */
export class ControlApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly detail?: string
  ) {
    super(message);
    this.name = 'ControlApiError';
  }
}

/** Thrown when the daemon is unreachable (not running / wrong port). */
export class DaemonUnreachableError extends Error {
  constructor(
    readonly baseUrl: string,
    readonly causedBy?: unknown
  ) {
    super(`toon-clientd not reachable at ${baseUrl}`);
    this.name = 'DaemonUnreachableError';
  }
}

export interface ControlClientOptions {
  /** Base URL of the daemon, e.g. `http://127.0.0.1:8787`. */
  baseUrl: string;
  /** Per-request timeout, ms. Default 35000 (publishes can wait on FULFILL). */
  timeoutMs?: number;
  /** Inject a fetch implementation (tests). Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class ControlClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ControlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = opts.timeoutMs ?? 35_000;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }

  /** True if the daemon answers `GET /status` (used as a liveness probe). */
  async ping(): Promise<boolean> {
    try {
      await this.request<StatusResponse>('GET', '/status');
      return true;
    } catch (err) {
      if (err instanceof DaemonUnreachableError) return false;
      // A reachable daemon that errored still counts as "up".
      return err instanceof ControlApiError;
    }
  }

  status(): Promise<StatusResponse> {
    return this.request<StatusResponse>('GET', '/status');
  }

  publish(body: PublishRequest): Promise<PublishResponse> {
    return this.request<PublishResponse>('POST', '/publish', body);
  }

  subscribe(body: SubscribeRequest): Promise<SubscribeResponse> {
    return this.request<SubscribeResponse>('POST', '/subscribe', body);
  }

  events(query: EventsQuery = {}): Promise<EventsResponse> {
    const qs = new URLSearchParams();
    if (query.subId) qs.set('subId', query.subId);
    if (query.cursor !== undefined) qs.set('cursor', String(query.cursor));
    if (query.limit !== undefined) qs.set('limit', String(query.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<EventsResponse>('GET', `/events${suffix}`);
  }

  openChannel(body: OpenChannelRequest = {}): Promise<{ channelId: string }> {
    return this.request<{ channelId: string }>('POST', '/channels', body);
  }

  channels(): Promise<ChannelsResponse> {
    return this.request<ChannelsResponse>('GET', '/channels');
  }

  swap(body: SwapRequest): Promise<SwapResponse> {
    return this.request<SwapResponse>('POST', '/swap', body);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      throw new DaemonUnreachableError(this.baseUrl, err);
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text();
    const json = text ? safeJson(text) : undefined;
    if (!res.ok) {
      const e = (json ?? {}) as ErrorResponse;
      throw new ControlApiError(
        e.error ?? `HTTP ${res.status}`,
        res.status,
        e.retryable ?? res.status === 503,
        e.detail
      );
    }
    return json as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

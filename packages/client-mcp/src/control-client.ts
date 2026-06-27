/**
 * Thin HTTP client for the `toon-clientd` localhost control plane. Used by the
 * MCP server (and any other caller) to drive the daemon without holding any
 * chain keys or long-lived connections itself.
 */

import type {
  AddApexRequest,
  AddApexResponse,
  AddRelayRequest,
  BalancesResponse,
  ChannelDepositRequest,
  ChannelDepositResponse,
  CloseChannelRequest,
  CloseChannelResponse,
  SettleChannelRequest,
  SettleChannelResponse,
  ChannelsResponse,
  ErrorResponse,
  EventsQuery,
  EventsResponse,
  FundWalletRequest,
  FundWalletResponse,
  HttpFetchPaidRequest,
  HttpFetchPaidResponse,
  OpenChannelRequest,
  PublishRequest,
  PublishResponse,
  PublishUnsignedRequest,
  QueryRequest,
  QueryResponse,
  RemoveApexRequest,
  RemoveRelayRequest,
  StatusResponse,
  SubscribeRequest,
  SubscribeResponse,
  SwapRequest,
  SwapResponse,
  TargetsResponse,
  UploadMediaRequest,
  UploadMediaResponse,
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

  publishUnsigned(body: PublishUnsignedRequest): Promise<PublishResponse> {
    return this.request<PublishResponse>('POST', '/publish-unsigned', body);
  }

  uploadMedia(body: UploadMediaRequest): Promise<UploadMediaResponse> {
    return this.request<UploadMediaResponse>('POST', '/upload-media', body);
  }

  subscribe(body: SubscribeRequest): Promise<SubscribeResponse> {
    return this.request<SubscribeResponse>('POST', '/subscribe', body);
  }

  query(body: QueryRequest): Promise<QueryResponse> {
    return this.request<QueryResponse>('POST', '/query', body);
  }

  events(query: EventsQuery = {}): Promise<EventsResponse> {
    const qs = new URLSearchParams();
    if (query.subId) qs.set('subId', query.subId);
    if (query.cursor !== undefined) qs.set('cursor', String(query.cursor));
    if (query.limit !== undefined) qs.set('limit', String(query.limit));
    if (query.relayUrl) qs.set('relayUrl', query.relayUrl);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return this.request<EventsResponse>('GET', `/events${suffix}`);
  }

  openChannel(body: OpenChannelRequest = {}): Promise<{ channelId: string }> {
    return this.request<{ channelId: string }>('POST', '/channels', body);
  }

  channels(): Promise<ChannelsResponse> {
    return this.request<ChannelsResponse>('GET', '/channels');
  }

  balances(): Promise<BalancesResponse> {
    // On-chain balance reads can be slow on devnet RPCs. Cap this read well
    // below the default 35s so the wallet card resolves (or shows its Retry
    // state) in a few seconds instead of spinning — the read seam retries, so
    // the effective bound stays modest.
    return this.request<BalancesResponse>('GET', '/balances', undefined, { timeoutMs: 12_000 });
  }

  depositToChannel(body: ChannelDepositRequest): Promise<ChannelDepositResponse> {
    return this.request<ChannelDepositResponse>('POST', '/channels/deposit', body);
  }

  closeChannel(body: CloseChannelRequest): Promise<CloseChannelResponse> {
    return this.request<CloseChannelResponse>('POST', '/channels/close', body);
  }

  settleChannel(body: SettleChannelRequest): Promise<SettleChannelResponse> {
    return this.request<SettleChannelResponse>('POST', '/channels/settle', body);
  }

  swap(body: SwapRequest): Promise<SwapResponse> {
    return this.request<SwapResponse>('POST', '/swap', body);
  }

  httpFetchPaid(body: HttpFetchPaidRequest): Promise<HttpFetchPaidResponse> {
    return this.request<HttpFetchPaidResponse>(
      'POST',
      '/http-fetch-paid',
      body
    );
  }

  targets(): Promise<TargetsResponse> {
    return this.request<TargetsResponse>('GET', '/targets');
  }

  addRelay(body: AddRelayRequest): Promise<TargetsResponse> {
    return this.request<TargetsResponse>('POST', '/relays', body);
  }

  removeRelay(body: RemoveRelayRequest): Promise<TargetsResponse> {
    return this.request<TargetsResponse>('DELETE', '/relays', body);
  }

  addApex(body: AddApexRequest): Promise<AddApexResponse> {
    return this.request<AddApexResponse>('POST', '/apex', body);
  }

  removeApex(body: RemoveApexRequest): Promise<TargetsResponse> {
    return this.request<TargetsResponse>('DELETE', '/apex', body);
  }

  fundWallet(body: FundWalletRequest = {}): Promise<FundWalletResponse> {
    // The faucet is chain-aware. The Mina faucet mints native MINA + USDC on a
    // slow-settling chain and can take up to ~120s to answer — the daemon waits
    // `defaultFaucetTimeout('mina')` = 120s server-side — while evm/solana
    // answer within ~30s. This control request must OUT-WAIT the daemon's faucet
    // budget; the default 35s aborts a still-working mina drip and surfaces a
    // misleading relay/apex timeout (#199-class). Give mina 130s, others 40s.
    const timeoutMs = body.chain === 'mina' ? 130_000 : 40_000;
    return this.request<FundWalletResponse>('POST', '/fund-wallet', body, {
      timeoutMs,
    });
  }

  /**
   * Whether an HTTP method is safe to transparently retry. Idempotent reads
   * (GET) and deletes can be replayed verbatim; a mutating POST cannot — the
   * daemon may have already applied it before the socket failed, so retrying
   * risks a double publish/fund/deposit.
   */
  private static isIdempotent(method: string): boolean {
    return method === 'GET' || method === 'DELETE';
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { timeoutMs?: number }
  ): Promise<T> {
    // Transparently retry idempotent requests on a transient connection failure.
    // The MCP server is long-lived and calls the daemon infrequently, so a
    // pooled keep-alive socket can be reaped by the daemon between calls; the
    // next request reuses the now-dead socket and fails with ECONNRESET /
    // "socket hang up", surfacing as `DaemonUnreachableError` even though the
    // daemon is up. A fresh socket on retry succeeds — this is the root cause of
    // the intermittent "daemon not reachable" on `toon_balances` (toon-client
    // #186). A genuine ECONNREFUSED (daemon mid-restart) benefits from the same
    // brief retry. Timeouts are NOT retried here (a slow handler is classified
    // as a `ControlApiError` 504 below, not a connection failure).
    const attempts = ControlClient.isIdempotent(method) ? 3 : 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await this.attemptOnce<T>(method, path, body, opts?.timeoutMs);
      } catch (err) {
        lastErr = err;
        if (attempt < attempts && err instanceof DaemonUnreachableError) {
          await new Promise((r) => setTimeout(r, 50 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  }

  private async attemptOnce<T>(
    method: string,
    path: string,
    body?: unknown,
    timeoutMs = this.timeoutMs
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      // A request WE aborted is a timeout (the daemon is reachable but the
      // handler is slow — e.g. a hung on-chain balance read), NOT an unreachable
      // daemon. Classify it as a retryable 504 so callers surface "retry"
      // instead of the misleading "the daemon failed to start — check the log".
      if (controller.signal.aborted) {
        throw new ControlApiError(
          `control request ${method} ${path} timed out after ${timeoutMs}ms`,
          504,
          true
        );
      }
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

/**
 * Persistent town-relay Nostr-WS subscription — the read half of the TOON
 * client, which `@toon-protocol/client` does not provide (its bootstrap only
 * issues one-shot WS queries and `DiscoveryTracker` is passive).
 *
 * Reads are FREE: this opens a long-lived NIP-01 connection to the town relay,
 * keeps a bounded ring buffer of received events (de-duplicated by `event.id`),
 * and lets callers drain new events via a monotonic cursor. It auto-reconnects
 * with exponential backoff and re-issues every active REQ on reconnect.
 *
 * The WebSocket is injectable (`wsFactory`) so unit tests can drive the wire
 * protocol without a real relay; the default factory uses the `ws` package and,
 * when a `socks5h://` proxy is configured, routes through it so `.anyone`
 * hidden-service relays are reachable.
 */

import { createRequire } from 'node:module';
import type { NostrEvent } from 'nostr-tools/pure';
import type { NostrFilter } from './control-api.js';

// ESM has no `require`; synchronously load the node-only `ws`/`socks-proxy-agent`
// deps for the default WebSocket factory without forcing every caller (e.g. the
// browser-style injected-factory path in tests) to pull them in.
const nodeRequire = createRequire(import.meta.url);

/** Minimal WebSocket surface this module depends on (subset of `ws`). */
export interface MinimalWebSocket {
  send(data: string): void;
  close(): void;
  on(event: 'open' | 'close', cb: () => void): void;
  on(event: 'message', cb: (data: unknown) => void): void;
  on(event: 'error', cb: (err: unknown) => void): void;
}

export type WebSocketFactory = (url: string) => MinimalWebSocket;

export interface RelaySubscriptionOptions {
  /** Town relay WS URL, e.g. `wss://<host>.anyone/` or `ws://localhost:7100`. */
  relayUrl: string;
  /** Optional `socks5h://host:port` proxy for `.anyone` relays. */
  socksProxy?: string;
  /** Max events retained in the ring buffer (oldest evicted). Default 5000. */
  bufferSize?: number;
  /** Base reconnect delay, ms. Default 1000. */
  reconnectBaseMs?: number;
  /** Max reconnect delay, ms. Default 30000. */
  reconnectMaxMs?: number;
  /** Inject a WebSocket factory (tests / proxy customisation). */
  wsFactory?: WebSocketFactory;
  /**
   * Decode an `EVENT` payload that arrived as a string. The TOON relay sends
   * events TOON-encoded (key/value text) rather than as a JSON object, so the
   * daemon injects a TOON decoder here. When the payload is already a JSON
   * object it is used directly and this is not called.
   */
  decodeEvent?: (raw: string) => NostrEvent;
  /**
   * Invoked once per newly-buffered (de-duplicated) event. The daemon uses this
   * to feed a runner-level MERGED buffer across many relays — so a fan-out read
   * (`toon_read` with no relayUrl) draws from one ordered stream with a single
   * scalar cursor. The relay still keeps its own buffer for `bufferedCount` /
   * single-relay drains.
   */
  onEvent?: (subId: string, event: NostrEvent) => void;
  /** Optional logger. */
  logger?: (msg: string) => void;
}

interface BufferedEvent {
  seq: number;
  subId: string;
  event: NostrEvent;
}

/** Result of {@link RelaySubscription.getEvents}. */
export interface DrainResult {
  events: NostrEvent[];
  cursor: number;
  hasMore: boolean;
}

const DEFAULT_BUFFER = 5000;
const DEFAULT_BASE_MS = 1000;
const DEFAULT_MAX_MS = 30_000;

/** Shared no-op used as the default logger. */
const noop = (): void => undefined;

export class RelaySubscription {
  private readonly relayUrl: string;
  private readonly socksProxy?: string;
  private readonly bufferSize: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly log: (msg: string) => void;
  private readonly wsFactory: WebSocketFactory;
  private readonly decodeEvent?: (raw: string) => NostrEvent;
  private readonly onEvent?: (subId: string, event: NostrEvent) => void;

  /** Active subscriptions: subId -> filters (re-sent on every (re)connect). */
  private readonly subscriptions = new Map<string, NostrFilter[]>();

  /** Ring buffer of received events, ordered by ascending `seq`. */
  private buffer: BufferedEvent[] = [];
  /** De-dup index: event.id -> seq (kept in lockstep with the buffer). */
  private readonly seen = new Set<string>();
  private seqCounter = 0;
  private subIdCounter = 0;

  private ws: MinimalWebSocket | null = null;
  private connected = false;
  private closing = false;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: RelaySubscriptionOptions) {
    this.relayUrl = opts.relayUrl;
    this.socksProxy = opts.socksProxy;
    this.bufferSize = opts.bufferSize ?? DEFAULT_BUFFER;
    this.reconnectBaseMs = opts.reconnectBaseMs ?? DEFAULT_BASE_MS;
    this.reconnectMaxMs = opts.reconnectMaxMs ?? DEFAULT_MAX_MS;
    this.log = opts.logger ?? noop;
    this.wsFactory = opts.wsFactory ?? defaultWebSocketFactory(this.socksProxy);
    this.decodeEvent = opts.decodeEvent;
    this.onEvent = opts.onEvent;
  }

  /** Whether the underlying socket is currently open. */
  isConnected(): boolean {
    return this.connected;
  }

  /** Number of events currently held in the buffer. */
  bufferedCount(): number {
    return this.buffer.length;
  }

  /** Active subscription ids. */
  activeSubscriptions(): string[] {
    return [...this.subscriptions.keys()];
  }

  /** Open the connection (idempotent). */
  start(): void {
    this.closing = false;
    if (this.ws) return;
    this.open();
  }

  /**
   * Register a persistent subscription and (if connected) send the REQ.
   * Returns the subscription id (caller-supplied or generated).
   */
  subscribe(filters: NostrFilter | NostrFilter[], subId?: string): string {
    const id = subId ?? `sub-${++this.subIdCounter}`;
    const list = Array.isArray(filters) ? filters : [filters];
    this.subscriptions.set(id, list);
    if (this.connected) this.sendReq(id, list);
    return id;
  }

  /** Cancel a subscription and send CLOSE if connected. */
  unsubscribe(subId: string): void {
    if (!this.subscriptions.delete(subId)) return;
    if (this.connected) this.sendRaw(['CLOSE', subId]);
  }

  /**
   * Drain events newer than `cursor`. The cursor is the highest `seq` returned;
   * pass it back to fetch only events received since. Filtering by `subId`
   * restricts to one subscription.
   */
  getEvents(
    opts: { subId?: string; cursor?: number; limit?: number } = {}
  ): DrainResult {
    const after = opts.cursor ?? 0;
    const limit = opts.limit ?? 200;
    const matches = this.buffer.filter(
      (b) =>
        b.seq > after && (opts.subId === undefined || b.subId === opts.subId)
    );
    const page = matches.slice(0, limit);
    const hasMore = matches.length > page.length;
    const last = page.at(-1);
    const cursor = last ? last.seq : after;
    return { events: page.map((b) => b.event), cursor, hasMore };
  }

  /** Close the connection permanently and stop reconnecting. */
  close(): void {
    this.closing = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
    this.connected = false;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private open(): void {
    let ws: MinimalWebSocket;
    try {
      ws = this.wsFactory(this.relayUrl);
    } catch (err) {
      this.log(`[relay] connect failed: ${errMsg(err)}`);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      this.connected = true;
      this.reconnectAttempts = 0;
      this.log(`[relay] connected to ${this.relayUrl}`);
      // Re-issue every active subscription.
      for (const [id, filters] of this.subscriptions) this.sendReq(id, filters);
    });

    ws.on('message', (data: unknown) => this.handleMessage(data));

    ws.on('error', (err: unknown) => {
      this.log(`[relay] socket error: ${errMsg(err)}`);
    });

    ws.on('close', () => {
      this.connected = false;
      this.ws = null;
      if (!this.closing) {
        this.log('[relay] disconnected; scheduling reconnect');
        this.scheduleReconnect();
      }
    });
  }

  private scheduleReconnect(): void {
    if (this.closing || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * 2 ** this.reconnectAttempts
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing) this.open();
    }, delay);
    // Don't keep the event loop alive solely for a reconnect timer.
    (this.reconnectTimer as { unref?: () => void }).unref?.();
  }

  private sendReq(subId: string, filters: NostrFilter[]): void {
    this.sendRaw(['REQ', subId, ...filters]);
  }

  private sendRaw(message: unknown[]): void {
    if (!this.ws || !this.connected) return;
    try {
      this.ws.send(JSON.stringify(message));
    } catch (err) {
      this.log(`[relay] send failed: ${errMsg(err)}`);
    }
  }

  private handleMessage(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(toText(data));
    } catch {
      return;
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return;
    const type = parsed[0];
    switch (type) {
      case 'EVENT': {
        const subId = typeof parsed[1] === 'string' ? parsed[1] : '';
        const event = this.parseEventPayload(parsed[2]);
        if (event && typeof event.id === 'string')
          this.bufferEvent(subId, event);
        break;
      }
      case 'EOSE':
        // End of stored events — nothing to do; we keep streaming live events.
        break;
      case 'CLOSED':
        this.log(
          `[relay] subscription closed by relay: ${String(parsed[2] ?? '')}`
        );
        break;
      case 'NOTICE':
        this.log(`[relay] NOTICE: ${String(parsed[1] ?? '')}`);
        break;
      default:
        break;
    }
  }

  /**
   * Normalise an `EVENT` payload to a NostrEvent. Standard relays send a JSON
   * object; the TOON relay sends a TOON-encoded string, decoded via the injected
   * `decodeEvent`. Returns undefined when it can't be parsed.
   */
  private parseEventPayload(raw: unknown): NostrEvent | undefined {
    if (
      raw &&
      typeof raw === 'object' &&
      typeof (raw as NostrEvent).id === 'string'
    ) {
      return raw as NostrEvent;
    }
    if (typeof raw === 'string' && this.decodeEvent) {
      try {
        return this.decodeEvent(raw);
      } catch (err) {
        this.log(`[relay] event decode failed: ${errMsg(err)}`);
        return undefined;
      }
    }
    return undefined;
  }

  private bufferEvent(subId: string, event: NostrEvent): void {
    if (this.seen.has(event.id)) return; // de-dup by event.id
    this.seen.add(event.id);
    this.buffer.push({ seq: ++this.seqCounter, subId, event });
    if (this.buffer.length > this.bufferSize) {
      const evicted = this.buffer.shift();
      if (evicted) this.seen.delete(evicted.event.id);
    }
    // Mirror into the runner-level merged buffer (cross-relay fan-out reads).
    this.onEvent?.(subId, event);
  }
}

function toText(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return Buffer.from(data).toString('utf8');
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  return String(data);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Default factory backed by the `ws` package. When a `socks5h://` proxy is
 * provided, routes the WebSocket through it via `socks-proxy-agent` (optional
 * dependency, loaded lazily so the bundle works without it).
 */
function defaultWebSocketFactory(socksProxy?: string): WebSocketFactory {
  return (url: string): MinimalWebSocket => {
    const WebSocketImpl = nodeRequire('ws') as new (
      address: string,
      opts?: { agent?: unknown }
    ) => MinimalWebSocket;
    let agent: unknown;
    if (socksProxy) {
      const { SocksProxyAgent } = nodeRequire('socks-proxy-agent') as {
        SocksProxyAgent: new (proxy: string) => unknown;
      };
      agent = new SocksProxyAgent(socksProxy);
    }
    return new WebSocketImpl(url, agent ? { agent } : undefined);
  };
}

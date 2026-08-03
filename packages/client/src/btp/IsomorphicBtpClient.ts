/* eslint-disable @typescript-eslint/no-non-null-assertion -- ws is guaranteed non-null when _isConnected */
/**
 * Isomorphic BTP client — works in both browser and Node.js.
 * Uses native WebSocket (browser) or globalThis.WebSocket (Node 21+).
 * No dependency on `ws`, `events`, or `Buffer`.
 *
 * Replaces the @toon-protocol/connector BTPClient for the client SDK.
 */

import {
  BTPMessageType,
  ILPPacketType,
  serializeBtpMessage,
  serializeIlpPrepare,
  parseBtpMessage,
  deserializeIlpPacket,
  type BTPProtocolData,
  type BTPMessageData,
  type BTPTransferData,
  type BTPErrorData,
  type ILPPreparePacket,
  type ILPResponsePacket,
} from './protocol.js';

const textEncoder = new TextEncoder();

/** A server-originated MESSAGE (RFC-0023 symmetric grammar, toon-client#493). */
export interface InboundBtpMessage {
  requestId: number;
  protocolData: BTPProtocolData[];
  ilpPacket?: Uint8Array;
}

/** A server-originated TRANSFER — settlement value, never an ILP packet. */
export interface InboundBtpTransfer {
  requestId: number;
  amount: bigint;
  protocolData: BTPProtocolData[];
}

/** What an inbound handler answers with — becomes the RESPONSE frame's body. */
export interface BtpHandlerResponse {
  protocolData?: BTPProtocolData[];
  ilpPacket?: Uint8Array;
}

export type BtpMessageHandler = (
  message: InboundBtpMessage
) => Promise<BtpHandlerResponse> | BtpHandlerResponse;

export type BtpTransferHandler = (
  transfer: InboundBtpTransfer
) => Promise<BtpHandlerResponse> | BtpHandlerResponse;

export interface IsomorphicBtpClientConfig {
  url: string;
  peerId: string;
  authToken: string;
  sendTimeoutMs?: number;
  authTimeoutMs?: number;
  /** Custom WebSocket constructor (e.g., the Node `ws` package, or for testing). */
  createWebSocket?: (url: string) => WebSocket;
  /**
   * Handles a server-originated MESSAGE. Unset: an inbound MESSAGE is
   * dropped unanswered, matching the pre-#493 dialect (the server never
   * originated one).
   */
  onMessage?: BtpMessageHandler;
  /**
   * Handles a server-originated TRANSFER. Unset: every inbound TRANSFER
   * still gets an empty RESPONSE ack — RFC-0023 requires every request be
   * answered, and this mirrors the connector's own default (`btp.rs`:
   * received, not yet accounted).
   */
  onTransfer?: BtpTransferHandler;
  /**
   * Called when in-flight inbound work (a MESSAGE/TRANSFER handler that had
   * not yet replied) is orphaned by a disconnect, instead of silently
   * vanishing.
   */
  onInboundError?: (error: Error, requestId: number) => void;
}

interface PendingRequest {
  resolve: (packet: ILPResponsePacket) => void;
  reject: (error: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

export class BtpConnectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BtpConnectionError';
  }
}

export class BtpAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BtpAuthError';
  }
}

/**
 * Lightweight BTP client that speaks the BTP binary protocol over WebSocket.
 * Handles: connect → authenticate → send ILP packets → receive responses.
 */
export class IsomorphicBtpClient {
  private ws: WebSocket | null = null;
  private _isConnected = false;
  private requestIdCounter = 0;
  private readonly pendingRequests = new Map<number, PendingRequest>();
  /**
   * requestIds of server-originated MESSAGE/TRANSFER frames whose handler
   * has not yet replied. A wholly separate space from `pendingRequests`
   * (client-allocated ids awaiting a RESPONSE/ERROR): this client never
   * resolves a `pendingRequests` entry from an inbound MESSAGE/TRANSFER, and
   * never answers an inbound MESSAGE/TRANSFER as though it were one of its
   * own — the two are correlated purely by BTP frame type, not by whether an
   * id happens to collide (toon-client#493).
   */
  private readonly inFlightInbound = new Set<number>();
  /** Config keys that stay optional after defaults are applied — everything else becomes required. */
  private readonly config: Required<
    Omit<
      IsomorphicBtpClientConfig,
      'createWebSocket' | 'onMessage' | 'onTransfer' | 'onInboundError'
    >
  > &
    Pick<
      IsomorphicBtpClientConfig,
      'createWebSocket' | 'onMessage' | 'onTransfer' | 'onInboundError'
    >;

  constructor(config: IsomorphicBtpClientConfig) {
    this.config = {
      sendTimeoutMs: 30_000,
      authTimeoutMs: 5_000,
      ...config,
    };
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  async connect(): Promise<void> {
    if (this._isConnected) return;

    return new Promise<void>((resolve, reject) => {
      try {
        this.ws = this.config.createWebSocket
          ? this.config.createWebSocket(this.config.url)
          : new WebSocket(this.config.url);
        this.ws.binaryType = 'arraybuffer';
      } catch (err) {
        reject(
          new BtpConnectionError(
            `Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`
          )
        );
        return;
      }

      this.ws.onopen = async () => {
        try {
          await this.authenticate();
          this._isConnected = true;
          resolve();
        } catch (err) {
          this._isConnected = false;
          this.ws?.close();
          reject(err);
        }
      };

      this.ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data);
      };

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.ws.onerror = (event: any) => {
        const underlying = event?.error ?? event?.message;
        const detail =
          underlying instanceof Error
            ? underlying.message
            : typeof underlying === 'string'
              ? underlying
              : null;
        reject(
          new BtpConnectionError(
            detail
              ? `WebSocket connection error: ${detail}`
              : 'WebSocket connection error'
          )
        );
      };

      this.ws.onclose = () => {
        this._isConnected = false;
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeoutId);
          pending.reject(new BtpConnectionError('Connection closed'));
          this.pendingRequests.delete(id);
        }
        this.failInFlightInbound('Connection closed before inbound request could be answered');
      };
    });
  }

  async disconnect(): Promise<void> {
    this._isConnected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeoutId);
      pending.reject(new BtpConnectionError('Disconnected'));
      this.pendingRequests.delete(id);
    }
    this.failInFlightInbound('Disconnected before inbound request could be answered');
  }

  /**
   * Send an ILP PREPARE packet, optionally with protocol data (e.g. payment channel claim).
   * Returns the ILP response (FULFILL or REJECT).
   */
  async sendPacket(
    packet: ILPPreparePacket,
    protocolData?: BTPProtocolData[]
  ): Promise<ILPResponsePacket> {
    if (!this._isConnected || !this.ws) {
      throw new BtpConnectionError('Not connected');
    }

    const serializedIlp = serializeIlpPrepare(packet);
    const requestId = this.nextRequestId();

    const btpMessage = serializeBtpMessage({
      type: BTPMessageType.MESSAGE,
      requestId,
      data: {
        protocolData: protocolData ?? [],
        ilpPacket: serializedIlp,
      },
    });

    this.ws.send(btpMessage);

    // Calculate timeout from packet expiry or default
    let timeoutMs = this.config.sendTimeoutMs;
    if (packet.expiresAt) {
      const remaining = packet.expiresAt.getTime() - Date.now();
      timeoutMs = Math.max(remaining - 500, 1000);
    }

    return new Promise<ILPResponsePacket>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new BtpConnectionError(`Packet send timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeoutId });
    });
  }

  /**
   * Send a fire-and-forget BTP MESSAGE carrying only protocol data (no ILP
   * packet). Used for out-of-band claim notifications that the connector's
   * ClaimReceiver consumes via `handleClaimMessage` — there is no RESPONSE
   * frame, so we resolve immediately after the WebSocket buffers the bytes.
   *
   * Mirrors `sendPacket` wire-format construction but uses an empty ILP
   * payload and does not enroll a pending request.
   */
  async sendProtocolData(
    protocolName: string,
    contentType: number,
    data: Uint8Array
  ): Promise<void> {
    if (!this._isConnected || !this.ws) {
      throw new BtpConnectionError('Not connected');
    }

    const requestId = this.nextRequestId();
    const btpMessage = serializeBtpMessage({
      type: BTPMessageType.MESSAGE,
      requestId,
      data: {
        protocolData: [{ protocolName, contentType, data }],
        ilpPacket: new Uint8Array(0),
      },
    });

    this.ws.send(btpMessage);
  }

  // ─── Private ────────────────────────────────────────────────────────────

  private async authenticate(): Promise<void> {
    if (!this.ws) throw new BtpAuthError('WebSocket not connected');

    const authData = JSON.stringify({
      peerId: this.config.peerId,
      secret: this.config.authToken,
    });

    const requestId = this.nextRequestId();
    const authMessage = serializeBtpMessage({
      type: BTPMessageType.MESSAGE,
      requestId,
      data: {
        protocolData: [
          {
            protocolName: 'auth',
            contentType: 0,
            data: textEncoder.encode(authData),
          },
        ],
        ilpPacket: new Uint8Array(0),
      },
    });

    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new BtpAuthError('Authentication timeout'));
      }, this.config.authTimeoutMs);

      // Temporarily intercept messages for auth response
      const originalHandler = this.ws!.onmessage;
      this.ws!.onmessage = (event: MessageEvent) => {
        try {
          const data = this.toUint8Array(event.data);

          // Try JSON parse first (server may respond with JSON)
          try {
            const jsonStr = new TextDecoder().decode(data);
            if (jsonStr.startsWith('{')) {
              // JSON response — not a BTP binary auth response, ignore
            }
          } catch {
            /* not JSON */
          }

          // Parse as BTP binary
          const message = parseBtpMessage(data);
          if (message.requestId === requestId) {
            clearTimeout(timeout);
            this.ws!.onmessage = originalHandler;

            if (message.type === BTPMessageType.ERROR) {
              const errData = message.data as BTPErrorData;
              reject(
                new BtpAuthError(
                  `Authentication failed: ${errData.code} msg=${errData.message ?? ''} trigger=${errData.triggeredAt ?? ''}`
                )
              );
            } else if (message.type === BTPMessageType.RESPONSE) {
              resolve();
            }
          }
        } catch (err) {
          clearTimeout(timeout);
          this.ws!.onmessage = originalHandler;
          reject(
            new BtpAuthError(err instanceof Error ? err.message : String(err))
          );
        }
      };

      this.ws!.send(authMessage);
    });
  }

  private handleMessage(raw: unknown): void {
    // Try JSON first (server can send JSON FULFILL/REJECT responses)
    try {
      const data = this.toUint8Array(raw);
      const jsonStr = new TextDecoder().decode(data);
      if (jsonStr.startsWith('{')) {
        const json = JSON.parse(jsonStr) as Record<string, unknown>;
        if (json['type'] === 'FULFILL' || json['type'] === 'REJECT') {
          const first = this.pendingRequests.entries().next();
          if (!first.done) {
            const [id, pending] = first.value;
            clearTimeout(pending.timeoutId);
            this.pendingRequests.delete(id);

            if (json['type'] === 'FULFILL') {
              const responseData = json['data']
                ? this.base64ToUint8Array(json['data'] as string)
                : new Uint8Array(0);
              // JSON FULFILLs may carry the fulfillment preimage as base64;
              // absent means all-zero (legacy). A sender-chosen condition
              // (toon-client#350) then fails verification — fail-closed.
              const fulfillment = json['fulfillment']
                ? this.base64ToUint8Array(json['fulfillment'] as string)
                : new Uint8Array(32);
              pending.resolve({
                type: ILPPacketType.FULFILL,
                fulfillment,
                data: responseData,
              });
            } else {
              pending.resolve({
                type: ILPPacketType.REJECT,
                code: (json['code'] as string) || 'F00',
                message: (json['message'] as string) || 'Unknown error',
                data: json['data']
                  ? this.base64ToUint8Array(json['data'] as string)
                  : new Uint8Array(0),
              });
            }
          }
          return;
        }
      }
    } catch {
      /* not JSON, try BTP binary */
    }

    // BTP binary response
    try {
      const data = this.toUint8Array(raw);
      const message = parseBtpMessage(data);

      // RESPONSE/ERROR answers a request THIS client originated — correlate
      // against `pendingRequests` only, never `inFlightInbound` (toon-client#493:
      // the two id spaces are distinguished by frame type, not by value).
      if (
        message.type === BTPMessageType.RESPONSE ||
        message.type === BTPMessageType.ERROR
      ) {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) return;

        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.requestId);

        if (message.type === BTPMessageType.ERROR) {
          const errData = message.data as BTPErrorData;
          pending.reject(
            new BtpConnectionError(`BTP error: ${errData.code} ${errData.name}`)
          );
          return;
        }

        const msgData = message.data as BTPMessageData;
        if (msgData.ilpPacket && msgData.ilpPacket.length > 0) {
          const ilpResponse = deserializeIlpPacket(msgData.ilpPacket);
          pending.resolve(ilpResponse);
        }
        return;
      }

      // MESSAGE/TRANSFER carrying a requestId this client never allocated —
      // a server-originated request (RFC-0023's symmetric grammar). Dispatch
      // to the configured handler and answer with the same requestId; never
      // consult or touch `pendingRequests`.
      if (message.type === BTPMessageType.MESSAGE) {
        this.handleInboundMessage(message.requestId, message.data as BTPMessageData);
        return;
      }
      if (message.type === BTPMessageType.TRANSFER) {
        this.handleInboundTransfer(message.requestId, message.data as BTPTransferData);
        return;
      }
    } catch {
      // Unparseable message — ignore
    }
  }

  private handleInboundMessage(requestId: number, data: BTPMessageData): void {
    const handler = this.config.onMessage;
    if (!handler) return; // additive: no handler configured, no answer (pre-#493 behavior)
    this.dispatchInbound(requestId, () =>
      handler({
        requestId,
        protocolData: data.protocolData ?? [],
        ilpPacket: data.ilpPacket,
      })
    );
  }

  private handleInboundTransfer(requestId: number, data: BTPTransferData): void {
    const handler = this.config.onTransfer;
    const invoke = handler
      ? () =>
          handler({
            requestId,
            amount: data.amount,
            protocolData: data.protocolData ?? [],
          })
      : (): BtpHandlerResponse => ({});
    this.dispatchInbound(requestId, invoke);
  }

  private dispatchInbound(
    requestId: number,
    invoke: () => Promise<BtpHandlerResponse> | BtpHandlerResponse
  ): void {
    this.inFlightInbound.add(requestId);
    Promise.resolve()
      .then(invoke)
      .then(
        (result) => this.replyToInbound(requestId, result ?? {}),
        (err) => this.replyToInboundError(requestId, err)
      );
  }

  /** True if the reply is still owed — false means a disconnect already failed it loudly. */
  private takeInFlight(requestId: number): boolean {
    return this.inFlightInbound.delete(requestId);
  }

  private replyToInbound(requestId: number, result: BtpHandlerResponse): void {
    if (!this.takeInFlight(requestId)) return;
    if (!this._isConnected || !this.ws) {
      this.config.onInboundError?.(
        new BtpConnectionError(
          `Cannot answer inbound request ${requestId}: not connected`
        ),
        requestId
      );
      return;
    }
    try {
      const btpMessage = serializeBtpMessage({
        type: BTPMessageType.RESPONSE,
        requestId,
        data: {
          protocolData: result.protocolData ?? [],
          ilpPacket: result.ilpPacket ?? new Uint8Array(0),
        },
      });
      this.ws.send(btpMessage);
    } catch (err) {
      this.config.onInboundError?.(
        err instanceof Error ? err : new Error(String(err)),
        requestId
      );
    }
  }

  private replyToInboundError(requestId: number, error: unknown): void {
    if (!this.takeInFlight(requestId)) return;
    const message = error instanceof Error ? error.message : String(error);
    if (!this._isConnected || !this.ws) {
      this.config.onInboundError?.(
        new BtpConnectionError(
          `Cannot answer inbound request ${requestId}: not connected (handler error: ${message})`
        ),
        requestId
      );
      return;
    }
    try {
      const btpMessage = serializeBtpMessage({
        type: BTPMessageType.ERROR,
        requestId,
        data: {
          code: 'F00',
          name: 'NotAcceptedError',
          triggeredAt: '',
          message,
          data: textEncoder.encode(message),
        },
      });
      this.ws.send(btpMessage);
    } catch (err) {
      this.config.onInboundError?.(
        err instanceof Error ? err : new Error(String(err)),
        requestId
      );
    }
  }

  /** Fail every inbound request still awaiting its handler, loudly rather than silently. */
  private failInFlightInbound(reason: string): void {
    for (const requestId of this.inFlightInbound) {
      this.config.onInboundError?.(new BtpConnectionError(reason), requestId);
    }
    this.inFlightInbound.clear();
  }

  private toUint8Array(data: unknown): Uint8Array {
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return textEncoder.encode(data);
    throw new Error(`Unexpected WebSocket data type: ${typeof data}`);
  }

  private base64ToUint8Array(base64: string): Uint8Array {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  private nextRequestId(): number {
    this.requestIdCounter = (this.requestIdCounter + 1) & 0xffffffff;
    return this.requestIdCounter;
  }
}

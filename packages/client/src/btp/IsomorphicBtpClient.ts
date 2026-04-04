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
  type BTPErrorData,
  type ILPPreparePacket,
  type ILPResponsePacket,
} from './protocol.js';

const textEncoder = new TextEncoder();

export interface IsomorphicBtpClientConfig {
  url: string;
  peerId: string;
  authToken: string;
  sendTimeoutMs?: number;
  authTimeoutMs?: number;
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
  private readonly config: Required<IsomorphicBtpClientConfig>;

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
        this.ws = new WebSocket(this.config.url);
        this.ws.binaryType = 'arraybuffer';
      } catch (err) {
        reject(new BtpConnectionError(`Failed to create WebSocket: ${err instanceof Error ? err.message : String(err)}`));
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

      this.ws.onerror = () => {
        reject(new BtpConnectionError('WebSocket connection error'));
      };

      this.ws.onclose = () => {
        this._isConnected = false;
        // Reject all pending requests
        for (const [id, pending] of this.pendingRequests) {
          clearTimeout(pending.timeoutId);
          pending.reject(new BtpConnectionError('Connection closed'));
          this.pendingRequests.delete(id);
        }
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
  }

  /**
   * Send an ILP PREPARE packet, optionally with protocol data (e.g. payment channel claim).
   * Returns the ILP response (FULFILL or REJECT).
   */
  async sendPacket(
    packet: ILPPreparePacket,
    protocolData?: BTPProtocolData[],
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
        protocolData: [{
          protocolName: 'auth',
          contentType: 0,
          data: textEncoder.encode(authData),
        }],
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
          } catch { /* not JSON */ }

          // Parse as BTP binary
          const message = parseBtpMessage(data);
          if (message.requestId === requestId) {
            clearTimeout(timeout);
            this.ws!.onmessage = originalHandler;

            if (message.type === BTPMessageType.ERROR) {
              const errData = message.data as BTPErrorData;
              reject(new BtpAuthError(`Authentication failed: ${errData.code}`));
            } else if (message.type === BTPMessageType.RESPONSE) {
              resolve();
            }
          }
        } catch (err) {
          clearTimeout(timeout);
          this.ws!.onmessage = originalHandler;
          reject(new BtpAuthError(err instanceof Error ? err.message : String(err)));
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
              pending.resolve({ type: ILPPacketType.FULFILL, data: responseData });
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
    } catch { /* not JSON, try BTP binary */ }

    // BTP binary response
    try {
      const data = this.toUint8Array(raw);
      const message = parseBtpMessage(data);

      if (message.type === BTPMessageType.RESPONSE || message.type === BTPMessageType.ERROR) {
        const pending = this.pendingRequests.get(message.requestId);
        if (!pending) return;

        clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(message.requestId);

        if (message.type === BTPMessageType.ERROR) {
          const errData = message.data as BTPErrorData;
          pending.reject(new BtpConnectionError(`BTP error: ${errData.code} ${errData.name}`));
          return;
        }

        const msgData = message.data as BTPMessageData;
        if (msgData.ilpPacket && msgData.ilpPacket.length > 0) {
          const ilpResponse = deserializeIlpPacket(msgData.ilpPacket);
          pending.resolve(ilpResponse);
        }
      }
    } catch {
      // Unparseable message — ignore
    }
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

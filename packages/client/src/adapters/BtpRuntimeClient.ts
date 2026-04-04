import {
  IsomorphicBtpClient,
  BtpConnectionError,
} from '../btp/IsomorphicBtpClient.js';
import { ILPPacketType, type BTPProtocolData } from '../btp/protocol.js';
import type { IlpClient, IlpSendResult } from '@toon-protocol/core';
import { withRetry } from '../utils/retry.js';
import { toBase64, fromBase64, encodeUtf8 } from '../utils/binary.js';

export interface BtpRuntimeClientConfig {
  btpUrl: string;
  peerId: string;
  authToken: string;
  /** Max reconnection attempts on send failure (default: 3) */
  maxRetries?: number;
  /** Delay between reconnection attempts in ms (default: 1000) */
  retryDelay?: number;
}

/**
 * Returns true if the error is a connection-level error worth retrying.
 * ILP application-level rejects (F02, T01, etc.) are NOT retried.
 */
function isConnectionError(error: Error): boolean {
  const msg = error.message.toLowerCase();
  return (
    msg.includes('not connected') ||
    msg.includes('connection') ||
    msg.includes('websocket') ||
    msg.includes('econnrefused') ||
    msg.includes('econnreset') ||
    msg.includes('socket hang up') ||
    msg.includes('timeout')
  );
}

/**
 * BTP transport implementing IlpClient.
 * Uses IsomorphicBtpClient (browser-native, no Node.js dependencies).
 */
export class BtpRuntimeClient implements IlpClient {
  private btpClient: IsomorphicBtpClient | null = null;
  private readonly config: BtpRuntimeClientConfig;
  private _isConnected = false;

  constructor(config: BtpRuntimeClientConfig) {
    this.config = config;
  }

  /**
   * Connects to the BTP peer via WebSocket.
   */
  async connect(): Promise<void> {
    this.btpClient = new IsomorphicBtpClient({
      url: this.config.btpUrl,
      peerId: this.config.peerId,
      authToken: this.config.authToken,
    });

    await this.btpClient.connect();
    this._isConnected = true;
  }

  /**
   * Attempts to reconnect by creating a fresh client and connecting.
   */
  async reconnect(): Promise<void> {
    if (this.btpClient) {
      try {
        await this.btpClient.disconnect();
      } catch {
        // Ignore disconnect errors during reconnect
      }
      this.btpClient = null;
      this._isConnected = false;
    }

    await this.connect();
  }

  /**
   * Disconnects from the BTP peer.
   */
  async disconnect(): Promise<void> {
    if (this.btpClient) {
      await this.btpClient.disconnect();
      this._isConnected = false;
      this.btpClient = null;
    }
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Sends an ILP packet via BTP with auto-reconnect on connection errors.
   * Satisfies IlpClient interface.
   */
  async sendIlpPacket(params: {
    destination: string;
    amount: string;
    data: string;
    timeout?: number;
  }): Promise<IlpSendResult> {
    return withRetry(() => this._sendIlpPacketOnce(params), {
      maxRetries: this.config.maxRetries ?? 3,
      retryDelay: this.config.retryDelay ?? 1000,
      shouldRetry: (error) => {
        if (!isConnectionError(error)) return false;
        this._isConnected = false;
        return true;
      },
    });
  }

  /**
   * Sends a balance proof claim via BTP protocol data, then sends an ILP packet.
   * Auto-reconnects on connection errors.
   */
  async sendIlpPacketWithClaim(
    params: {
      destination: string;
      amount: string;
      data: string;
      timeout?: number;
    },
    claim: Record<string, unknown>
  ): Promise<IlpSendResult> {
    return withRetry(() => this._sendIlpPacketWithClaimOnce(params, claim), {
      maxRetries: this.config.maxRetries ?? 3,
      retryDelay: this.config.retryDelay ?? 1000,
      shouldRetry: (error) => {
        if (!isConnectionError(error)) return false;
        this._isConnected = false;
        return true;
      },
    });
  }

  /**
   * Single-attempt ILP packet send. Reconnects if not connected.
   */
  private async _sendIlpPacketOnce(params: {
    destination: string;
    amount: string;
    data: string;
    timeout?: number;
  }): Promise<IlpSendResult> {
    if (!this._isConnected) {
      await this.reconnect();
    }

    const response = await this.btpClient!.sendPacket({
      type: 12 as const,
      amount: BigInt(params.amount),
      destination: params.destination,
      executionCondition: new Uint8Array(32),
      expiresAt: new Date(Date.now() + (params.timeout ?? 30000)),
      data: fromBase64(params.data),
    });

    if (response.type === ILPPacketType.FULFILL) {
      return {
        accepted: true,
        data: response.data.length > 0 ? toBase64(response.data) : undefined,
      };
    }

    // Reject
    return {
      accepted: false,
      code: response.code,
      message: response.message,
      data: response.data.length > 0 ? toBase64(response.data) : undefined,
    };
  }

  /**
   * Single-attempt claim + ILP packet send. Reconnects if not connected.
   */
  private async _sendIlpPacketWithClaimOnce(
    params: {
      destination: string;
      amount: string;
      data: string;
      timeout?: number;
    },
    claim: Record<string, unknown>
  ): Promise<IlpSendResult> {
    if (!this._isConnected) {
      await this.reconnect();
    }

    if (!this.btpClient) {
      throw new BtpConnectionError('BTP client not connected');
    }

    const protocolData: BTPProtocolData[] = [
      {
        protocolName: 'payment-channel-claim',
        contentType: 1,
        data: encodeUtf8(JSON.stringify(claim)),
      },
    ];

    const response = await this.btpClient.sendPacket(
      {
        type: 12 as const,
        amount: BigInt(params.amount),
        destination: params.destination,
        executionCondition: new Uint8Array(32),
        expiresAt: new Date(Date.now() + (params.timeout ?? 30000)),
        data: fromBase64(params.data),
      },
      protocolData,
    );

    if (response.type === ILPPacketType.FULFILL) {
      return {
        accepted: true,
        data: response.data.length > 0 ? toBase64(response.data) : undefined,
      };
    }

    return {
      accepted: false,
      code: response.code,
      message: response.message,
      data: response.data.length > 0 ? toBase64(response.data) : undefined,
    };
  }
}

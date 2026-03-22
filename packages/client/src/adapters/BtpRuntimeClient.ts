import { BTPClient } from '@toon-protocol/connector';
import type { ILPPreparePacket } from '@toon-protocol/connector';
import type { IlpClient, IlpSendResult } from '@toon-protocol/core';
import type { EVMClaimMessage } from '../signing/evm-signer.js';
import { withRetry } from '../utils/retry.js';

/** BTP Peer — matches @toon-protocol/connector's Peer interface */
interface Peer {
  id: string;
  url: string;
  authToken: string;
  connected: boolean;
  lastSeen: Date;
}

/** BTP claim protocol constants — matches @toon-protocol/connector's BTP_CLAIM_PROTOCOL */
const BTP_CLAIM_PROTOCOL = {
  NAME: 'payment-channel-claim',
  CONTENT_TYPE: 1,
} as const;

/** Pino-compatible logger interface */
interface ConsoleLogger {
  level: string;
  silent: (...args: unknown[]) => void;
  info: typeof console.info;
  warn: typeof console.warn;
  error: typeof console.error;
  debug: typeof console.debug;
  trace: typeof console.debug;
  fatal: typeof console.error;
  child: () => ConsoleLogger;
}

/** Creates a pino-compatible logger wrapper around console */
function createConsoleLogger(): ConsoleLogger {
  const noop = (..._args: unknown[]) => {
    // intentional no-op for pino's silent log level
  };
  const logger: ConsoleLogger = {
    level: 'info',
    silent: noop,
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    debug: console.debug.bind(console),
    trace: console.debug.bind(console),
    fatal: console.error.bind(console),
    child: () => createConsoleLogger(),
  };
  return logger;
}

/** ILP packet type constants — matches @toon-protocol/connector's PacketType enum */
const ILP_PACKET_TYPE = {
  PREPARE: 12,
  FULFILL: 13,
  REJECT: 14,
} as const;

/** Shape of a BTP fulfill response */
interface BtpFulfillResponse {
  type: typeof ILP_PACKET_TYPE.FULFILL;
  data: Buffer;
}

/** Shape of a BTP reject response */
interface BtpRejectResponse {
  type: typeof ILP_PACKET_TYPE.REJECT;
  code: string;
  message: string;
  data: Buffer;
}

export interface BtpRuntimeClientConfig {
  btpUrl: string;
  peerId: string;
  authToken: string;
  logger?: ConsoleLogger;
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
 * Wraps BTPClient from @toon-protocol/connector with auto-reconnect on connection loss.
 */
export class BtpRuntimeClient implements IlpClient {
  private btpClient: BTPClient | null = null;
  private readonly config: BtpRuntimeClientConfig;
  private _isConnected = false;
  private readonly logger: ConsoleLogger;

  constructor(config: BtpRuntimeClientConfig) {
    this.config = config;
    this.logger = config.logger ?? createConsoleLogger();
  }

  /**
   * Connects to the BTP peer via WebSocket.
   */
  async connect(): Promise<void> {
    const peer: Peer = {
      id: this.config.peerId,
      url: this.config.btpUrl,
      authToken: this.config.authToken,
      connected: false,
      lastSeen: new Date(),
    };

    // Cast logger: ConsoleLogger implements the subset of pino's Logger
    // that BTPClient actually uses at runtime (info, warn, error, debug, child)
    this.btpClient = new BTPClient(
      peer,
      this.config.peerId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.logger as any
    );

    await this.btpClient.connect();
    this._isConnected = true;
  }

  /**
   * Attempts to reconnect by creating a fresh BTPClient and connecting.
   */
  async reconnect(): Promise<void> {
    // Clean up old client if it exists
    if (this.btpClient) {
      try {
        await this.btpClient.disconnect();
      } catch {
        // Ignore disconnect errors during reconnect
      }
      this.btpClient = null;
      this._isConnected = false;
    }

    this.logger.info('[BtpRuntimeClient] Reconnecting...');
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
        // Mark as disconnected so reconnect happens on next attempt
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
    claim: EVMClaimMessage
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

    const packet = {
      type: ILP_PACKET_TYPE.PREPARE,
      amount: BigInt(params.amount),
      destination: params.destination,
      executionCondition: Buffer.alloc(32),
      expiresAt: new Date(Date.now() + (params.timeout ?? 30000)),
      data: Buffer.from(params.data, 'base64'),
    } as ILPPreparePacket;

    const response = await this.btpClient?.sendPacket(packet);
    if (!response) {
      throw new Error('BTP client not connected');
    }

    if (response.type === ILP_PACKET_TYPE.FULFILL) {
      const fulfill = response as unknown as BtpFulfillResponse;
      return {
        accepted: true,
        data:
          fulfill.data.length > 0 ? fulfill.data.toString('base64') : undefined,
      };
    }

    // Reject packet — ILP application-level error, not a connection error
    const reject = response as unknown as BtpRejectResponse;
    return {
      accepted: false,
      code: reject.code,
      message: reject.message,
      data: reject.data.length > 0 ? reject.data.toString('base64') : undefined,
    };
  }

  /**
   * Single-attempt claim + ILP packet send. Reconnects if not connected.
   * Embeds the claim in the same BTP message as the ILP PREPARE packet.
   */
  private async _sendIlpPacketWithClaimOnce(
    params: {
      destination: string;
      amount: string;
      data: string;
      timeout?: number;
    },
    claim: EVMClaimMessage
  ): Promise<IlpSendResult> {
    if (!this._isConnected) {
      await this.reconnect();
    }

    if (!this.btpClient) {
      throw new Error('BTP client not connected');
    }

    const packet = {
      type: ILP_PACKET_TYPE.PREPARE,
      amount: BigInt(params.amount),
      destination: params.destination,
      executionCondition: Buffer.alloc(32),
      expiresAt: new Date(Date.now() + (params.timeout ?? 30000)),
      data: Buffer.from(params.data, 'base64'),
    } as ILPPreparePacket;

    // Send ILP packet with claim embedded in the same BTP message
    const protocolData = [
      {
        protocolName: BTP_CLAIM_PROTOCOL.NAME,
        contentType: BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
        data: Buffer.from(JSON.stringify(claim)),
      },
    ];

    const response = await this.btpClient.sendPacket(packet, protocolData);

    if (response.type === ILP_PACKET_TYPE.FULFILL) {
      const fulfill = response as unknown as BtpFulfillResponse;
      return {
        accepted: true,
        data:
          fulfill.data.length > 0 ? fulfill.data.toString('base64') : undefined,
      };
    }

    const reject = response as unknown as BtpRejectResponse;
    return {
      accepted: false,
      code: reject.code,
      message: reject.message,
      data: reject.data.length > 0 ? reject.data.toString('base64') : undefined,
    };
  }
}

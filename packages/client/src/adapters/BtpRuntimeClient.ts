import { BTPClient } from '@crosstown/connector';
import type { ILPPreparePacket } from '@crosstown/connector';
import type { IlpClient, IlpSendResult } from '@crosstown/core';
import type { EVMClaimMessage } from '../signing/evm-signer.js';

/** BTP Peer — matches @crosstown/connector's Peer interface */
interface Peer {
  id: string;
  url: string;
  authToken: string;
  connected: boolean;
  lastSeen: Date;
}

/** BTP claim protocol constants — matches @crosstown/connector's BTP_CLAIM_PROTOCOL */
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

/** ILP packet type constants — matches @crosstown/connector's PacketType enum */
const ILP_PACKET_TYPE = {
  PREPARE: 12,
  FULFILL: 13,
  REJECT: 14,
} as const;

/** Shape of a BTP fulfill response */
interface BtpFulfillResponse {
  type: typeof ILP_PACKET_TYPE.FULFILL;
  fulfillment: Buffer;
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
}

/**
 * BTP transport implementing IlpClient.
 * Wraps BTPClient from @crosstown/connector.
 */
export class BtpRuntimeClient implements IlpClient {
  private btpClient: BTPClient | null = null;
  private readonly config: BtpRuntimeClientConfig;
  private _isConnected = false;

  constructor(config: BtpRuntimeClientConfig) {
    this.config = config;
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
    const logger = this.config.logger ?? createConsoleLogger();
    this.btpClient = new BTPClient(
      peer,
      this.config.peerId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      logger as any
    );

    await this.btpClient.connect();
    this._isConnected = true;
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
   * Sends an ILP packet via BTP.
   * Satisfies IlpClient interface.
   */
  async sendIlpPacket(params: {
    destination: string;
    amount: string;
    data: string;
    timeout?: number;
  }): Promise<IlpSendResult> {
    if (!this.btpClient || !this._isConnected) {
      throw new Error('BTP client not connected. Call connect() first.');
    }

    const packet = {
      type: ILP_PACKET_TYPE.PREPARE,
      amount: BigInt(params.amount),
      destination: params.destination,
      executionCondition: Buffer.alloc(32),
      expiresAt: new Date(Date.now() + (params.timeout ?? 30000)),
      data: Buffer.from(params.data, 'base64'),
    } as ILPPreparePacket;

    try {
      const response = await this.btpClient.sendPacket(packet);

      if (response.type === ILP_PACKET_TYPE.FULFILL) {
        const fulfill = response as unknown as BtpFulfillResponse;
        return {
          accepted: true,
          fulfillment: fulfill.fulfillment.toString('base64'),
          data:
            fulfill.data.length > 0
              ? fulfill.data.toString('base64')
              : undefined,
        };
      }

      // Reject packet
      const reject = response as unknown as BtpRejectResponse;
      return {
        accepted: false,
        code: reject.code,
        message: reject.message,
        data:
          reject.data.length > 0 ? reject.data.toString('base64') : undefined,
      };
    } catch (error) {
      return {
        accepted: false,
        code: 'T00',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Sends a balance proof claim via BTP protocol data, then sends an ILP packet.
   *
   * @param params - ILP packet parameters
   * @param claim - EVM claim message to attach
   * @returns ILP send result
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
    if (!this.btpClient || !this._isConnected) {
      throw new Error('BTP client not connected. Call connect() first.');
    }

    // Send claim as BTP protocol data first
    await this.btpClient.sendProtocolData(
      BTP_CLAIM_PROTOCOL.NAME,
      BTP_CLAIM_PROTOCOL.CONTENT_TYPE,
      Buffer.from(JSON.stringify(claim))
    );

    // Then send the ILP packet
    return this.sendIlpPacket(params);
  }
}

import { BTPClient } from '@agent-society/connector';
import type { ILPPreparePacket } from '@agent-society/connector';
import type { AgentRuntimeClient, IlpSendResult } from '@crosstown/core';
import type { EVMClaimMessage } from '../signing/evm-signer.js';

/** BTP Peer — matches @agent-society/connector's Peer interface */
interface Peer {
  id: string;
  url: string;
  authToken: string;
  connected: boolean;
  lastSeen: Date;
}

/** BTP claim protocol constants — matches @agent-society/connector's BTP_CLAIM_PROTOCOL */
const BTP_CLAIM_PROTOCOL = {
  NAME: 'payment-channel-claim',
  CONTENT_TYPE: 1,
} as const;

/** ILP packet type constants — matches @agent-society/shared's PacketType enum */
const ILP_PACKET_TYPE = {
  PREPARE: 12,
  FULFILL: 13,
  REJECT: 14,
} as const;

export interface BtpRuntimeClientConfig {
  btpUrl: string;
  peerId: string;
  authToken: string;
  logger?: any;
}

/**
 * BTP transport implementing AgentRuntimeClient.
 * Wraps BTPClient from @agent-society/connector.
 */
export class BtpRuntimeClient implements AgentRuntimeClient {
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

    this.btpClient = new BTPClient(
      peer,
      this.config.peerId,
      this.config.logger ?? console
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
   * Satisfies AgentRuntimeClient interface.
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
        return {
          accepted: true,
          fulfillment: (response as any).fulfillment.toString('base64'),
          data: (response as any).data.length > 0 ? (response as any).data.toString('base64') : undefined,
        };
      }

      // Reject packet
      return {
        accepted: false,
        code: (response as any).code,
        message: (response as any).message,
        data: (response as any).data.length > 0 ? (response as any).data.toString('base64') : undefined,
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

import { describe, it, expect, vi, beforeEach } from 'vitest';

/** ILP packet type constants — matches @agent-society/shared's PacketType enum */
const ILP_PACKET_TYPE = {
  PREPARE: 12,
  FULFILL: 13,
  REJECT: 14,
} as const;

// Mock instances
const mockConnect = vi.fn();
const mockDisconnect = vi.fn();
const mockSendPacket = vi.fn();
const mockSendProtocolData = vi.fn();

// Mock @agent-society/connector
vi.mock('@agent-society/connector', () => {
  return {
    BTPClient: vi.fn().mockImplementation(() => ({
      connect: mockConnect,
      disconnect: mockDisconnect,
      sendPacket: mockSendPacket,
      sendProtocolData: mockSendProtocolData,
    })),
  };
});

import { BtpRuntimeClient } from './BtpRuntimeClient.js';

describe('BtpRuntimeClient', () => {
  let client: BtpRuntimeClient;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new BtpRuntimeClient({
      btpUrl: 'ws://localhost:3000',
      peerId: 'test-peer',
      authToken: 'test-token',
    });
  });

  describe('connect/disconnect lifecycle', () => {
    it('should connect successfully', async () => {
      mockConnect.mockResolvedValue(undefined);
      await client.connect();
      expect(client.isConnected).toBe(true);
    });

    it('should disconnect successfully', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockDisconnect.mockResolvedValue(undefined);
      await client.connect();
      await client.disconnect();
      expect(client.isConnected).toBe(false);
    });

    it('should handle disconnect when not connected', async () => {
      await client.disconnect(); // Should not throw
      expect(client.isConnected).toBe(false);
    });
  });

  describe('sendIlpPacket', () => {
    beforeEach(async () => {
      mockConnect.mockResolvedValue(undefined);
      await client.connect();
    });

    it('should throw when not connected', async () => {
      const disconnectedClient = new BtpRuntimeClient({
        btpUrl: 'ws://localhost:3000',
        peerId: 'test-peer',
        authToken: 'test-token',
      });

      await expect(
        disconnectedClient.sendIlpPacket({
          destination: 'g.test',
          amount: '1000',
          data: Buffer.from('test').toString('base64'),
        })
      ).rejects.toThrow('BTP client not connected');
    });

    it('should map fulfill response to IlpSendResult', async () => {
      mockSendPacket.mockResolvedValue({
        type: ILP_PACKET_TYPE.FULFILL,
        fulfillment: Buffer.from('fulfillment-data'),
        data: Buffer.from('response-data'),
      });

      const result = await client.sendIlpPacket({
        destination: 'g.test.relay',
        amount: '1000',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.accepted).toBe(true);
      expect(result.fulfillment).toBe(Buffer.from('fulfillment-data').toString('base64'));
      expect(result.data).toBe(Buffer.from('response-data').toString('base64'));
    });

    it('should map reject response to IlpSendResult', async () => {
      mockSendPacket.mockResolvedValue({
        type: ILP_PACKET_TYPE.REJECT,
        code: 'F02',
        triggeredBy: 'g.test',
        message: 'Insufficient funds',
        data: Buffer.alloc(0),
      });

      const result = await client.sendIlpPacket({
        destination: 'g.test.relay',
        amount: '1000',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.accepted).toBe(false);
      expect(result.code).toBe('F02');
      expect(result.message).toBe('Insufficient funds');
    });

    it('should handle errors gracefully', async () => {
      mockSendPacket.mockRejectedValue(new Error('Connection lost'));

      const result = await client.sendIlpPacket({
        destination: 'g.test.relay',
        amount: '1000',
        data: Buffer.from('test').toString('base64'),
      });

      expect(result.accepted).toBe(false);
      expect(result.code).toBe('T00');
      expect(result.message).toBe('Connection lost');
    });

    it('should create ILP packet with correct fields', async () => {
      mockSendPacket.mockResolvedValue({
        type: ILP_PACKET_TYPE.FULFILL,
        fulfillment: Buffer.alloc(32),
        data: Buffer.alloc(0),
      });

      await client.sendIlpPacket({
        destination: 'g.test.relay',
        amount: '5000',
        data: Buffer.from('hello').toString('base64'),
      });

      expect(mockSendPacket).toHaveBeenCalledWith(
        expect.objectContaining({
          type: ILP_PACKET_TYPE.PREPARE,
          amount: 5000n,
          destination: 'g.test.relay',
        })
      );
    });
  });

  describe('sendIlpPacketWithClaim', () => {
    beforeEach(async () => {
      mockConnect.mockResolvedValue(undefined);
      await client.connect();
    });

    it('should send claim protocol data then ILP packet', async () => {
      mockSendProtocolData.mockResolvedValue(undefined);
      mockSendPacket.mockResolvedValue({
        type: ILP_PACKET_TYPE.FULFILL,
        fulfillment: Buffer.alloc(32),
        data: Buffer.alloc(0),
      });

      const claim = {
        blockchain: 'evm' as const,
        senderId: 'test',
        channelId: '0x1234',
        nonce: 1,
        transferredAmount: '1000',
        lockedAmount: '0',
        locksRoot: '0x0000',
        signature: '0xabcd',
        signerAddress: '0x1111',
      };

      const result = await client.sendIlpPacketWithClaim(
        { destination: 'g.test', amount: '1000', data: '' },
        claim
      );

      expect(mockSendProtocolData).toHaveBeenCalledWith(
        'payment-channel-claim',
        1,
        expect.any(Buffer)
      );
      expect(result.accepted).toBe(true);

      // Verify claim was sent before packet
      const protocolCallOrder = mockSendProtocolData.mock.invocationCallOrder[0];
      const packetCallOrder = mockSendPacket.mock.invocationCallOrder[0];
      expect(protocolCallOrder).toBeLessThan(packetCallOrder);
    });

    it('should throw when not connected', async () => {
      const disconnectedClient = new BtpRuntimeClient({
        btpUrl: 'ws://localhost:3000',
        peerId: 'test-peer',
        authToken: 'test-token',
      });

      const claim = {
        blockchain: 'evm' as const,
        senderId: 'test',
        channelId: '0x1234',
        nonce: 1,
        transferredAmount: '1000',
        lockedAmount: '0',
        locksRoot: '0x0000',
        signature: '0xabcd',
        signerAddress: '0x1111',
      };

      await expect(
        disconnectedClient.sendIlpPacketWithClaim(
          { destination: 'g.test', amount: '1000', data: '' },
          claim
        )
      ).rejects.toThrow('BTP client not connected');
    });
  });
});

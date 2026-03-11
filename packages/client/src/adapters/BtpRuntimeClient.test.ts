import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/** ILP packet type constants — matches @crosstown/connector's PacketType enum */
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

// Mock @crosstown/connector
vi.mock('@crosstown/connector', () => {
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
    vi.useFakeTimers();
    vi.clearAllMocks();
    client = new BtpRuntimeClient({
      btpUrl: 'ws://localhost:3000',
      peerId: 'test-peer',
      authToken: 'test-token',
      maxRetries: 2,
      retryDelay: 100,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
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

    it('should auto-reconnect when not connected', async () => {
      // Simulate disconnection
      mockSendPacket
        .mockRejectedValueOnce(new Error('BTP client not connected'))
        .mockResolvedValueOnce({
          type: ILP_PACKET_TYPE.FULFILL,
          fulfillment: Buffer.alloc(32),
          data: Buffer.alloc(0),
        });
      mockDisconnect.mockResolvedValue(undefined);

      const resultPromise = client.sendIlpPacket({
        destination: 'g.test',
        amount: '1000',
        data: Buffer.from('test').toString('base64'),
      });

      // Advance through retry delay
      await vi.advanceTimersByTimeAsync(100);

      const result = await resultPromise;
      expect(result.accepted).toBe(true);
      // connect called: initial + reconnect
      expect(mockConnect).toHaveBeenCalledTimes(2);
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
      expect(result.fulfillment).toBe(
        Buffer.from('fulfillment-data').toString('base64')
      );
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

    it('should throw after exhausting retries on connection errors', async () => {
      mockSendPacket.mockRejectedValue(new Error('Connection lost'));
      mockDisconnect.mockResolvedValue(undefined);

      const resultPromise = client.sendIlpPacket({
        destination: 'g.test.relay',
        amount: '1000',
        data: Buffer.from('test').toString('base64'),
      });

      const errorPromise = resultPromise.catch((err) => err);

      // Advance through all retry delays
      await vi.advanceTimersByTimeAsync(100); // 1st retry
      await vi.advanceTimersByTimeAsync(200); // 2nd retry (exponential)

      const error = (await errorPromise) as Error;
      expect(error.message).toBe('Connection lost');
    });

    it('should not retry on ILP application errors (non-connection)', async () => {
      mockSendPacket.mockRejectedValue(new Error('Invalid packet format'));

      await expect(
        client.sendIlpPacket({
          destination: 'g.test.relay',
          amount: '1000',
          data: Buffer.from('test').toString('base64'),
        })
      ).rejects.toThrow('Invalid packet format');

      // Only one attempt, no retries
      expect(mockSendPacket).toHaveBeenCalledTimes(1);
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
      const protocolCallOrder =
        mockSendProtocolData.mock.invocationCallOrder[0];
      const packetCallOrder = mockSendPacket.mock.invocationCallOrder[0];
      expect(protocolCallOrder).toBeLessThan(packetCallOrder!);
    });

    it('should auto-reconnect on connection error during claim send', async () => {
      mockSendProtocolData
        .mockRejectedValueOnce(new Error('WebSocket closed'))
        .mockResolvedValueOnce(undefined);
      mockSendPacket.mockResolvedValue({
        type: ILP_PACKET_TYPE.FULFILL,
        fulfillment: Buffer.alloc(32),
        data: Buffer.alloc(0),
      });
      mockDisconnect.mockResolvedValue(undefined);

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

      const resultPromise = client.sendIlpPacketWithClaim(
        { destination: 'g.test', amount: '1000', data: '' },
        claim
      );

      await vi.advanceTimersByTimeAsync(100);

      const result = await resultPromise;
      expect(result.accepted).toBe(true);
      // connect called: initial + reconnect
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it('should throw when not connected and reconnect fails', async () => {
      const disconnectedClient = new BtpRuntimeClient({
        btpUrl: 'ws://localhost:3000',
        peerId: 'test-peer',
        authToken: 'test-token',
        maxRetries: 0,
      });

      mockConnect.mockRejectedValue(new Error('ECONNREFUSED'));

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
      ).rejects.toThrow('ECONNREFUSED');
    });
  });

  describe('reconnect', () => {
    it('should create a new BTPClient and connect', async () => {
      mockConnect.mockResolvedValue(undefined);
      mockDisconnect.mockResolvedValue(undefined);

      await client.connect();
      expect(client.isConnected).toBe(true);

      await client.reconnect();
      expect(client.isConnected).toBe(true);
      expect(mockConnect).toHaveBeenCalledTimes(2);
    });

    it('should handle reconnect when not previously connected', async () => {
      mockConnect.mockResolvedValue(undefined);

      await client.reconnect();
      expect(client.isConnected).toBe(true);
    });
  });
});

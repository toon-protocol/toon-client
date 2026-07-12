/**
 * Unit tests for ToonClient.sendSwapPacket (Story 12.5 AC-3).
 *
 * Covers:
 *   - INVALID_STATE before start()
 *   - NO_BTP_CLIENT when BTP client missing
 *   - MISSING_CLAIM when neither explicit claim nor ChannelManager provided
 *   - explicit claim happy path (forwards IlpSendResult verbatim)
 *   - auto-claim path via ChannelManager
 */

import { describe, it, expect, vi } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { ToonClientError } from './errors.js';

function baseConfig() {
  return {
    connectorUrl: 'http://localhost:9999',
    ilpInfo: {
      pubkey: '0'.repeat(64),
      ilpAddress: 'g.toon.test',
    },
    toonEncoder: (_e: unknown) => new Uint8Array(0),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

describe('ToonClient.sendSwapPacket (Story 12.5 AC-3)', () => {
  it('throws INVALID_STATE when client has not been started', async () => {
    const client = new ToonClient(baseConfig());
    await expect(
      client.sendSwapPacket({
        destination: 'g.toon.mill1',
        amount: 100n,
        toonData: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toMatchObject({
      name: 'ToonClientError',
      code: 'INVALID_STATE',
    });
  });

  it('throws NO_ILP_TRANSPORT when no active transport can send a packet+claim', async () => {
    const client = new ToonClient(baseConfig());
    // Inject a started state with no claim-capable transport: the runtimeClient
    // is the level-3 HttpRuntimeClient (no sendIlpPacketWithClaim) and there is
    // no BTP socket.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: undefined,
    };

    await expect(
      client.sendSwapPacket({
        destination: 'g.toon.mill1',
        amount: 100n,
        toonData: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toMatchObject({
      name: 'ToonClientError',
      code: 'NO_ILP_TRANSPORT',
    });
  });

  it('throws MISSING_CLAIM when neither claim nor ChannelManager provided', async () => {
    const client = new ToonClient(baseConfig());
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim: vi.fn() },
    };

    await expect(
      client.sendSwapPacket({
        destination: 'g.toon.mill1',
        amount: 100n,
        toonData: new Uint8Array([1, 2, 3]),
      })
    ).rejects.toThrow(ToonClientError);
  });

  it('forwards IlpSendResult verbatim on the explicit-claim happy path', async () => {
    const client = new ToonClient(baseConfig());

    const expectedResult = {
      accepted: true,
      data: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
    };
    const sendIlpPacketWithClaim = vi.fn(async () => expectedResult);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };

    // Stub the resolver to avoid needing a real EvmSigner + ChannelManager.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).resolveClaimForDestination = vi.fn(async () => ({
      fake: 'claim-message',
    }));

    const result = await client.sendSwapPacket({
      destination: 'g.toon.mill1',
      amount: 100n,
      toonData: new Uint8Array([1, 2, 3]),
      claim: { fake: true } as never,
    });

    expect(result).toBe(expectedResult);
    expect(sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    const [ilpParams, claimMessage] =
      sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect(ilpParams).toMatchObject({
      destination: 'g.toon.mill1',
      amount: '100',
    });
    // data is base64 of toonData
    expect(typeof (ilpParams as { data: unknown }).data).toBe('string');
    expect(claimMessage).toEqual({ fake: 'claim-message' });
  });

  it('auto-resolves claim via ChannelManager when no explicit claim supplied (AC-3 case b)', async () => {
    const client = new ToonClient(baseConfig());

    const expectedResult = {
      accepted: true,
      data: Buffer.from(JSON.stringify({ ok: true })).toString('base64'),
    };
    const sendIlpPacketWithClaim = vi.fn(async () => expectedResult);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };

    // Simulate a wired ChannelManager by stubbing the shared resolver so it
    // returns an auto-resolved claim message rather than throwing MISSING_CLAIM.
    const autoClaimMessage = { auto: 'resolved' };
    const resolverSpy = vi.fn(async () => autoClaimMessage);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).resolveClaimForDestination = resolverSpy;

    const result = await client.sendSwapPacket({
      destination: 'g.toon.mill1',
      amount: 250n,
      toonData: new Uint8Array([9, 8, 7]),
      // NOTE: no `claim` — exercise the auto-claim branch.
    });

    expect(result).toBe(expectedResult);
    // Resolver was invoked with destination + amount, and NO explicit claim.
    expect(resolverSpy).toHaveBeenCalledTimes(1);
    const resolverArgs = resolverSpy.mock.calls[0];
    expect(resolverArgs?.[0]).toBe('g.toon.mill1');
    expect(resolverArgs?.[1]).toBe(250n);
    expect(resolverArgs?.[2]).toBeUndefined();
    // BTP send received the auto-resolved claim message verbatim.
    const [, claimMessage] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect(claimMessage).toBe(autoClaimMessage);
  });

  it('forwards a sender-chosen executionCondition + expiresAt to the transport (#350)', async () => {
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async () => ({ accepted: true }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).resolveClaimForDestination = vi.fn(async () => ({
      fake: 'claim-message',
    }));

    const condition = new Uint8Array(32).fill(9);
    const expiresAt = new Date('2026-07-12T00:00:30.000Z');

    await client.sendSwapPacket({
      destination: 'g.toon.mill1',
      amount: 100n,
      toonData: new Uint8Array([1]),
      claim: { fake: true } as never,
      executionCondition: condition,
      expiresAt,
    });

    const [ilpParams] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect(ilpParams).toMatchObject({
      destination: 'g.toon.mill1',
      executionCondition: condition,
      expiresAt,
    });
  });

  it('omits condition/expiry from transport params by default (legacy zero-condition path)', async () => {
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async () => ({ accepted: true }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).resolveClaimForDestination = vi.fn(async () => ({
      fake: 'claim-message',
    }));

    await client.sendSwapPacket({
      destination: 'g.toon.mill1',
      amount: 100n,
      toonData: new Uint8Array([1]),
      claim: { fake: true } as never,
    });

    const [ilpParams] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect(ilpParams).not.toHaveProperty('executionCondition');
    expect(ilpParams).not.toHaveProperty('expiresAt');
  });
});

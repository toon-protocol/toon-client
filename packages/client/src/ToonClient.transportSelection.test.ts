/**
 * Unit tests for the transport-agnostic paid-write path
 * (connector-proxy alignment).
 *
 * `publishEvent`/`sendSwapPacket`/`sendPayment` must route the ILP PREPARE +
 * signed claim through the ACTIVE ILP transport — the `runtimeClient` (which is
 * the HttpIlpClient `POST /ilp` proxy transport when `proxyUrl`/
 * `connectorHttpEndpoint` is configured, else the BTP socket) — rather than
 * hard-requiring a BTP client. These tests assert the selection precedence
 * (runtimeClient first, btpClient fallback) and the NO_ILP_TRANSPORT error when
 * neither transport can send a packet+claim.
 */

import { describe, it, expect, vi } from 'vitest';
import { ToonClient } from './ToonClient.js';
import type { NostrEvent } from 'nostr-tools/pure';
import type { SignedBalanceProof } from './types.js';

const SECRET_KEY = new Uint8Array(32).fill(7);

function baseConfig() {
  return {
    secretKey: SECRET_KEY,
    connectorUrl: 'http://localhost:9999',
    destinationAddress: 'g.proxy',
    ilpInfo: { pubkey: '0'.repeat(64), ilpAddress: 'g.toon.test' },
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

function makeEvent(): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: '0'.repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: 'hi',
    sig: 'b'.repeat(128),
  } as unknown as NostrEvent;
}

function makeProof(): SignedBalanceProof {
  return {
    channelId:
      '0xdff44167e826f9f85e5f046f2358c79c8354691b44a89cac0e7f584612258d2d',
    nonce: 1,
    transferredAmount: 1_000_000n,
    lockedAmount: 0n,
    locksRoot: '0x' + '0'.repeat(64),
    signature: '0x' + 'c'.repeat(130),
    signerAddress: '0x' + 'd'.repeat(40),
    chainId: 31337,
    tokenNetworkAddress: '0x' + 'e'.repeat(40),
  } as unknown as SignedBalanceProof;
}

describe('ToonClient paid-write transport selection', () => {
  it('publishEvent routes through runtimeClient (HTTP proxy) when it implements sendIlpPacketWithClaim', async () => {
    const client = new ToonClient(baseConfig());

    const httpSend = vi.fn(async () => ({ accepted: true }));
    const btpSend = vi.fn(async () => ({ accepted: true }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      // Simulates the HttpIlpClient being the selected runtime client (proxyUrl set).
      runtimeClient: { sendIlpPacketWithClaim: httpSend, sendIlpPacket: vi.fn() },
      peersDiscovered: 0,
      // No BTP client at all on the proxy path.
      btpClient: undefined,
    };

    const result = await client.publishEvent(makeEvent(), { claim: makeProof() });

    expect(result.success).toBe(true);
    expect(httpSend).toHaveBeenCalledTimes(1);
    expect(btpSend).not.toHaveBeenCalled();
    expect(httpSend.mock.calls[0]?.[0]).toMatchObject({ destination: 'g.proxy' });
  });

  it('prefers runtimeClient over btpClient when both implement the claim method', async () => {
    const client = new ToonClient(baseConfig());
    const httpSend = vi.fn(async () => ({ accepted: true }));
    const btpSend = vi.fn(async () => ({ accepted: true }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: { sendIlpPacketWithClaim: httpSend },
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim: btpSend },
    };

    await client.publishEvent(makeEvent(), { claim: makeProof() });
    expect(httpSend).toHaveBeenCalledTimes(1);
    expect(btpSend).not.toHaveBeenCalled();
  });

  it('falls back to btpClient when runtimeClient lacks the claim method', async () => {
    const client = new ToonClient(baseConfig());
    const btpSend = vi.fn(async () => ({ accepted: true }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      // Level-3 HttpRuntimeClient: implements sendIlpPacket only, no claim variant.
      runtimeClient: { sendIlpPacket: vi.fn() },
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim: btpSend },
    };

    await client.publishEvent(makeEvent(), { claim: makeProof() });
    expect(btpSend).toHaveBeenCalledTimes(1);
  });

  it('throws NO_ILP_TRANSPORT when no active transport can send a packet+claim', async () => {
    const client = new ToonClient(baseConfig());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: { sendIlpPacket: vi.fn() }, // no claim method
      peersDiscovered: 0,
      btpClient: undefined,
    };

    // sendPayment surfaces the transport error directly (no PUBLISH_ERROR wrap).
    await expect(
      client.sendPayment({
        destination: 'g.proxy',
        amount: '1000000',
        claim: makeProof(),
      })
    ).rejects.toMatchObject({ code: 'NO_ILP_TRANSPORT' });
  });

  it('sendPayment routes through the active transport (proxy) with the inline claim', async () => {
    const client = new ToonClient(baseConfig());
    const httpSend = vi.fn(async () => ({ accepted: true }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: { sendIlpPacketWithClaim: httpSend },
      peersDiscovered: 0,
      btpClient: undefined,
    };

    const res = await client.sendPayment({
      destination: 'g.proxy',
      amount: '1000000',
      claim: makeProof(),
    });
    expect(res.accepted).toBe(true);
    expect(httpSend).toHaveBeenCalledTimes(1);
  });
});

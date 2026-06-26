/**
 * Unit tests for ToonClient.publishEvent claim DELIVERY MECHANISM (Story 50.3 AC#1).
 *
 * Regression guard for the F06 ("No payment channel claim attached to packet")
 * root cause: when a caller supplies a pre-signed `{ claim }`, the signed
 * balance-proof MUST be attached INLINE on the ILP PREPARE packet as a
 * `payment-channel-claim` BTP protocol-data entry (so the per-packet
 * `InboundClaimValidator` on the receiving connector accepts it). It MUST NOT
 * be delivered ONLY via the out-of-band `sendClaimMessage` (claim-receiver)
 * path — that async settlement channel does not satisfy the per-packet
 * validator, which `return null`s for amount 0 and emits F06 when no inline
 * `payment-channel-claim` protocol-data entry is present.
 *
 * These tests assert at the `publishEvent` surface that the inline transport
 * method (`sendIlpPacketWithClaim`) is the one invoked, carrying the claim, and
 * that the async-only path (`sendClaimMessage`) is NOT used as the sole
 * delivery mechanism.
 */

import { describe, it, expect, vi } from 'vitest';
import { ToonClient } from './ToonClient.js';
import type { NostrEvent } from 'nostr-tools/pure';
import type { SignedBalanceProof } from './types.js';

// A deterministic 32-byte secret key so getPublicKey() works.
const SECRET_KEY = new Uint8Array(32).fill(7);

function baseConfig() {
  return {
    secretKey: SECRET_KEY,
    connectorUrl: 'http://localhost:9999',
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '0'.repeat(64),
      ilpAddress: 'g.toon.test',
    },
    // Non-empty encoder so the computed default amount is > 0 (claim path).
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
    content: 'hello relay',
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

describe('ToonClient.publishEvent claim delivery mechanism (Story 50.3 AC#1)', () => {
  it('attaches the explicit claim INLINE via sendIlpPacketWithClaim (not the async claim-receiver path)', async () => {
    const client = new ToonClient(baseConfig());

    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: true,
      data: undefined,
    }));
    // The async out-of-band path must NOT be the delivery mechanism for the
    // PREPARE's claim — if publishEvent ever routes here instead of inline, the
    // receiving per-packet validator emits F06.
    const sendClaimMessage = vi.fn(async () => undefined);
    const sendIlpPacket = vi.fn(async () => ({ accepted: true }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim, sendClaimMessage, sendIlpPacket },
    };

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
    });

    expect(result.success).toBe(true);

    // INLINE path used exactly once.
    expect(sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    // Async claim-receiver path was NOT used as the (sole) delivery mechanism.
    expect(sendClaimMessage).not.toHaveBeenCalled();

    const [ilpParams, claimMessage] =
      sendIlpPacketWithClaim.mock.calls[0] ?? [];

    // The PREPARE targets the configured apex destination.
    expect(ilpParams).toMatchObject({ destination: 'g.proxy' });

    // The claim message carried inline is the EVM claim derived from the proof,
    // matching the connector's `payment-channel-claim` validator expectations.
    expect(claimMessage).toMatchObject({
      blockchain: 'evm',
      channelId: makeProof().channelId,
      signature: makeProof().signature,
      signerAddress: makeProof().signerAddress,
      transferredAmount: '1000000',
    });
  });

  // --- Bug 1: a non-2xx HTTP-over-ILP FULFILL must FAIL the publish ----------

  /** base64 of a full HTTP/1.1 response message (the FULFILL `data` shape). */
  function httpFulfill(status: number, statusText: string, body: string): string {
    const head =
      `HTTP/1.1 ${status} ${statusText}\r\n` +
      `content-length: ${Buffer.byteLength(body, 'utf-8')}\r\n` +
      `\r\n`;
    return Buffer.from(head + body, 'utf-8').toString('base64');
  }

  it('FAILS the publish (no fake eventId) when the FULFILL HTTP status is non-2xx', async () => {
    const client = new ToonClient(baseConfig());

    // ACCEPTED ILP FULFILL whose `data` decodes to a 404 — payment cleared but
    // the relay did NOT persist the event. Must NOT report success.
    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: true,
      data: httpFulfill(404, 'Not Found', '404 Not Found'),
    }));

    // Real-ish channel-manager spy: the explicit-claim path does not re-sign, so
    // signBalanceProof must never run here — asserting it is not called confirms
    // the failed write does not advance the nonce watermark beyond what the
    // caller already signed (nonce semantics match the REJECT path).
    const signBalanceProof = vi.fn();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = { signBalanceProof, isTracking: () => false };

    const result = await client.publishEvent(makeEvent(), { claim: makeProof() });

    expect(result.success).toBe(false);
    expect(result.eventId).toBeUndefined();
    expect(result.error).toMatch(/404/);
    // No re-signing on the explicit-claim failure path → no extra nonce burn.
    expect(signBalanceProof).not.toHaveBeenCalled();
  });

  it('SUCCEEDS when the FULFILL HTTP status is 2xx', async () => {
    const client = new ToonClient(baseConfig());
    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: true,
      data: httpFulfill(200, 'OK', 'ok'),
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };

    const result = await client.publishEvent(makeEvent(), { claim: makeProof() });
    expect(result.success).toBe(true);
    expect(result.eventId).toBe(makeEvent().id);
  });

  it('preserves success for a non-HTTP FULFILL (legacy / non-proxy relays)', async () => {
    const client = new ToonClient(baseConfig());
    // Bare, non-HTTP base64 payload — must not be treated as a failed write.
    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: true,
      data: Buffer.from('ack:1', 'utf-8').toString('base64'),
    }));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim },
    };

    const result = await client.publishEvent(makeEvent(), { claim: makeProof() });
    expect(result.success).toBe(true);
    expect(result.eventId).toBe(makeEvent().id);
  });

  it('honors an explicit ilpAmount override while still attaching the claim inline', async () => {
    const client = new ToonClient(baseConfig());

    const sendIlpPacketWithClaim = vi.fn(async () => ({
      accepted: true,
      data: undefined,
    }));
    const sendClaimMessage = vi.fn(async () => undefined);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).state = {
      bootstrapService: {},
      discoveryTracker: {},
      runtimeClient: {},
      peersDiscovered: 0,
      btpClient: { sendIlpPacketWithClaim, sendClaimMessage },
    };

    const result = await client.publishEvent(makeEvent(), {
      claim: makeProof(),
      ilpAmount: 1_000_000n,
    });

    expect(result.success).toBe(true);
    expect(sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    expect(sendClaimMessage).not.toHaveBeenCalled();

    const [ilpParams] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect(ilpParams).toMatchObject({ amount: '1000000' });
  });
});

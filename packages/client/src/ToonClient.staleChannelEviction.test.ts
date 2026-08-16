/**
 * A paid write refused with `F01 - ... names a channel this connector has no
 * record of` evicts the binding that produced the claim and retries ONCE
 * against a re-resolved channel (toon-client#581).
 *
 * The counterparty check #578/#580 added runs before a packet exists and can
 * only catch a record that visibly disagrees with the destination's announce.
 * A node that keeps its settlement address but loses its channel state passes
 * that check and refuses every write — which is what happened live to both
 * `rig` and the daemon on 2026-08-16, with hand-editing `~/.toon-client`
 * as the only recovery. The reject is the connector's own answer, so it, not
 * inference, drives the eviction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { ChannelManager } from './channel/ChannelManager.js';
import { InMemoryChannelStore } from './channel/ChannelStore.js';
import { EvmSigner } from './signing/evm-signer.js';
import { generatePrivateKey } from 'viem/accounts';
import type { IlpSendResult } from '@toon-protocol/core';

const CHAIN = 'evm:84532';
const PEER_ID = 'toon';
const SETTLEMENT = '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff';
const TOKEN_NETWORK = '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478';

const LOST_CHANNEL = `0x${'11'.repeat(32)}`;
const HELD_CHANNEL = `0x${'22'.repeat(32)}`;

/** The message the live devnet connector returns for a claim it cannot place. */
const F01_UNKNOWN_CHANNEL = {
  accepted: false as const,
  code: 'F01',
  message:
    'claim rejected: names a channel this connector has no record of, so ' +
    'there is no counterparty to verify its signature against',
};

/** `F01` for a claim whose nonce did not advance — a HEALTHY channel. */
const F01_NONCE_RACE = {
  accepted: false as const,
  code: 'F01',
  message: 'claim rejected: NonceNotAdvancing (expected > 41, got 41)',
};

const NEGOTIATION = {
  chain: CHAIN,
  chainType: 'evm',
  chainId: 84532,
  settlementAddress: SETTLEMENT,
  tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
  tokenNetwork: TOKEN_NETWORK,
};

function baseConfig() {
  return {
    secretKey: new Uint8Array(32).fill(7),
    connectorUrl: 'http://connector.test',
    destinationAddress: 'g.toon',
    supportedChains: [CHAIN],
    ilpInfo: { pubkey: '0'.repeat(64), ilpAddress: 'g.toon.test' },
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

/**
 * A started client whose ChannelManager is REAL (so bindings, supersession and
 * re-resolution are the shipped code) over a fake on-chain opener that models
 * the idempotent open: it hands back whichever channel this identity already
 * holds with the counterparty.
 */
function startedClient(opts: {
  /** Channel ids the opener returns, in order. */
  opens: string[];
  /** Results the transport returns, in order. */
  responses: IlpSendResult[];
}) {
  const client = new ToonClient(baseConfig());

  const openChannel = vi.fn(async () => ({
    channelId: opts.opens.shift() ?? HELD_CHANNEL,
    status: 'opening',
  }));
  const store = new InMemoryChannelStore();
  const manager = new ChannelManager(
    new EvmSigner(generatePrivateKey()),
    store
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
  manager.setChannelClient({ openChannel } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private field
  (client as any).channelManager = manager;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private field
  (client as any).peerNegotiations.set(PEER_ID, NEGOTIATION);

  const sendIlpPacketWithClaim = vi.fn(
    async () => opts.responses.shift() ?? { accepted: true }
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- private field
  (client as any).state = {
    bootstrapService: {},
    discoveryTracker: { getAllDiscoveredPeers: () => [] },
    discoverySubscription: { requiredTransportFor: () => undefined },
    runtimeClient: { sendIlpPacketWithClaim },
    peersDiscovered: 0,
  };

  return { client, manager, store, openChannel, sendIlpPacketWithClaim };
}

/** A paid write, taken at the `sendSwapPacket` seam (no sealing to mock). */
function write(client: ToonClient): Promise<IlpSendResult> {
  return client.sendSwapPacket({
    destination: 'g.toon',
    amount: 1000n,
    toonData: new Uint8Array([1, 2, 3]),
  });
}

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warn.mockRestore();
});

describe('an F01 naming an unknown channel evicts its binding and re-resolves', () => {
  it('recovers the write on a re-resolved channel instead of failing', async () => {
    const t = startedClient({
      opens: [LOST_CHANNEL, HELD_CHANNEL],
      responses: [F01_UNKNOWN_CHANNEL, { accepted: true }],
    });

    const result = await write(t.client);

    expect(result.accepted).toBe(true);
    expect(t.sendIlpPacketWithClaim).toHaveBeenCalledTimes(2);
    // The retry rides the RE-RESOLVED channel, not the dead one.
    expect(t.manager.getChannelForPeer(PEER_ID)).toBe(HELD_CHANNEL);
  });

  it('supersedes the dead binding rather than deleting it (deposit stays reclaimable)', async () => {
    const t = startedClient({
      opens: [LOST_CHANNEL, HELD_CHANNEL],
      responses: [F01_UNKNOWN_CHANNEL, { accepted: true }],
    });

    await write(t.client);

    const key = `${PEER_ID}|${CHAIN}|${TOKEN_NETWORK}`;
    expect(t.store.loadBinding(key)?.channelId).toBe(HELD_CHANNEL);
    const archived = t.store
      .listBindings()
      .find((b) => b.binding.channelId === LOST_CHANNEL);
    expect(archived?.key).toBe(`${key}|superseded:${LOST_CHANNEL}`);
    expect(archived?.binding.supersededAt).toEqual(expect.any(String));
  });

  it('re-resolves through the ordinary open path — no forced extra on-chain open', async () => {
    // The opener is idempotent on-chain: it binds whatever channel this
    // identity already holds with this counterparty. Modelled by handing the
    // SAME id back on the second call, as the live TokenNetwork does.
    const t = startedClient({
      opens: [LOST_CHANNEL, LOST_CHANNEL],
      responses: [F01_UNKNOWN_CHANNEL, { accepted: true }],
    });

    const result = await write(t.client);

    // Re-resolution landed back on the same channel, so there is nothing to
    // retry against — the original failure is reported rather than the write
    // being re-sent (and re-charged) onto the very channel that refused it.
    expect(result).toMatchObject({ accepted: false, code: 'F01' });
    expect(t.sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    // ONE resolution per write: no channel-per-write open storm.
    expect(t.openChannel).toHaveBeenCalledTimes(2);
    expect(t.openChannel.mock.calls[1]?.[0]).toMatchObject({
      peerAddress: SETTLEMENT,
    });
  });

  it('retries exactly ONCE — a second F01 is the failure, not another eviction', async () => {
    const t = startedClient({
      opens: [LOST_CHANNEL, HELD_CHANNEL, `0x${'33'.repeat(32)}`],
      responses: [F01_UNKNOWN_CHANNEL, F01_UNKNOWN_CHANNEL],
    });

    const result = await write(t.client);

    expect(result).toMatchObject({ accepted: false, code: 'F01' });
    expect(t.sendIlpPacketWithClaim).toHaveBeenCalledTimes(2);
    // The second channel is NOT evicted: a loop here opens one channel per
    // write and burns the gas the retry exists to save.
    expect(t.manager.getChannelForPeer(PEER_ID)).toBe(HELD_CHANNEL);
    expect(t.openChannel).toHaveBeenCalledTimes(2);
  });

  it('leaves a NONCE-race F01 alone — that channel is healthy', async () => {
    const t = startedClient({
      opens: [HELD_CHANNEL],
      responses: [F01_NONCE_RACE],
    });

    const result = await write(t.client);

    expect(result).toMatchObject({ code: 'F01' });
    expect(t.sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    expect(t.manager.getChannelForPeer(PEER_ID)).toBe(HELD_CHANNEL);
    expect(
      t.store.loadBinding(`${PEER_ID}|${CHAIN}|${TOKEN_NETWORK}`)?.channelId
    ).toBe(HELD_CHANNEL);
  });

  it('leaves an F02 (no route) alone — nothing about the channel is in question', async () => {
    const t = startedClient({
      opens: [HELD_CHANNEL],
      responses: [
        { accepted: false, code: 'F02', message: 'No route to destination' },
      ],
    });

    const result = await write(t.client);

    expect(result).toMatchObject({ code: 'F02' });
    expect(t.sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    expect(t.manager.getChannelForPeer(PEER_ID)).toBe(HELD_CHANNEL);
  });

  it('does not evict on an EXPLICIT caller-supplied claim — no binding of ours behind it', async () => {
    const t = startedClient({
      opens: [HELD_CHANNEL],
      responses: [F01_UNKNOWN_CHANNEL],
    });
    // Bind the channel the way a previous write would have, then send with a
    // claim the caller signed itself.
    await t.manager.ensureChannel(PEER_ID, NEGOTIATION);

    const result = await t.client.sendSwapPacket({
      destination: 'g.toon',
      amount: 1000n,
      toonData: new Uint8Array([1, 2, 3]),
      claim: {
        channelId: HELD_CHANNEL,
        nonce: 1,
        transferredAmount: 1000n,
        lockedAmount: 0n,
        locksRoot: `0x${'00'.repeat(32)}`,
        signature: `0x${'ab'.repeat(65)}`,
      } as never,
    });

    expect(result).toMatchObject({ code: 'F01' });
    expect(t.sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    expect(t.manager.getChannelForPeer(PEER_ID)).toBe(HELD_CHANNEL);
  });

  it('does not evict when the reject names a DIFFERENT channel', async () => {
    const t = startedClient({
      opens: [HELD_CHANNEL],
      responses: [
        {
          accepted: false,
          code: 'F01',
          message: `claim rejected: no record of channel 0x${'99'.repeat(32)}`,
        },
      ],
    });

    const result = await write(t.client);

    expect(result).toMatchObject({ code: 'F01' });
    expect(t.sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);
    expect(t.manager.getChannelForPeer(PEER_ID)).toBe(HELD_CHANNEL);
  });
});

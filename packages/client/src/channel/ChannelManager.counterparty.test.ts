import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generatePrivateKey } from 'viem/accounts';
import { EvmSigner } from '../signing/evm-signer.js';
import { ChannelManager } from './ChannelManager.js';
import { InMemoryChannelStore, JsonFileChannelStore } from './ChannelStore.js';
import type { ChannelStore } from './ChannelStore.js';

/**
 * A recorded peer→channel binding survives the node that terminates its route
 * being REPLACED (toon-meta: the devnet apex `g.toon` was retired 2026-08-14
 * and other nodes took over the names under it).
 *
 * The binding key is `peer|chain|tokenNetwork` — a ROUTE, with no counterparty
 * in it — so all three fields kept matching and `resumeChannel` handed back a
 * channel opened against the retired node. Every claim signed on it came back
 * `F01 - claim rejected: names a channel this connector has no record of`, and
 * a `toon_upload` to `g.toon.ario` failed even though a CORRECT binding for
 * that destination sat in the same file. Deleting the dead record by hand was
 * the only fix.
 */

const RELAY_SETTLEMENT = '0x3F43d923a611bCB2D0Bfb5d6ee2C3AC3EfEaf308';
const STORE_SETTLEMENT = '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff';
/** The retired `g.toon` apex, destroyed 2026-08-14. */
const RETIRED_SETTLEMENT = '0xf29fd62c4848b9573c9b90adbf61b664f386d9cf';

const TOKEN_NETWORK = '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478';

function negotiationFor(settlementAddress: string) {
  return {
    chain: 'evm:84532',
    chainType: 'evm',
    chainId: 84532,
    settlementAddress,
    tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
    tokenNetwork: TOKEN_NETWORK,
  };
}

const DEAD_CHANNEL =
  '0x413d0c87b29428100cbd600c3c1b9d67e67d16ff0f7a7960bffedee6740a1c5d';
const LIVE_CHANNEL =
  '0xa220e723602d448be11ac52559a6043c03ed64635ebcf7c45437b1a8e809594c';
const REOPENED_CHANNEL = '0x' + 'c3'.repeat(32);

describe('ChannelManager counterparty validation on resume', () => {
  let signer: EvmSigner;

  beforeEach(() => {
    signer = new EvmSigner(generatePrivateKey());
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  function managerWith(store: ChannelStore, opensAs: string) {
    const openChannel = vi.fn(async () => ({
      channelId: opensAs,
      status: 'opening',
    }));
    const mgr = new ChannelManager(signer, store);
    mgr.setChannelClient({
      openChannel,
    } as unknown as Parameters<ChannelManager['setChannelClient']>[0]);
    return { mgr, openChannel };
  }

  /** Record a binding the way a previous process's successful open would have. */
  async function record(
    store: ChannelStore,
    peerId: string,
    settlementAddress: string,
    channelId: string
  ): Promise<void> {
    const { mgr } = managerWith(store, channelId);
    await mgr.ensureChannel(peerId, negotiationFor(settlementAddress));
  }

  it('does not reuse a binding whose counterparty no longer matches the announce', async () => {
    const store = new InMemoryChannelStore();
    await record(store, 'toon', RETIRED_SETTLEMENT, DEAD_CHANNEL);

    // Fresh process. The route is unchanged — same peer, same chain, same token
    // network — but a different node answers it now.
    const next = managerWith(store, REOPENED_CHANNEL);
    const resolved = await next.mgr.ensureChannel(
      'toon',
      negotiationFor(STORE_SETTLEMENT)
    );

    expect(resolved).not.toBe(DEAD_CHANNEL);
    expect(resolved).toBe(REOPENED_CHANNEL);
    // Re-resolved against the address announced NOW, so the connector can
    // verify the claims signed on it.
    expect(next.openChannel).toHaveBeenCalledWith(
      expect.objectContaining({ peerAddress: STORE_SETTLEMENT })
    );
  });

  it('still resumes a sibling binding whose counterparty is current', async () => {
    // Both records live in the SAME store, exactly as `channels.peers.json`
    // held them: the dead `toon` one and the working store one.
    const store = new InMemoryChannelStore();
    await record(store, 'toon', RETIRED_SETTLEMENT, DEAD_CHANNEL);
    await record(
      store,
      'nostr-499cdd71c7c3eab8',
      STORE_SETTLEMENT,
      LIVE_CHANNEL
    );

    const next = managerWith(store, REOPENED_CHANNEL);
    const resumed = await next.mgr.ensureChannel(
      'nostr-499cdd71c7c3eab8',
      negotiationFor(STORE_SETTLEMENT)
    );

    expect(resumed).toBe(LIVE_CHANNEL);
    expect(next.openChannel).not.toHaveBeenCalled();
  });

  it('ARCHIVES the retired binding rather than dropping it (its deposit is still on-chain)', async () => {
    const store = new InMemoryChannelStore();
    await record(store, 'toon', RETIRED_SETTLEMENT, DEAD_CHANNEL);

    const next = managerWith(store, REOPENED_CHANNEL);
    await next.mgr.ensureChannel('toon', negotiationFor(STORE_SETTLEMENT));

    const live = `toon|evm:84532|${TOKEN_NETWORK}`;
    // Gone from the resume path…
    expect(store.loadBinding?.(live)?.channelId).toBe(REOPENED_CHANNEL);
    // …but still enumerable, so whatever it locked stays reclaimable.
    const archived = store
      .listBindings?.()
      .find((b) => b.binding.channelId === DEAD_CHANNEL);
    expect(archived).toBeDefined();
    expect(archived?.key).toBe(`${live}|superseded:${DEAD_CHANNEL}`);
    expect(archived?.binding.supersededAt).toEqual(expect.any(String));
    expect(archived?.binding.context.recipient).toBe(RETIRED_SETTLEMENT);
  });

  it('resumes a legacy binding with no recorded counterparty and back-fills it', async () => {
    // Pre-validation records carry no `context.recipient`: unverified, not
    // stale. Refusing them would open (and fund) a second on-chain channel on
    // no evidence at all.
    const store = new InMemoryChannelStore();
    store.save(LIVE_CHANNEL, { nonce: 4, cumulativeAmount: 4000n });
    store.saveBinding(`relay|evm:84532|${TOKEN_NETWORK}`, {
      channelId: LIVE_CHANNEL,
      context: {
        chainType: 'evm',
        chainId: 84532,
        tokenNetworkAddress: TOKEN_NETWORK,
      },
    });

    const next = managerWith(store, REOPENED_CHANNEL);
    const resumed = await next.mgr.ensureChannel(
      'relay',
      negotiationFor(RELAY_SETTLEMENT)
    );

    expect(resumed).toBe(LIVE_CHANNEL);
    expect(next.openChannel).not.toHaveBeenCalled();
    // Backfilled, so the NEXT run can verify it instead of trusting it forever.
    expect(
      store.loadBinding?.(`relay|evm:84532|${TOKEN_NETWORK}`)?.context.recipient
    ).toBe(RELAY_SETTLEMENT);
  });

  it('tolerates the checksum case an announce carries (no false supersede)', async () => {
    const store = new InMemoryChannelStore();
    await record(store, 'ario', STORE_SETTLEMENT.toLowerCase(), LIVE_CHANNEL);

    const next = managerWith(store, REOPENED_CHANNEL);
    const resumed = await next.mgr.ensureChannel(
      'ario',
      negotiationFor('0x6B6C2DAcF7ac1f1273F72Bef2E6084f9EE6d3bFF')
    );

    expect(resumed).toBe(LIVE_CHANNEL);
    expect(next.openChannel).not.toHaveBeenCalled();
  });

  it('survives a restart through the real file-backed store', async () => {
    const path = join(
      tmpdir(),
      `counterparty-${Date.now()}-${Math.random()}.json`
    );
    try {
      await record(
        new JsonFileChannelStore(path),
        'toon',
        RETIRED_SETTLEMENT,
        DEAD_CHANNEL
      );

      const next = managerWith(
        new JsonFileChannelStore(path),
        REOPENED_CHANNEL
      );
      const resolved = await next.mgr.ensureChannel(
        'toon',
        negotiationFor(STORE_SETTLEMENT)
      );
      expect(resolved).toBe(REOPENED_CHANNEL);

      const onDisk = JSON.parse(
        readFileSync(path.replace(/\.json$/, '.peers.json'), 'utf-8')
      ) as Record<string, { channelId: string; supersededAt?: string }>;
      const live = `toon|evm:84532|${TOKEN_NETWORK}`;
      expect(onDisk[live]?.channelId).toBe(REOPENED_CHANNEL);
      expect(onDisk[live]?.supersededAt).toBeUndefined();
      expect(onDisk[`${live}|superseded:${DEAD_CHANNEL}`]?.channelId).toBe(
        DEAD_CHANNEL
      );
    } finally {
      rmSync(path, { force: true });
      rmSync(path.replace(/\.json$/, '.peers.json'), { force: true });
    }
  });
});

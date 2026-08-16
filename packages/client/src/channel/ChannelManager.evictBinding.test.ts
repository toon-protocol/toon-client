/**
 * `evictBinding` — the GROUND-TRUTH counterpart to the counterparty check
 * (toon-client#581).
 *
 * #578/#580's check is a prediction: it catches a binding whose recorded
 * counterparty visibly disagrees with what the destination announces today. A
 * node that keeps its settlement address but loses its channel state — a wiped
 * connector, a restored-from-backup box, a redeployed contract — passes that
 * check and then refuses every paid write with
 * `F01 - claim rejected: names a channel this connector has no record of`.
 * That happened live on 2026-08-16 to both `rig` and the daemon, and the only
 * recovery was hand-editing JSON.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import { EvmSigner } from '../signing/evm-signer.js';
import { ChannelManager } from './ChannelManager.js';
import { InMemoryChannelStore } from './ChannelStore.js';
import type { ChannelStore } from './ChannelStore.js';

const SETTLEMENT = '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff';
const TOKEN_NETWORK = '0xa79C3b1dbcEA00a6d84735a134395D8eF6D6a478';

const LOST_CHANNEL = `0x${'11'.repeat(32)}`;
const HELD_CHANNEL = `0x${'22'.repeat(32)}`;

function negotiation() {
  return {
    chain: 'evm:84532',
    chainType: 'evm',
    chainId: 84532,
    settlementAddress: SETTLEMENT,
    tokenAddress: '0x49beE1Bca5d15Fb0963117923403F9498119a9Ce',
    tokenNetwork: TOKEN_NETWORK,
  };
}

describe('ChannelManager.evictBinding (toon-client#581)', () => {
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
    mgr.setChannelClient(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      { openChannel } as any
    );
    return { mgr, openChannel };
  }

  it('retires the binding the refused claim was drawn on, so the next resolve re-resolves', async () => {
    const store = new InMemoryChannelStore();
    const first = managerWith(store, LOST_CHANNEL);
    expect(await first.mgr.ensureChannel('toon', negotiation())).toBe(
      LOST_CHANNEL
    );
    // Poisoned: without eviction this binding is handed back to every
    // subsequent write, forever.
    expect(await first.mgr.ensureChannel('toon', negotiation())).toBe(
      LOST_CHANNEL
    );

    expect(first.mgr.evictBinding('toon', negotiation(), LOST_CHANNEL)).toBe(
      true
    );

    // The counterparty is UNCHANGED — this is precisely the case the
    // counterparty check cannot see.
    const next = managerWith(store, HELD_CHANNEL);
    expect(await next.mgr.ensureChannel('toon', negotiation())).toBe(
      HELD_CHANNEL
    );
  });

  it('re-resolves through the ordinary open path — no forced/extra on-chain open', async () => {
    const store = new InMemoryChannelStore();
    const { mgr, openChannel } = managerWith(store, LOST_CHANNEL);
    await mgr.ensureChannel('toon', negotiation());
    expect(openChannel).toHaveBeenCalledTimes(1);

    mgr.evictBinding('toon', negotiation(), LOST_CHANNEL);

    // The opener is idempotent on-chain: it binds whatever channel this
    // identity ALREADY holds with this counterparty. Modelled here by handing
    // the same id back.
    const held = managerWith(store, HELD_CHANNEL);
    await held.mgr.ensureChannel('toon', negotiation());
    await held.mgr.ensureChannel('toon', negotiation());

    // Exactly ONE resolution attempt across two writes: the second is served
    // from the re-established binding, not from a second open.
    expect(held.openChannel).toHaveBeenCalledTimes(1);
    expect(held.openChannel.mock.calls[0]?.[0]).toMatchObject({
      peerAddress: SETTLEMENT,
    });
  });

  it('SUPERSEDES rather than deletes, so the dead channel’s deposit stays reclaimable', async () => {
    const store = new InMemoryChannelStore();
    const { mgr } = managerWith(store, LOST_CHANNEL);
    await mgr.ensureChannel('toon', negotiation());
    const key = `toon|evm:84532|${TOKEN_NETWORK}`;

    mgr.evictBinding('toon', negotiation(), LOST_CHANNEL);

    // Gone from the resume path…
    expect(store.loadBinding?.(key)).toBeUndefined();
    // …but still enumerable, so whatever it locked stays reclaimable.
    const archived = store
      .listBindings?.()
      .find((b) => b.binding.channelId === LOST_CHANNEL);
    expect(archived?.key).toBe(`${key}|superseded:${LOST_CHANNEL}`);
    expect(archived?.binding.supersededAt).toEqual(expect.any(String));
    // The channel itself stays TRACKED so close/settle still work on it.
    expect(mgr.isTracking(LOST_CHANNEL)).toBe(true);
  });

  it('refuses to retire a binding that names a DIFFERENT channel', async () => {
    // A concurrent write may already have re-resolved this peer. Retiring the
    // replacement would open a third channel.
    const store = new InMemoryChannelStore();
    const { mgr } = managerWith(store, HELD_CHANNEL);
    await mgr.ensureChannel('toon', negotiation());

    expect(mgr.evictBinding('toon', negotiation(), LOST_CHANNEL)).toBe(false);
    expect(await mgr.ensureChannel('toon', negotiation())).toBe(HELD_CHANNEL);
  });

  it('is a no-op when there is no binding to retire', () => {
    const store = new InMemoryChannelStore();
    const { mgr } = managerWith(store, HELD_CHANNEL);
    expect(mgr.evictBinding('toon', negotiation(), LOST_CHANNEL)).toBe(false);
  });
});

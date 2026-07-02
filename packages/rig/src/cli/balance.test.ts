/**
 * `rig balance` tests (#263): joins the client's wallet-balance readers
 * (injected money ops) with the #262 channel map + claim watermark —
 * deposited / claimed / available per recorded channel of the ACTIVE
 * identity only — as a free read (`requireUplink: false`, no confirm gate,
 * no client start).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelMapStore } from '../standalone/channel-map.js';
import type { WalletBalanceInfo } from '../standalone/money.js';
import { BALANCE_USAGE, runBalance, type BalanceDeps } from './balance.js';
import type { CliIo } from './push.js';
import type {
  StandaloneContext,
  StandaloneLoadOptions,
} from './standalone-context.js';

const IDENTITY = 'a'.repeat(64);
const OTHER_IDENTITY = 'b'.repeat(64);
const CHANNEL_ID = '0x' + '11'.repeat(32);
const OTHER_CHANNEL_ID = '0x' + '99'.repeat(32);

interface Harness {
  deps: BalanceDeps;
  out: string[];
  err: string[];
  loads: StandaloneLoadOptions[];
  stopped: boolean;
}

function makeHarness(
  env: NodeJS.ProcessEnv,
  wallet: WalletBalanceInfo[] = []
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const loads: StandaloneLoadOptions[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isInteractive: false,
    confirm: async () => false,
  };
  const harness: Harness = {
    out,
    err,
    loads,
    stopped: false,
    deps: undefined as unknown as BalanceDeps,
  };
  const context: StandaloneContext = {
    ownerPubkey: IDENTITY,
    identitySource: 'env',
    identitySourceLabel: 'RIG_MNEMONIC env',
    publisher: {
      getFeeRates: async () => ({ uploadFeePerByte: 10n, eventFee: 1n }),
      uploadGitObject: async () => {
        throw new Error('balance never uploads');
      },
      publishEvent: async () => {
        throw new Error('balance never publishes');
      },
    },
    defaultRelayUrls: [],
    fetchRemote: async () => {
      throw new Error('balance never reads remote state');
    },
    money: {
      openChannel: async () => {
        throw new Error('balance never opens channels');
      },
      closeChannel: async () => {
        throw new Error('balance never closes channels');
      },
      settleChannel: async () => {
        throw new Error('balance never settles channels');
      },
      walletBalances: async () => wallet,
    },
    stop: async () => {
      harness.stopped = true;
    },
  };
  harness.deps = {
    io,
    env,
    cwd: '/nonexistent',
    loadStandalone: async (options) => {
      loads.push(options);
      return context;
    },
  };
  return harness;
}

describe('rig balance', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-balance-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedChannels(): void {
    const store = new ChannelMapStore({
      mapPath: join(dir, 'rig-channels.json'),
      watermarkPath: join(dir, 'channels.json'),
    });
    store.record({
      channelId: CHANNEL_ID,
      peerId: 'nostr-2813187e',
      identity: IDENTITY,
      destination: 'g.proxy.relay.store',
      chain: 'evm:31337',
      tokenNetwork: '0x' + '22'.repeat(20),
      context: {
        chainType: 'evm',
        chainId: 31337,
        tokenNetworkAddress: '0x' + '22'.repeat(20),
      },
      depositTotal: '100000',
    });
    // Another identity's channel — must NOT show up in this identity's view.
    store.record({
      channelId: OTHER_CHANNEL_ID,
      peerId: 'nostr-ffffffff',
      identity: OTHER_IDENTITY,
      destination: 'g.proxy.relay.store',
      chain: 'evm:31337',
      tokenNetwork: '0x' + '22'.repeat(20),
      context: {
        chainType: 'evm',
        chainId: 31337,
        tokenNetworkAddress: '0x' + '22'.repeat(20),
      },
    });
    writeFileSync(
      join(dir, 'channels.json'),
      JSON.stringify({
        [CHANNEL_ID]: { nonce: 15, cumulativeAmount: '16120' },
      })
    );
  }

  const WALLET: WalletBalanceInfo[] = [
    {
      chain: 'evm',
      address: '0x' + 'ab'.repeat(20),
      amount: '9983880',
      asset: 'USDC',
      assetScale: 6,
    },
  ];

  it('joins wallet balances with map+watermark channel holdings (--json)', async () => {
    seedChannels();
    const h = makeHarness({ TOON_CLIENT_HOME: dir }, WALLET);
    expect(await runBalance(['--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: 'balance',
      identity: { pubkey: IDENTITY, source: 'env' },
      wallet: WALLET,
      channels: [
        {
          channelId: CHANNEL_ID,
          destination: 'g.proxy.relay.store',
          peerId: 'nostr-2813187e',
          chain: 'evm:31337',
          status: 'open',
          depositTotal: '100000',
          cumulativeClaimed: '16120',
          nonce: 15,
          // deposited − claimed
          available: '83880',
        },
      ],
    });
    expect(h.stopped).toBe(true);
  });

  it('is a free read: the loader is asked to tolerate a missing uplink', async () => {
    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance([], h.deps)).toBe(0);
    expect(h.loads[0]?.requireUplink).toBe(false);
  });

  it("other identities' channels are excluded from the view", async () => {
    seedChannels();
    const h = makeHarness({ TOON_CLIENT_HOME: dir }, WALLET);
    expect(await runBalance(['--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as {
      channels: { channelId: string }[];
    };
    expect(parsed.channels.map((c) => c.channelId)).toEqual([CHANNEL_ID]);
  });

  it('renders the human view: identity, wallet lines, channel lines', async () => {
    seedChannels();
    const h = makeHarness({ TOON_CLIENT_HOME: dir }, WALLET);
    expect(await runBalance([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain(`Identity: ${IDENTITY} (from RIG_MNEMONIC env)`);
    expect(text).toContain('Wallet (on-chain):');
    expect(text).toMatch(/evm\s+0xabab.*9983880 USDC \(scale 6\)/);
    expect(text).toContain('Channels (recorded):');
    expect(text).toContain(
      `${CHANNEL_ID} [open]  deposited 100000  claimed 16120  available 83880`
    );
  });

  it('handles no balances and no channels gracefully', async () => {
    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('no balance readable');
    expect(text).toContain('none — paid commands record their channel');
  });

  it('an unknown deposit or claim yields a null available (never a guess)', async () => {
    const store = new ChannelMapStore({
      mapPath: join(dir, 'rig-channels.json'),
      watermarkPath: join(dir, 'channels.json'),
    });
    store.record({
      channelId: CHANNEL_ID,
      peerId: 'nostr-2813187e',
      identity: IDENTITY,
      destination: 'g.proxy.relay.store',
      chain: 'evm:31337',
      tokenNetwork: '',
      context: { chainType: 'evm', chainId: 31337, tokenNetworkAddress: '' },
      // no depositTotal, no watermark entry
    });
    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance(['--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as {
      channels: { available: string | null; cumulativeClaimed: string | null }[];
    };
    expect(parsed.channels[0]).toMatchObject({
      available: null,
      cumulativeClaimed: null,
    });
  });

  it('a corrupt channel map is a clear error (exit 1)', async () => {
    writeFileSync(join(dir, 'rig-channels.json'), 'not-json{');
    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance(['--json'], h.deps)).toBe(1);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed['error']).toBe('channel_map_corrupt');
    expect(h.stopped).toBe(true);
  });

  it('--help prints usage', async () => {
    const h = makeHarness({});
    expect(await runBalance(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toBe(BALANCE_USAGE);
    expect(h.loads).toEqual([]);
  });
});

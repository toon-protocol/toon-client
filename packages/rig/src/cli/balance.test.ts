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
import type { WalletChainBalanceInfo } from '../standalone/money.js';
import {
  BALANCE_USAGE,
  readWalletBounded,
  runBalance,
  walletReadTimeoutMs,
  WalletReadTimeoutError,
  type BalanceDeps,
} from './balance.js';
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
  wallet: WalletChainBalanceInfo[] = [],
  // Override the wallet reader itself (e.g. a hanging or rejecting read) —
  // defaults to resolving `wallet` immediately.
  walletImpl?: () => Promise<WalletChainBalanceInfo[]>
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const loads: StandaloneLoadOptions[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    // The machine document lands in the same `out` stream the pre-#265
    // assertions read (production routes it to the real stdout).
    emitJson: (payload) => out.push(JSON.stringify(payload, null, 2)),
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
      walletChainBalances: walletImpl ?? (async () => wallet),
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

  const EVM_ADDR = '0x' + 'ab'.repeat(20);
  const SOL_ADDR = 'So1anaAddr11111111111111111111111111111111';
  const MINA_ADDR = 'B62qMinaAddr1111111111111111111111111111111';

  // The full 2×3 matrix: native + USDC on EVM and Solana; native MINA only.
  const WALLET: WalletChainBalanceInfo[] = [
    {
      chain: 'evm',
      chainKey: 'evm:31337',
      address: EVM_ADDR,
      native: { symbol: 'ETH', amount: '1500000000000000000', decimals: 18 },
      tokens: [
        {
          symbol: 'USDC',
          amount: '9983880',
          decimals: 6,
          address: '0x' + 'cc'.repeat(20),
        },
      ],
    },
    {
      chain: 'solana',
      chainKey: 'solana',
      address: SOL_ADDR,
      native: { symbol: 'SOL', amount: '2000000000', decimals: 9 },
      tokens: [{ symbol: 'USDC', amount: '0', decimals: 6, address: 'MintUSDC' }],
    },
    {
      chain: 'mina',
      chainKey: 'mina',
      address: MINA_ADDR,
      native: { symbol: 'MINA', amount: '0', decimals: 9 },
      tokens: [],
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
          // claims within the deposit → no overdraft
          overdrawn: '0',
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

  it('renders the human view: identity, per-chain native+USDC, channel lines', async () => {
    seedChannels();
    const h = makeHarness({ TOON_CLIENT_HOME: dir }, WALLET);
    expect(await runBalance([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain(`Identity: ${IDENTITY} (from RIG_MNEMONIC env)`);
    expect(text).toContain('Wallet (on-chain):');
    // EVM: native ETH (18 dec → 1.5) + USDC (6 dec → 9.98388), same chain block.
    expect(text).toMatch(/evm:31337\s+0xabab/);
    expect(text).toMatch(/ETH 1\.5\s+USDC 9\.98388/);
    // Solana: native SOL (9 dec → 2) + USDC 0, on the solana block.
    expect(text).toMatch(/solana\s+So1ana/);
    expect(text).toMatch(/SOL 2\s+USDC 0/);
    // Mina: native MINA only (no configured token).
    expect(text).toMatch(/mina\s+B62qMina/);
    expect(text).toContain('MINA 0');
    expect(text).toContain('Channels (recorded):');
    expect(text).toContain(
      `${CHANNEL_ID} [open]  deposited 100000  claimed 16120  available 83880`
    );
  });

  it('a chain whose RPC is unreachable degrades to a per-chain notice, not a crash', async () => {
    const wallet: WalletChainBalanceInfo[] = [
      { ...WALLET[0]! },
      {
        chain: 'solana',
        chainKey: 'solana',
        address: SOL_ADDR,
        tokens: [],
        unreadable: true,
        error: 'Solana RPC request failed: HTTP 502',
      },
    ];
    const h = makeHarness({ TOON_CLIENT_HOME: dir }, wallet);
    expect(await runBalance([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    // The reachable EVM chain still renders …
    expect(text).toMatch(/ETH 1\.5\s+USDC 9\.98388/);
    // … and the unreachable one shows a clear notice with the cause.
    expect(text).toMatch(/solana\s+So1ana/);
    expect(text).toContain('unreadable (RPC unreachable)');
    expect(text).toContain('HTTP 502');
  });

  it('--json carries the full per-chain native+tokens shape', async () => {
    const h = makeHarness({ TOON_CLIENT_HOME: dir }, WALLET);
    expect(await runBalance(['--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as { wallet: WalletChainBalanceInfo[] };
    expect(parsed.wallet).toEqual(WALLET);
    expect(parsed.wallet[0]).toMatchObject({
      chain: 'evm',
      chainKey: 'evm:31337',
      native: { symbol: 'ETH', amount: '1500000000000000000', decimals: 18 },
      tokens: [{ symbol: 'USDC', amount: '9983880', decimals: 6 }],
    });
  });

  it('handles no balances and no channels gracefully', async () => {
    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('no chain configured');
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
      overdrawn: null,
    });
  });

  it('claims beyond the deposit surface as overdrawn, not just available 0', async () => {
    // Live-devnet shape (channel 0xea1a942b…, 2026-07-21): the recorded
    // deposit matches the chain, but the peer kept accepting claims past the
    // collateral — the on-chain TokenNetwork caps redemption at the deposit,
    // so the excess is unsecured. `available` floors at 0 (correct: nothing
    // is left) and the overdraft is reported separately.
    const store = new ChannelMapStore({
      mapPath: join(dir, 'rig-channels.json'),
      watermarkPath: join(dir, 'channels.json'),
    });
    store.record({
      channelId: CHANNEL_ID,
      peerId: 'nostr-2813187e',
      identity: IDENTITY,
      destination: 'g.toon.relay',
      chain: 'evm:84532',
      tokenNetwork: '0x' + '22'.repeat(20),
      context: {
        chainType: 'evm',
        chainId: 84532,
        tokenNetworkAddress: '0x' + '22'.repeat(20),
      },
      depositTotal: '100000',
    });
    writeFileSync(
      join(dir, 'channels.json'),
      JSON.stringify({
        [CHANNEL_ID]: { nonce: 31, cumulativeAmount: '140840' },
      })
    );

    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance(['--json'], h.deps)).toBe(0);
    const parsed = JSON.parse(h.out.join('\n')) as {
      channels: { available: string; overdrawn: string }[];
    };
    expect(parsed.channels[0]).toMatchObject({
      depositTotal: '100000',
      cumulativeClaimed: '140840',
      available: '0',
      overdrawn: '40840',
    });

    const h2 = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance([], h2.deps)).toBe(0);
    const text = h2.out.join('\n');
    expect(text).toContain(
      `${CHANNEL_ID} [open]  deposited 100000  claimed 140840  available 0`
    );
    expect(text).toContain('OVERDRAWN by 40840');
    expect(text).toContain('rig channel open --deposit');
  });

  it('a channel exactly spent (claimed == deposited) is NOT flagged overdrawn', async () => {
    const store = new ChannelMapStore({
      mapPath: join(dir, 'rig-channels.json'),
      watermarkPath: join(dir, 'channels.json'),
    });
    store.record({
      channelId: CHANNEL_ID,
      peerId: 'nostr-2813187e',
      identity: IDENTITY,
      destination: 'g.toon.relay',
      chain: 'evm:84532',
      tokenNetwork: '0x' + '22'.repeat(20),
      context: {
        chainType: 'evm',
        chainId: 84532,
        tokenNetworkAddress: '0x' + '22'.repeat(20),
      },
      depositTotal: '100000',
    });
    writeFileSync(
      join(dir, 'channels.json'),
      JSON.stringify({
        [CHANNEL_ID]: { nonce: 8, cumulativeAmount: '100000' },
      })
    );
    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance([], h.deps)).toBe(0);
    const text = h.out.join('\n');
    expect(text).toContain('available 0');
    expect(text).not.toContain('OVERDRAWN');
  });

  it('a corrupt channel map is a clear error (exit 1)', async () => {
    writeFileSync(join(dir, 'rig-channels.json'), 'not-json{');
    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runBalance(['--json'], h.deps)).toBe(1);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed['error']).toBe('channel_map_corrupt');
    expect(h.stopped).toBe(true);
  });

  // ── The silent-exit bug (Mina path): a wallet read that never settles ─────
  // Regression: `rig balance` awaited the wallet read UNBOUNDED, so a Mina read
  // that neither resolved nor kept the event loop alive drained the one-shot
  // CLI to a silent exit-0 with NO output. The bound must turn that into a
  // loud, non-zero failure that STILL prints the identity + channels.

  /** A wallet read that never resolves and never rejects — the drain trigger. */
  const neverSettles = (): Promise<WalletChainBalanceInfo[]> =>
    new Promise<WalletChainBalanceInfo[]>(() => {});

  it('a hanging wallet read fails loudly (exit 1) — never a silent exit', async () => {
    seedChannels();
    const h = makeHarness(
      { TOON_CLIENT_HOME: dir, RIG_BALANCE_WALLET_TIMEOUT_MS: '30' },
      [],
      neverSettles
    );
    const code = await runBalance([], h.deps);
    // Non-zero: the read failed. And it is NOT silent — the report still prints.
    expect(code).toBe(1);
    const text = h.out.join('\n');
    expect(text).toContain(`Identity: ${IDENTITY}`);
    expect(text).toContain('Wallet (on-chain):');
    expect(text).toContain('wallet balances unavailable');
    expect(text).toMatch(/timed out after 30ms/);
    // The recorded channel is still shown — the local read is unaffected.
    expect(text).toContain('Channels (recorded):');
    expect(text).toContain(CHANNEL_ID);
    // Teardown still runs on the failure path.
    expect(h.stopped).toBe(true);
  });

  it('a hanging wallet read under --json emits one error envelope (exit 1)', async () => {
    const h = makeHarness(
      { TOON_CLIENT_HOME: dir, RIG_BALANCE_WALLET_TIMEOUT_MS: '30' },
      [],
      neverSettles
    );
    expect(await runBalance(['--json'], h.deps)).toBe(1);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed['error']).toBe('error');
    expect(String(parsed['detail'])).toMatch(/timed out after 30ms/);
    expect(h.stopped).toBe(true);
  });

  it('a rejecting wallet read fails loudly and still prints the channels', async () => {
    seedChannels();
    const h = makeHarness({ TOON_CLIENT_HOME: dir }, [], async () => {
      throw new Error('Mina GraphQL request failed: HTTP 500');
    });
    expect(await runBalance([], h.deps)).toBe(1);
    const text = h.out.join('\n');
    expect(text).toContain(`Identity: ${IDENTITY}`);
    expect(text).toContain(
      'wallet balances unavailable — Mina GraphQL request failed: HTTP 500'
    );
    expect(text).toContain(CHANNEL_ID);
  });

  it('a rejecting wallet read under --json is a single error envelope (exit 1)', async () => {
    const h = makeHarness({ TOON_CLIENT_HOME: dir }, [], async () => {
      throw new Error('Mina GraphQL request failed: HTTP 500');
    });
    expect(await runBalance(['--json'], h.deps)).toBe(1);
    const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
    expect(parsed['error']).toBe('error');
    expect(String(parsed['detail'])).toContain('HTTP 500');
  });

  it('a slow-but-successful wallet read within the bound still succeeds (exit 0)', async () => {
    const h = makeHarness(
      { TOON_CLIENT_HOME: dir, RIG_BALANCE_WALLET_TIMEOUT_MS: '5000' },
      [],
      () =>
        new Promise<WalletChainBalanceInfo[]>((resolve) =>
          setTimeout(() => resolve(WALLET), 10)
        )
    );
    expect(await runBalance([], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain('MINA 0');
  });

  describe('readWalletBounded / walletReadTimeoutMs', () => {
    it('rejects with WalletReadTimeoutError when the read outlasts the bound', async () => {
      await expect(readWalletBounded(neverSettles, 20)).rejects.toBeInstanceOf(
        WalletReadTimeoutError
      );
    });

    it('resolves with the value when the read finishes in time', async () => {
      await expect(readWalletBounded(async () => WALLET, 1000)).resolves.toEqual(
        WALLET
      );
    });

    it('a non-positive timeout opts out of the bound (waits for the read)', async () => {
      await expect(readWalletBounded(async () => WALLET, 0)).resolves.toEqual(
        WALLET
      );
    });

    it('parses the env override; falls back to the default on junk/absent', () => {
      expect(walletReadTimeoutMs({ RIG_BALANCE_WALLET_TIMEOUT_MS: '500' })).toBe(
        500
      );
      expect(walletReadTimeoutMs({ RIG_BALANCE_WALLET_TIMEOUT_MS: '0' })).toBe(0);
      expect(walletReadTimeoutMs({ RIG_BALANCE_WALLET_TIMEOUT_MS: 'nope' })).toBe(
        20_000
      );
      expect(walletReadTimeoutMs({})).toBe(20_000);
    });
  });

  it('--help prints usage', async () => {
    const h = makeHarness({});
    expect(await runBalance(['--help'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toBe(BALANCE_USAGE);
    expect(h.loads).toEqual([]);
  });
});

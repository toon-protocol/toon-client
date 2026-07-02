/**
 * `rig channel` tests: `list` (#262) renders the persisted peer→channel map
 * joined with the claim-watermark state, free of any client/network; the
 * lifecycle subcommands (#263: open/close/settle) drive the injected
 * standalone money ops behind the push confirm idiom — on-chain spends only
 * after --yes / interactive confirm, `--json` without `--yes` is a pure
 * plan, and close/settle fail fast from LOCAL watermark state (unknown ids,
 * wrong identity, wrong withdraw phase) before any client starts.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ChannelMapStore,
  type ChannelMapRecord,
} from '../standalone/channel-map.js';
import type {
  ChannelCloseOutcome,
  ChannelOpenOutcome,
  ChannelSettleOutcome,
} from '../standalone/money.js';
import { CHANNEL_USAGE, runChannel, type ChannelDeps } from './channel.js';
import type { CliIo } from './push.js';
import type {
  StandaloneContext,
  StandaloneLoadOptions,
} from './standalone-context.js';

const IDENTITY = 'a'.repeat(64);
const OTHER_IDENTITY = 'b'.repeat(64);
const CHANNEL_ID = '0x' + '11'.repeat(32);

interface Harness {
  deps: ChannelDeps;
  out: string[];
  err: string[];
}

function makeHarness(
  env: NodeJS.ProcessEnv,
  options: {
    loadStandalone?: ChannelDeps['loadStandalone'];
    isInteractive?: boolean;
    confirmAnswer?: boolean;
    onConfirm?: (question: string) => void;
  } = {}
): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isInteractive: options.isInteractive ?? false,
    confirm: async (question) => {
      options.onConfirm?.(question);
      return options.confirmAnswer ?? false;
    },
  };
  return {
    deps: {
      io,
      env,
      cwd: '/nonexistent',
      ...(options.loadStandalone
        ? { loadStandalone: options.loadStandalone }
        : {}),
    },
    out,
    err,
  };
}

// ---------------------------------------------------------------------------
// Fake standalone money ops (the StandaloneMoneyOps seam)
// ---------------------------------------------------------------------------

interface FakeMoney {
  context: StandaloneContext;
  load: ChannelDeps['loadStandalone'];
  loads: StandaloneLoadOptions[];
  openCalls: ({ deposit?: bigint } | undefined)[];
  closeCalls: ChannelMapRecord[];
  settleCalls: ChannelMapRecord[];
  stopped: boolean;
  openOutcome: ChannelOpenOutcome;
  closeOutcome: ChannelCloseOutcome;
  settleOutcome: ChannelSettleOutcome;
  settleError?: Error;
}

function makeMoney(identity: string = IDENTITY): FakeMoney {
  const fake: FakeMoney = {
    loads: [],
    openCalls: [],
    closeCalls: [],
    settleCalls: [],
    stopped: false,
    openOutcome: {
      channelId: CHANNEL_ID,
      resumed: false,
      destination: 'g.proxy.relay.store',
      chain: 'evm:31337',
      peerId: 'nostr-2813187e',
      depositTotal: '100000',
    },
    closeOutcome: {
      channelId: CHANNEL_ID,
      txHash: '0xclosetx',
      closedAt: '1000',
      settleableAt: '2000',
    },
    settleOutcome: { channelId: CHANNEL_ID, txHash: '0xsettletx' },
    load: async (options) => {
      fake.loads.push(options);
      return fake.context;
    },
    context: undefined as unknown as StandaloneContext,
  };
  fake.context = {
    ownerPubkey: identity,
    identitySource: 'env',
    identitySourceLabel: 'RIG_MNEMONIC env',
    publisher: {
      getFeeRates: async () => ({ uploadFeePerByte: 10n, eventFee: 1n }),
      uploadGitObject: async () => {
        throw new Error('channel commands never upload');
      },
      publishEvent: async () => {
        throw new Error('channel commands never publish');
      },
    },
    defaultRelayUrls: [],
    fetchRemote: async () => {
      throw new Error('channel commands never read remote state');
    },
    money: {
      openChannel: async (opts) => {
        fake.openCalls.push(opts);
        return fake.openOutcome;
      },
      closeChannel: async (record) => {
        fake.closeCalls.push(record);
        return fake.closeOutcome;
      },
      settleChannel: async (record) => {
        fake.settleCalls.push(record);
        if (fake.settleError) throw fake.settleError;
        return fake.settleOutcome;
      },
      walletBalances: async () => [],
    },
    stop: async () => {
      fake.stopped = true;
    },
  };
  return fake;
}

describe('rig channel', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-channel-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedStore(overrides: Partial<ChannelMapRecord> = {}): void {
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
        recipient: '0x' + '44'.repeat(20),
      },
      depositTotal: '100000',
      ...overrides,
    });
    writeFileSync(
      join(dir, 'channels.json'),
      JSON.stringify({
        [CHANNEL_ID]: { nonce: 15, cumulativeAmount: '16120' },
      })
    );
  }

  /** Overwrite the watermark entry for CHANNEL_ID. */
  function seedWatermark(entry: Record<string, unknown>): void {
    writeFileSync(
      join(dir, 'channels.json'),
      JSON.stringify({ [CHANNEL_ID]: entry })
    );
  }

  describe('list', () => {
    it('renders peer, chain, channel id, deposit, claimed, status', async () => {
      seedStore();
      const h = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['list'], h.deps)).toBe(0);
      const text = h.out.join('\n');
      expect(text).toContain(`channel ${CHANNEL_ID} [open]`);
      expect(text).toContain('g.proxy.relay.store (nostr-2813187e)');
      expect(text).toContain('evm:31337');
      expect(text).toContain(`token-network 0x${'22'.repeat(20)}`);
      expect(text).toContain('deposited   100000');
      expect(text).toContain('claimed     16120 base units (nonce 15)');
      expect(h.err).toEqual([]);
    });

    it('shows the withdraw status from the watermark timers', async () => {
      seedStore();
      seedWatermark({
        nonce: 15,
        cumulativeAmount: '16120',
        closedAt: '100',
        settleableAt: '200',
        settledAt: '300',
      });
      const h = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['list'], h.deps)).toBe(0);
      expect(h.out.join('\n')).toContain(`channel ${CHANNEL_ID} [settled]`);
    });

    it('--json emits a machine-parseable envelope (strings for base units)', async () => {
      seedStore();
      const h = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['list', '--json'], h.deps)).toBe(0);
      const parsed = JSON.parse(h.out.join('\n')) as {
        command: string;
        channels: Record<string, unknown>[];
      };
      expect(parsed.command).toBe('channel list');
      expect(parsed.channels).toEqual([
        {
          channelId: CHANNEL_ID,
          peerId: 'nostr-2813187e',
          identity: IDENTITY,
          destination: 'g.proxy.relay.store',
          chain: 'evm:31337',
          tokenNetwork: '0x' + '22'.repeat(20),
          depositTotal: '100000',
          cumulativeClaimed: '16120',
          nonce: 15,
          status: 'open',
          openedAt: expect.stringContaining('T') as unknown,
          lastUsedAt: expect.stringContaining('T') as unknown,
        },
      ]);
    });

    it('an empty (or missing) store lists nothing, exit 0', async () => {
      const h = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['list'], h.deps)).toBe(0);
      expect(h.out.join('\n')).toContain('No payment channels recorded');

      const j = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['list', '--json'], j.deps)).toBe(0);
      expect(JSON.parse(j.out.join('\n'))).toEqual({
        command: 'channel list',
        channels: [],
      });
    });

    it('a channel with no watermark entry shows unknown claim state', async () => {
      seedStore();
      rmSync(join(dir, 'channels.json'));
      const h = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['list'], h.deps)).toBe(0);
      expect(h.out.join('\n')).toContain('unknown (no local claim state)');
    });

    it('a corrupt store file is a clear error (exit 1), also under --json', async () => {
      writeFileSync(join(dir, 'rig-channels.json'), 'not-json{');
      const h = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['list'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toMatch(/corrupt/);

      const j = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['list', '--json'], j.deps)).toBe(1);
      const parsed = JSON.parse(j.out.join('\n')) as Record<string, unknown>;
      expect(parsed['error']).toBe('channel_map_corrupt');
    });
  });

  describe('open (#263)', () => {
    it('--yes executes the shared resume-or-open path and reports the result', async () => {
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['open', '--yes'], h.deps)).toBe(0);
      expect(fake.openCalls).toEqual([undefined]);
      expect(fake.stopped).toBe(true);
      const text = h.out.join('\n');
      expect(text).toContain(`Opened channel ${CHANNEL_ID} on evm:31337`);
      expect(text).toContain('g.proxy.relay.store (nostr-2813187e)');
      // No --peer: the loader gets no channelDestination override.
      expect(fake.loads[0]?.channelDestination).toBeUndefined();
    });

    it('--peer flows to the loader as the channel anchor override', async () => {
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(
        await runChannel(['open', '--peer', 'g.other.relay.store', '--yes'], h.deps)
      ).toBe(0);
      expect(fake.loads[0]?.channelDestination).toBe('g.other.relay.store');
    });

    it('--deposit is parsed as base-unit bigint and passed to the money op', async () => {
      const fake = makeMoney();
      fake.openOutcome = {
        ...fake.openOutcome,
        depositAdded: '500',
        depositTotal: '100500',
        depositTxHash: '0xdeptx',
      };
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(
        await runChannel(['open', '--deposit', '500', '--yes'], h.deps)
      ).toBe(0);
      expect(fake.openCalls).toEqual([{ deposit: 500n }]);
      const text = h.out.join('\n');
      expect(text).toContain('+500 base units');
      expect(text).toContain('100500 base units total');
    });

    it('a resumed channel is reported as resumed (no on-chain open)', async () => {
      const fake = makeMoney();
      fake.openOutcome = { ...fake.openOutcome, resumed: true };
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['open', '--yes'], h.deps)).toBe(0);
      expect(h.out.join('\n')).toContain(
        `Resumed recorded channel ${CHANNEL_ID}`
      );
    });

    it('rejects a non-positive or non-integer --deposit (exit 2)', async () => {
      for (const bad of ['0', '-5', '1.5', 'abc']) {
        const fake = makeMoney();
        const h = makeHarness(
          { TOON_CLIENT_HOME: dir },
          { loadStandalone: fake.load }
        );
        expect(await runChannel(['open', '--deposit', bad, '--yes'], h.deps)).toBe(2);
        expect(fake.openCalls).toEqual([]);
      }
    });

    it('refuses without --yes in a non-interactive session (nothing executed)', async () => {
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['open'], h.deps)).toBe(1);
      expect(fake.openCalls).toEqual([]);
      expect(h.err.join('\n')).toContain('--yes');
      expect(fake.stopped).toBe(true);
    });

    it('interactive decline aborts before anything is opened', async () => {
      const fake = makeMoney();
      const questions: string[] = [];
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        {
          loadStandalone: fake.load,
          isInteractive: true,
          confirmAnswer: false,
          onConfirm: (q) => questions.push(q),
        }
      );
      expect(await runChannel(['open'], h.deps)).toBe(1);
      expect(questions[0]).toMatch(/on-chain channel open/i);
      expect(fake.openCalls).toEqual([]);
      expect(h.err.join('\n')).toContain('aborted');
    });

    it('interactive accept proceeds', async () => {
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load, isInteractive: true, confirmAnswer: true }
      );
      expect(await runChannel(['open'], h.deps)).toBe(0);
      expect(fake.openCalls).toHaveLength(1);
      // The plan states the on-chain consequence + identity before asking.
      const text = h.out.join('\n');
      expect(text).toContain('Channel open plan:');
      expect(text).toContain(`Identity: ${IDENTITY}`);
    });

    it('--json without --yes is a pure plan (exit 0, nothing executed)', async () => {
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(
        await runChannel(['open', '--json', '--deposit', '500'], h.deps)
      ).toBe(0);
      expect(fake.openCalls).toEqual([]);
      const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        command: 'channel open',
        executed: false,
        plan: { destination: null, deposit: '500' },
        identity: { pubkey: IDENTITY, source: 'env' },
      });
      expect(parsed['hint']).toMatch(/--yes/);
    });

    it('--json --yes emits the execution envelope', async () => {
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['open', '--json', '--yes'], h.deps)).toBe(0);
      const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        command: 'channel open',
        executed: true,
        result: {
          channelId: CHANNEL_ID,
          resumed: false,
          destination: 'g.proxy.relay.store',
          chain: 'evm:31337',
          peerId: 'nostr-2813187e',
          depositTotal: '100000',
          depositAdded: null,
          depositTxHash: null,
        },
      });
    });

    it('money-op failures surface as an error envelope under --json (exit 1)', async () => {
      const fake = makeMoney();
      fake.context.money = {
        ...(fake.context.money as NonNullable<StandaloneContext['money']>),
        openChannel: async () => {
          throw new Error('bootstrap exploded');
        },
      };
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['open', '--json', '--yes'], h.deps)).toBe(1);
      const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
      expect(parsed['command']).toBe('channel open');
      expect(parsed['detail']).toMatch(/bootstrap exploded/);
      expect(fake.stopped).toBe(true);
    });
  });

  describe('close (#263)', () => {
    it('--yes closes the recorded channel and reports the challenge window', async () => {
      seedStore();
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['close', CHANNEL_ID, '--yes'], h.deps)).toBe(0);
      expect(fake.closeCalls).toHaveLength(1);
      expect(fake.closeCalls[0]?.channelId).toBe(CHANNEL_ID);
      expect(fake.closeCalls[0]?.context.tokenNetworkAddress).toBe(
        '0x' + '22'.repeat(20)
      );
      const text = h.out.join('\n');
      expect(text).toContain('is closing');
      expect(text).toContain('0xclosetx');
      expect(text).toContain(`rig channel settle ${CHANNEL_ID}`);
      expect(fake.stopped).toBe(true);
    });

    it('--json --yes emits closedAt/settleableAt', async () => {
      seedStore();
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(
        await runChannel(['close', CHANNEL_ID, '--json', '--yes'], h.deps)
      ).toBe(0);
      const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        command: 'channel close',
        executed: true,
        channelId: CHANNEL_ID,
        result: { txHash: '0xclosetx', closedAt: '1000', settleableAt: '2000' },
      });
    });

    it('an unknown channel id fails fast — no standalone context is loaded', async () => {
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['close', '0xnope', '--yes'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toContain('rig channel list');
      expect(fake.loads).toEqual([]);
      expect(fake.closeCalls).toEqual([]);
    });

    it('an already-closing channel is refused with a settle hint (no client start)', async () => {
      seedStore();
      seedWatermark({
        nonce: 15,
        cumulativeAmount: '16120',
        closedAt: '100',
        settleableAt: '99999999999',
      });
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['close', CHANNEL_ID, '--yes'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toContain('already closing');
      expect(fake.loads).toEqual([]);
    });

    it('an already-settled channel is refused', async () => {
      seedStore();
      seedWatermark({
        nonce: 15,
        cumulativeAmount: '16120',
        closedAt: '100',
        settleableAt: '200',
        settledAt: '300',
      });
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['close', CHANNEL_ID, '--yes'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toContain('already settled');
      expect(fake.loads).toEqual([]);
    });

    it("refuses when the active identity is not the channel's opener", async () => {
      seedStore({ identity: OTHER_IDENTITY });
      const fake = makeMoney(); // active identity: IDENTITY
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['close', CHANNEL_ID, '--yes'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toMatch(/opened by identity/);
      expect(fake.closeCalls).toEqual([]);
      expect(fake.stopped).toBe(true);
    });

    it('confirm gate: non-TTY without --yes refuses; --json without --yes is a plan', async () => {
      seedStore();
      const fake = makeMoney();
      const refuse = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['close', CHANNEL_ID], refuse.deps)).toBe(1);
      expect(fake.closeCalls).toEqual([]);

      const plan = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['close', CHANNEL_ID, '--json'], plan.deps)).toBe(0);
      const parsed = JSON.parse(plan.out.join('\n')) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        command: 'channel close',
        executed: false,
        channelId: CHANNEL_ID,
      });
      expect(fake.closeCalls).toEqual([]);
    });

    it('requires exactly one channel id (exit 2)', async () => {
      const h = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(['close'], h.deps)).toBe(2);
      expect(h.err.join('\n')).toContain('exactly one');
    });
  });

  describe('settle (#263)', () => {
    /** Seed a closed channel whose window elapsed long ago. */
    function seedSettleable(): void {
      seedStore();
      seedWatermark({
        nonce: 15,
        cumulativeAmount: '16120',
        closedAt: '100',
        settleableAt: '200',
      });
    }

    it('--yes settles a channel whose challenge window elapsed', async () => {
      seedSettleable();
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['settle', CHANNEL_ID, '--yes'], h.deps)).toBe(0);
      expect(fake.settleCalls).toHaveLength(1);
      expect(fake.settleCalls[0]?.channelId).toBe(CHANNEL_ID);
      const text = h.out.join('\n');
      expect(text).toContain('settled');
      expect(text).toContain('0xsettletx');
    });

    it('--json --yes emits the settle envelope', async () => {
      seedSettleable();
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(
        await runChannel(['settle', CHANNEL_ID, '--json', '--yes'], h.deps)
      ).toBe(0);
      expect(JSON.parse(h.out.join('\n'))).toMatchObject({
        command: 'channel settle',
        executed: true,
        channelId: CHANNEL_ID,
        result: { txHash: '0xsettletx' },
      });
    });

    it('an open (never closed) channel is refused with a close hint (no client start)', async () => {
      seedStore();
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['settle', CHANNEL_ID, '--yes'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toContain('rig channel close');
      expect(fake.loads).toEqual([]);
    });

    it('a still-open challenge window is refused locally with the remaining time', async () => {
      seedStore();
      const future = String(Math.floor(Date.now() / 1000) + 500);
      seedWatermark({
        nonce: 15,
        cumulativeAmount: '16120',
        closedAt: '100',
        settleableAt: future,
      });
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['settle', CHANNEL_ID, '--yes'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toMatch(/challenge window is still open/);
      expect(h.err.join('\n')).toMatch(/\d+s remain/);
      expect(fake.loads).toEqual([]);
    });

    it("the client's SettleTooEarlyError maps to the settle_too_early code", async () => {
      seedSettleable();
      const fake = makeMoney();
      fake.settleError = Object.assign(new Error('not settleable yet'), {
        name: 'SettleTooEarlyError',
        settleableAt: '2000',
      });
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(
        await runChannel(['settle', CHANNEL_ID, '--json', '--yes'], h.deps)
      ).toBe(1);
      const parsed = JSON.parse(h.out.join('\n')) as Record<string, unknown>;
      expect(parsed['error']).toBe('settle_too_early');
      expect(parsed['settleableAt']).toBe('2000');
    });

    it('an already-settled channel is refused', async () => {
      seedStore();
      seedWatermark({
        nonce: 15,
        cumulativeAmount: '16120',
        closedAt: '100',
        settleableAt: '200',
        settledAt: '300',
      });
      const fake = makeMoney();
      const h = makeHarness(
        { TOON_CLIENT_HOME: dir },
        { loadStandalone: fake.load }
      );
      expect(await runChannel(['settle', CHANNEL_ID, '--yes'], h.deps)).toBe(1);
      expect(h.err.join('\n')).toContain('already settled');
      expect(fake.loads).toEqual([]);
    });
  });

  it('help and unknown subcommands', async () => {
    for (const argv of [['help'], ['--help'], ['-h'], ['list', '--help']]) {
      const h = makeHarness({ TOON_CLIENT_HOME: dir });
      expect(await runChannel(argv, h.deps)).toBe(0);
      expect(h.out.join('\n')).toContain('Usage: rig channel');
    }
    const bare = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runChannel([], bare.deps)).toBe(2);
    expect(bare.err.join('\n')).toContain('Usage: rig channel');

    const unknown = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runChannel(['frobnicate'], unknown.deps)).toBe(2);
    expect(unknown.err.join('\n')).toContain('unknown subcommand');
    // The lifecycle subcommands are documented (#263).
    for (const word of ['open', 'close', 'settle']) {
      expect(CHANNEL_USAGE).toContain(word);
    }
  });
});

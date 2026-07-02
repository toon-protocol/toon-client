/**
 * `rig channel list` tests (#262): renders the persisted peer→channel map
 * joined with the claim-watermark state, `--json` is machine-parseable, and
 * a corrupt store is a clear error — all free (no client, no network).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelMapStore } from '../standalone/channel-map.js';
import { CHANNEL_USAGE, runChannel, type ChannelDeps } from './channel.js';
import type { CliIo } from './push.js';

const IDENTITY = 'a'.repeat(64);
const CHANNEL_ID = '0x' + '11'.repeat(32);

interface Harness {
  deps: ChannelDeps;
  out: string[];
  err: string[];
}

function makeHarness(env: NodeJS.ProcessEnv): Harness {
  const out: string[] = [];
  const err: string[] = [];
  const io: CliIo = {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    isInteractive: false,
    confirm: async () => false,
  };
  return { deps: { io, env }, out, err };
}

describe('rig channel', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rig-channel-cli-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedStore(): void {
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
    });
    writeFileSync(
      join(dir, 'channels.json'),
      JSON.stringify({
        [CHANNEL_ID]: { nonce: 15, cumulativeAmount: '16120' },
      })
    );
  }

  it('list renders peer, chain, channel id, deposit, claimed, status', async () => {
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

  it('list shows the withdraw status from the watermark timers', async () => {
    seedStore();
    writeFileSync(
      join(dir, 'channels.json'),
      JSON.stringify({
        [CHANNEL_ID]: {
          nonce: 15,
          cumulativeAmount: '16120',
          closedAt: '100',
          settleableAt: '200',
          settledAt: '300',
        },
      })
    );
    const h = makeHarness({ TOON_CLIENT_HOME: dir });
    expect(await runChannel(['list'], h.deps)).toBe(0);
    expect(h.out.join('\n')).toContain(`channel ${CHANNEL_ID} [settled]`);
  });

  it('list --json emits a machine-parseable envelope (strings for base units)', async () => {
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
    expect(await runChannel(['open'], unknown.deps)).toBe(2);
    expect(unknown.err.join('\n')).toContain('unknown subcommand');
    // #263 breadcrumb: lifecycle commands are documented as not-yet-built.
    expect(CHANNEL_USAGE).toContain('#263');
  });
});

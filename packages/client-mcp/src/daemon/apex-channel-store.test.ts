import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadApexChannel,
  saveApexChannel,
  supersedeApexChannel,
} from './apex-channel-store.js';

/**
 * The apex store is keyed `destination|chain` — an ILP NAME, not a node. When
 * the node terminating that name is replaced (the devnet apex `g.toon` was
 * retired 2026-08-14), both key fields still match, so the runner resumed —
 * and re-bound — a channel the node now answering has no record of, and every
 * paid write came back `F01 - claim rejected`.
 */

const RETIRED = '0xf29fd62c4848b9573c9b90adbf61b664f386d9cf';
const DEAD_CHANNEL =
  '0x413d0c87b29428100cbd600c3c1b9d67e67d16ff0f7a7960bffedee6740a1c5d';

describe('apex-channel-store supersede', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'apex-channels-'));
    path = join(dir, 'apex-channels.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seedRetired(): void {
    saveApexChannel(path, 'g.toon', 'evm', {
      channelId: DEAD_CHANNEL,
      context: {
        chainType: 'evm',
        chainId: 84532,
        tokenNetworkAddress: '0xa79c3b1dbcea00a6d84735a134395d8ef6d6a478',
        recipient: RETIRED,
      },
    });
  }

  it('retires a record from the resume path', () => {
    seedRetired();
    expect(loadApexChannel(path, 'g.toon', 'evm')?.channelId).toBe(
      DEAD_CHANNEL
    );

    supersedeApexChannel(path, 'g.toon', 'evm');

    expect(loadApexChannel(path, 'g.toon', 'evm')).toBeNull();
  });

  it('ARCHIVES rather than deletes — the channel may still hold a deposit', () => {
    seedRetired();
    supersedeApexChannel(path, 'g.toon', 'evm');

    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<
      string,
      { channelId: string; supersededAt?: string }
    >;
    expect(onDisk['g.toon|evm']).toBeUndefined();
    const archived = onDisk[`g.toon|evm|superseded:${DEAD_CHANNEL}`];
    expect(archived?.channelId).toBe(DEAD_CHANNEL);
    expect(archived?.supersededAt).toEqual(expect.any(String));
  });

  it('frees the live key for the re-resolved channel, keeping both records', () => {
    seedRetired();
    supersedeApexChannel(path, 'g.toon', 'evm');
    saveApexChannel(path, 'g.toon', 'evm', {
      channelId: '0xnew',
      context: {
        chainType: 'evm',
        chainId: 84532,
        tokenNetworkAddress: '0xa79c3b1dbcea00a6d84735a134395d8ef6d6a478',
        recipient: '0x6b6c2dacf7ac1f1273f72bef2e6084f9ee6d3bff',
      },
    });

    expect(loadApexChannel(path, 'g.toon', 'evm')?.channelId).toBe('0xnew');
    const onDisk = JSON.parse(readFileSync(path, 'utf-8')) as Record<
      string,
      unknown
    >;
    expect(Object.keys(onDisk)).toHaveLength(2);
  });

  it('is idempotent and a no-op for an unrecorded route', () => {
    seedRetired();
    supersedeApexChannel(path, 'g.toon', 'evm');
    const after = readFileSync(path, 'utf-8');
    supersedeApexChannel(path, 'g.toon', 'evm');
    supersedeApexChannel(path, 'g.nowhere', 'evm');
    expect(readFileSync(path, 'utf-8')).toBe(after);
  });

  it('reads a legacy record (no recipient, no supersededAt) unchanged', () => {
    writeFileSync(
      path,
      JSON.stringify({
        'g.toon.relay|evm': {
          channelId: '0xlegacy',
          context: {
            chainType: 'evm',
            chainId: 84532,
            tokenNetworkAddress: '0xa79c',
          },
        },
      })
    );
    const loaded = loadApexChannel(path, 'g.toon.relay', 'evm');
    expect(loaded?.channelId).toBe('0xlegacy');
    expect(loaded?.context.recipient).toBeUndefined();
  });
});

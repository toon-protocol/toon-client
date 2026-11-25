import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChannelStoreEntry } from './ChannelStore.js';

/**
 * The two files the release before the one-record store wrote for `entry`: a
 * watermark entry, with `nonce`, in `channels.json`, and the binding, with its
 * context, in `channels.peers.json` under its `batch|…` key.
 */
export function writeLegacyFiles(
  entry: ChannelStoreEntry,
  options: { watermark: boolean } = { watermark: true }
): string {
  const dir = mkdtempSync(join(tmpdir(), 'channel-legacy-'));
  const path = join(dir, 'channels.json');
  const { network, config } = entry.batchSettlement;
  const asset = network.startsWith('eip155:')
    ? config.token.toLowerCase()
    : config.token;
  writeFileSync(
    path,
    JSON.stringify(
      options.watermark
        ? {
            [entry.channelId]: {
              nonce: 0,
              cumulativeAmount: entry.cumulativeAmount.toString(),
              signedCeiling: (entry.signedCeiling ?? 0n).toString(),
            },
          }
        : {}
    )
  );
  writeFileSync(
    join(dir, 'channels.peers.json'),
    JSON.stringify({
      [`batch|${entry.connector}|${network}|${asset}`]: {
        channelId: entry.channelId,
        context: {
          chainType: entry.batchSettlement.chain,
          chainId: 84532,
          tokenNetworkAddress: '0x0000000000000000000000000000000000000000',
          tokenAddress: config.token,
          recipient: config.receiver,
        },
        depositTotal: entry.depositTotal.toString(),
        openedAt: '2026-10-01T00:00:00.000Z',
        batchSettlement: entry.batchSettlement,
      },
    })
  );
  return path;
}

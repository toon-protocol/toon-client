/**
 * `rig channel` — inspect the payment channels paid rig commands hold (#262).
 *
 * Paid commands open a channel lazily on first use and RECORD it in the
 * peer→channel map under `TOON_CLIENT_HOME` (default `~/.toon-client`,
 * `rig-channels.json`), so later invocations resume the same channel instead
 * of opening (and funding) a new one per run. `rig channel list` reads that
 * map plus the client's nonce-watermark store (`channels.json`) and shows
 * current holdings — a FREE command: local files only, no client start, no
 * network, no payment (and therefore no `@toon-protocol/client` import).
 *
 * The money-lifecycle subcommands (open/deposit/close/settle) are #263 —
 * they will operate on the same store.
 */

import { parseArgs } from 'node:util';
import {
  channelStatus,
  ChannelMapStore,
  resolveChannelPaths,
  type ChannelMapRecord,
  type WatermarkEntry,
} from '../standalone/channel-map.js';
import { describeError } from './errors.js';
import type { CliIo } from './push.js';

export const CHANNEL_USAGE = `Usage: rig channel <subcommand>

Inspect the payment channels paid rig commands hold with relay/store peers.
Paid commands open a channel lazily on first use and record it under
TOON_CLIENT_HOME (default ~/.toon-client, rig-channels.json), so later
invocations resume the same channel instead of opening a new one per run.

Subcommands:
  list [--json]    show recorded channels — peer, chain, channel id, deposit,
                   cumulative claimed, status. Free: reads local state only.

Channel money-lifecycle commands (open/deposit/close/settle) are not built
yet (tracked in toon-protocol/toon-client#263).`;

/** What `rig channel` needs from the command environment. */
export interface ChannelDeps {
  io: CliIo;
  env: NodeJS.ProcessEnv;
}

/** One channel in the `--json` envelope (unknowns are null, bigints strings). */
interface ChannelJson {
  channelId: string;
  peerId: string;
  identity: string;
  destination: string;
  chain: string;
  tokenNetwork: string;
  depositTotal: string | null;
  cumulativeClaimed: string | null;
  nonce: number | null;
  status: 'open' | 'closing' | 'settleable' | 'settled';
  openedAt: string;
  lastUsedAt: string;
}

/** Route one `rig channel …` invocation; returns the exit code. */
export async function runChannel(
  args: string[],
  deps: ChannelDeps
): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return runChannelList(rest, deps);
    case 'help':
    case '--help':
    case '-h':
      io.out(CHANNEL_USAGE);
      return 0;
    case undefined:
      io.err(CHANNEL_USAGE);
      return 2;
    default:
      io.err(`rig channel: unknown subcommand ${JSON.stringify(sub)}`);
      io.err(CHANNEL_USAGE);
      return 2;
  }
}

function runChannelList(args: string[], deps: ChannelDeps): number {
  const { io, env } = deps;
  let json = false;
  try {
    const { values } = parseArgs({
      args,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      io.out(CHANNEL_USAGE);
      return 0;
    }
    json = values.json ?? false;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CHANNEL_USAGE);
    return 2;
  }

  try {
    const paths = resolveChannelPaths(env);
    const store = new ChannelMapStore(paths);
    const records = store.list();
    const rows = records.map((record) => describeChannel(record, store));

    if (json) {
      io.out(
        JSON.stringify({ command: 'channel list', channels: rows }, null, 2)
      );
      return 0;
    }
    if (rows.length === 0) {
      io.out(
        'No payment channels recorded — paid rig commands (push, issue, ' +
          'comment, pr) record the channel they open on first use.'
      );
      return 0;
    }
    io.out(
      `${rows.length} payment channel${rows.length === 1 ? '' : 's'} ` +
        `recorded in ${paths.mapPath}:`
    );
    for (const row of rows) {
      io.out('');
      for (const line of renderChannel(row)) io.out(line);
    }
    return 0;
  } catch (err) {
    const described = describeError(err, 'channel list');
    if (json) {
      io.out(JSON.stringify({ command: 'channel list', ...described.json }, null, 2));
    } else {
      for (const line of described.lines) io.err(line);
    }
    return 1;
  }
}

/** Join one map record with its watermark state. */
function describeChannel(
  record: ChannelMapRecord,
  store: ChannelMapStore
): ChannelJson {
  const watermark: WatermarkEntry | undefined = store.readWatermark(
    record.channelId
  );
  return {
    channelId: record.channelId,
    peerId: record.peerId,
    identity: record.identity,
    destination: record.destination,
    chain: record.chain,
    tokenNetwork: record.tokenNetwork,
    depositTotal: record.depositTotal ?? null,
    cumulativeClaimed: watermark?.cumulativeAmount ?? null,
    nonce: watermark?.nonce ?? null,
    status: channelStatus(watermark),
    openedAt: record.openedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function renderChannel(row: ChannelJson): string[] {
  const claimed =
    row.cumulativeClaimed === null
      ? 'unknown (no local claim state)'
      : `${row.cumulativeClaimed} base units (nonce ${row.nonce})`;
  return [
    `channel ${row.channelId} [${row.status}]`,
    `  peer        ${row.destination} (${row.peerId})`,
    `  identity    ${row.identity.slice(0, 8)}…`,
    `  chain       ${row.chain}` +
      (row.tokenNetwork ? `  token-network ${row.tokenNetwork}` : ''),
    `  deposited   ${row.depositTotal ?? 'unrecorded'}` +
      (row.depositTotal ? ' base units' : ''),
    `  claimed     ${claimed}`,
    `  opened      ${row.openedAt}  (last used ${row.lastUsedAt})`,
  ];
}

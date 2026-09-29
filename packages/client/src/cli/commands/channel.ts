/**
 * `toon channel open|deposit|status|close|settle` — the x402 `batch-settlement`
 * channels this client pays the connector from (connector ADRs 0074, 0075).
 *
 * Opening costs no native gas: on Base a facilitator relays the deposit, on
 * Solana the connector sponsors the open. Leaving is the payer's own
 * transaction on its own chain account, and is the one step that costs gas.
 * `status` reports two watermarks when asked to — the local one is what this
 * client has signed, the connector's is what it has banked, and they differ
 * exactly when a voucher was signed and never accepted.
 */
import { UsageError, boolOption, stringOption } from '../args.js';
import type { CommandContext } from '../context.js';
import { CHANNEL_SUBCOMMANDS } from '../args.js';
import { assetInfo, formatAmount, type AssetInfo } from '../output.js';
import type { ClaimStateResult, ChannelState, BatchExitResult } from '../../client/types.js';

/** The rows that describe one channel to a person. */
function stateRows(state: ChannelState, asset: AssetInfo): [string, string][] {
  const rows: [string, string][] = [
    ['channel', state.channel.channelId],
    ['network', state.channel.network],
    ['deposit', formatAmount(state.depositTotal, asset)],
    ['signed', formatAmount(state.signed, asset)],
    [
      'available',
      formatAmount(
        state.depositTotal > state.signed ? state.depositTotal - state.signed : 0n,
        asset
      ),
    ],
  ];
  if (state.closedAt !== undefined) rows.push(['closed at', `${state.closedAt.toString()} (unix seconds)`]);
  if (state.settleableAt !== undefined) {
    rows.push(['settleable at', `${state.settleableAt.toString()} (unix seconds)`]);
  }
  if (state.settledAt !== undefined) rows.push(['settled at', `${state.settledAt.toString()} (unix seconds)`]);
  return rows;
}

/** The connector's own view of one channel, rendered beside ours. */
function connectorRows(entry: ClaimStateResult, asset: AssetInfo): [string, string][] {
  if (!entry.ok) {
    return [['connector', `cannot report this channel (${entry.error})`]];
  }
  return [
    ['connector claimed', formatAmount(entry.cumulativeClaimed, asset)],
    ['connector max', formatAmount(entry.maxCumulative, asset)],
    ['connector available', formatAmount(entry.available, asset)],
  ];
}

/** One channel's exit step, for a person. */
function exitRows(result: BatchExitResult): [string, string][] {
  const rows: [string, string][] = [['channel', result.channelId]];
  if (result.transaction !== undefined) rows.push(['tx', result.transaction]);
  if (result.settleableAt !== undefined) rows.push(['settleable at', result.settleableAt.toString()]);
  if (result.error !== undefined) rows.push(['error', result.error]);
  if (
    result.transaction === undefined &&
    result.error === undefined &&
    result.settleableAt === undefined
  ) {
    rows.push(['status', 'nothing left to take back']);
  }
  return rows;
}

export async function run(ctx: CommandContext): Promise<number> {
  const sub = ctx.positionals[0];
  if (sub === undefined || !(CHANNEL_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(`channel needs one of: ${CHANNEL_SUBCOMMANDS.join(', ')}`, 'channel');
  }

  const client = await ctx.client();
  const channel = client.channel;

  if (sub === 'open') {
    const state = await channel.open();
    const asset = assetInfo(state.channel.config.token);
    ctx.out.render(state, () => {
      ctx.out.line('Channel open.');
      ctx.out.rows(stateRows(state, asset));
    });
    return 0;
  }

  if (sub === 'deposit') {
    const amount = ctx.positionals[1] ?? stringOption(ctx.values, 'amount');
    if (amount === undefined) {
      throw new UsageError('channel deposit needs an amount in base units', 'channel');
    }
    let value: bigint;
    try {
      value = BigInt(amount);
    } catch {
      throw new UsageError(`'${amount}' is not a whole number of base units`, 'channel');
    }
    const state = await channel.deposit(value);
    const asset = assetInfo(state.channel.config.token);
    ctx.out.render(state, () => {
      ctx.out.line('Deposit confirmed.');
      ctx.out.rows(stateRows(state, asset));
    });
    return 0;
  }

  if (sub === 'close' || sub === 'settle') {
    const results = sub === 'close' ? await channel.close() : await channel.settle();
    ctx.out.render(results, () => {
      if (results.length === 0) {
        ctx.out.line('No channel is ready to settle yet.');
        return;
      }
      ctx.out.line(
        sub === 'close'
          ? 'Leaving every open channel. Settle each once its window has elapsed.'
          : 'Unspent deposits returned where each window had elapsed.'
      );
      for (const r of results) ctx.out.rows(exitRows(r));
    });
    return results.some((r) => r.error !== undefined) ? 1 : 0;
  }

  // status
  const channels = channel.channels();
  let connectorView: ClaimStateResult[] | undefined;
  if (boolOption(ctx.values, 'connector-view') && channels.length > 0) {
    connectorView = await client.claimState(channels.map((c) => c.channel.channelId));
  }
  ctx.out.render(connectorView === undefined ? channels : { channels, connector: connectorView }, () => {
    if (channels.length === 0) {
      ctx.out.line("No channel with this node yet. Open one with 'toon channel open', or pay for a request.");
      return;
    }
    for (const state of channels) {
      const asset = assetInfo(state.channel.config.token);
      const rows = stateRows(state, asset);
      const theirs = connectorView?.find((e) => e.channelId === state.channel.channelId);
      if (theirs !== undefined) rows.push(...connectorRows(theirs, asset));
      ctx.out.rows(rows);
      ctx.out.line();
    }
  });
  return 0;
}

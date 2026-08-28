/**
 * `toon channel open|deposit|status|close|settle` — the payment channel's
 * lifecycle, which is the only part of this CLI that spends gas.
 *
 * Every subcommand here is *your* transaction on *your* chain account. Nothing
 * about it goes through the connector: a connector has no endpoint that opens a
 * channel, it discovers yours by reading the chain (connector ADR 0052). That is
 * also why `status` reports two watermarks when asked to — the local one is what
 * this client has signed, the connector's is what it has banked, and they differ
 * exactly when a claim was signed and never accepted.
 */
import { UsageError, boolOption, stringOption } from '../args.js';
import type { CommandContext } from '../context.js';
import { CHANNEL_SUBCOMMANDS } from '../args.js';
import { assetFromTerms, formatAmount, type AssetInfo } from '../output.js';
import type { ChannelState, ClaimStateResult } from '../../client/types.js';

/** The rows that describe a channel to a person. */
function stateRows(state: ChannelState, asset: AssetInfo): [string, string][] {
  const rows: [string, string][] = [
    ['channel', state.channelId],
    ['chain', state.domain.chain],
    ['counterparty', state.counterparty],
    ['status', state.status],
    ['deposit', formatAmount(state.depositTotal, asset)],
    ['spent', formatAmount(state.spent, asset)],
    ['available', formatAmount(state.available, asset)],
    ['nonce', String(state.nonce)],
  ];
  if (state.onChain?.closedAt !== undefined) {
    rows.push(['closed at', `${state.onChain.closedAt.toString()} (unix seconds)`]);
  }
  if (state.onChain?.settleableAt !== undefined) {
    rows.push(['settleable at', `${state.onChain.settleableAt.toString()} (unix seconds)`]);
  }
  return rows;
}

/** The connector's own view of one channel, rendered beside ours. */
function connectorRows(entry: ClaimStateResult, asset: AssetInfo): [string, string][] {
  if (!entry.ok) {
    return [['connector', `cannot report this channel (${entry.error})`]];
  }
  return [
    ['connector nonce', String(entry.nonce)],
    ['connector claimed', formatAmount(entry.cumulativeClaimed, asset)],
    [
      'connector deposit',
      entry.depositTotal === null ? 'declared only' : formatAmount(entry.depositTotal, asset),
    ],
    [
      'connector available',
      entry.available === null ? 'unknown' : formatAmount(entry.available, asset),
    ],
  ];
}

export async function run(ctx: CommandContext): Promise<number> {
  const sub = ctx.positionals[0];
  if (sub === undefined || !(CHANNEL_SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new UsageError(
      `channel needs one of: ${CHANNEL_SUBCOMMANDS.join(', ')}`,
      'channel'
    );
  }

  const client = await ctx.client();
  const channel = client.channel;

  if (sub === 'open') {
    const deposit = stringOption(ctx.values, 'deposit');
    const timeout = stringOption(ctx.values, 'settlement-timeout');
    const state = await channel.open({
      ...(deposit !== undefined ? { deposit } : {}),
      ...(timeout !== undefined ? { settlementTimeout: Number(timeout) } : {}),
    });
    const asset = assetFromTerms(state.domain);
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
    const state = await channel.deposit(amount);
    const asset = assetFromTerms(state.domain);
    ctx.out.render(state, () => {
      ctx.out.line('Deposit confirmed.');
      ctx.out.rows(stateRows(state, asset));
    });
    return 0;
  }

  if (sub === 'close') {
    const result = await channel.close();
    ctx.out.render(result, () => {
      ctx.out.line('Challenge period started. Settle once it has elapsed.');
      const rows: [string, string][] = [];
      if (result.txHash !== undefined) rows.push(['tx', result.txHash]);
      if (result.closedAt !== undefined) rows.push(['closed at', result.closedAt.toString()]);
      if (result.settleableAt !== undefined) {
        rows.push(['settleable at', result.settleableAt.toString()]);
      }
      ctx.out.rows(rows);
    });
    return 0;
  }

  if (sub === 'settle') {
    const result = await channel.settle();
    ctx.out.render(result, () => {
      ctx.out.line('Channel settled; the collateral is released.');
      if (result.txHash !== undefined) ctx.out.rows([['tx', result.txHash]]);
    });
    return 0;
  }

  // status
  const state = await channel.state({ onChain: true });
  const asset = assetFromTerms(state.domain);
  let connectorView: ClaimStateResult | undefined;
  if (boolOption(ctx.values, 'connector-view')) {
    const entries = await client.claimState([state.channelId]);
    connectorView = entries[0];
  }

  ctx.out.render({ ...state, ...(connectorView !== undefined ? { connectorView } : {}) }, () => {
    ctx.out.rows(stateRows(state, asset));
    if (connectorView !== undefined) {
      ctx.out.line();
      ctx.out.rows(connectorRows(connectorView, asset));
    }
  });
  return 0;
}

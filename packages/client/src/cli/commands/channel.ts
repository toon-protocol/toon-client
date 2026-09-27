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
import type {
  BatchChannelSummary,
  BatchExitResult,
  BatchSettlementFacade,
} from '../../client/batch-settlement-facade.js';

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
  if (client.batchSettlement !== undefined) {
    return runBatchSettlement(ctx, sub, client.batchSettlement);
  }
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

/** One channel's exit step, for a person. */
function exitRows(result: BatchExitResult): [string, string][] {
  const rows: [string, string][] = [['channel', result.channelId]];
  if (result.transaction !== undefined) rows.push(['tx', result.transaction]);
  if (result.settleableAt !== undefined) rows.push(['settleable at', result.settleableAt.toString()]);
  if (result.error !== undefined) rows.push(['error', result.error]);
  if (result.transaction === undefined && result.error === undefined && result.settleableAt === undefined) {
    rows.push(['status', 'nothing left to take back']);
  }
  return rows;
}

/** The rows that describe an x402 batch-settlement channel to a person. */
function batchRows(summary: BatchChannelSummary): [string, string][] {
  const rows: [string, string][] = [
    ['channel', summary.channel.channelId],
    ['scheme', 'batch-settlement'],
    ['network', summary.channel.network],
    ['deposit', summary.depositTotal.toString()],
    ['signed', summary.signed.toString()],
  ];
  if (summary.closedAt !== undefined) rows.push(['closed at', summary.closedAt.toString()]);
  if (summary.settleableAt !== undefined) {
    rows.push(['settleable at', summary.settleableAt.toString()]);
  }
  if (summary.settledAt !== undefined) rows.push(['settled at', summary.settledAt.toString()]);
  return rows;
}

/**
 * `toon channel …` under `--batch-settlement`: the same verbs, on the x402
 * channels this client pays the node from (connector ADR 0074). Opening costs
 * no native gas; closing and settling are the payer's own transactions and do.
 */
async function runBatchSettlement(
  ctx: CommandContext,
  sub: string,
  batch: BatchSettlementFacade
): Promise<number> {
  if (sub === 'open') {
    const summary = await batch.open();
    ctx.out.render(summary, () => {
      ctx.out.line('Batch-settlement channel open.');
      ctx.out.rows(batchRows(summary));
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
    const summary = await batch.deposit(value);
    ctx.out.render(summary, () => {
      ctx.out.line('Deposit confirmed.');
      ctx.out.rows(batchRows(summary));
    });
    return 0;
  }

  if (sub === 'close' || sub === 'settle') {
    const results = sub === 'close' ? await batch.close() : await batch.settle();
    ctx.out.render(results, () => {
      if (results.length === 0) {
        ctx.out.line('No batch-settlement channel is ready to settle yet.');
        return;
      }
      ctx.out.line(
        sub === 'close'
          ? 'Leaving every open batch-settlement channel. Settle each once its window has elapsed.'
          : 'Unspent deposits returned where each window had elapsed.'
      );
      for (const r of results) ctx.out.rows(exitRows(r));
    });
    return results.some((r) => r.error !== undefined) ? 1 : 0;
  }

  // status
  const channels = batch.channels();
  ctx.out.render(channels, () => {
    if (channels.length === 0) {
      ctx.out.line('No batch-settlement channel with this node yet.');
      return;
    }
    for (const summary of channels) ctx.out.rows(batchRows(summary));
  });
  return 0;
}

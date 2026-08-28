/**
 * `toon transfer --to <address> --amount <base units> [--asset native|token]`
 *
 * An ordinary on-chain send, out of the wallet this client derives. It exists
 * because the channel wallet is a real account that accumulates change — gas
 * left over, token recovered from a settled channel — and getting it out should
 * not require importing the phrase somewhere else.
 *
 * `--amount` is in **base units**, like every other amount this CLI takes: the
 * chain and the connector agree on integers, and a CLI that quietly accepted
 * `0.1` where a contract expects `100000` is a CLI that will one day send a
 * hundred thousand times too much.
 */
import { UsageError, stringOption } from '../args.js';
import type { CommandContext } from '../context.js';
import { formatAmount } from '../output.js';
import type { TransferAssetKind } from '../../wallet/transfer.js';

export async function run(ctx: CommandContext): Promise<number> {
  const to = stringOption(ctx.values, 'to');
  const amount = stringOption(ctx.values, 'amount');
  const assetFlag = stringOption(ctx.values, 'asset') ?? 'token';
  if (to === undefined) throw new UsageError('transfer needs --to <address>', 'transfer');
  if (amount === undefined) {
    throw new UsageError('transfer needs --amount <base units>', 'transfer');
  }
  if (assetFlag !== 'native' && assetFlag !== 'token') {
    throw new UsageError(`--asset must be 'native' or 'token'; got '${assetFlag}'`, 'transfer');
  }
  const asset: TransferAssetKind = assetFlag;

  const client = await ctx.client();
  const result = await client.wallet.transfer({ chain: client.chain, asset, to, amount });

  ctx.out.render(result, () => {
    ctx.out.line('Transfer delivered.');
    ctx.out.rows([
      ['chain', result.chain],
      ['asset', result.asset],
      ['to', result.to],
      ['amount', formatAmount(result.amount)],
      ['tx', result.txHash],
      ['balance before', formatAmount(result.balanceBefore)],
      ['balance after', formatAmount(result.balanceAfter)],
    ]);
  });

  return 0;
}

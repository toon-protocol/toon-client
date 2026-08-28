/**
 * `toon balances` — what this identity holds on chain.
 *
 * Nothing here concerns the connector. It answers the two questions that come up
 * when a channel operation fails: is there gas to pay for the transaction, and
 * is there token to put in the channel.
 *
 * A chain whose RPC could not be reached is reported as unreadable rather than
 * as zero. "I could not look" and "there is nothing there" lead to opposite next
 * steps, and conflating them is how someone concludes their funds are gone.
 */
import type { CommandContext } from '../context.js';
import { formatAmount } from '../output.js';
import type { WalletTokenAmount } from '../../wallet/balances.js';

function amountRow(token: WalletTokenAmount): [string, string] {
  const label = token.symbol ?? token.address ?? 'token';
  return [
    label,
    formatAmount(token.amount, {
      ...(token.decimals !== undefined ? { decimals: token.decimals } : {}),
      ...(token.symbol !== undefined ? { symbol: token.symbol } : {}),
    }),
  ];
}

export async function run(ctx: CommandContext): Promise<number> {
  const client = await ctx.client();
  const chains = await client.wallet.balances();

  ctx.out.render({ identity: client.identity, chains }, () => {
    for (const chain of chains) {
      ctx.out.line(`${chain.chainKey}  ${chain.address}`);
      if (chain.unreadable === true) {
        ctx.out.rows([['unreadable', chain.error ?? 'the RPC could not be reached']], '    ');
        ctx.out.line();
        continue;
      }
      const rows: [string, string][] = [];
      if (chain.native !== undefined) rows.push(amountRow(chain.native));
      for (const token of chain.tokens) rows.push(amountRow(token));
      ctx.out.rows(rows, '    ');
      ctx.out.line();
    }
  });

  return 0;
}

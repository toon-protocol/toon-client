/**
 * `toon probe <destination>` — learn what a path costs without buying the work.
 *
 * A probe carries a real claim but never spends it: the connector prices the
 * path, reports the figure, and refuses the packet. So the refusal printed here
 * is the *successful* outcome, and the command exits 0 — the failure mode of a
 * probe is not getting an answer, not being told no.
 */
import { UsageError } from '../args.js';
import type { CommandContext } from '../context.js';
import { assetFromSettlement, formatAmount } from '../output.js';

export async function run(ctx: CommandContext): Promise<number> {
  const destination = ctx.positionals[0];
  if (destination === undefined) throw new UsageError('probe needs a destination', 'probe');

  const client = await ctx.client();
  const result = await client.probe(destination);
  const description = await client.describe();
  const asset = assetFromSettlement(description.settlements[0]);

  ctx.out.render({ destination, ...result }, () => {
    ctx.out.rows([
      ['destination', destination],
      ['cost', formatAmount(result.accumulatedCost, asset)],
      ['code', result.code],
      ['message', result.message],
    ]);
  });

  return 0;
}

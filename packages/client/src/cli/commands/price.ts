/**
 * `toon price <destination> [URL]` — what one route costs.
 *
 * Free, keyless and channel-less, like `describe`. `null` back from the
 * connector is a real answer — "no route I serve matches this destination" —
 * and is printed as such rather than turned into an error, because asking about
 * a destination a node does not carry is a normal thing to do while finding out
 * which node does.
 */
import { UsageError } from '../args.js';
import type { CommandContext } from '../context.js';
import { assetFromSettlement, formatAmount } from '../output.js';

export async function run(ctx: CommandContext): Promise<number> {
  const destination = ctx.positionals[0];
  if (destination === undefined) throw new UsageError('price needs a destination', 'price');
  const url = ctx.positionals[1];

  const client = await ctx.client({
    keyless: true,
    ...(url !== undefined ? { connector: url } : {}),
  });
  const price = await client.price(destination);
  // The decimals a price is denominated in are the settlement's, so the
  // self-description is read even here — it is cached and already fetched.
  const description = await client.describe();
  const asset = assetFromSettlement(description.settlements[0]);

  ctx.out.render(
    {
      connector: client.connector,
      destination,
      price,
      decimals: asset.decimals,
      asset: asset.symbol,
    },
    () => {
      if (price === null) {
        ctx.out.line(`${destination}  no route — this node prices nothing that covers it`);
      } else {
        ctx.out.line(`${destination}  ${formatAmount(price, asset)}`);
      }
    }
  );

  return 0;
}

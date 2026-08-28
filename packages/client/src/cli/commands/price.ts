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
  const terms = await client.routePrice(destination);
  // The decimals a price is denominated in are the settlement's, so the
  // self-description is read even here — it is cached and already fetched.
  const description = await client.describe();
  const asset = assetFromSettlement(description.settlements[0]);
  const perKib = terms?.pricePerKib;

  ctx.out.render(
    {
      connector: client.connector,
      destination,
      price: terms?.price ?? null,
      ...(perKib !== undefined ? { pricePerKib: perKib } : {}),
      decimals: asset.decimals,
      asset: asset.symbol,
    },
    () => {
      if (terms === null) {
        ctx.out.line(`${destination}  no route — this node prices nothing that covers it`);
      } else if (perKib === undefined) {
        ctx.out.line(`${destination}  ${formatAmount(terms.price, asset)}`);
      } else {
        // A metered route's base price is never what a packet costs, so the
        // rate is printed beside it rather than left for a refusal to reveal.
        ctx.out.line(
          `${destination}  ${formatAmount(terms.price, asset)}` +
            ` + ${formatAmount(perKib, asset)}/KiB of sealed payload`
        );
      }
    }
  );

  return 0;
}

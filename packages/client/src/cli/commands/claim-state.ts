/**
 * `toon claim-state` — the connector's own watermark for the channels this
 * identity controls.
 *
 * The authoritative half of the picture. `toon channel status` shows what this
 * client has *signed*; this shows what the connector has *banked*, which is the
 * figure every future claim has to advance past. When the two disagree, a claim
 * was signed and never accepted, and the connector's number is the one to
 * believe.
 */
import type { CommandContext } from '../context.js';
import { assetFromSettlement, formatAmount } from '../output.js';

export async function run(ctx: CommandContext): Promise<number> {
  const client = await ctx.client();
  const entries = await client.claimState();
  const description = await client.describe();
  const asset = assetFromSettlement(description.settlements[0]);

  ctx.out.render({ connector: client.connector, channels: entries }, () => {
    if (entries.length === 0) {
      ctx.out.line('This connector reports no channels for your account.');
      ctx.out.line("Open one with 'toon channel open --deposit 100000'.");
      return;
    }
    for (const entry of entries) {
      const id = entry.channelId ?? entry.channelAccount ?? '(unnamed)';
      if (!entry.ok) {
        ctx.out.rows([
          ['channel', id],
          ['chain', entry.blockchain],
          ['state', `unreadable (${entry.error})`],
        ]);
        ctx.out.line();
        continue;
      }
      ctx.out.rows([
        ['channel', id],
        ['chain', entry.blockchain],
        ['nonce', String(entry.nonce)],
        ['claimed', formatAmount(entry.cumulativeClaimed, asset)],
        [
          'deposit',
          entry.depositTotal === null ? 'declared only' : formatAmount(entry.depositTotal, asset),
        ],
        ['available', entry.available === null ? 'unknown' : formatAmount(entry.available, asset)],
        [
          // Printed as the connector gave it, unconverted: the field is
          // best-effort and non-durable, and `null` means "unknown", never
          // "never claimed" (client-edge-spec.md §1.10).
          'last claim',
          entry.lastClaimTime === null ? 'unknown — not "never"' : String(entry.lastClaimTime),
        ],
      ]);
      ctx.out.line();
    }
  });

  return 0;
}

/**
 * `toon faucet` — ask the devnet faucet for test funds.
 *
 * Devnet only, and deliberately unglamorous: it drips the settlement token (and,
 * on Base Sepolia, the gas to move it) onto the address this keystore derives,
 * so that `toon channel open` has something to lock. On a real network this
 * command has nothing to do.
 */
import type { CommandContext } from '../context.js';

export async function run(ctx: CommandContext): Promise<number> {
  const client = await ctx.client();
  const result = await client.wallet.faucet();

  ctx.out.render(result, () => {
    ctx.out.line('Faucet request accepted.');
    ctx.out.rows([
      ['chain', result.chain],
      ['address', result.address],
    ]);
    ctx.out.line();
    ctx.out.line("Check it landed with 'toon balances'.");
  });

  return 0;
}

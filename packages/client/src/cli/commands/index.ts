/**
 * The command table: the one place a name becomes code.
 *
 * Kept beside {@link ../args.js!COMMANDS} — which is the one place a name
 * becomes *help* — and checked against it by this package's own tests, so a
 * command can never be dispatchable without being documented or documented
 * without being dispatchable.
 */
import type { CommandContext } from '../context.js';
import * as balances from './balances.js';
import * as channel from './channel.js';
import * as claimState from './claim-state.js';
import * as describe from './describe.js';
import * as faucet from './faucet.js';
import * as identity from './identity.js';
import * as init from './init.js';
import * as price from './price.js';
import * as probe from './probe.js';
import * as send from './send.js';
import * as transfer from './transfer.js';

/** A command: do the work, return the process exit code. */
export type CommandRunner = (ctx: CommandContext) => Promise<number>;

export const RUNNERS: Record<string, CommandRunner> = {
  init: init.run,
  identity: identity.run,
  describe: describe.run,
  price: price.run,
  probe: probe.run,
  send: send.run,
  channel: channel.run,
  'claim-state': claimState.run,
  balances: balances.run,
  transfer: transfer.run,
  faucet: faucet.run,
};

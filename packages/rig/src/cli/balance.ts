/**
 * `rig balance` — the combined money view for the active identity (#263):
 * on-chain wallet balances plus open payment-channel holdings.
 *
 * FREE: no payment, no nonce guard, no channel, no relay. The wallet section
 * reuses the client's own balance readers (`ToonClient.getBalances()` on the
 * UNSTARTED embedded client) which read the SETTLEMENT chain the channels
 * actually use — the settlement-chain key wins over the network preset's
 * primary chain, so a devnet identity funded on `evm:anvil:31337` shows that
 * balance, not the preset chain's zero (the #260-era getBalances mismatch).
 * The channel section joins the #262 peer→channel map with the claim
 * watermark: deposited / claimed / available per recorded channel of THIS
 * identity. A write uplink is NOT required (`requireUplink: false`) — reads
 * work from a read-only config.
 */

import { parseArgs } from 'node:util';
import {
  channelStatus,
  ChannelMapStore,
  resolveChannelPaths,
} from '../standalone/channel-map.js';
import type { WalletBalanceInfo } from '../standalone/money.js';
import { describeError } from './errors.js';
import {
  defaultLoadStandalone,
  identityReport,
  type IdentityReport,
  type PushDeps,
} from './push.js';
import { renderIdentityLine } from './render.js';
import type { StandaloneContext } from './standalone-context.js';

export const BALANCE_USAGE = `Usage: rig balance [--json]

Show the active identity's money: on-chain wallet balances (per configured
chain, read from the settlement chain the payment channels actually use) and
recorded payment-channel holdings (deposited / claimed / available). Free —
reads chain RPCs and local state only; nothing is signed or paid.

Options:
  --json      machine-readable envelope (base units as strings)
  -h, --help  show this help`;

/** What `rig balance` needs — the shared paid-command deps (loader seam). */
export type BalanceDeps = PushDeps;

/** One recorded channel in the balance view. */
interface ChannelBalanceJson {
  channelId: string;
  destination: string;
  peerId: string;
  chain: string;
  status: 'open' | 'closing' | 'settleable' | 'settled';
  depositTotal: string | null;
  cumulativeClaimed: string | null;
  nonce: number | null;
  /** depositTotal − cumulativeClaimed, when both are known (floored at 0). */
  available: string | null;
}

/** `--json` envelope. */
interface BalanceJson {
  command: 'balance';
  identity: IdentityReport;
  wallet: WalletBalanceInfo[];
  channels: ChannelBalanceJson[];
}

/** Run `rig balance`; returns the process exit code. */
export async function runBalance(
  args: string[],
  deps: BalanceDeps
): Promise<number> {
  const { io, env } = deps;
  let json = false;
  try {
    const { values } = parseArgs({
      args,
      options: {
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      io.out(BALANCE_USAGE);
      return 0;
    }
    json = values.json ?? false;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(BALANCE_USAGE);
    return 2;
  }

  let ctx: StandaloneContext | undefined;
  try {
    ctx = await (deps.loadStandalone ?? defaultLoadStandalone)({
      env,
      cwd: deps.cwd,
      warn: (line) => io.err(line),
      // Free read: works without a proxy/BTP write uplink.
      requireUplink: false,
    });
    const identity = identityReport(ctx);

    // ── Wallet: the client's own settlement-chain-aware balance readers ─────
    const wallet = ctx.money ? await ctx.money.walletBalances() : [];

    // ── Channels: #262 map ⋈ claim watermark, THIS identity only ────────────
    const store = new ChannelMapStore(resolveChannelPaths(env));
    const channels: ChannelBalanceJson[] = store
      .list()
      .filter((record) => record.identity === identity.pubkey)
      .map((record) => {
        const watermark = store.readWatermark(record.channelId);
        const deposited = record.depositTotal;
        const claimed = watermark?.cumulativeAmount;
        let available: string | null = null;
        if (deposited !== undefined && claimed !== undefined) {
          const remaining = BigInt(deposited) - BigInt(claimed);
          available = (remaining > 0n ? remaining : 0n).toString();
        }
        return {
          channelId: record.channelId,
          destination: record.destination,
          peerId: record.peerId,
          chain: record.chain,
          status: channelStatus(watermark),
          depositTotal: deposited ?? null,
          cumulativeClaimed: claimed ?? null,
          nonce: watermark?.nonce ?? null,
          available,
        };
      });

    if (json) {
      io.out(
        JSON.stringify(
          { command: 'balance', identity, wallet, channels } satisfies BalanceJson,
          null,
          2
        )
      );
      return 0;
    }

    io.out(renderIdentityLine(identity));
    io.out('');
    io.out('Wallet (on-chain):');
    if (wallet.length === 0) {
      io.out(
        '  (no balance readable — no chain configured, the RPC is unreachable, ' +
          "or the chain's keys derive only during a client start)"
      );
    }
    for (const balance of wallet) {
      io.out(
        `  ${balance.chain.padEnd(7)} ${balance.address}  ${balance.amount}` +
          (balance.asset ? ` ${balance.asset}` : ' base units') +
          (balance.assetScale !== undefined ? ` (scale ${balance.assetScale})` : '')
      );
    }
    io.out('');
    io.out('Channels (recorded):');
    if (channels.length === 0) {
      io.out(
        '  none — paid commands record their channel on first use; ' +
          '`rig channel open` records one explicitly.'
      );
    }
    for (const c of channels) {
      io.out(
        `  ${c.channelId} [${c.status}]  deposited ${c.depositTotal ?? '?'}  ` +
          `claimed ${c.cumulativeClaimed ?? '?'}  available ${c.available ?? '?'}` +
          `  (${c.chain} → ${c.destination})`
      );
    }
    return 0;
  } catch (err) {
    const described = describeError(err, 'balance');
    if (json) {
      io.out(JSON.stringify({ command: 'balance', ...described.json }, null, 2));
    } else {
      for (const line of described.lines) io.err(line);
    }
    return 1;
  } finally {
    if (ctx) {
      try {
        await ctx.stop();
      } catch {
        // best-effort teardown
      }
    }
  }
}

/**
 * `rig balance` — the combined money view for the active identity (#263):
 * on-chain wallet balances plus open payment-channel holdings.
 *
 * FREE: no payment, no nonce guard, no channel, no relay. The wallet section
 * reuses the client's full multi-chain reader (`ToonClient.getWalletBalances()`
 * on the UNSTARTED embedded client, #299): for every configured chain it shows
 * the native coin (ETH / SOL / MINA) AND USDC. The Solana/Mina addresses are
 * derived from the mnemonic on demand — the same keys `start()` registers and
 * `rig fund` prints — so all chains appear even before a start. The EVM chain
 * key is the settlement chain (it wins over the network preset's primary), so a
 * devnet identity funded on `evm:anvil:31337` shows that chain's balances, not
 * the preset chain's zero (the #260-era getBalances mismatch). Each chain reads
 * independently; an unreachable RPC degrades to a per-chain notice.
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
import type {
  WalletChainBalanceInfo,
  WalletTokenAmountInfo,
} from '../standalone/money.js';
import { emitCliError } from './errors.js';
import {
  defaultLoadStandalone,
  identityReport,
  type IdentityReport,
  type PushDeps,
} from './push.js';
import { renderIdentityLine } from './render.js';
import type { StandaloneContext } from './standalone-context.js';

export const BALANCE_USAGE = `Usage: rig balance [--json]

Show the active identity's money: the full on-chain wallet view — native coin
plus USDC on every configured chain (EVM / Solana / Mina) — and recorded
payment-channel holdings (deposited / claimed / available). Free — reads chain
RPCs and local state only; nothing is signed or paid. An unreachable chain RPC
degrades to a per-chain notice without failing the others.

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
  wallet: WalletChainBalanceInfo[];
  channels: ChannelBalanceJson[];
}

/**
 * Format a base-unit integer string as a human decimal using `decimals`.
 * No decimals known → the base-unit string verbatim. Trims trailing zeros but
 * keeps at least one fractional digit only when non-integer.
 */
export function formatUnits(amount: string, decimals?: number): string {
  if (decimals === undefined || decimals <= 0) return amount;
  const neg = amount.startsWith('-');
  const digits = (neg ? amount.slice(1) : amount).padStart(decimals + 1, '0');
  const whole = digits.slice(0, digits.length - decimals);
  const frac = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + (frac ? `${whole}.${frac}` : whole);
}

/** `SYMBOL amount` for one asset, formatted with its decimals. */
function renderAmount(a: WalletTokenAmountInfo): string {
  return `${a.symbol ?? 'token'} ${formatUnits(a.amount, a.decimals)}`;
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

    // ── Wallet: the client's full multi-chain view (#299) — native + USDC ───
    const wallet = ctx.money ? await ctx.money.walletChainBalances() : [];

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
      io.emitJson({
        command: 'balance',
        identity,
        wallet,
        channels,
      } satisfies BalanceJson);
      return 0;
    }

    io.out(renderIdentityLine(identity));
    io.out('');
    io.out('Wallet (on-chain):');
    if (wallet.length === 0) {
      io.out(
        '  (no chain configured for this identity — nothing to read)'
      );
    }
    for (const chain of wallet) {
      io.out(`  ${chain.chainKey.padEnd(11)} ${chain.address}`);
      if (chain.unreadable) {
        io.out(
          `    unreadable (RPC unreachable)` +
            (chain.error ? ` — ${chain.error}` : '')
        );
        continue;
      }
      const assets = [...(chain.native ? [chain.native] : []), ...chain.tokens];
      if (assets.length === 0) {
        io.out('    (no balance readable)');
        continue;
      }
      io.out(`    ${assets.map(renderAmount).join('   ')}`);
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
    return emitCliError(io, json, 'balance', err);
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

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
  /**
   * cumulativeClaimed − depositTotal, when both are known (floored at 0).
   * Non-zero means the cumulative signed claims exceed the recorded on-chain
   * collateral: the peer accepted (and may keep accepting) claims it cannot
   * fully redeem on-chain until the deposit is topped up — the on-chain
   * TokenNetwork caps redemption at the deposit. `available 0` alone cannot
   * distinguish "exactly spent" from "overdrawn", hence this field.
   */
  overdrawn: string | null;
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

/** Env override for the wallet-read timeout; `0` opts out (wait forever). */
const WALLET_READ_TIMEOUT_ENV = 'RIG_BALANCE_WALLET_TIMEOUT_MS';
/** Default cap on the wallet read — generous, only trips a genuine hang. */
const DEFAULT_WALLET_READ_TIMEOUT_MS = 20_000;

/** Resolve the wallet-read timeout (ms): valid non-negative env override, else default. */
export function walletReadTimeoutMs(env: NodeJS.ProcessEnv): number {
  const raw = env[WALLET_READ_TIMEOUT_ENV];
  if (raw === undefined || raw === '') return DEFAULT_WALLET_READ_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_WALLET_READ_TIMEOUT_MS;
}

/**
 * The wallet read exceeded {@link walletReadTimeoutMs}. This is the guard that
 * turns the silent-exit bug into a loud, actionable failure: on the Mina
 * settlement path a wallet read can neither resolve nor keep a live handle
 * open (a hung GraphQL endpoint, a nonexistent on-chain account, o1js-adjacent
 * work), so awaiting it UNBOUNDED lets Node's event loop drain and the one-shot
 * CLI exits 0 with no output at all. The bounded read's live timer prevents
 * that drain and forces a decision instead.
 */
export class WalletReadTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(
      `wallet balance read timed out after ${timeoutMs}ms — the chain ` +
        'RPC/GraphQL endpoint is unreachable or hanging. (A nonexistent Mina ' +
        'account reads as 0, so a hang points at the endpoint, not an empty ' +
        'balance.) Recorded channels are unaffected; retry, or set ' +
        `${WALLET_READ_TIMEOUT_ENV}=0 to wait indefinitely.`
    );
    this.name = 'WalletReadTimeoutError';
  }
}

/**
 * Read the multi-chain wallet view under a hard time bound. The `setTimeout`
 * is deliberately NOT `unref()`ed: its live handle is exactly what keeps the
 * one-shot CLI's event loop from draining to a silent exit-0 while the read
 * hangs. A late rejection from the losing promise is swallowed so it never
 * surfaces as an unhandled rejection after the race is decided.
 */
export async function readWalletBounded(
  read: () => Promise<WalletChainBalanceInfo[]>,
  timeoutMs: number
): Promise<WalletChainBalanceInfo[]> {
  const settled = read();
  // A `0` (or negative) timeout opts out of the bound entirely (wait forever).
  if (timeoutMs <= 0) return settled;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new WalletReadTimeoutError(timeoutMs)), timeoutMs);
  });
  // Don't let the loser reject into an unhandled rejection post-race.
  settled.catch(() => {});
  try {
    return await Promise.race([settled, guard]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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

    // ── Channels: #262 map ⋈ claim watermark, THIS identity only ────────────
    // Read FIRST: a purely local read that is always available (a corrupt map
    // is still a clear error via the outer catch), so the report can show
    // recorded channels even when the on-chain wallet read below fails.
    const store = new ChannelMapStore(resolveChannelPaths(env));
    const channels: ChannelBalanceJson[] = store
      .list()
      .filter((record) => record.identity === identity.pubkey)
      .map((record) => {
        const watermark = store.readWatermark(record.channelId);
        const deposited = record.depositTotal;
        const claimed = watermark?.cumulativeAmount;
        let available: string | null = null;
        let overdrawn: string | null = null;
        if (deposited !== undefined && claimed !== undefined) {
          const remaining = BigInt(deposited) - BigInt(claimed);
          available = (remaining > 0n ? remaining : 0n).toString();
          overdrawn = (remaining < 0n ? -remaining : 0n).toString();
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
          overdrawn,
        };
      });

    // ── Wallet: the client's full multi-chain view (#299) — native + USDC ───
    // BOUNDED. An unbounded await here is the silent-exit bug: on the Mina path
    // the read can neither resolve nor keep the event loop alive, so the CLI
    // drains and exits 0 with no output. The bound turns any such hang into a
    // loud, non-zero failure that STILL prints the identity + channels.
    let wallet: WalletChainBalanceInfo[] = [];
    let walletError: Error | undefined;
    if (ctx.money) {
      const money = ctx.money;
      try {
        wallet = await readWalletBounded(
          () => money.walletChainBalances(),
          walletReadTimeoutMs(env)
        );
      } catch (err) {
        walletError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (json) {
      // A wallet-read failure is a hard error in the machine contract: emit the
      // single error envelope (never a partial + a silent 0).
      if (walletError) return emitCliError(io, json, 'balance', walletError);
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
    if (walletError) {
      // Loud, actionable — never a silent gap. The channels below still print.
      io.out(`  wallet balances unavailable — ${walletError.message}`);
    } else if (wallet.length === 0) {
      io.out('  (no chain configured for this identity — nothing to read)');
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
      if (c.overdrawn !== null && BigInt(c.overdrawn) > 0n) {
        io.out(
          `    OVERDRAWN by ${c.overdrawn}: cumulative claims exceed the ` +
            `recorded deposit — the peer accepted claims only partially ` +
            `covered by on-chain collateral. Top up with ` +
            `\`rig channel open --deposit <amount>\`.`
        );
      }
    }
    // Non-zero when the wallet read failed — the report is printed, but the
    // command reports failure (never a silent success on a broken read).
    return walletError ? 1 : 0;
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

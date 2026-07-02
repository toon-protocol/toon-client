/**
 * `rig channel` — the payment channels paid rig commands hold (#262), plus
 * the explicit money lifecycle (#263): open / close / settle.
 *
 * Paid commands open a channel lazily on first use and RECORD it in the
 * peer→channel map under `TOON_CLIENT_HOME` (default `~/.toon-client`,
 * `rig-channels.json`), so later invocations resume the same channel instead
 * of opening (and funding) a new one per run. `rig channel list` reads that
 * map plus the client's nonce-watermark store (`channels.json`) and shows
 * current holdings — a FREE command: local files only, no client start, no
 * network, no payment (and therefore no `@toon-protocol/client` import).
 *
 * The lifecycle subcommands are ON-CHAIN wallet operations (gas + collateral
 * movement, not relay claims), so they follow the push confirm idiom: print
 * what will happen, then require `--yes` (mandatory in a non-TTY session) or
 * an interactive y/N confirm; `--json` without `--yes` is a pure plan.
 *
 *   open    the SAME resume-or-open path lazy paid writes use (factored, not
 *           forked): resumes the recorded channel when one is live, else
 *           opens + records a fresh one; `--deposit` adds collateral on top.
 *   close   starts the settlement challenge window for a recorded channel —
 *           the channel stops paying immediately; collateral is released by
 *           `settle` once the window elapses.
 *   settle  releases the remaining collateral after the challenge window
 *           (the client refuses a too-early settle BEFORE spending gas).
 *
 * close/settle recover deposits stranded by pre-#262 one-channel-per-run
 * behaviour: any channel present in the map can be driven to settled.
 */

import { parseArgs } from 'node:util';
import {
  channelStatus,
  ChannelMapStore,
  resolveChannelPaths,
  type ChannelMapRecord,
  type WatermarkEntry,
} from '../standalone/channel-map.js';
import { emitCliError } from './errors.js';
import {
  defaultLoadStandalone,
  identityReport,
  type CliIo,
  type IdentityReport,
  type PushDeps,
} from './push.js';
import { renderIdentityLine } from './render.js';
import type { StandaloneContext } from './standalone-context.js';
import type { StandaloneMoneyOps } from '../standalone/money.js';

export const CHANNEL_USAGE = `Usage: rig channel <subcommand>

Manage the payment channels paid rig commands hold with relay/store peers.
Paid commands open a channel lazily on first use and record it under
TOON_CLIENT_HOME (default ~/.toon-client, rig-channels.json), so later
invocations resume the same channel instead of opening a new one per run.

Subcommands:
  list [--json]    show recorded channels — peer, chain, channel id, deposit,
                   cumulative claimed, status. Free: reads local state only.

  open [--peer <ilp-destination>] [--deposit <base-units>]
                   explicitly open the payment channel for a peer — the SAME
                   path paid commands use lazily: resumes the recorded live
                   channel if one exists (no on-chain spend), else opens and
                   records a fresh one (locks the peer-negotiated initial
                   deposit on-chain). --peer is the ILP destination to anchor
                   to (default: the configured destination, e.g. the devnet
                   apex); --deposit adds that much extra collateral after the
                   open/resume. On-chain: asks for confirmation (--yes skips).

  close <channelId>
                   close a recorded channel — an on-chain tx that starts the
                   settlement challenge window (the peer's settlementTimeout).
                   The channel stops paying immediately; the remaining
                   collateral stays locked until \`rig channel settle\` after
                   the window elapses. Asks for confirmation (--yes skips).

  settle <channelId>
                   settle a closed channel once its challenge window elapsed —
                   an on-chain tx that releases the remaining collateral back
                   to your wallet. Refused (without spending gas) while the
                   window is still open. Asks for confirmation (--yes skips).

Common options: --json (machine-readable envelopes; without --yes lifecycle
commands emit a pure plan and execute nothing), --yes, -h/--help.`;

/**
 * What `rig channel` needs from the command environment — the shared paid
 * command deps (io/env/cwd + injectable standalone loader): `list` uses only
 * io/env, the lifecycle subcommands load the standalone context.
 */
export type ChannelDeps = PushDeps;

/** One channel in the `--json` envelope (unknowns are null, bigints strings). */
interface ChannelJson {
  channelId: string;
  peerId: string;
  identity: string;
  destination: string;
  chain: string;
  tokenNetwork: string;
  depositTotal: string | null;
  cumulativeClaimed: string | null;
  nonce: number | null;
  status: 'open' | 'closing' | 'settleable' | 'settled';
  openedAt: string;
  lastUsedAt: string;
}

/** Route one `rig channel …` invocation; returns the exit code. */
export async function runChannel(
  args: string[],
  deps: ChannelDeps
): Promise<number> {
  const { io } = deps;
  const [sub, ...rest] = args;
  switch (sub) {
    case 'list':
      return runChannelList(rest, deps);
    case 'open':
      return runChannelOpen(rest, deps);
    case 'close':
      return runChannelWithdrawStep(rest, deps, 'close');
    case 'settle':
      return runChannelWithdrawStep(rest, deps, 'settle');
    case 'help':
    case '--help':
    case '-h':
      io.out(CHANNEL_USAGE);
      return 0;
    case undefined:
      io.err(CHANNEL_USAGE);
      return 2;
    default:
      io.err(`rig channel: unknown subcommand ${JSON.stringify(sub)}`);
      io.err(CHANNEL_USAGE);
      return 2;
  }
}

// ---------------------------------------------------------------------------
// list (#262)
// ---------------------------------------------------------------------------

function runChannelList(args: string[], deps: ChannelDeps): number {
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
      io.out(CHANNEL_USAGE);
      return 0;
    }
    json = values.json ?? false;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CHANNEL_USAGE);
    return 2;
  }

  try {
    const paths = resolveChannelPaths(env);
    const store = new ChannelMapStore(paths);
    const records = store.list();
    const rows = records.map((record) => describeChannel(record, store));

    if (json) {
      io.emitJson({ command: 'channel list', channels: rows });
      return 0;
    }
    if (rows.length === 0) {
      io.out(
        'No payment channels recorded — paid rig commands (push, issue, ' +
          'comment, pr) record the channel they open on first use, and ' +
          '`rig channel open` records an explicit one.'
      );
      return 0;
    }
    io.out(
      `${rows.length} payment channel${rows.length === 1 ? '' : 's'} ` +
        `recorded in ${paths.mapPath}:`
    );
    for (const row of rows) {
      io.out('');
      for (const line of renderChannel(row)) io.out(line);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'channel list', err);
  }
}

/** Join one map record with its watermark state. */
function describeChannel(
  record: ChannelMapRecord,
  store: ChannelMapStore
): ChannelJson {
  const watermark: WatermarkEntry | undefined = store.readWatermark(
    record.channelId
  );
  return {
    channelId: record.channelId,
    peerId: record.peerId,
    identity: record.identity,
    destination: record.destination,
    chain: record.chain,
    tokenNetwork: record.tokenNetwork,
    depositTotal: record.depositTotal ?? null,
    cumulativeClaimed: watermark?.cumulativeAmount ?? null,
    nonce: watermark?.nonce ?? null,
    status: channelStatus(watermark),
    openedAt: record.openedAt,
    lastUsedAt: record.lastUsedAt,
  };
}

function renderChannel(row: ChannelJson): string[] {
  const claimed =
    row.cumulativeClaimed === null
      ? 'unknown (no local claim state)'
      : `${row.cumulativeClaimed} base units (nonce ${row.nonce})`;
  return [
    `channel ${row.channelId} [${row.status}]`,
    `  peer        ${row.destination} (${row.peerId})`,
    `  identity    ${row.identity.slice(0, 8)}…`,
    `  chain       ${row.chain}` +
      (row.tokenNetwork ? `  token-network ${row.tokenNetwork}` : ''),
    `  deposited   ${row.depositTotal ?? 'unrecorded'}` +
      (row.depositTotal ? ' base units' : ''),
    `  claimed     ${claimed}`,
    `  opened      ${row.openedAt}  (last used ${row.lastUsedAt})`,
  ];
}

// ---------------------------------------------------------------------------
// Shared money-command plumbing (#263)
// ---------------------------------------------------------------------------

/** Load the standalone context and require its money-ops surface. */
async function loadMoneyContext(
  deps: ChannelDeps,
  options?: { channelDestination?: string }
): Promise<{ ctx: StandaloneContext; money: StandaloneMoneyOps }> {
  const ctx = await (deps.loadStandalone ?? defaultLoadStandalone)({
    env: deps.env,
    cwd: deps.cwd,
    warn: (line) => deps.io.err(line),
    ...(options?.channelDestination
      ? { channelDestination: options.channelDestination }
      : {}),
  });
  const money = ctx.money;
  if (!money) {
    await ctx.stop().catch(() => undefined);
    throw new Error(
      'this standalone loader does not expose money operations — ' +
        'channel open/close/settle need the #263 loader'
    );
  }
  return { ctx, money };
}

/**
 * The push-idiom confirm gate for an ON-CHAIN money operation. Returns the
 * exit code to bail out with, or undefined to proceed. In `--json` mode
 * without `--yes` the caller emits its plan envelope (exit 0) — this gate
 * signals that with `'json-plan'`.
 */
async function confirmOnChain(
  io: CliIo,
  flags: { yes: boolean; json: boolean },
  question: string
): Promise<'proceed' | 'json-plan' | number> {
  if (flags.yes) return 'proceed';
  if (flags.json) return 'json-plan';
  if (!io.isInteractive) {
    io.err(
      'refusing to move on-chain funds without confirmation in a ' +
        'non-interactive session — re-run with --yes (or use --json for a plan)'
    );
    return 1;
  }
  const proceed = await io.confirm(question);
  if (proceed) return 'proceed';
  io.err('aborted — no on-chain transaction was sent.');
  return 1;
}

/** Format a string-encoded unix-seconds timestamp for humans. */
function formatUnixSeconds(value: string): string {
  const ms = Number(value) * 1000;
  return Number.isFinite(ms) ? new Date(ms).toISOString() : `t=${value}s`;
}

/** Whole seconds from now until a string-encoded unix-seconds timestamp. */
function secondsUntil(value: string, nowSec: number): number {
  return Number(value) - nowSec;
}

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

interface ChannelOpenJson {
  command: 'channel open';
  identity: IdentityReport;
  executed: boolean;
  plan: { destination: string | null; deposit: string | null };
  result?: {
    channelId: string;
    resumed: boolean;
    destination: string;
    chain: string | null;
    peerId: string | null;
    depositTotal: string | null;
    depositAdded: string | null;
    depositTxHash: string | null;
  };
  hint?: string;
}

async function runChannelOpen(
  args: string[],
  deps: ChannelDeps
): Promise<number> {
  const { io } = deps;
  let peer: string | undefined;
  let deposit: bigint | undefined;
  let yes = false;
  let json = false;
  try {
    const { values } = parseArgs({
      args,
      options: {
        peer: { type: 'string' },
        deposit: { type: 'string' },
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
    });
    if (values.help) {
      io.out(CHANNEL_USAGE);
      return 0;
    }
    peer = values.peer;
    yes = values.yes ?? false;
    json = values.json ?? false;
    if (values.deposit !== undefined) {
      if (!/^\d+$/.test(values.deposit) || BigInt(values.deposit) <= 0n) {
        throw new Error(
          `--deposit must be a positive base-unit integer, got ${JSON.stringify(values.deposit)}`
        );
      }
      deposit = BigInt(values.deposit);
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CHANNEL_USAGE);
    return 2;
  }

  let ctx: StandaloneContext | undefined;
  try {
    const loaded = await loadMoneyContext(deps, {
      ...(peer ? { channelDestination: peer } : {}),
    });
    ctx = loaded.ctx;
    const identity = identityReport(ctx);
    const plan = {
      destination: peer ?? null,
      deposit: deposit?.toString() ?? null,
    };

    if (!json) {
      io.out('Channel open plan:');
      io.out(`  peer (ILP)  ${peer ?? '(configured default destination)'}`);
      io.out(
        `  deposit     ${deposit !== undefined ? `+${deposit} base units of extra collateral after the open/resume` : 'none beyond the peer-negotiated initial deposit'}`
      );
      io.out(renderIdentityLine(identity));
      io.out(
        'If a live channel is already recorded for this peer it is RESUMED ' +
          '(no on-chain spend); otherwise an on-chain channel open locks the ' +
          'peer-negotiated initial deposit from your wallet (plus gas).'
      );
    }

    const gate = await confirmOnChain(
      io,
      { yes, json },
      'Proceed with on-chain channel open? [y/N] '
    );
    if (gate === 'json-plan') {
      io.emitJson({
        command: 'channel open',
        identity,
        executed: false,
        plan,
        hint: 'plan only — re-run with --yes to open (on-chain: locks collateral and spends gas)',
      } satisfies ChannelOpenJson);
      return 0;
    }
    if (gate !== 'proceed') return gate;

    const outcome = await loaded.money.openChannel(
      deposit !== undefined ? { deposit } : undefined
    );

    if (json) {
      io.emitJson({
        command: 'channel open',
        identity,
        executed: true,
        plan,
        result: {
          channelId: outcome.channelId,
          resumed: outcome.resumed,
          destination: outcome.destination,
          chain: outcome.chain ?? null,
          peerId: outcome.peerId ?? null,
          depositTotal: outcome.depositTotal ?? null,
          depositAdded: outcome.depositAdded ?? null,
          depositTxHash: outcome.depositTxHash ?? null,
        },
      } satisfies ChannelOpenJson);
      return 0;
    }
    io.out(
      outcome.resumed
        ? `Resumed recorded channel ${outcome.channelId} — no on-chain open was needed.`
        : `Opened channel ${outcome.channelId}${outcome.chain ? ` on ${outcome.chain}` : ''} and recorded it for reuse.`
    );
    io.out(`  peer        ${outcome.destination}${outcome.peerId ? ` (${outcome.peerId})` : ''}`);
    if (outcome.depositAdded) {
      io.out(
        `  deposited   +${outcome.depositAdded} base units` +
          (outcome.depositTxHash ? `  (tx ${outcome.depositTxHash})` : '')
      );
    }
    if (outcome.depositTotal) {
      io.out(`  collateral  ${outcome.depositTotal} base units total on-chain`);
    }
    return 0;
  } catch (err) {
    return emitCliError(io, json, 'channel open', err);
  } finally {
    await stopQuietly(ctx);
  }
}

// ---------------------------------------------------------------------------
// close / settle (the two halves of withdraw)
// ---------------------------------------------------------------------------

interface WithdrawJson {
  command: 'channel close' | 'channel settle';
  identity: IdentityReport;
  executed: boolean;
  channelId: string;
  result?: {
    txHash: string | null;
    closedAt?: string;
    settleableAt?: string;
  };
  hint?: string;
}

/**
 * Fail-fast local pre-checks from the recorded watermark timers — before any
 * identity resolution or client start (chain state stays authoritative: the
 * client re-checks before spending gas).
 */
function withdrawPrecheck(
  step: 'close' | 'settle',
  channelId: string,
  watermark: WatermarkEntry | undefined,
  nowSec: number
): string | undefined {
  const status = channelStatus(watermark, nowSec);
  if (status === 'settled') {
    return `channel ${channelId} is already settled — nothing left to ${step}.`;
  }
  if (step === 'close') {
    if (status === 'closing' || status === 'settleable') {
      const at = watermark?.settleableAt;
      return (
        `channel ${channelId} is already closing — ` +
        (status === 'settleable'
          ? 'its challenge window has elapsed; run `rig channel settle` to release the collateral.'
          : `settleable at ${at ? formatUnixSeconds(at) : 'the end of its challenge window'} (run \`rig channel settle\` then).`)
      );
    }
    return undefined;
  }
  // settle
  if (status === 'open') {
    return (
      `channel ${channelId} is not closed — run \`rig channel close ${channelId}\` ` +
      'first (settle only releases collateral after the challenge window of a closed channel).'
    );
  }
  if (status === 'closing' && watermark?.settleableAt !== undefined) {
    const remain = secondsUntil(watermark.settleableAt, nowSec);
    return (
      `channel ${channelId} is not settleable yet — the challenge window is ` +
      `still open (${remain}s remain, settleable at ${formatUnixSeconds(watermark.settleableAt)}). ` +
      'Nothing was spent; re-run after that time.'
    );
  }
  return undefined;
}

async function runChannelWithdrawStep(
  args: string[],
  deps: ChannelDeps,
  step: 'close' | 'settle'
): Promise<number> {
  const { io, env } = deps;
  const command = `channel ${step}` as WithdrawJson['command'];
  let channelId: string | undefined;
  let yes = false;
  let json = false;
  try {
    const { values, positionals } = parseArgs({
      args,
      options: {
        yes: { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
      },
      allowPositionals: true,
    });
    if (values.help) {
      io.out(CHANNEL_USAGE);
      return 0;
    }
    yes = values.yes ?? false;
    json = values.json ?? false;
    if (positionals.length !== 1) {
      throw new Error(
        `rig channel ${step} takes exactly one <channelId> (got ${positionals.length}) — \`rig channel list\` shows recorded channels`
      );
    }
    channelId = positionals[0] as string;
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    io.err(CHANNEL_USAGE);
    return 2;
  }

  let ctx: StandaloneContext | undefined;
  try {
    // ── Local state: the recorded channel + its watermark (free, fail-fast) ──
    const store = new ChannelMapStore(resolveChannelPaths(env));
    const record = store.list().find((r) => r.channelId === channelId);
    if (!record) {
      throw new Error(
        `no recorded channel ${JSON.stringify(channelId)} — \`rig channel list\` shows the channels this identity holds`
      );
    }
    const watermark = store.readWatermark(channelId);
    const nowSec = Math.floor(Date.now() / 1000);
    const refusal = withdrawPrecheck(step, channelId, watermark, nowSec);
    if (refusal) throw new Error(refusal);

    // ── Identity (must match the channel's opener — its claims/keys) ────────
    const loaded = await loadMoneyContext(deps);
    ctx = loaded.ctx;
    const identity = identityReport(ctx);
    if (record.identity !== identity.pubkey) {
      throw new Error(
        `channel ${channelId} was opened by identity ${record.identity.slice(0, 8)}… ` +
          `but the active identity is ${identity.pubkey.slice(0, 8)}… ` +
          `(from ${identity.sourceLabel}) — on-chain ${step} must be signed by ` +
          "the opener's wallet key. Switch RIG_MNEMONIC (or the keystore) to that identity."
      );
    }

    // ── Plan + confirm gate ──────────────────────────────────────────────────
    if (!json) {
      const claimed = watermark?.cumulativeAmount;
      io.out(`Channel ${step} plan:`);
      io.out(`  channel     ${channelId} [${channelStatus(watermark, nowSec)}]`);
      io.out(`  peer        ${record.destination} (${record.peerId})`);
      io.out(`  chain       ${record.chain}`);
      io.out(
        `  deposited   ${record.depositTotal ?? 'unrecorded'}` +
          (claimed !== undefined ? `   claimed ${claimed} base units` : '')
      );
      io.out(renderIdentityLine(identity));
      if (step === 'close') {
        io.out(
          'Closing is an ON-CHAIN transaction (gas) that starts the settlement ' +
            'challenge window: the channel stops paying immediately, and the ' +
            'remaining collateral stays locked until `rig channel settle` ' +
            'succeeds after the window elapses.'
        );
      } else {
        io.out(
          'Settling is an ON-CHAIN transaction (gas) that releases the ' +
            "remaining collateral back to your wallet. The chain's challenge " +
            'window is authoritative — a too-early settle is refused before ' +
            'any gas is spent.'
        );
      }
    }
    const gate = await confirmOnChain(
      io,
      { yes, json },
      `Proceed with on-chain channel ${step}? [y/N] `
    );
    if (gate === 'json-plan') {
      io.emitJson({
        command,
        identity,
        executed: false,
        channelId,
        hint: `plan only — re-run with --yes to ${step} (on-chain transaction)`,
      } satisfies WithdrawJson);
      return 0;
    }
    if (gate !== 'proceed') return gate;

    // ── Execute ──────────────────────────────────────────────────────────────
    if (step === 'close') {
      const result = await loaded.money.closeChannel(record);
      if (json) {
        io.emitJson({
          command,
          identity,
          executed: true,
          channelId,
          result: {
            txHash: result.txHash ?? null,
            closedAt: result.closedAt,
            settleableAt: result.settleableAt,
          },
        } satisfies WithdrawJson);
        return 0;
      }
      io.out(
        `Channel ${channelId} is closing` +
          (result.txHash ? ` (tx ${result.txHash})` : '') +
          '.'
      );
      io.out(
        `  challenge window: settleable at ${formatUnixSeconds(result.settleableAt)} ` +
          `(~${Math.max(0, secondsUntil(result.settleableAt, nowSec))}s from now)`
      );
      io.out(
        `  run \`rig channel settle ${channelId}\` after that time to release the collateral.`
      );
      return 0;
    }

    const result = await loaded.money.settleChannel(record);
    if (json) {
      io.emitJson({
        command,
        identity,
        executed: true,
        channelId,
        result: { txHash: result.txHash ?? null },
      } satisfies WithdrawJson);
      return 0;
    }
    io.out(
      `Channel ${channelId} settled` +
        (result.txHash ? ` (tx ${result.txHash})` : '') +
        ' — the remaining collateral was released to your wallet.'
    );
    return 0;
  } catch (err) {
    return emitCliError(io, json, command, err);
  } finally {
    await stopQuietly(ctx);
  }
}

// ---------------------------------------------------------------------------
// Small shared helpers
// ---------------------------------------------------------------------------

async function stopQuietly(ctx: StandaloneContext | undefined): Promise<void> {
  if (!ctx) return;
  try {
    await ctx.stop();
  } catch {
    // best-effort teardown
  }
}

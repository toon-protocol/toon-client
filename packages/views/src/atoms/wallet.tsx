/**
 * Wallet atoms — manage wallets + payment channels.
 *
 *   - `wallet-overview` — per-chain wallet address (copy-to-share) + on-chain
 *     token balance, read live from the `toon_balances` seam; an optional
 *     devnet "Get test funds" action (faucet).
 *   - `channel-list`    — tracked payment channels with nonce + available
 *     (spendable) balance, read live from the `toon_channels` seam.
 *
 * Atoms never call the bridge directly: balances/channels arrive via the
 * runtime-wired `readBalances` / `readChannels` seams, and the faucet fires the
 * wired `fund` action. No key material lives here.
 */
import { useEffect, useRef, useState, type FC, type ReactNode } from 'react';
import { Wallet, Landmark, Coins, Check, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Spinner } from '@/components/ui/spinner.js';
import { MonoId } from '@/components/mono-id.js';
import { CopyButton } from '@/components/copy-button.js';
import { Stepper } from './loading.js';
import {
  type Atom,
  type AtomRenderProps,
  type AtomBalance,
  type AtomChannel,
  type AtomStatus,
} from './types.js';

/** Human chain label for the per-chain rows. */
const CHAIN_LABEL: Record<string, string> = {
  evm: 'EVM',
  solana: 'Solana',
  mina: 'Mina',
};

/** One per-chain wallet row: the address always shows; balance enriches it. */
interface WalletRow {
  chain: string;
  address: string;
  balance?: AtomBalance;
}

/**
 * Build the wallet rows from the live identity (`toon_status`) — addresses are
 * always available — and enrich each with an on-chain balance from `toon_balances`
 * when present. This keeps the wallet useful (address + copy-to-share + faucet)
 * even before the multi-chain balance reader is wired, with balances lighting up
 * as soon as the seam returns them.
 */
function buildRows(identity: AtomStatus['identity'], balances: AtomBalance[]): WalletRow[] {
  const byChain = new Map(balances.map((b) => [b.chain, b]));
  const rows: WalletRow[] = [];
  const add = (chain: string, address?: string): void => {
    if (!address) return;
    const row: WalletRow = { chain, address };
    const bal = byChain.get(chain);
    if (bal) row.balance = bal;
    rows.push(row);
  };
  add('evm', identity?.evmAddress);
  add('solana', identity?.solanaAddress);
  add('mina', identity?.minaAddress);
  // Surface any balance whose chain wasn't in identity (defensive).
  for (const b of balances) {
    if (!rows.some((r) => r.chain === b.chain)) rows.push({ chain: b.chain, address: b.address, balance: b });
  }
  return rows;
}

/**
 * Format an integer micro-unit amount (decimal string) into a grouped,
 * trimmed human figure. `scale` is the token's decimal places (default 6, the
 * protocol's stablecoin base). BigInt-free string math, so no precision loss.
 */
function formatUnits(amount: string, scale = 6): string {
  const neg = amount.trim().startsWith('-');
  const digits = amount.replace(/[^0-9]/g, '') || '0';
  const padded = digits.padStart(scale + 1, '0');
  const whole = padded.slice(0, padded.length - scale).replace(/^0+(?=\d)/, '');
  const frac = (scale > 0 ? padded.slice(padded.length - scale) : '').slice(0, 4).replace(/0+$/, '');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${grouped}${frac ? `.${frac}` : ''}`;
}

/** A small inline loading row, consistent with the `loading` atom. */
const Loading: FC<{ label: string }> = ({ label }) => (
  <div className="flex items-center gap-2 px-1 py-3 text-sm text-muted-foreground" role="status" aria-live="polite">
    <Spinner size="sm" />
    {label}
  </div>
);

const CardShell: FC<{ icon: ReactNode; title: string; action?: ReactNode; children: ReactNode }> = ({
  icon,
  title,
  action,
  children,
}) => (
  <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm">
    <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="text-primary">{icon}</span>
        <span className="text-sm font-semibold">{title}</span>
      </div>
      {action}
    </div>
    <div className="px-4 py-3">{children}</div>
  </div>
);

// ── wallet-overview ──────────────────────────────────────────────────────────

/** Lifecycle of the optional on-chain balance enrichment. */
type BalanceState = 'loading' | 'ok' | 'error';
/**
 * Per-chain faucet-drip feedback so the Fund button isn't a silent no-op. The
 * drip is ASYNC: `'funding'` is the brief submit, `'submitted'` means the daemon
 * accepted it and balances are now polling (the Mina faucet settles in ~1-2 min,
 * past the host's tool-call timeout), `'error'` is a rejected submit.
 */
type FundState = 'funding' | 'submitted' | 'error';

const WalletOverview: FC<AtomRenderProps> = ({ readStatus, readBalances, actions }) => {
  const [identity, setIdentity] = useState<AtomStatus['identity'] | null | undefined>(undefined);
  const [balances, setBalances] = useState<AtomBalance[]>([]);
  const [balState, setBalState] = useState<BalanceState>(readBalances ? 'loading' : 'ok');
  // Bump to force a balance re-read (manual retry + post-fund refresh).
  const [balReload, setBalReload] = useState(0);
  const [funding, setFunding] = useState<Record<string, FundState>>({});
  const fund = actions['fund'];
  // Post-submit balance re-poll timers (the async drip settles after the call
  // returns) — cleared on unmount so we never setState on a gone component.
  const pollTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
  useEffect(
    () => () => {
      pollTimers.current.forEach(clearTimeout);
      pollTimers.current = [];
    },
    []
  );

  // Addresses come from the live status identity (always available); balances
  // are an optional enrichment that may be absent until the reader is wired.
  useEffect(() => {
    if (!readStatus) {
      setIdentity(null);
      return;
    }
    let cancelled = false;
    void readStatus()
      .then((s) => !cancelled && setIdentity(s.identity ?? null))
      .catch(() => !cancelled && setIdentity(null));
    return () => {
      cancelled = true;
    };
  }, [readStatus]);

  useEffect(() => {
    if (!readBalances) return;
    let cancelled = false;
    setBalState('loading');
    void readBalances()
      .then((b) => {
        if (cancelled) return;
        setBalances(b);
        setBalState('ok');
      })
      // The read seam retries the flaky control plane and only rejects on a
      // persistent failure (toon-client#186) — surface it as an error/retry
      // state rather than a blank card that looks like a real zero balance.
      .catch(() => !cancelled && setBalState('error'));
    return () => {
      cancelled = true;
    };
  }, [readBalances, balReload]);

  const onFund = async (chain: string): Promise<void> => {
    if (!fund) return;
    setFunding((f) => ({ ...f, [chain]: 'funding' }));
    const outcome = await fund({ chain });
    // `fund` may resolve to void (older paths) — treat that as success. With the
    // async drip the call now returns a 'pending' submit, not a settled balance.
    const ok = !outcome || outcome.ok !== false;
    setFunding((f) => ({ ...f, [chain]: ok ? 'submitted' : 'error' }));
    // The drip settles AFTER the submit returns (EVM/Solana ~30s, Mina ~1-2 min),
    // so re-read balances now and then a few more times so the new balance lights
    // up without a manual refresh.
    if (ok) {
      setBalReload((n) => n + 1);
      for (const delay of [15_000, 45_000, 90_000]) {
        pollTimers.current.push(
          setTimeout(() => setBalReload((n) => n + 1), delay)
        );
      }
    }
  };

  const retryBalances = (): void => setBalReload((n) => n + 1);

  const rows = identity ? buildRows(identity, balances) : [];

  // Defense in depth (#200): even when `readBalances` resolved `'ok'`, a shape
  // mismatch that slipped through as an empty list would leave every value cell
  // blank — indistinguishable from a real zero balance, with no retry. If the
  // balance seam IS wired and we have address rows but NONE carries a balance,
  // treat it as unavailable (show the retry banner) rather than a silent blank.
  // When the seam isn't wired (`readBalances` undefined) the addresses-only card
  // is the intended degraded mode, so don't flag it.
  const balancesUnavailable =
    !!readBalances &&
    balState === 'ok' &&
    rows.length > 0 &&
    !rows.some((r) => r.balance);
  const showBalanceError = balState === 'error' || balancesUnavailable;

  return (
    <CardShell icon={<Wallet aria-hidden="true" className="size-4" />} title="Wallet">
      {identity === undefined ? (
        <Loading label="Loading wallet…" />
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No wallet addresses configured yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => {
            const fundState = funding[row.chain];
            return (
              <li key={`${row.chain}:${row.address}`} className="flex flex-col gap-1 py-3 first:pt-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {CHAIN_LABEL[row.chain] ?? row.chain}
                  </span>
                  {row.balance ? (
                    <span className="font-mono text-sm font-semibold tabular-nums">
                      {formatUnits(row.balance.amount, row.balance.assetScale ?? 6)}
                      {row.balance.asset ? (
                        <span className="ml-1 text-xs font-normal text-muted-foreground">{row.balance.asset}</span>
                      ) : null}
                    </span>
                  ) : balState === 'loading' ? (
                    <Spinner size="sm" />
                  ) : null}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <MonoId value={row.address} prefixLen={10} suffixLen={6} className="text-muted-foreground" />
                  <div className="flex items-center gap-0.5">
                    <CopyButton value={row.address} label={`Copy ${CHAIN_LABEL[row.chain] ?? row.chain} address`} />
                    {fund ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        disabled={fundState === 'funding'}
                        className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                        onClick={() => void onFund(row.chain)}
                      >
                        {fundState === 'funding' ? (
                          <Spinner size="sm" />
                        ) : fundState === 'submitted' ? (
                          <Check aria-hidden="true" className="text-primary" />
                        ) : (
                          <Coins aria-hidden="true" />
                        )}
                        {fundState === 'funding'
                          ? 'Submitting…'
                          : fundState === 'submitted'
                            ? 'Submitted'
                            : fundState === 'error'
                              ? 'Retry fund'
                              : 'Fund'}
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {showBalanceError ? (
        <div className="mt-2 flex items-center justify-between gap-2 rounded-md bg-muted/50 px-2 py-1.5">
          <span className="text-xs text-muted-foreground">Balances are temporarily unavailable.</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 px-2 text-xs"
            onClick={retryBalances}
          >
            <RotateCw aria-hidden="true" />
            Retry
          </Button>
        </div>
      ) : null}
      {Object.values(funding).some((s) => s === 'submitted') ? (
        <p className="mt-2 text-xs text-muted-foreground">
          Drip submitted — balances updating… (Mina can take 1–2 min to settle.)
        </p>
      ) : null}
      {fund ? (
        <p className="mt-2 text-[10px] text-muted-foreground/70">
          “Fund” requests devnet test funds from the faucet — it receives, it doesn’t spend.
        </p>
      ) : null}
    </CardShell>
  );
};

// ── channel-list ─────────────────────────────────────────────────────────────

const ChannelList: FC<AtomRenderProps> = ({ readChannels }) => {
  const [channels, setChannels] = useState<AtomChannel[] | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!readChannels) {
      setError(true);
      return;
    }
    let cancelled = false;
    void readChannels()
      .then((c) => !cancelled && setChannels(c))
      .catch(() => !cancelled && setError(true));
    return () => {
      cancelled = true;
    };
  }, [readChannels]);

  return (
    <CardShell
      icon={<Landmark aria-hidden="true" className="size-4" />}
      title="Payment channels"
      action={
        channels && channels.length > 0 ? (
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground tabular-nums">
            {channels.length}
          </span>
        ) : undefined
      }
    >
      {error ? (
        <p className="py-2 text-sm text-destructive">Channels are unavailable.</p>
      ) : channels === null ? (
        <Loading label="Loading channels…" />
      ) : channels.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No channels open yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {channels.map((c) => (
            <li key={c.channelId} className="flex flex-col gap-1.5 py-3 first:pt-0 last:pb-0">
              <div className="flex items-baseline justify-between gap-3">
                <MonoId value={c.channelId} className="text-foreground" />
                <span className="text-xs text-muted-foreground">
                  nonce <span className="font-mono font-medium text-foreground">{c.nonce}</span>
                </span>
              </div>
              {c.availableBalance !== undefined ? (
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-muted-foreground">Available</span>
                  <span className="font-mono font-semibold tabular-nums text-foreground">
                    {formatUnits(c.availableBalance)}
                    {c.depositTotal !== undefined ? (
                      <span className="ml-1 font-normal text-muted-foreground">
                        / {formatUnits(c.depositTotal)}
                      </span>
                    ) : null}
                  </span>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </CardShell>
  );
};

// ── deposit-form ─────────────────────────────────────────────────────────────

type DepositPhase = 'idle' | 'depositing' | 'receipt';

const DepositForm: FC<AtomRenderProps> = ({ readChannels, actions }) => {
  const [channels, setChannels] = useState<AtomChannel[]>([]);
  const [channelId, setChannelId] = useState('');
  const [amount, setAmount] = useState('');
  const [phase, setPhase] = useState<DepositPhase>('idle');
  const [depositTotal, setDepositTotal] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const deposit = actions['deposit'];

  useEffect(() => {
    if (!readChannels) return;
    let cancelled = false;
    void readChannels()
      .then((c) => {
        if (cancelled) return;
        setChannels(c);
        const first = c[0];
        if (first) setChannelId((prev) => prev || first.channelId);
      })
      .catch(() => {
        /* selector simply stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [readChannels]);

  const submit = async (): Promise<void> => {
    const value = amount.trim();
    if (!channelId || !value || !deposit) return;
    setError(null);
    setPhase('depositing');
    const outcome = await deposit({ channelId, amount: value });
    if (!outcome || outcome.ok === false) {
      setError(outcome?.error ?? 'Deposit failed.');
      setPhase('idle');
      return;
    }
    const data = (outcome.data ?? {}) as { depositTotal?: string };
    setDepositTotal(data.depositTotal ?? null);
    setPhase('receipt');
  };

  if (phase === 'receipt') {
    return (
      <CardShell icon={<Coins aria-hidden="true" className="size-4" />} title="Deposit">
        <div className="flex flex-col gap-2 py-1">
          <p className="text-sm">Collateral added to <MonoId value={channelId} className="text-foreground" />.</p>
          {depositTotal ? (
            <p className="text-xs text-muted-foreground">
              New deposit total{' '}
              <span className="font-mono font-semibold text-foreground">{formatUnits(depositTotal)}</span>
            </p>
          ) : null}
          <div className="flex justify-end">
            <Button variant="outline" size="sm" onClick={() => { setPhase('idle'); setAmount(''); }}>
              Deposit more
            </Button>
          </div>
        </div>
      </CardShell>
    );
  }

  const busy = phase === 'depositing';
  return (
    <CardShell icon={<Coins aria-hidden="true" className="size-4" />} title="Deposit collateral">
      <div className="flex flex-col gap-3 py-1">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Channel</span>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={busy || channels.length === 0}
            className="h-9 rounded-md border border-input bg-transparent px-3 font-mono text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
          >
            {channels.length === 0 ? <option value="">No open channels</option> : null}
            {channels.map((c) => (
              <option key={c.channelId} value={c.channelId}>
                {c.channelId.length > 22 ? `${c.channelId.slice(0, 12)}…${c.channelId.slice(-6)}` : c.channelId}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Amount (micro-units)</span>
          <Input
            type="text"
            inputMode="numeric"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9]/g, ''))}
            placeholder="1000000"
            disabled={busy}
          />
        </label>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground/70">Adds on-chain collateral — a paid, signed transaction.</span>
          <Button size="sm" disabled={busy || !channelId || !amount.trim() || !deposit} onClick={() => void submit()}>
            <Coins aria-hidden="true" />
            {busy ? 'Depositing…' : 'Deposit'}
            <span className="ml-1 text-[10px] opacity-70">(pays)</span>
          </Button>
        </div>
      </div>
    </CardShell>
  );
};

// ── withdraw-flow ────────────────────────────────────────────────────────────

const WITHDRAW_STEPS = ['Close channel', 'Wait for timeout', 'Settle'];

/** mm:ss for a remaining-seconds countdown. */
function mmss(totalSec: number): string {
  const s = Math.max(0, Math.floor(totalSec));
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

type CloseState = 'open' | 'closing' | 'settleable' | 'settled';

const WithdrawFlow: FC<AtomRenderProps> = ({ readChannels, actions }) => {
  const [channels, setChannels] = useState<AtomChannel[]>([]);
  const [channelId, setChannelId] = useState('');
  // Optimistic override after a close/settle action (readChannels is the
  // authoritative source but doesn't auto-refresh between actions).
  const [override, setOverride] = useState<{ closeState?: CloseState; settleableAt?: string }>({});
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));
  const [busy, setBusy] = useState<null | 'close' | 'settle'>(null);
  const [error, setError] = useState<string | null>(null);
  const close = actions['close'];
  const settle = actions['settle'];

  useEffect(() => {
    if (!readChannels) return;
    let cancelled = false;
    void readChannels()
      .then((c) => {
        if (cancelled) return;
        setChannels(c);
        const first = c[0];
        if (first) setChannelId((prev) => prev || first.channelId);
      })
      .catch(() => {
        /* selector stays empty */
      });
    return () => {
      cancelled = true;
    };
  }, [readChannels]);

  // Tick the clock so the countdown + settle gate update live.
  useEffect(() => {
    const t = setInterval(() => setNowSec(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // Reset the optimistic override when the user switches channels.
  useEffect(() => setOverride({}), [channelId]);

  const channel = channels.find((c) => c.channelId === channelId);
  const rawState = (override.closeState ?? channel?.closeState ?? 'open') as CloseState;
  const settleableAt = override.settleableAt ?? channel?.settleableAt;
  const settleableSec = settleableAt !== undefined ? Number(settleableAt) : undefined;
  const elapsed = settleableSec !== undefined && nowSec >= settleableSec;
  // A 'closing' channel whose grace period has elapsed is effectively settleable.
  const state: CloseState = rawState === 'closing' && elapsed ? 'settleable' : rawState;
  const activeStep = state === 'open' ? 0 : state === 'closing' ? 1 : state === 'settleable' ? 2 : 3;
  const remaining = settleableSec !== undefined ? settleableSec - nowSec : 0;

  const onClose = async (): Promise<void> => {
    if (!channelId || !close) return;
    setError(null);
    setBusy('close');
    const outcome = await close({ channelId });
    if (!outcome || outcome.ok === false) {
      setError(outcome?.error ?? 'Close failed.');
      setBusy(null);
      return;
    }
    const data = (outcome.data ?? {}) as { settleableAt?: string };
    setOverride({ closeState: 'closing', settleableAt: data.settleableAt });
    setBusy(null);
  };

  const onSettle = async (): Promise<void> => {
    if (!channelId || !settle) return;
    setError(null);
    setBusy('settle');
    const outcome = await settle({ channelId });
    if (!outcome || outcome.ok === false) {
      // Retryable (called a hair early) — keep the gate, let the countdown catch up.
      setError(outcome?.error ?? 'Not settleable yet — try again in a moment.');
      setBusy(null);
      return;
    }
    setOverride((o) => ({ ...o, closeState: 'settled' }));
    setBusy(null);
  };

  if (state === 'settled') {
    return (
      <CardShell icon={<Landmark aria-hidden="true" className="size-4" />} title="Withdraw">
        <div className="flex flex-col gap-3 py-1">
          <Stepper steps={WITHDRAW_STEPS} active={3} />
          <p className="text-sm">
            Settled — collateral released from <MonoId value={channelId} className="text-foreground" />.
          </p>
        </div>
      </CardShell>
    );
  }

  return (
    <CardShell icon={<Landmark aria-hidden="true" className="size-4" />} title="Withdraw">
      <div className="flex flex-col gap-3 py-1">
        <label className="flex flex-col gap-1">
          <span className="text-xs font-medium text-muted-foreground">Channel</span>
          <select
            value={channelId}
            onChange={(e) => setChannelId(e.target.value)}
            disabled={!!busy || channels.length === 0}
            className="h-9 rounded-md border border-input bg-transparent px-3 font-mono text-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 disabled:opacity-50"
          >
            {channels.length === 0 ? <option value="">No open channels</option> : null}
            {channels.map((c) => (
              <option key={c.channelId} value={c.channelId}>
                {c.channelId.length > 22 ? `${c.channelId.slice(0, 12)}…${c.channelId.slice(-6)}` : c.channelId}
              </option>
            ))}
          </select>
        </label>

        <Stepper steps={WITHDRAW_STEPS} active={activeStep} />

        {state === 'closing' ? (
          <p className="text-xs text-muted-foreground">
            Settleable in{' '}
            <span className="font-mono font-medium text-foreground tabular-nums">{mmss(remaining)}</span>{' '}
            — the settlement grace period must elapse before collateral is released.
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center justify-between gap-2">
          <span className="text-[10px] text-muted-foreground/70">
            Withdraw is two signed on-chain txs (close, then settle).
          </span>
          {state === 'open' ? (
            <Button size="sm" disabled={busy === 'close' || !channelId || !close} onClick={() => void onClose()}>
              <Coins aria-hidden="true" />
              {busy === 'close' ? 'Closing…' : 'Close'}
              <span className="ml-1 text-[10px] opacity-70">(pays)</span>
            </Button>
          ) : (
            <Button
              size="sm"
              disabled={busy === 'settle' || state !== 'settleable' || !settle}
              onClick={() => void onSettle()}
            >
              <Coins aria-hidden="true" />
              {busy === 'settle' ? 'Settling…' : 'Settle'}
              <span className="ml-1 text-[10px] opacity-70">(pays)</span>
            </Button>
          )}
        </div>
      </div>
    </CardShell>
  );
};

export const walletAtoms: Atom[] = [
  { id: 'wallet-overview', writes: [{ name: 'toon_fund_wallet' }], Component: WalletOverview },
  { id: 'channel-list', Component: ChannelList },
  { id: 'deposit-form', writes: [{ name: 'toon_channel_deposit', spendy: true }], Component: DepositForm },
  {
    id: 'withdraw-flow',
    writes: [
      { name: 'toon_channel_close', spendy: true },
      { name: 'toon_channel_settle', spendy: true },
    ],
    Component: WithdrawFlow,
  },
];

// Exported for unit tests.
export { formatUnits };

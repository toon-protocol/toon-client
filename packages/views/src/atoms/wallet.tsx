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
import { useEffect, useState, type FC, type ReactNode } from 'react';
import { Wallet, Landmark, Coins } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Spinner } from '@/components/ui/spinner.js';
import { MonoId } from '@/components/mono-id.js';
import { CopyButton } from '@/components/copy-button.js';
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

const WalletOverview: FC<AtomRenderProps> = ({ readStatus, readBalances, actions }) => {
  const [identity, setIdentity] = useState<AtomStatus['identity'] | null | undefined>(undefined);
  const [balances, setBalances] = useState<AtomBalance[]>([]);
  const fund = actions['fund'];

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
    void readBalances()
      .then((b) => !cancelled && setBalances(b))
      .catch(() => {
        /* balances are best-effort; absence is not an error */
      });
    return () => {
      cancelled = true;
    };
  }, [readBalances]);

  const rows = identity ? buildRows(identity, balances) : [];

  return (
    <CardShell icon={<Wallet aria-hidden="true" className="size-4" />} title="Wallet">
      {identity === undefined ? (
        <Loading label="Loading wallet…" />
      ) : rows.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">No wallet addresses configured yet.</p>
      ) : (
        <ul className="flex flex-col divide-y divide-border">
          {rows.map((row) => (
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
                      className="h-7 gap-1 px-2 text-xs text-muted-foreground hover:text-foreground"
                      onClick={() => void fund({ chain: row.chain })}
                    >
                      <Coins aria-hidden="true" />
                      Fund
                    </Button>
                  ) : null}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
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

export const walletAtoms: Atom[] = [
  { id: 'wallet-overview', writes: [{ name: 'toon_fund_wallet' }], Component: WalletOverview },
  { id: 'channel-list', Component: ChannelList },
];

// Exported for unit tests.
export { formatUnits };

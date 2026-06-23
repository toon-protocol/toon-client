/**
 * DeFi atoms — pre-open a payment channel, run a swap, show a settlement
 * receipt.
 *
 * No key material or signing lives in the iframe: actions only *call the tool*
 * (the daemon signs the source-asset claim and returns the target-chain claim).
 * Payment-claim validation is the connector's job — never re-implemented here.
 *
 * `channel-card` and `settlement-receipt` are read-only renders driven by their
 * ViewSpec `props` (a `ChannelInfo[]` / `SwapResponse` the agent binds in).
 * `swap-form` is interactive: it collects swap params and fires the spendy
 * `toon_swap` action.
 */
import { useState, type FC } from 'react';
import { type Atom, type AtomRenderProps } from './types.js';
import { OPEN_CHANNEL_TOOL, SWAP_TOOL } from '../tool-names.js';

function short(s: string): string {
  return s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-6)}` : s;
}

interface ChannelInfo {
  channelId?: string;
  nonce?: number | string;
  cumulativeAmount?: string;
}

/**
 * Read-only list of tracked payment channels. Channels come from `props.channels`
 * (the agent binds the daemon's `toon_channels` result in); the optional `open`
 * action pre-opens a new channel toward `props.destination`.
 */
const ChannelCard: FC<AtomRenderProps> = ({ props, actions }) => {
  const channels = Array.isArray(props['channels'])
    ? (props['channels'] as ChannelInfo[])
    : [];
  const destination =
    typeof props['destination'] === 'string' ? props['destination'] : undefined;
  const [busy, setBusy] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);

  const open = async (): Promise<void> => {
    if (!actions['open']) return;
    setBusy(true);
    try {
      const args = destination ? { destination } : {};
      const ok = await actions['open'](args);
      setOpened(ok === false ? null : 'opened');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="text-sm font-semibold">Payment channels</div>
      {channels.length === 0 ? (
        <p className="text-xs text-muted-foreground">No channels tracked yet.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {channels.map((c, i) => (
            <li key={c.channelId ?? i} className="flex items-baseline justify-between text-sm">
              <span className="font-mono text-xs">{short(c.channelId ?? '—')}</span>
              <span className="text-xs text-muted-foreground">
                nonce {c.nonce ?? 0} · {c.cumulativeAmount ?? '0'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {actions['open'] ? (
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void open()}
            className="rounded-md border border-border px-3 py-1 text-sm hover:bg-muted disabled:opacity-50"
          >
            {busy ? 'Opening…' : 'Open channel'}
          </button>
          {opened ? <span className="text-xs text-muted-foreground">Channel opened.</span> : null}
        </div>
      ) : null}
    </div>
  );
};

/**
 * Collects swap params and fires the spendy `toon_swap` action. Static params
 * (destination, millPubkey, pair, chainRecipient) come from `props` — the form
 * collects the source `amount`. Signing happens daemon-side.
 */
const SwapForm: FC<AtomRenderProps> = ({ props, actions }) => {
  const label = typeof props['label'] === 'string' ? props['label'] : 'Swap';
  const pair =
    props['pair'] && typeof props['pair'] === 'object'
      ? (props['pair'] as { from?: { assetCode?: string }; to?: { assetCode?: string }; rate?: string })
      : undefined;
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<'ok' | 'fail' | null>(null);

  const submit = async (): Promise<void> => {
    const value = amount.trim();
    if (!value || !actions['swap']) return;
    setBusy(true);
    setDone(null);
    try {
      const ok = await actions['swap']({ amount: value });
      setDone(ok === false ? 'fail' : 'ok');
      if (ok !== false) setAmount('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      {pair?.from?.assetCode && pair?.to?.assetCode ? (
        <div className="text-sm">
          <span className="font-medium">
            {pair.from.assetCode} → {pair.to.assetCode}
          </span>
          {pair.rate ? (
            <span className="ml-2 text-xs text-muted-foreground">rate {pair.rate}</span>
          ) : null}
        </div>
      ) : (
        <div className="text-sm font-medium">Swap</div>
      )}
      <input
        type="text"
        inputMode="decimal"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        placeholder="Amount (source micro-units)"
        className="w-full rounded-md border border-input bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-ring"
      />
      <div className="flex items-center justify-end gap-2">
        {done === 'ok' ? <span className="text-xs text-muted-foreground">Swap submitted.</span> : null}
        {done === 'fail' ? <span className="text-xs text-destructive">Swap failed.</span> : null}
        <button
          type="button"
          disabled={busy || !amount.trim() || !actions['swap']}
          onClick={() => void submit()}
          className="rounded-md bg-primary px-3 py-1 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50"
        >
          {busy ? 'Swapping…' : label} <span className="text-xs opacity-80">(pays)</span>
        </button>
      </div>
    </div>
  );
};

interface SwapClaimView {
  sourceAmount?: string;
  targetAmount?: string;
  channelId?: string;
  claimId?: string;
  nonce?: string;
  recipient?: string;
}

interface SwapResponseView {
  accepted?: boolean;
  state?: string;
  cumulativeSource?: string;
  cumulativeTarget?: string;
  packetsAccepted?: number;
  claims?: SwapClaimView[];
}

/**
 * Read-only render of a `SwapResponse` / `SwapClaim[]` passed in via
 * `props.receipt`: target amount, chain claim, channelId, claim id, nonce.
 */
const SettlementReceipt: FC<AtomRenderProps> = ({ props }) => {
  const receipt =
    props['receipt'] && typeof props['receipt'] === 'object'
      ? (props['receipt'] as SwapResponseView)
      : undefined;

  if (!receipt) {
    return (
      <div className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
        No settlement yet — run a swap to see its receipt.
      </div>
    );
  }

  const claims = receipt.claims ?? [];
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-semibold">Settlement receipt</span>
        <span
          className={
            'text-xs ' + (receipt.accepted ? 'text-muted-foreground' : 'text-destructive')
          }
        >
          {receipt.state ?? (receipt.accepted ? 'completed' : 'failed')}
        </span>
      </div>
      <div className="text-sm">
        {receipt.cumulativeSource ?? '0'} → {receipt.cumulativeTarget ?? '0'}{' '}
        <span className="text-xs text-muted-foreground">
          ({receipt.packetsAccepted ?? claims.length} packet(s))
        </span>
      </div>
      {claims.length > 0 ? (
        <ul className="flex flex-col gap-1 border-t border-border pt-2">
          {claims.map((c, i) => (
            <li key={c.claimId ?? i} className="flex flex-col text-xs text-muted-foreground">
              <span>
                target {c.targetAmount ?? '0'} on{' '}
                <span className="font-mono">{short(c.channelId ?? '—')}</span>
              </span>
              <span>
                claim {short(c.claimId ?? '—')} · nonce {c.nonce ?? '0'}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
};

export const defiAtoms: Atom[] = [
  { id: 'channel-card', kinds: [], writes: [{ name: OPEN_CHANNEL_TOOL }], Component: ChannelCard },
  { id: 'swap-form', writes: [{ name: SWAP_TOOL, spendy: true }], Component: SwapForm },
  { id: 'settlement-receipt', Component: SettlementReceipt },
];

/**
 * DeFi atoms — payment channels, swaps, settlement receipts.
 *
 * No key material or signing lives in the iframe: actions only call the tool
 * (the daemon signs the source-asset claim and returns the target-chain claim).
 */
import { useState, type FC } from 'react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Badge } from '@/components/ui/badge.js';
import { MonoId } from '@/components/mono-id.js';
import { type Atom, type AtomRenderProps } from './types.js';
import { OPEN_CHANNEL_TOOL, SWAP_TOOL } from '../tool-names.js';

interface ChannelInfo {
  channelId?: string;
  nonce?: number | string;
  cumulativeAmount?: string;
}

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
      const outcome = await actions['open'](args);
      setOpened(outcome?.ok === false ? null : 'opened');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold">Payment channels</span>
        {channels.length > 0 && (
          <Badge variant="secondary">{channels.length}</Badge>
        )}
      </div>
      {channels.length === 0 ? (
        <p className="text-xs text-muted-foreground">No channels open yet.</p>
      ) : (
        <ul className="mb-3 flex flex-col gap-2">
          {channels.map((c, i) => (
            <li
              key={c.channelId ?? i}
              className="flex items-baseline justify-between border-l-2 border-border pl-2"
            >
              <MonoId value={c.channelId ?? '—'} />
              <span className="text-xs text-muted-foreground">
                nonce <span className="font-medium text-foreground">{c.nonce ?? 0}</span>
                {' · '}
                {c.cumulativeAmount ?? '0'}
              </span>
            </li>
          ))}
        </ul>
      )}
      {actions['open'] ? (
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void open()}
          >
            {busy ? 'Opening…' : 'Open channel'}
          </Button>
          {opened ? (
            <span className="text-xs text-muted-foreground">Channel opened.</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};

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
      const outcome = await actions['swap']({ amount: value });
      const failed = outcome?.ok === false;
      setDone(failed ? 'fail' : 'ok');
      if (!failed) setAmount('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border-l-2 border-ring bg-card p-4">
      <div className="mb-3">
        {pair?.from?.assetCode && pair?.to?.assetCode ? (
          <div className="flex items-baseline gap-2">
            <span className="font-semibold">
              {pair.from.assetCode}
              <span className="mx-1.5 text-muted-foreground">→</span>
              {pair.to.assetCode}
            </span>
            {pair.rate ? (
              <span className="text-xs text-muted-foreground">@ {pair.rate}</span>
            ) : null}
          </div>
        ) : (
          <span className="font-semibold">Swap</span>
        )}
      </div>
      <div className="flex gap-2">
        <Input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="Amount (source micro-units)"
        />
        <Button
          disabled={busy || !amount.trim() || !actions['swap']}
          onClick={() => void submit()}
          className="shrink-0"
        >
          {busy ? 'Swapping…' : label}
          <span className="ml-1 text-[10px] opacity-70">(pays)</span>
        </Button>
      </div>
      {done === 'ok' ? (
        <p className="mt-2 text-xs text-muted-foreground">Swap submitted.</p>
      ) : null}
      {done === 'fail' ? (
        <p className="mt-2 text-xs text-destructive">Swap failed — try again.</p>
      ) : null}
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

const SettlementReceipt: FC<AtomRenderProps> = ({ props }) => {
  const receipt =
    props['receipt'] && typeof props['receipt'] === 'object'
      ? (props['receipt'] as SwapResponseView)
      : undefined;

  if (!receipt) {
    return (
      <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
        No settlement yet — run a swap to see its receipt.
      </div>
    );
  }

  const claims = receipt.claims ?? [];
  const succeeded = receipt.accepted !== false && receipt.state !== 'failed';

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="font-semibold text-sm">Settlement receipt</span>
        <Badge variant={succeeded ? 'secondary' : 'destructive'}>
          {receipt.state ?? (succeeded ? 'completed' : 'failed')}
        </Badge>
      </div>
      <div className="mb-2 font-mono text-sm">
        {receipt.cumulativeSource ?? '0'}
        <span className="mx-1.5 text-muted-foreground">→</span>
        {receipt.cumulativeTarget ?? '0'}
        <span className="ml-2 text-xs text-muted-foreground">
          ({receipt.packetsAccepted ?? claims.length} packet{claims.length !== 1 ? 's' : ''})
        </span>
      </div>
      {claims.length > 0 ? (
        <ul className="flex flex-col gap-1.5 border-t border-border pt-2">
          {claims.map((c, i) => (
            <li key={c.claimId ?? i} className="grid grid-cols-[auto_1fr] gap-x-3 text-xs">
              <span className="text-muted-foreground">target</span>
              <span>
                {c.targetAmount ?? '0'} on <MonoId value={c.channelId ?? '—'} />
              </span>
              <span className="text-muted-foreground">claim</span>
              <span>
                <MonoId value={c.claimId ?? '—'} /> · nonce {c.nonce ?? '0'}
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

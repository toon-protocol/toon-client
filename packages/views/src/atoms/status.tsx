/**
 * `client-status` — the daemon-health dashboard.
 *
 * Closes the render-vocabulary gap for non-event data: before this atom the
 * agent had no way to render "show me my status" and fell back to plain text.
 * It sources everything from the live `toon_status` read seam ({@link
 * AtomRenderProps.readStatus}) — atoms never call the bridge directly — and
 * renders ready/bootstrapping state, uptime, relay, transport, settlement,
 * per-chain readiness, and identity as a clean card built from the shadcn
 * primitives + the generic content tokens.
 */
import { useEffect, useState, type FC, type ReactNode } from 'react';
import { Activity, Loader2, Radio } from 'lucide-react';
import { Badge } from '@/components/ui/badge.js';
import { Separator } from '@/components/ui/separator.js';
import { MonoId } from '@/components/mono-id.js';
import { useRefreshTick } from './use-refresh.js';
import { type Atom, type AtomRenderProps, type AtomStatus } from './types.js';

/** Format an uptime in ms as a compact human string (e.g. "1d 2h", "5m"). */
function formatUptime(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

const Row: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex items-baseline justify-between gap-4">
    <dt className="text-sm text-muted-foreground">{label}</dt>
    <dd className="min-w-0 text-right text-sm font-medium tabular-nums">{children}</dd>
  </div>
);

const ChainBadge: FC<{ chain: string; ready: boolean; detail?: string }> = ({
  chain,
  ready,
  detail,
}) => (
  <Badge
    variant={ready ? 'default' : 'secondary'}
    title={detail}
    aria-label={`${chain} settlement ${ready ? 'ready' : 'not ready'}`}
  >
    {chain}
  </Badge>
);

const ClientStatus: FC<AtomRenderProps> = ({ readStatus, refreshNonce }) => {
  const [status, setStatus] = useState<AtomStatus | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(true);
  // Re-read the daemon/relay status after a successful write (e.g. opening a
  // channel flips `ready`, publishing changes buffered counts): immediate + a
  // short settlement delay so the dashboard reflects the new state in place.
  const refreshTick = useRefreshTick(refreshNonce);

  useEffect(() => {
    if (!readStatus) {
      setLoading(false);
      setError(true);
      return;
    }
    let cancelled = false;
    void readStatus()
      .then((s) => {
        if (!cancelled) {
          setStatus(s);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(true);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [readStatus, refreshTick]);

  if (loading) {
    return (
      <div
        className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground"
        role="status"
        aria-live="polite"
      >
        <Loader2 aria-hidden="true" className="size-4 animate-spin" />
        Loading client status…
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="rounded-xl border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive">
        Client status is unavailable.
      </div>
    );
  }

  const ready = status.ready === true;
  const bootstrapping = status.bootstrapping === true;
  const stateLabel = ready ? 'Ready' : bootstrapping ? 'Bootstrapping' : 'Offline';
  const stateVariant = ready ? 'default' : bootstrapping ? 'secondary' : 'destructive';

  const relay = status.relay;
  const identity = status.identity;
  const feeLabel = `${status.feePerEvent}${status.asset ? ` ${status.asset}` : ''}`;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card text-card-foreground shadow-sm">
      {/* Header: daemon state + uptime */}
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity aria-hidden="true" className="size-4 text-primary" />
          <span className="text-sm font-semibold">Client status</span>
        </div>
        <div className="flex items-center gap-2">
          {typeof status.uptimeMs === 'number' ? (
            <span className="text-xs text-muted-foreground tabular-nums">
              up {formatUptime(status.uptimeMs)}
            </span>
          ) : null}
          <Badge variant={stateVariant} aria-label={`Daemon state: ${stateLabel}`}>
            {stateLabel}
          </Badge>
        </div>
      </div>

      <div className="flex flex-col gap-4 px-4 py-3">
        {/* Settlement */}
        <dl className="flex flex-col gap-2">
          <Row label="Settlement chain">{status.settlementChain}</Row>
          <Row label="Fee per event">{feeLabel}</Row>
        </dl>

        {/* Relay / transport */}
        {relay || status.transport ? (
          <>
            <Separator />
            <dl className="flex flex-col gap-2">
              {relay ? (
                <>
                  <Row label="Relay">
                    <span className="flex min-w-0 items-center justify-end gap-1.5">
                      <Radio
                        aria-hidden="true"
                        className={
                          relay.connected
                            ? 'size-3.5 shrink-0 text-primary'
                            : 'size-3.5 shrink-0 text-muted-foreground'
                        }
                      />
                      <span className="truncate font-mono text-xs" title={relay.url ?? undefined}>
                        {relay.url ?? '—'}
                      </span>
                    </span>
                  </Row>
                  <Row label="Connection">
                    <Badge variant={relay.connected ? 'default' : 'destructive'}>
                      {relay.connected ? 'connected' : 'disconnected'}
                    </Badge>
                  </Row>
                  <Row label="Buffered events">{relay.buffered ?? 0}</Row>
                  <Row label="Subscriptions">{relay.subscriptions?.length ?? 0}</Row>
                </>
              ) : null}
              {status.transport ? (
                <Row label="Transport">
                  <span className="flex min-w-0 items-baseline justify-end gap-1.5">
                    <span className="shrink-0">{status.transport.type ?? 'direct'}</span>
                    {status.transport.btpUrl ? (
                      <span
                        className="truncate font-mono text-xs text-muted-foreground"
                        title={status.transport.btpUrl}
                      >
                        {status.transport.btpUrl}
                      </span>
                    ) : null}
                  </span>
                </Row>
              ) : null}
            </dl>
          </>
        ) : null}

        {/* Per-chain readiness */}
        {status.network && status.network.length > 0 ? (
          <>
            <Separator />
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Chains
              </span>
              <div className="flex flex-wrap gap-1.5">
                {status.network.map((c) => (
                  <ChainBadge key={c.chain} chain={c.chain} ready={c.ready} detail={c.detail} />
                ))}
              </div>
            </div>
          </>
        ) : null}

        {/* Identity */}
        {identity ? (
          <>
            <Separator />
            <div className="flex flex-col gap-1.5">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Identity
              </span>
              <dl className="flex flex-col gap-1.5">
                {identity.nostrPubkey ? (
                  <Row label="npub">
                    <MonoId value={identity.nostrPubkey} prefixLen={10} suffixLen={6} />
                  </Row>
                ) : null}
                {identity.evmAddress ? (
                  <Row label="EVM">
                    <MonoId value={identity.evmAddress} prefixLen={8} suffixLen={6} />
                  </Row>
                ) : null}
                {identity.solanaAddress ? (
                  <Row label="Solana">
                    <MonoId value={identity.solanaAddress} prefixLen={8} suffixLen={6} />
                  </Row>
                ) : null}
                {identity.minaAddress ? (
                  <Row label="Mina">
                    <MonoId value={identity.minaAddress} prefixLen={8} suffixLen={6} />
                  </Row>
                ) : null}
              </dl>
            </div>
          </>
        ) : null}

        {status.lastError ? (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Last error: {status.lastError}
          </p>
        ) : null}
      </div>
    </div>
  );
};

export const statusAtoms: Atom[] = [{ id: 'client-status', Component: ClientStatus }];

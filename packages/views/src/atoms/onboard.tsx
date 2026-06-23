/**
 * Onboarding atom — a get-started card for new TOON clients.
 *
 * Presentational: driven entirely by its ViewSpec `props` (no event parsing).
 * Walks a new user through claiming an identity and opening a payment channel,
 * then offers an optional `publish` action to publish their initial kind:0
 * profile (wired by the runtime to `toon_publish_unsigned`).
 */
import { type FC } from 'react';
import { cn } from '../lib/cn.js';
import { type Atom, type AtomRenderProps } from './types.js';

function shortPk(pk: string): string {
  return pk.length > 12 ? `${pk.slice(0, 8)}…${pk.slice(-4)}` : pk;
}

const DEFAULT_STEPS = [
  'Claim your identity (one mnemonic, multi-chain).',
  'Open a payment channel to a TOON apex.',
  'Publish your first event — reads stay free.',
];

const OnboardCard: FC<AtomRenderProps> = ({ props, actions }) => {
  const pubkey = typeof props['pubkey'] === 'string' ? props['pubkey'] : undefined;
  const steps = Array.isArray(props['steps'])
    ? (props['steps'] as unknown[]).map(String)
    : DEFAULT_STEPS;
  const label = typeof props['label'] === 'string' ? props['label'] : 'Publish profile';

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
      <div>
        <div className="font-semibold">Get started with TOON</div>
        {pubkey ? (
          <div className="truncate text-xs text-muted-foreground">{shortPk(pubkey)}</div>
        ) : null}
      </div>
      <ol className="flex flex-col gap-1.5 text-sm text-muted-foreground">
        {steps.map((step, i) => (
          <li key={i} className="flex gap-2">
            <span className="font-medium text-foreground">{i + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
      {actions['publish'] ? (
        <div className="flex justify-end">
          <button
            type="button"
            className={cn(
              'rounded-md px-3 py-1 text-sm font-medium',
              'bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50'
            )}
            onClick={() => void actions['publish']?.()}
          >
            {label}
          </button>
        </div>
      ) : null}
    </div>
  );
};

export const onboardAtoms: Atom[] = [
  { id: 'onboard-card', writes: [{ name: 'toon_publish_unsigned' }], Component: OnboardCard },
];
